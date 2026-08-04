import { contextBridge } from "electron";

/** 暴露给渲染进程的最小 API。 */
const api = {
  version: "0.1.3",
  platform: process.platform
} as const;

contextBridge.exposeInMainWorld("hnflow", api);
