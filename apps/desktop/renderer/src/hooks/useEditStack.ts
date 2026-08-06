// 编辑栈逻辑（T9 + v0.4.1 T12）：enterSubworkflow 进入子工作流编辑层，exitLevel 返回父层。
//
// 子工作流节点两种形态：
// - 内嵌子图（params.template 非 string）：双击直接进入编辑层（可编辑）；
// - 模板引用（params.template = "name@version"）：内容在模板库，进入前异步加载 →
//   进入即置只读（保护模板），想修改需「保存为新版本」发布后解除只读。
//
// 层级图快照存取：由 EditorState reducer 内部 levelGraphs 栈管理（state.tsx T5 定稿）——
// - pushLevel：当前层图入 levelGraphs，graph 切换为子图；
// - popLevel：子图编辑结果回写父节点 subworkflow，graph 恢复父层图。
// 故本 hook 不再另存模块级快照（避免与 reducer 双轨漂移、StrictMode 双挂载下残留）。
//
// 模板引用上下文（currentTemplateRef）：模板名只能从父节点 params.template 解析，而父节点数据
// 在 reducer 内部 levelGraphs 未暴露、EditStackItem 也无模板名字段；workflow.name ≠ 模板名
// （模板打包产物 name 固定「子工作流」）。SaveAsVersionModal 发布新版本需要模板名，故在此
// 以模块级单值记录（进入时写、退出/失败清空），只读展示用途，不参与状态同步。

import { useCallback } from "react";
import { message } from "antd";
import { toEditorGraph } from "@core/editing/editor-graph";
import type { Workflow } from "@core/model/types";
import type { EditorGraphNode } from "@core/editing/editor-graph";
import { editorActions, useEditor } from "../editor/state.js";
import { useNodeUi } from "../editor/ui-context.js";

/** 编辑栈对外 API（组件内调用，避免直接拼 action）。 */
export interface EditStackApi {
  /** 是否处于子工作流层（editStack 非空时可返回上级）。 */
  readonly canExit: boolean;
  /**
   * 进入子工作流编辑层（异步）：
   * - 非 subworkflow 节点：静默忽略；
   * - 内嵌子图：置可编辑后 pushLevel 进入；
   * - 模板引用：置只读 → 加载模板内容 → pushLevel（失败退出只读并提示）。
   */
  readonly enterSubworkflow: (node: EditorGraphNode) => Promise<void>;
  /** 返回父层：子图编辑结果回写父节点后恢复父层图（栈空时 reducer 幂等忽略），退出即解除只读。 */
  readonly exitLevel: () => void;
}

/** 当前模板引用子图上下文（模块级单值；SaveAsVersionModal 发布新版本取模板名）。 */
interface TemplateRefContext {
  readonly name: string;
  readonly version: string;
}
let currentTemplateRef: TemplateRefContext | undefined = undefined;

/** 读取当前模板引用上下文：非模板引用子图/未进入模板子图时返回 undefined。 */
export function getCurrentTemplateRef(): TemplateRefContext | undefined {
  return currentTemplateRef;
}

/** 解析 "name@version" 模板引用：lastIndexOf("@") 切分；非法（缺失/空段）返回 undefined。 */
function parseTemplateRef(ref: string): TemplateRefContext | undefined {
  const sep = ref.lastIndexOf("@");
  if (sep <= 0 || sep === ref.length - 1) {
    return undefined;
  }
  return { name: ref.slice(0, sep), version: ref.slice(sep + 1) };
}

/** IPC/核心库错误 → message 文案（主进程已转中文友好消息，透传即可）。 */
function errorText(error: unknown, fallback: string): string {
  return error instanceof Error && error.message !== "" ? error.message : fallback;
}

/** 编辑栈 hook：包装 EditorState 的 pushLevel/popLevel 动作 + 模板引用只读层进入。 */
export function useEditStack(): EditStackApi {
  const { state, dispatch } = useEditor();
  const { setReadOnly } = useNodeUi();

  const enterSubworkflow = useCallback(
    async (node: EditorGraphNode): Promise<void> => {
      if (node.type !== "subworkflow") {
        return; // 非子工作流节点：不进入编辑层
      }
      const templateRef = node.params["template"];
      if (typeof templateRef !== "string") {
        // 内嵌子图：内容在画布内，可编辑（显式解除只读，防御残留只读态）。
        setReadOnly(false);
        if (node.subworkflow !== undefined) {
          dispatch(editorActions.pushLevel({ id: node.id, name: node.name }, node.subworkflow));
        }
        return;
      }
      // 模板引用：内容在模板库，进入即只读（保护模板）。
      const ref = parseTemplateRef(templateRef);
      if (ref === undefined) {
        setReadOnly(false);
        message.error("模板引用格式非法（应为 name@version）。");
        return;
      }
      setReadOnly(true);
      currentTemplateRef = ref;
      try {
        const result = await window.hnflow.loadTemplateVersion({ name: ref.name, version: ref.version });
        // main 已校验（loadTemplateVersionPayload → toJSON）；跨 IPC 断言，toEditorGraph 二次校验兜底。
        const graph = toEditorGraph(result.workflow as Workflow);
        dispatch(editorActions.pushLevel({ id: node.id, name: node.name }, graph));
      } catch (error) {
        console.error("加载模板子图失败", error);
        currentTemplateRef = undefined;
        setReadOnly(false);
        message.error(errorText(error, "加载模板子图失败"));
      }
    },
    [dispatch, setReadOnly],
  );

  const exitLevel = useCallback(() => {
    dispatch(editorActions.popLevel());
    currentTemplateRef = undefined;
    setReadOnly(false); // 退出即解除只读（无论是否只读层）
  }, [dispatch, setReadOnly]);

  return { canExit: state.editStack.length > 0, enterSubworkflow, exitLevel };
}
