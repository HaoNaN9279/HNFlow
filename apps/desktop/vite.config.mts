// Vite 配置：renderer 构建（React + AntD + X6）+ CSP 按模式注入 + @core 别名。
// root=renderer/，产物输出到 dist/renderer/（主进程 loadFile 加载）。

import react from "@vitejs/plugin-react";
import { fileURLToPath } from "node:url";
import { defineConfig, type Plugin } from "vite";

const coreSrcDir = fileURLToPath(new URL("../../src", import.meta.url));

/** 开发模式 CSP：vite dev 需内联脚本/样式（react 插件 preamble + HMR）+ ws 热更新。 */
const DEV_CSP =
  "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; connect-src 'self' ws:";
/** 生产模式 CSP：script-src 保持严格（仅 self）；style-src 需 unsafe-inline——
 *  AntD 5（cssinjs）与 X6 在运行期注入内联样式，严格 style-src 会整体阻断样式渲染。后续可再收紧。 */
const PROD_CSP =
  "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:";

/** 按构建模式替换 index.html 中 %VITE_CSP% 占位的插件。 */
function cspPlugin(): Plugin {
  return {
    name: "hnflow-csp",
    transformIndexHtml: {
      order: "pre",
      handler(html, ctx) {
        // dev server 时 ctx.server 存在（dev 放宽 CSP）；vite build 时无 server（严格 CSP）
        const csp = ctx.server !== undefined ? DEV_CSP : PROD_CSP;
        return html.replace("%VITE_CSP%", csp);
      },
    },
  };
}

export default defineConfig({
  root: "renderer",
  base: "./",
  plugins: [react(), cspPlugin()],
  resolve: {
    alias: {
      "@core": coreSrcDir,
    },
  },
  // dev server 端口固定 5173（main.ts 的 DEV_SERVER_URL 默认值），与主进程加载分支对齐
  server: {
    port: 5173,
    strictPort: true,
  },
  build: {
    outDir: "../dist/renderer",
    emptyOutDir: true,
  },
});
