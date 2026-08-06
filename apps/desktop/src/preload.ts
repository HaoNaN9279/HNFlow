// 预加载脚本：通过 contextBridge 暴露类型安全的最小 API 给渲染进程。
// 全部 IPC 走 ipcRenderer.invoke（主进程 ipcMain.handle 注册于 src/ipc/handlers.ts）。

import { contextBridge, ipcRenderer, type IpcRendererEvent } from "electron";
import {
  IPC,
  type AgentChatPayload,
  type HnflowApi,
  type LoadTemplateVersionPayload,
  type ReleaseTemplatePayload,
  type ReviewDecisionPayload,
  type ReviewRequestInfo,
  type RunWorkflowPayload,
} from "./shared/ipc.js";

const api: HnflowApi = {
  version: "0.4.1",
  platform: process.platform,
  listNodeTypes: () => ipcRenderer.invoke(IPC.listNodeTypes),
  newWorkflow: () => ipcRenderer.invoke(IPC.workflowNew),
  openWorkflow: () => ipcRenderer.invoke(IPC.workflowOpen),
  saveAsWorkflow: (workflow: unknown, suggestedName?: string) =>
    ipcRenderer.invoke(IPC.workflowSaveAs, suggestedName === undefined ? { workflow } : { workflow, suggestedName }),
  saveWorkflow: (filePath: string, workflow: unknown) => ipcRenderer.invoke(IPC.workflowSave, { filePath, workflow }),
  runWorkflow: (payload: RunWorkflowPayload) => ipcRenderer.invoke(IPC.workflowRun, payload),
  // 审核决策：invoke 提交（main 侧 resolve 对应 pending 请求）。
  sendReviewDecision: (payload: ReviewDecisionPayload) => ipcRenderer.invoke(IPC.workflowReviewDecision, payload),
  // 审核请求事件订阅：main → renderer（webContents.send）；返回取消订阅函数。
  onReviewRequest: (cb: (request: ReviewRequestInfo) => void) => {
    const listener = (_event: IpcRendererEvent, request: ReviewRequestInfo) => cb(request);
    ipcRenderer.on(IPC.workflowReviewRequest, listener);
    return () => {
      ipcRenderer.off(IPC.workflowReviewRequest, listener);
    };
  },
  chatWithAgent: (payload: AgentChatPayload) => ipcRenderer.invoke(IPC.agentChat, payload),
  listTemplates: () => ipcRenderer.invoke(IPC.templateList),
  loadTemplateVersion: (payload: LoadTemplateVersionPayload) => ipcRenderer.invoke(IPC.templateLoadVersion, payload),
  releaseTemplate: (payload: ReleaseTemplatePayload) => ipcRenderer.invoke(IPC.templateRelease, payload),
};

contextBridge.exposeInMainWorld("hnflow", api);
