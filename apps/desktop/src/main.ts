import { app, BrowserWindow, dialog, Menu, shell, Tray } from "electron";
import * as path from "node:path";
import { HumanTaskStore } from "../../../src/human/HumanTaskStore.js";
import { RunStateStore } from "../../../src/runstate/RunStateStore.js";
import { registerIpcHandlers } from "./ipc/handlers.js";
import { ensureTemplateLibrary, TEMPLATE_LIB_DIR } from "./ipc/templates.js";
import { ensureGroupLibrary, GROUP_LIB_DIR } from "./ipc/groups.js";
import { RUN_STATE_FILE } from "./ipc/run.js";
import { getActiveRuns } from "./ipc/run-tracker.js";
import { ensureTrayIcon } from "./tray-icon.js";
import { recoverInterruptedRuns } from "./recovery.js";
import { scanAndNotify } from "./task-timeout-scan.js";
import {
  CLOSE_BUTTON_ORDER,
  CLOSE_CHOICES,
  CLOSE_DIALOG_BUTTONS,
  closePromptMessage,
  decideClose,
  shouldConfirmClose,
} from "./window-lifecycle.js";

/** 开发服务器地址：vite dev 默认端口 5173；可通过环境变量覆盖。 */
const DEV_SERVER_URL = "http://localhost:5173";

/** 人工任务持久化文件名（位于 userData 下）；超时扫描 HumanTaskStore 用。 */
const HUMAN_TASK_FILE = "human_tasks.json";

/** 当前是否为开发模式：VITE_DEV_SERVER_URL 显式指定 或 NODE_ENV=development。
 *  括号访问 env 避免 bun build 把 process.env.NODE_ENV 编译期常量折叠（NODE_ENV 是 bun 的已知折叠键）。 */
function isDevMode(): boolean {
  return process.env.VITE_DEV_SERVER_URL !== undefined || process.env["NODE_ENV"] === "development";
}

/** 主窗口引用：托盘菜单「显示主窗口」与关闭拦截共用。 */
let mainWindow: BrowserWindow | undefined;

/** 托盘实例：undefined 表示未创建（图标初始化失败等）；完整退出时销毁。 */
let tray: Tray | undefined;

/** 完整退出标志：托盘菜单退出 / 关闭确认「退出应用」/ before-quit 置位，close 拦截据此放行。 */
let isQuitting = false;

/** 人工任务超时扫描定时器句柄：undefined 表示未启动；完整退出时 clearInterval。 */
let timeoutTimer: ReturnType<typeof setInterval> | undefined;

/** 创建主窗口，按模式加载渲染进程页面（dev=开发服务器 / prod=构建产物）。
 *  产物路径基于 app.getAppPath()（bun build 会把 __dirname 内联成源码目录，不可用于定位 dist 产物）。 */
function createWindow(): BrowserWindow {
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

  // T2 关闭拦截：有运行中任务时弹确认框（后台继续 / 退出应用 / 取消）。
  // 运行计数来源：ipc/run-tracker.ts（T1 完成后在 run.ts 的 runWorkflowOnce 前后 increment/decrement 接线）。
  win.on("close", (event) => {
    handleWindowClose(event, win);
  });
  win.on("closed", () => {
    if (mainWindow === win) {
      mainWindow = undefined;
    }
  });

  if (isDevMode()) {
    void win.loadURL(process.env.VITE_DEV_SERVER_URL ?? DEV_SERVER_URL);
  } else {
    void win.loadFile(path.join(appPath, "dist", "renderer", "index.html"));
  }
  mainWindow = win;
  return win;
}

/** 关闭拦截：无运行任务或正在完整退出 → 放行；否则 preventDefault + 确认框（决策逻辑在 window-lifecycle.ts）。 */
function handleWindowClose(event: Electron.Event, win: BrowserWindow): void {
  if (isQuitting || !shouldConfirmClose(getActiveRuns())) {
    return; // 放行：完整退出路径或无运行中任务
  }
  event.preventDefault(); // 有运行中任务：拦截关闭，先询问用户
  void dialog
    .showMessageBox(win, {
      type: "question",
      title: "HNFlow",
      message: closePromptMessage(getActiveRuns()),
      buttons: [...CLOSE_DIALOG_BUTTONS],
      defaultId: 0, // 默认「后台继续」
      cancelId: 2, // Esc → 取消：窗口保持打开
    })
    .then(({ response }) => {
      if (win.isDestroyed()) {
        return; // 对话框期间窗口已被销毁（极端路径），不再处理
      }
      const choice = CLOSE_BUTTON_ORDER[response] ?? CLOSE_CHOICES.cancel;
      if (choice === CLOSE_CHOICES.cancel) {
        return; // 取消：不动作，窗口保持打开
      }
      const { hide } = decideClose(choice, getActiveRuns());
      if (hide) {
        win.hide(); // 后台继续：隐藏窗口，任务继续运行
      } else {
        isQuitting = true; // 退出应用：before-quit 清理托盘，close 拦截放行
        app.quit();
      }
    });
}

