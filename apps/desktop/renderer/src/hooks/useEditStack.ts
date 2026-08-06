// 编辑栈逻辑（T9）：enterSubworkflow 进入子工作流编辑层，exitLevel 返回父层。
//
// 层级图快照存取：由 EditorState reducer 内部 levelGraphs 栈管理（state.tsx T5 定稿）——
// - pushLevel：当前层图入 levelGraphs，graph 切换为子图（node.subworkflow）；
// - popLevel：子图编辑结果回写父节点 subworkflow，graph 恢复父层图。
// 故本 hook 不再另存模块级快照（避免与 reducer 双轨漂移、StrictMode 双挂载下残留），
// 只做入/退/可退三件事，父层图恢复完全委托 reducer。
//
// 消费约定：SubworkflowNode 双击子工作流节点 → enterSubworkflow；
// 层级导航 UI（面包屑 + 返回上级按钮）→ exitLevel / canExit（T9 可选增强）。

import { useCallback } from "react";
import type { EditorGraphNode } from "@core/editing/editor-graph";
import { editorActions, useEditor } from "../editor/state.js";

/** 编辑栈对外 API（组件内调用，避免直接拼 action）。 */
export interface EditStackApi {
  /** 是否处于子工作流层（editStack 非空时可返回上级）。 */
  readonly canExit: boolean;
  /** 进入子工作流编辑层（校验 type === "subworkflow" 且携带 subworkflow 子图，非法静默忽略）。 */
  readonly enterSubworkflow: (node: EditorGraphNode) => void;
  /** 返回父层：子图编辑结果回写父节点后恢复父层图（栈空时 reducer 幂等忽略）。 */
  readonly exitLevel: () => void;
}

/** 编辑栈 hook：包装 EditorState 的 pushLevel/popLevel 动作。 */
export function useEditStack(): EditStackApi {
  const { state, dispatch } = useEditor();

  const enterSubworkflow = useCallback(
    (node: EditorGraphNode) => {
      if (node.type !== "subworkflow" || node.subworkflow === undefined) {
        return; // 非子工作流节点或缺子图：不进入编辑层
      }
      dispatch(editorActions.pushLevel({ id: node.id, name: node.name }, node.subworkflow));
    },
    [dispatch],
  );

  const exitLevel = useCallback(() => {
    dispatch(editorActions.popLevel());
  }, [dispatch]);

  return { canExit: state.editStack.length > 0, enterSubworkflow, exitLevel };
}
