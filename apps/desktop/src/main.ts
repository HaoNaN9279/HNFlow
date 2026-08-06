import { app, BrowserWindow, Menu, shell } from "electron";
import * as path from "node:path";
import { registerIpcHandlers } from "./ipc/handlers.js";
import { ensureTemplateLibrary } from "./ipc/templates.js";

/** 开发服务器地址：vite dev 默认端口 5173；可通过环境变量覆盖。 */
const DEV_SERVER_URL = "http://localhost:5173";

/** 当前是否为开发模式：VITE_DEV_SERVER_URL 显式指定 或 NODE_ENV=development。
 *  括号访问 env 避免 bun build 把 process.env.NODE_ENV 编译期常量折叠（NODE_ENV 是 bun 的已知折叠键）。 */
function isDevMode(): boolean {
  return process.env.VITE_DEV_SERVER_URL !== undefined || process.env["NODE_ENV"] === "development";
}

/** 创建主窗口，按模式加载渲染进程页面（dev=开发服务器 / prod=构建产物）。
 *  产物路径基于 app.getAppPath()（bun build 会把 __dirname 内联成源码目录，不可用于定位 dist 产物）。 */
function createWindow(): void {
  const appPath = app.getAppPath();
  const win = new BrowserWindow({
    width: 1200,
    height: 800,
    title: "HNFlow",
    webPreferences: {
      preload: path.join(appPath, "dist", "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  if (isDevMode()) {
    void win.loadURL(process.env.VITE_DEV_SERVER_URL ?? DEV_SERVER_URL);
  } else {
    void win.loadFile(path.join(appPath, "dist", "renderer", "index.html"));
  }
}

/** 构建应用菜单（文件 / 视图 / 帮助）。 */
function buildMenu(): void {
  const isMac = process.platform === "darwin";
  const template: Electron.MenuItemConstructorOptions[] = [
    ...(isMac ? [{ role: "appMenu" as const }] : []),
    {
      label: "文件",
      submenu: [
        {
          label: "新建工作流",
          accelerator: "CmdOrCtrl+N",
          click: (): void => {
            // 占位：T5 接入工作流创建
          },
        },
        { type: "separator" },
        {
          label: "打开",
          accelerator: "CmdOrCtrl+O",
          click: (): void => {
            // 占位：T11 接入文件对话框
          },
        },
        { type: "separator" },
        isMac ? { role: "close" as const, label: "关闭窗口" } : { role: "quit" as const, label: "退出" },
      ],
    },
    {
      label: "视图",
      submenu: [
        { role: "reload" as const, label: "刷新" },
        { role: "toggleDevTools" as const, label: "开发者工具" },
      ],
    },
    {
      label: "帮助",
      role: "help" as const,
      submenu: [
        {
          label: "关于",
          click: (): void => {
            void shell.openExternal("https://github.com/hnflow/hnflow");
          },
        },
      ],
    },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

void app.whenReady().then(async () => {
  registerIpcHandlers();
  // 首启初始化模板库（userData/templates 写入种子模板）；失败不阻塞启动，仅告警。
  await ensureTemplateLibrary(app.getPath("userData")).catch((error) => {
    console.error("模板库初始化失败（可手动创建 templates 目录）", error);
  });
  buildMenu();
  createWindow();

  // macOS：点击 Dock 图标时若无窗口则重建
  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow();
    }
  });
});

// 非 macOS：关闭全部窗口即退出
app.on("window-all-closed", () => {
  if (process.platform !== "darwin") {
    app.quit();
  }
});
