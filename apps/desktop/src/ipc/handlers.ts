// 主进程 IPC 处理器注册：editor:listNodeTypes / workflow:new / workflow:open / workflow:saveAs / workflow:save。
// 文件对话框（GUI）留在此文件；读写/校验/错误翻译纯逻辑在 workflow-io.ts（可独立验证）。
// 错误传播：ipcMain.handle 抛错 → renderer invoke reject → renderer 捕获后 message.error 展示中文。

import { app, dialog, ipcMain } from "electron";
import { join } from "node:path";
import { loadWorkflow } from "../../../../src/storage/index.js";
import { toJSON } from "../../../../src/serialization/index.js";
import {
  IPC,
  type LoadTemplateVersionPayload,
  type LoadTemplateVersionResponse,
  type OpenWorkflowResponse,
  type ReleaseTemplatePayload,
  type ReleaseTemplateResponse,
  type SaveAsWorkflowPayload,
  type SaveAsWorkflowResponse,
  type SaveWorkflowPayload,
  type SaveWorkflowResult,
  type TemplateSummary,
  type WorkflowTemplate,
} from "../shared/ipc.js";
import { listNodeTypeMetadata } from "./node-types.js";
import { listTemplates, loadTemplateVersionPayload, releaseTemplateFromPayload, TEMPLATE_LIB_DIR } from "./templates.js";
import { friendlyWorkflowError, saveWorkflowToFile, validatedWorkflowTemplate } from "./workflow-io.js";

/** 打开/保存对话框共用过滤条件：JSON 工作流文件。 */
const WORKFLOW_FILTERS: Electron.FileFilter[] = [{ name: "工作流文件", extensions: ["json"] }];

/** 模板库根目录：userData/templates（首次启动由 ensureTemplateLibrary 写入种子模板）。 */
function templatesRootDir(): string {
  return join(app.getPath("userData"), TEMPLATE_LIB_DIR);
}

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

  // 模板列表：扫描 userData/templates 下全部 template.json 汇总。
  ipcMain.handle(IPC.templateList, async (): Promise<readonly TemplateSummary[]> => {
    try {
      return await listTemplates(templatesRootDir());
    } catch (error) {
      throw friendlyWorkflowError(error);
    }
  });

  // 模板版本加载：name + version（缺省 currentVersion）→ 该版本 workflow 可序列化形状。
  ipcMain.handle(
    IPC.templateLoadVersion,
    async (_event, payload: LoadTemplateVersionPayload): Promise<LoadTemplateVersionResponse> => {
      try {
        return await loadTemplateVersionPayload(templatesRootDir(), payload);
      } catch (error) {
        throw friendlyWorkflowError(error);
      }
    },
  );

  // 模板发布新版本：releaseTemplateFromPayload 内部已做中文错误翻译（核心库错误透传 / errno 转「文件操作失败」）。
  ipcMain.handle(
    IPC.templateRelease,
    (_event, payload: ReleaseTemplatePayload): Promise<ReleaseTemplateResponse> =>
      releaseTemplateFromPayload(templatesRootDir(), payload),
  );
}
