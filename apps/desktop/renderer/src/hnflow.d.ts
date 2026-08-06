// preload 暴露的 window.hnflow 全局类型声明（跨 tsconfig 引用共享类型）。

import type { HnflowApi } from "../../src/shared/ipc.js";

declare global {
  interface Window {
    hnflow: HnflowApi;
  }
}

export {};
