// 预加载脚本：通过 contextBridge 暴露类型安全的最小 API 给渲染进程。
// 全部 IPC 走 ipcRenderer.invoke（主进程 ipcMain.handle 注册于 src/ipc/handlers.ts）。

import { contextBridge, ipcRenderer } from "electron";
import { IPC, type HnflowApi } from "./shared/ipc.js";

const api: HnflowApi = {
  version: "0.4.0",
  platform: process.platform,
  listNodeTypes: () => ipcRenderer.invoke(IPC.listNodeTypes),
  newWorkflow: () => ipcRenderer.invoke(IPC.workflowNew),
  openWorkflow: () => ipcRenderer.invoke(IPC.workflowOpen),
  saveAsWorkflow: (workflow: unknown, suggestedName?: string) =>
    ipcRenderer.invoke(IPC.workflowSaveAs, suggestedName === undefined ? { workflow } : { workflow, suggestedName }),
  saveWorkflow: (filePath: string, workflow: unknown) => ipcRenderer.invoke(IPC.workflowSave, { filePath, workflow }),
};

contextBridge.exposeInMainWorld("hnflow", api);
