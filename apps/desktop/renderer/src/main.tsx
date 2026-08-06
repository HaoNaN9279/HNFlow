// 渲染进程入口：React 挂载点，全局 reset + 应用根组件。

import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import "antd/dist/reset.css";
import "@antv/x6/dist/index.css";
import "@antv/x6-plugin-selection/dist/index.css";
import "@antv/x6-plugin-snapline/dist/index.css";
import App from "./App.js";
import "./global.css";

const rootEl = document.getElementById("root");
if (rootEl === null) {
  throw new Error("缺少挂载点 #root");
}

createRoot(rootEl).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
