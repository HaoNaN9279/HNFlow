// 主进程 IPC 处理器注册：editor:listNodeTypes / workflow:new / workflow:open / workflow:saveAs / workflow:save。
// 文件对话框（GUI）留在此文件；读写/校验/错误翻译纯逻辑在 workflow-io.ts（可独立验证）。
// 错误传播：ipcMain.handle 抛错 → renderer invoke reject → renderer 捕获后 message.error 展示中文。

import { dialog, ipcMain } from "electron";
import { loadWorkflow } from "../../../../src/storage/index.js";
import { toJSON } from "../../../../src/serialization/index.js";
import {
  IPC,
  type OpenWorkflowResponse,
  type SaveAsWorkflowPayload,
  type SaveAsWorkflowResponse,
  type SaveWorkflowPayload,
  type SaveWorkflowResult,
  type WorkflowTemplate,
} from "../shared/ipc.js";
import { listNodeTypeMetadata } from "./node-types.js";
import { friendlyWorkflowError, saveWorkflowToFile, validatedWorkflowTemplate } from "./workflow-io.js";

/** 打开/保存对话框共用过滤条件：JSON 工作流文件。 */
const WORKFLOW_FILTERS: Electron.FileFilter[] = [{ name: "工作流文件", extensions: ["json"] }];

/** 注册全部 IPC 处理器；应在 app ready 前调用。 */
export function registerIpcHandlers(): void {
  ipcMain.handle(IPC.listNodeTypes, () => listNodeTypeMetadata());

  // 新建：返回经 workflowSchema 校验的空模板（renderer 据此渲染空画布）。
  ipcMain.handle(IPC.workflowNew, (): WorkflowTemplate => validatedWorkflowTemplate());

  // 打开：系统对话框选文件 → loadWorkflow 读入+deserialize 校验 → 返回 { filePath, workflow }。
  ipcMain.handle(IPC.workflowOpen, async (): Promise<OpenWorkflowResponse> => {
    const picked = await dialog.showOpenDialog({
      title: "打开工作流",
      properties: ["openFile"],
      filters: WORKFLOW_FILTERS,
    });
    const filePath = picked.canceled ? undefined : picked.filePaths[0];
    if (filePath === undefined) {
      return { canceled: true };
    }
    try {
      const workflow = await loadWorkflow(filePath);
      return { filePath, workflow: toJSON(workflow) };
    } catch (error) {
      throw friendlyWorkflowError(error);
    }
  });

  // 另存为：系统对话框选路径 → 校验写盘 → 返回 { filePath }。
  ipcMain.handle(IPC.workflowSaveAs, async (_event, payload: SaveAsWorkflowPayload): Promise<SaveAsWorkflowResponse> => {
    const suggested = payload.suggestedName ?? "未命名工作流";
    const picked = await dialog.showSaveDialog({
      title: "保存工作流",
      defaultPath: `${suggested}.json`,
      filters: WORKFLOW_FILTERS,
    });
    if (picked.canceled || picked.filePath === undefined) {
      return { canceled: true };
    }
    try {
      await saveWorkflowToFile(picked.filePath, payload.workflow);
    } catch (error) {
      throw friendlyWorkflowError(error);
    }
    return { filePath: picked.filePath };
  });

  // 覆盖保存：直接校验写盘已打开文件路径。
  ipcMain.handle(IPC.workflowSave, async (_event, payload: SaveWorkflowPayload): Promise<SaveWorkflowResult> => {
    try {
      await saveWorkflowToFile(payload.filePath, payload.workflow);
    } catch (error) {
      throw friendlyWorkflowError(error);
    }
    return { ok: true };
  });
}
