---
name: photoshop-create
description: 搭建新的 Photoshop 开发项目脚手架，支持 ExtendScript、UXP 和 C++ SDK 三种类型
model: standard
---

# `/photoshop-create` — Photoshop 项目脚手架搭建

> **这是一份指导文档，不是自动化执行工具。**
> 它指导 AI 代理在搭建新的 Photoshop 开发项目时，应生成正确的目录结构、文件模板和 manifest 配置。不执行软件安装、Photoshop 运行时调用或构建操作。

---

## 1. 用途

搭建一个新的 Photoshop 开发项目，可选三种层面类型之一：

| 子命令 | 层面 | 使用场景 |
|---|---|---|
| `extendscript` | ExtendScript (.jsx) | 快速脚本、批处理、遗留自动化 |
| `uxp` | UXP (.psjs + manifest.json) | 现代面板/脚本插件，带 UI 和权限模型 |
| `cpp` | C++ SDK (.cpp/.h) | 高性能滤镜、格式处理器、混合 UXP+C++ |

AI 代理生成目录树、入口文件，以及（对于 UXP）与请求版本匹配的有效 `manifest.json`。用户指定项目名称、层面类型和可选参数。

---

## 2. 用法

```
/photoshop-create extendscript --name <项目名称> [--version <x.y.z>]
/photoshop-create uxp --name <项目名称> --type <panel|script|headless> [--manifest-version <4|5|6>] [--framework <react|vue|none>] [--host-min <x.y.z>]
/photoshop-create cpp --name <项目名称> [--sdk-version <2025|2026>]
```

### 缩写形式

```
/create ps-es --name BatchResize --version 1.0.0
/create ps-uxp --name LayerManager --type panel --manifest-version 5
/create ps-cpp --name CustomFilter --sdk-version 2025
```

---

## 3. 参数

### 全局参数

| 参数 | 必需 | 描述 |
|---|---|---|
| `--name` | 是 | 项目名称（用于目录名、入口文件名和 manifest `id`） |
| `--version` | 否 | 语义版本号字符串 (`x.y.z`)。默认值：`1.0.0` |

### ExtendScript 特定参数

| 参数 | 必需 | 描述 |
|---|---|---|
| *(除全局参数外无其他)* | — | ExtendScript 项目没有额外的脚手架参数。始终会添加 `#target photoshop` 指令。 |

### UXP 特定参数

| 参数 | 必需 | 描述 |
|---|---|---|
| `--type` | 是 | 插件类型：`panel`（可停靠 UI 面板）、`script`（菜单触发的脚本）、`headless`（无 UI）。 |
| `--manifest-version` | 否 | 目标 manifest 版本：`4`、`5` 或 `6`。默认值：`5`。见下方 **§6 — manifest.json 模板指南**。 |
| `--framework` | 否 | 面板类型的 UI 框架：`react`、`vue` 或 `none`。默认值：`none`（使用 Spectrum Web Components 的原生 HTML/CSS/JS）。 |
| `--host-min` | 否 | 最低 Photoshop 版本（例如 `24.0`、`25.0`）。默认值：`24.0`。 |

### C++ SDK 特定参数

| 参数 | 必需 | 描述 |
|---|---|---|
| `--sdk-version` | 否 | 目标 Photoshop SDK 版本年份（例如 `2025`、`2026`）。默认值：`2025`。此参数仅用于文档目的——不生成任何构建配置或平台工具链文件。 |

---

## 4. 执行步骤

### 4.1 ExtendScript 项目 (`extendscript` / `ps-es`)

1. **创建目录结构**

   ```
   <项目名称>/
   ├── scripts/          # 入口 .jsx 文件
   │   └── <项目名称>.jsx
   ├── includes/         # 共享的 .jsxinc 模块
   │   └── <项目名称>.jsxinc    （可选，如有辅助函数则包含）
   └── docs/             # 使用文档
       └── README.md
   ```

