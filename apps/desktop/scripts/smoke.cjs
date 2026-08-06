// T4 临时冒烟脚本：验证生产模式窗口加载后 React 挂载、四区 id、preload API。验证后删除。
const { app, BrowserWindow } = require("electron");
const path = require("node:path");

app.whenReady().then(async () => {
  const win = new BrowserWindow({
    show: false,
    webPreferences: {
      preload: path.join(app.getAppPath(), "dist", "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  const logs = [];
  win.webContents.on("console-message", (_event, level, message) => {
    logs.push(`[${level}] ${message}`);
  });
  win.webContents.on("did-fail-load", (_e, code, desc) => {
    console.log("DID_FAIL_LOAD:", code, desc);
  });
  await win.loadFile(path.join(app.getAppPath(), "dist", "renderer", "index.html"));
  await new Promise((resolve) => setTimeout(resolve, 2000));

  const rootHtml = await win.webContents.executeJavaScript(
    "document.getElementById('root') ? document.getElementById('root').innerHTML.slice(0, 200) : 'NO_ROOT'",
  );
  const panels = await win.webContents.executeJavaScript(
    "[...document.querySelectorAll('#toolbar,#material-panel,#canvas,#config-panel')].map((e) => e.id).join(',')",
  );
  const hnflow = await win.webContents.executeJavaScript("JSON.stringify(window.hnflow ? { v: window.hnflow.version, p: window.hnflow.platform, fns: typeof window.hnflow.listNodeTypes } : 'NO_API')");

  console.log("ROOT_HTML:", rootHtml);
  console.log("PANELS:", panels);
  console.log("HNFLOW_API:", hnflow);
  console.log("CONSOLE_ERRORS:", logs.filter((l) => l.startsWith("[3]") || l.startsWith("[2]")).length);
  app.exit(0);
});