/** 创建系统托盘：图标路径来自 ensureTrayIcon（userData/icons/tray.png），tooltip + 菜单。 */
function createTray(iconPath: string): void {
  tray = new Tray(iconPath);
  tray.setToolTip("HNFlow");
  tray.setContextMenu(
    Menu.buildFromTemplate([
      {
        label: "显示主窗口",
        click: (): void => {
          if (mainWindow === undefined) {
            createWindow(); // 窗口已关闭 → 重建
          } else {
            mainWindow.show();
            mainWindow.focus();
          }
        },
      },
      { type: "separator" },
      {
        label: "退出",
        click: (): void => {
          isQuitting = true; // 托盘退出：跳过关闭确认，直接完整退出
          app.quit();
        },
      },
    ]),
  );
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
  // T5 异常恢复（验收 3）：注册 IPC 后、创建窗口前，扫描未完成工作流自动恢复；失败不阻塞启动，仅告警。
  await recoverInterruptedRuns(
    new RunStateStore({ filePath: path.join(app.getPath("userData"), RUN_STATE_FILE) }),
    {
      templatesRootDir: path.join(app.getPath("userData"), TEMPLATE_LIB_DIR),
      groupsRootDir: path.join(app.getPath("userData"), GROUP_LIB_DIR),
    },
  ).catch((error) => {
    console.error("异常恢复失败（未完成工作流可手动重跑）", error);
  });
  // 首启初始化模板库（userData/templates 写入种子模板）；失败不阻塞启动，仅告警。
  await ensureTemplateLibrary(app.getPath("userData")).catch((error) => {
    console.error("模板库初始化失败（可手动创建 templates 目录）", error);
  });
  // 首启初始化功能组库（userData/groups 写入种子功能组）；失败不阻塞启动，仅告警。
  await ensureGroupLibrary(app.getPath("userData")).catch((error) => {
    console.error("功能组库初始化失败（可手动创建 groups 目录）", error);
  });
  // 人工任务超时提醒：启动扫描一次 + 每小时定时扫描；读取/通知异常仅告警不崩主进程。
  const humanStore = new HumanTaskStore({ filePath: path.join(app.getPath("userData"), HUMAN_TASK_FILE) });
  const scan = (): void => {
    void scanAndNotify(humanStore).catch((error) => {
      console.warn("人工任务超时扫描失败", error);
    });
  };
  scan();
  timeoutTimer = setInterval(scan, 60 * 60 * 1000);
  buildMenu();
  // 托盘初始化（base64 内嵌图标写出 userData/icons/tray.png）；失败不阻塞启动——无托盘时关窗即退出（见 window-all-closed 兜底）。
  try {
    const iconPath = await ensureTrayIcon(app.getPath("userData"));
    createTray(iconPath);
  } catch (error) {
    console.error("托盘初始化失败（无托盘驻留，关闭窗口将直接退出）", error);
  }
  createWindow();

  // macOS：点击 Dock 图标时若无窗口则重建
  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow();
    }
  });
});

// T2 后台驻留：有系统托盘时关闭窗口不退出（运行中任务继续后台执行）；真正退出走托盘菜单/关闭确认「退出应用」。
app.on("window-all-closed", () => {
  // 兜底：托盘创建失败（无图标等）时保留原行为关窗即退，避免应用无法退出。
  if (tray === undefined) {
    app.quit();
  }
});

// 完整退出清理：销毁托盘；停止超时扫描定时器；运行计数为纯内存，随进程退出清零，无需额外清理。
app.on("before-quit", () => {
  isQuitting = true;
  if (timeoutTimer !== undefined) {
    clearInterval(timeoutTimer);
    timeoutTimer = undefined;
  }
  if (tray !== undefined) {
    tray.destroy();
    tray = undefined;
  }
});