2. **生成入口脚本** (`scripts/<项目名称>.jsx`)

   ```javascript
   // @target photoshop
   // @include "includes/<项目名称>.jsxinc"
   // @description <项目名称> — <简要描述>
   // @version <版本>

   (function() {
       'use strict';

       // 保护：确保至少有一个文档打开
       if (app.documents.length === 0) {
           alert('请先打开一个文档。');
           return;
       }

       var doc = app.activeDocument;

       // --- 项目特定逻辑写在这里 ---
       $.writeln('正在运行 <项目名称> v<版本>');

       // 将文档修改操作包裹在 suspendHistory 中以支持撤消
       doc.suspendHistory('<项目名称>', '/* 动作字符串 */');

   })();
   ```

   - 第 1 行**必须**是 `#target photoshop`，以实现跨平台文件启动兼容性。
   - 将所有逻辑包裹在 IIFE 中以避免全局作用域污染（ES3 限制：仅 `var`，无 `let`/`const`/箭头函数）。
   - 将面向用户的操作包裹在 `doc.suspendHistory()` 中。
   - 使用 `$.writeln()` 进行调试日志记录。

3. **生成包含模块** (`includes/<项目名称>.jsxinc`)

   ```javascript
   // @include guard — 此文件不是独立脚本
   // <项目名称> 的共享辅助函数

   (function() {
       // 在此放置共享函数
       // 使用 .jsxinc 扩展名 — Photoshop 的 ExtendScript 引擎
       // 将其与独立 .jsx 文件区分开。
   })();
   ```

4. **生成文档** (`docs/README.md`) — 简短的使用说明，引用入口脚本路径。

---

### 4.2 UXP 项目 (`uxp` / `ps-uxp`)

1. **创建目录结构**

   ```
   <项目名称>/
   ├── src/               # 源代码
   │   ├── main.js        # 入口点（必需）
   │   ├── <组件>.js      # 额外模块（根据需要）
   │   └── style.css      # 样式（面板类型）
   ├── public/            # 静态资源
   │   └── icons/
   │       ├── dark-23.png
   │       ├── dark-46.png
   │       ├── light-23.png
   │       └── light-46.png
   ├── dist/              # 构建输出（搭建时为空）
   └── manifest.json      # 插件 manifest
   ```

   - **面板类型**：添加 `public/icons/`，包含深色/浅色主题的 23px 和 46px PNG 图标。
   - **脚本 / 无头类型**：省略 `public/icons/`（无 UI 界面）。

2. **生成入口脚本** (`src/main.js`)

   ```javascript
   'use strict';

   const app = require('photoshop').app;
   const core = require('photoshop').core;

   // --- 插件逻辑写在这里 ---
   // 所有文档修改操作必须包裹在 executeAsModal 中：
   // await core.executeAsModal(async (executionContext) => { ... });

   // 示例：记录活动文档信息
   if (app.activeDocument) {
       console.log('活动文档：', app.activeDocument.name);
   }
   ```

   - 每个 `.psjs` / `.js` 文件必须以 `"use strict"` 开头。
   - 通过 `require('photoshop').app` 导入 Photoshop DOM。
   - 对任何文档修改操作使用 `core.executeAsModal()`。

3. **生成 manifest.json** — 见下方 **§6 — manifest.json 模板指南**，根据 `--manifest-version` 生成相应版本的模板。

4. **框架设置**（如果 `--framework react` 或 `--framework vue`）：
   - 生成带框架入口点的 `src/`（例如 React 的 `index.jsx`）。
   - 添加 `package.json` 占位符，注明框架依赖关系。
   - 不要运行 `npm install`——这是一个指导性脚手架。

---

### 4.3 C++ SDK 项目 (`cpp` / `ps-cpp`)

> **⚠ 仅文档性质的脚手架。** 不生成构建配置、平台工具链文件（`.vcxproj`、`.xcodeproj`）或 SDK 头文件。用户必须手动设置 C++ SDK 环境。项目结构指导请参考 `capability-groups/domain/photoshop/1.0.0/rules/photoshop.md`。

1. **创建目录结构**

   ```
   <项目名称>/
   ├── source/            # 源文件 (.cpp)
   │   └── <项目名称>.cpp
   ├── include/           # SDK 头文件和项目头文件
   │   └── <项目名称>/
   │       └── Plugin.h
   ├── resources/         # PiPL 资源文件、图标、版本信息
   │   └── <项目名称>.r
   └── docs/              # 构建和架构说明
       └── BUILD.md
   ```

