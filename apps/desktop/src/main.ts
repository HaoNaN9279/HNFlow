import { app, BrowserWindow, Menu, shell } from "electron";
import * as path from "node:path";

/** 创建主窗口，加载渲染进程页面。 */
function createWindow(): void {
  const win = new BrowserWindow({
    width: 1200,
    height: 800,
    title: "HNFlow",
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false
    }
  });

  // dist 输出后主进程位于 apps/desktop/dist/main.js，渲染页面位于 apps/desktop/renderer/
  void win.loadFile(path.join(__dirname, "../renderer/index.html"));
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
            // 占位：v0.2 接入工作流创建
          }
        },
        { type: "separator" },
        {
          label: "打开",
          accelerator: "CmdOrCtrl+O",
          click: (): void => {
            // 占位：v0.2 接入工作流打开
          }
        },
        { type: "separator" },
        isMac ? { role: "close" as const, label: "关闭窗口" } : { role: "quit" as const, label: "退出" }
      ]
    },
    {
      label: "视图",
      submenu: [
        { role: "reload" as const, label: "刷新" },
        { role: "toggleDevTools" as const, label: "开发者工具" }
      ]
    },
    {
      label: "帮助",
      role: "help" as const,
      submenu: [
        {
          label: "关于",
          click: (): void => {
            void shell.openExternal("https://github.com/hnflow/hnflow");
          }
        }
      ]
    }
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

void app.whenReady().then(() => {
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
