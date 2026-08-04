# HNFlow Desktop（Electron 壳）

HNFlow 桌面端外壳。v0.1.3 仅提供窗口、菜单与基本布局，不含引擎/数据库接入。

## 环境

- bun >= 1.3
- Windows / macOS / Linux

## 安装

```bash
cd apps/desktop
bun install
```

> 国内网络若 Electron 二进制下载失败，可设置镜像后重新运行：
> ```bash
> $env:ELECTRON_MIRROR="https://npmmirror.com/mirrors/electron/"
> bun run install.js
> ```

## 构建

```bash
bun run build    # 等价于 tsc -p tsconfig.json，输出到 dist/
```

## 启动

```bash
bun start        # 先构建再启动 Electron
# 或分别执行：
bun run build
bunx electron .
```

## 目录结构

```
apps/desktop/
├── package.json        # @hnflow/desktop，独立包
├── tsconfig.json       # 主进程/预加载编译配置（CommonJS 输出）
├── src/
│   ├── main.ts         # 主进程：窗口 + 菜单 + 生命周期
│   └── preload.ts      # 预加载：暴露 window.hnflow（版本/平台）
└── renderer/           # 渲染进程：纯静态 HTML/CSS/JS
    ├── index.html
    ├── style.css
    └── renderer.js
```

## 说明

- 主进程编译为 CommonJS（`dist/main.js`），Electron 直接加载。
- `contextIsolation: true`、`nodeIntegration: false`，渲染进程仅通过 `window.hnflow` 与主进程通信。
- 本项目使用独立 tsconfig，不影响根目录核心库 `@hnflow/core`。