2. **生成源文件** (`source/<项目名称>.cpp`)

   ```cpp
   // <项目名称> — Photoshop C++ SDK 插件
   // 目标 SDK：Photoshop <sdk-version>
   //
   // 注意：这是一个结构骨架。套件获取、描述符
   // 构造和错误处理由开发者负责。

   #include "PSPlugIn.h"
   #include "PITypes.h"
   #include "PIActionDescriptor.h"

   // 入口点（滤镜插件示例）
   DLLExport SPAPI PluginMain(const short selector,
                              FilterRecordPtr filterRecord,
                              long* data,
                              short* result) {
       // 套件获取模式：
       // SPBasicSuite* sSPBasic = filterRecord->sSPBasic;
       // sSPBasic->AcquireSuite(kSomeSuite, kSomeVersion, (const void**)&suitePtr);
       //
       // 必须检查 kSPNoError 返回值，并 Free() 所有获取的套件。
       // 通过套件 Make() 调用获取的内存必须显式释放。
   }
   ```

3. **生成资源文件** (`resources/<项目名称>.r`)

   ```
   // PiPL 资源 — 定义插件类型和入口函数
   // 类型：filter (.8bf)、automation、format、import、export
   // 入口：PluginMain (filter)、AutoPluginMain (automation)
   ```

4. **生成构建说明** (`docs/BUILD.md`) — 占位符，指导用户：
   - 设置 Photoshop C++ SDK 环境。
   - 在 Visual Studio（Windows）或 Xcode（macOS）中打开平台项目。
   - 构建并将生成的 `.8bf` / `.plugin` 复制到 Photoshop 的 `Plug-ins/` 目录。

---

## 5. 输出

该命令在用户指定的位置（默认：当前工作目录）生成一个完整的脚手架目录树。AI 代理显式列出每个创建的文件及其用途。

**示例输出 (ExtendScript)：**

```
已创建项目 "BatchResize" 于 ./BatchResize/
├── scripts/BatchResize.jsx        — 入口脚本 (#target photoshop, IIFE 包装器)
├── includes/BatchResize.jsxinc    — 共享辅助函数模块
└── docs/README.md                 — 使用文档
```

**示例输出 (UXP)：**

```
已创建项目 "LayerManager" 于 ./LayerManager/
├── src/
│   ├── main.js                     — 入口点 (executeAsModal 包装)
│   └── style.css                   — 插件样式 (Spectrum Web Components 令牌)
├── public/icons/
│   ├── dark-23.png                 — 深色主题图标 (23px)
│   ├── dark-46.png                 — 深色主题图标 (46px)
│   ├── light-23.png                — 浅色主题图标 (23px)
│   └── light-46.png                — 浅色主题图标 (46px)
├── dist/                           — 构建输出 (空)
└── manifest.json                   — Manifest v5 (requiredPermissions 块)
```

**示例输出 (C++ SDK)：**

```
已创建项目 "CustomFilter" 于 ./CustomFilter/
├── source/CustomFilter.cpp         — 源文件骨架 (PluginMain 入口)
├── include/CustomFilter/Plugin.h   — 项目头文件
├── resources/CustomFilter.r        — PiPL 资源存根
└── docs/BUILD.md                   — 构建说明占位符
```

---

## 6. manifest.json 模板指南

根据 `--manifest-version` 参数生成相应版本的 manifest。

### manifest v4 (Photoshop 2022+, `--manifest-version 4`)

```json
{
    "manifestVersion": 4,
    "id": "<前缀>.<项目名称>",
    "name": "<项目显示名称>",
    "version": "<版本>",
    "main": "index.html",
    "host": {
        "app": "PS",
        "minVersion": "<最低主机版本>"
    },
    "entrypoints": [
        {
            "type": "panel",
            "id": "panel",
            "label": "<项目显示名称>",
            "minimumSize": { "width": 300, "height": 400 },
            "preferredDockedSize": { "width": 350, "height": 500 }
        }
    ],
    "icons": [
        { "width": 23, "height": 23, "path": "icons/dark-23.png", "theme": "dark" },
        { "width": 46, "height": 46, "path": "icons/dark-46.png", "theme": "dark" },
        { "width": 23, "height": 23, "path": "icons/light-23.png", "theme": "light" },
        { "width": 46, "height": 46, "path": "icons/light-46.png", "theme": "light" }
    ]
}
```

**注意：**
- 对于 `minVersion >= 23.0`，`apiVersion` 默认为 2。
- 没有 `requiredPermissions` 块——文件系统/网络 API 不可访问。
- 适用于不需要文件系统或网络访问的插件。
- 面板插件的 `entrypoints` 类型为 `"panel"`，脚本插件为 `"script"`，无头插件则省略。

