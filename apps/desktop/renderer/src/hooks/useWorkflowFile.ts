// useWorkflowFile：工作流文件生命周期（新建/打开/保存）与顶层元信息维护（T11）。
// - currentMeta：顶层工作流 { id, name, version }；newWorkflow/openWorkflow 成功后更新，
//   保存时经 fromEditorGraph 导出（EditorGraph 顶层不携带元信息，故在此维护）；
// - currentFilePath：已打开/另存为的文件路径；undefined 时「保存」走另存为对话框；
// - 保存导出：fromEditorGraph(state.graph, currentMeta) 导出顶层工作流；若处于子工作流编辑层
//   （editStack 非空）先提示返回顶层——子层编辑需经 popLevel 回写父节点后顶层图才完整。

import { useCallback, useState } from "react";
import { message } from "antd";
import { fromEditorGraph, toEditorGraph } from "@core/editing/editor-graph";
import type { Workflow } from "@core/model/types";
import { editorActions, useEditor } from "../editor/state.js";

/** 顶层工作流元信息（保存时作为 fromEditorGraph 的 meta 导出）。 */
export interface WorkflowMeta {
  readonly id: string;
  readonly name: string;
  readonly version: string;
}

/** 文件生命周期 API（工具栏消费）。 */
export interface WorkflowFileApi {
  /** 已打开/另存为的文件路径；未保存过为 undefined。 */
  readonly currentFilePath: string | undefined;
  /** 顶层工作流元信息（id/name/version）。 */
  readonly currentMeta: WorkflowMeta;
  readonly handleNew: () => Promise<void>;
  readonly handleOpen: () => Promise<void>;
  readonly handleSave: () => Promise<void>;
}

/** IPC/核心库错误 → message 文案（主进程已转中文友好消息，透传即可）。 */
function errorText(error: unknown, fallback: string): string {
  return error instanceof Error && error.message !== "" ? error.message : fallback;
}

/** 初始元信息：未打开任何文件时视作未命名新工作流（保存时写此 id/name/version）。 */
function initialMeta(): WorkflowMeta {
  return { id: `workflow-${Date.now()}`, name: "未命名工作流", version: "0.1.0" };
}

export function useWorkflowFile(): WorkflowFileApi {
  const { state, dispatch } = useEditor();
  const [currentFilePath, setCurrentFilePath] = useState<string | undefined>(undefined);
  const [currentMeta, setCurrentMeta] = useState<WorkflowMeta>(initialMeta);

  /** 新建：workflow:new 空模板 → 空图（元信息随模板）→ setGraph + 路径重置为未保存。 */
  const handleNew = useCallback(async () => {
    try {
      const template = await window.hnflow.newWorkflow();
      const meta: WorkflowMeta = { id: template.id, name: template.name, version: template.version };
      dispatch(editorActions.setGraph({ ...meta, nodes: [], edges: [] }));
      setCurrentMeta(meta);
      setCurrentFilePath(undefined);
    } catch (error) {
      console.error("新建工作流失败", error);
      message.error(errorText(error, "新建工作流失败"));
    }
  }, [dispatch]);

  /** 打开：workflow:open（main 弹对话框+读入校验）→ toEditorGraph 渲染 → 元信息/路径更新。 */
  const handleOpen = useCallback(async () => {
    try {
      const result = await window.hnflow.openWorkflow();
      if ("canceled" in result) {
        return; // 用户取消：静默返回
      }
      const workflow = result.workflow as Workflow; // main 已 deserialize 校验；断言跨 IPC 边界，toEditorGraph 二次校验兜底
      const graph = toEditorGraph(workflow);
      dispatch(editorActions.setGraph(graph));
      setCurrentMeta({ id: workflow.id, name: workflow.name, version: workflow.version });
      setCurrentFilePath(result.filePath);
    } catch (error) {
      console.error("打开工作流失败", error);
      message.error(errorText(error, "打开工作流失败"));
    }
  }, [dispatch]);

  /** 保存：顶层图 + currentMeta → fromEditorGraph 导出 → 无路径走另存为，否则覆盖保存。 */
  const handleSave = useCallback(async () => {
    if (state.editStack.length > 0) {
      message.info("请先返回顶层工作流再保存（子层编辑需先退出）。");
      return;
    }
    let workflow: Workflow;
    try {
      workflow = fromEditorGraph(state.graph, currentMeta); // 结构校验失败（节点 id 重复等）抛错
    } catch (error) {
      console.error("导出工作流数据失败", error);
      message.error(errorText(error, "工作流数据不合法，无法保存"));
      return;
    }
    try {
      if (currentFilePath === undefined) {
        const result = await window.hnflow.saveAsWorkflow(workflow, currentMeta.name);
        if ("canceled" in result) {
          return; // 用户取消另存为：不改变当前状态
        }
        setCurrentFilePath(result.filePath);
      } else {
        await window.hnflow.saveWorkflow(currentFilePath, workflow);
      }
      message.success("保存成功");
    } catch (error) {
      console.error("保存工作流失败", error);
      message.error(errorText(error, "保存失败"));
    }
  }, [state.graph, state.editStack, currentMeta, currentFilePath]);

  return { currentFilePath, currentMeta, handleNew, handleOpen, handleSave };
}