### manifest v5 (Photoshop 2023+, `--manifest-version 5`, 默认)

```json
{
    "manifestVersion": 5,
    "id": "<前缀>.<项目名称>",
    "name": "<项目显示名称>",
    "version": "<版本>",
    "main": "index.html",
    "host": {
        "app": "PS",
        "minVersion": "<最低主机版本>"
    },
    "entrypoints": [
        {
            "type": "panel",
            "id": "panel",
            "label": "<项目显示名称>",
            "minimumSize": { "width": 300, "height": 400 },
            "preferredDockedSize": { "width": 350, "height": 500 }
        }
    ],
    "icons": [
        { "width": 23, "height": 23, "path": "icons/dark-23.png", "theme": "dark" },
        { "width": 46, "height": 46, "path": "icons/dark-46.png", "theme": "dark" },
        { "width": 23, "height": 23, "path": "icons/light-23.png", "theme": "light" },
        { "width": 46, "height": 46, "path": "icons/light-46.png", "theme": "light" }
    ],
    "requiredPermissions": {
        "localFileSystem": ["read", "save"],
        "network": ["communication"]
    }
}
```

**注意：**
- 在 v5 中 `requiredPermissions` 是**必需的**。未声明的权限在安装时被拒绝，无运行时回退。
- 仅添加插件实际需要的最小权限（最小权限原则）。
- `require('uxp').storage.localFileSystem.getFolder()` 需要 `"localFileSystem"` 权限。
- 任何 `fetch()` 或 HTTP 通信需要 `"network"` 权限。

### manifest v6 (Photoshop 2024+, `--manifest-version 6`)

```json
{
    "manifestVersion": 6,
    "id": "<前缀>.<项目名称>",
    "name": "<项目显示名称>",
    "version": "<版本>",
    "main": "index.html",
    "host": {
        "app": "PS",
        "minVersion": "<最低主机版本>"
    },
    "entrypoints": [
        {
            "type": "panel",
            "id": "panel",
            "label": "<项目显示名称>",
            "minimumSize": { "width": 300, "height": 400 },
            "preferredDockedSize": { "width": 350, "height": 500 }
        }
    ],
    "icons": [
        { "width": 23, "height": 23, "path": "icons/dark-23.png", "theme": "dark" },
        { "width": 46, "height": 46, "path": "icons/dark-46.png", "theme": "dark" },
        { "width": 23, "height": 23, "path": "icons/light-23.png", "theme": "light" },
        { "width": 46, "height": 46, "path": "icons/light-46.png", "theme": "light" }
    ],
    "requiredPermissions": {
        "localFileSystem": ["read", "save"],
        "network": ["communication"]
    }
}
```

**注意：**
- v6 在结构上与 v5 相同，但可能在未来的 Photoshop 版本中引入新的 schema 属性。
- 从 Photoshop 2024 (v25) 起可用（见 `rules/photoshop.md` 中的兼容性表）。

### 版本兼容性参考

| Manifest | Photoshop | apiVersion | 关键变化 |
|---|---|---|---|
| v4 | 2022+ (v23) | 2 (自动) | 基础 UXP manifest |
| v5 | 2023+ (v24) | 2 (自动) | `requiredPermissions` 块为必填 |
| v6 | 2024+ (v25) | 2 (自动) | 面向未来，schema 与 v5 相同 |

---

## 7. 说明

- **不安装软件。** 此命令不安装 C++ SDK、Visual Studio、Xcode 或任何其他开发工具链。
- **不执行 Photoshop。** 此命令不在 Photoshop 中运行脚本，也不启动 UXP Developer Tool。
- **不管理包依赖。** 不执行 `npm install`、`pip install` 或类似的依赖安装。
- **不执行构建。** UXP `dist/` 保持为空；C++ 项目需要手动构建配置。
- **跨层面混合项目** (UXP + C++)：先运行 `/photoshop-create uxp`，然后单独运行 `/photoshop-create cpp`，或手动合并两个结构。混合插件需要在 UXP `manifest.json` 和 C++ `PSDLLMain()` 注册之间的匹配 `component ID` 字段。
- 对于面向 Marketplace 分发的插件，`manifest.json` 必须提供单个 `host` 定义，而非数组。
