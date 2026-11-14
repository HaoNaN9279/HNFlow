---
name: photoshop-utils
description: 快速访问 Photoshop API 文档、版本兼容性检查、ExtendScript→UXP 迁移参考和代码片段
---

## /photoshop-utils — Photoshop 工具与参考指南

斜杠命令，用于快速访问 API 文档、版本兼容性检查、ExtendScript→UXP 迁移参考以及跨所有 Photoshop 开发层面（ExtendScript/JSX、UXP/PSJS、C++ SDK）的可复用代码片段。

---

### 用法

```
/photoshop-utils docs <查询>              — 查找 API 文档
/photoshop-utils version <api> [版本]      — 检查 API 版本兼容性
/photoshop-utils migrate <api|模式>        — 显示 ExtendScript→UXP 迁移映射
/photoshop-utils snippets <主题>           — 浏览代码片段索引
/photoshop-utils help                      — 显示此帮助
```

---

### 1. API 文档查询

打开或搜索官方 Adobe 文档。所有查询针对 adobe.com 域名。

| 层面 | 主要文档 | 搜索 URL | 快速参考 |
|---------|-------------|-----------|-----------------|
| UXP/PSJS | [Photoshop UXP API 参考](https://developer.adobe.com/photoshop/uxp/2025/) | `https://developer.adobe.com/search/?q=<term>` | [Photoshop UXP 脚本指南](https://developer.adobe.com/photoshop/scripting/) |
| ExtendScript | [ExtendScript API 参考](https://extendscript.docsforadobe.dev/) | 在参考 URL 后附加 `#search=<term>` | [Adobe 脚本指南](https://helpx.adobe.com/photoshop/using/scripting.html) |
| C++ SDK | [Photoshop SDK 文档](https://developer.adobe.com/photoshop/sdk/) | `https://developer.adobe.com/search/?q=<term>+photoshop+sdk` | [SDK GitHub](https://github.com/AdobeDocs/photoshop-sdk) |
| 动作描述符 | [Action Manager 参考](https://developer.adobe.com/photoshop/uxp/2025/ps_action/) | 通过 UDT 动作录制 | Scripting Listener 插件 |
| manifest schema | [Manifest 配置](https://developer.adobe.com/photoshop/uxp/2025/manifest/) | — | UDT > Validate |

**搜索辅助：**

- `/photoshop-utils docs batchPlay` — 在 adobe.com 打开 batchPlay 参考
- `/photoshop-utils docs layer.create` — 在 Adobe Developer 搜索图层创建 API
- `/photoshop-utils docs executeAction` — 显示 ExtendScript→UXP 等效项和链接

**注意：** 不包括离线 API 文档。所有查询针对 Adobe 托管的在线文档。

---

### 2. 版本兼容性

Photoshop 版本层面支持矩阵（来自 rules/photoshop.md）：

| 层面 | PS 2022 (v23) | PS 2023 (v24) | PS 2024 (v25) | PS 2025 (v26) | PS 2026 (v27) |
|---------|:---:|:---:|:---:|:---:|:---:|
| ExtendScript | ✓ | ✓ | ✓ | ✓ | ✓ |
| UXP (manifest v4, apiVersion 2) | ✓ | ✓ | ✓ | ✓ | ✓ |
| UXP (manifest v5, permissions model) | ✓ (v23.3+) | ✓ | ✓ | ✓ | ✓ |
| UXP (manifest v6) | — | — | ✓ | ✓ | ✓ |
| UXP (batchPlay) | ✓ | ✓ | ✓ | ✓ | ✓ |
| C++ SDK (PIUXPSuite v1) | ✓ (v23.3+) | ✓ | ✓ | ✓ | ✓ |
| C++ SDK (filter/automation) | ✓ | ✓ | ✓ | ✓ | ✓ |

**版本依赖 API 的注释模式：**

```typescript
// @since PS 2024 (v25) — app.activeDocument.artboards
// @removed PS 2023 (v24) — someLegacyAPI()
// @deprecated PS 2025 (v26) — 改用 batchPlay()
// @minVersion 24.0 — 在 manifest.json requiredPermissions 块中
```

**更新日志参考：**

- [Photoshop UXP 更新日志](https://developer.adobe.com/photoshop/uxp/changelog/) — 每个版本的 API 新增、弃用和移除
- [Adobe 社区论坛](https://community.adobe.com/t5/photoshop-ecosystem/bd-p/photoshop-ecosystem) — 特定版本的问题和解决方案
- GitHub [AdobeDocs/uxp-photoshop](https://github.com/AdobeDocs/uxp-photoshop) 发布 — SDK 更新说明

**用法：**

```
/photoshop-utils version batchPlay v23      — 检查 PS 2022 中的 batchPlay
/photoshop-utils version "manifest v5"      — 显示 manifest v5 何时引入
/photoshop-utils version executeAsModal     — 显示 executeAsModal 的版本要求
```

---

### 3. ExtendScript → UXP 迁移

#### 主要差异

| # | ExtendScript (.jsx) | UXP (.psjs) | 说明 |
|---|--------------------|-------------|-------|
| 1 | `executeAction(stringID, descriptor, dialogModes)` | `batchPlay([actionDescriptor], { modalBehavior })` | `batchPlay` 接受描述符数组；ExtendScript 中同步，UXP 中异步 |
| 2 | `executeActionGet(reference)` | `batchPlay([{ _obj: "get", _target: reference }])` | 包裹为单元素 batchPlay 数组 |
| 3 | `app.documents.length > 0` 保护后使用 `app.activeDocument` | `app.activeDocument` 返回 `undefined`——用 `if (app.activeDocument)` 检查 | UXP 消除了运行时抛出；不需要 `documents.length` 属性 |
| 4 | `$.writeln(message)` | `console.log(message)` | UXP 使用标准 web 控制台；输出显示在 UDT Developer Console 中 |
| 5 | `app.doScript(actionName, descriptor, dialogModes)` | `batchPlay([...])` 在 `executeAsModal()` 内部 | 没有直接的 `doScript` 等效项；使用带录制动作的 batchPlay |
| 6 | `app.activeDocument.suspendHistory(undoName, actionString)` | `executeAsModal()` 自动处理撤消分组 | UXP 模态作用域创建单个撤消步骤；不需要手动调用 `suspendHistory` |
| 7 | `app.open(File(path))` | `require('photoshop').core.openFile(path)` 或 `require('uxp').storage` 令牌 API | ExtendScript 使用 Adobe File 对象；UXP 使用基于存储能力的访问 |
| 8 | `charIDToTypeID("char")` / `stringIDToTypeID("s")` | `require('photoshop').action.charIDToTypeID()` / `.stringIDToTypeID()` | API 从全局作用域移至 `photoshop.action` 模块 |
| 9 | 带 `Window` 和 UI 资源的 `ScriptUI` 对话框 | HTML 模板 + [Spectrum Web Components](https://opensource.adobe.com/spectrum-web-components/) | ExtendScript 构建原生 OS 对话框；UXP 在带 CSS 的 Chromium 面板中渲染 |
| 10 | `#include "helpers.jsxinc"` | `require('./helpers.js')` 或 ES 模块 `import` | ExtendScript 使用预处理器包含；UXP 使用 CommonJS/ES 模块 |
| 11 | 文件顶部的 `#target photoshop` 指令 | `manifest.json` 中的 `"host": { "app": "PS", "minVersion": "23.0.0" }` | UXP 注册从脚本级别指令移至插件 manifest |
| 12 | `app.activeDocument.layers[i]`（同步数组索引） | `await doc.layers[i]` 或 `doc.layers.get(i)` | UXP 图层访问可能需要 `await` 以进行异步集合解析 |
| 13 | ES3：仅 `var`，无箭头函数，无 `Promise` | 现代 JS：`let`/`const`、箭头函数、`async/await`、`Promise` | UXP 运行在 Chromium v102+ 引擎上，支持完整的 ES2022 |
| 14 | `alert(message)` / `confirm(message)`（ExtendScript 内置） | `app.showAlert(message)` | UXP 没有 `window.alert()`；使用 `photoshop.app.showAlert()` |

#### 执行模型迁移

```
ExtendScript (同步)                            UXP (异步 + 模态)
══════════════════════════                    ════════════════════════
var doc = app.activeDocument;                 const doc = app.activeDocument;
doc.resizeImage(800, 600);                    await require('photoshop').core.executeAsModal(
                                                async () => { doc.resizeImage(800, 600); }
                                              );
```

**关键规则：** UXP 中所有文档修改操作都需要 `executeAsModal` 包装器。省略会导致静默失败——不抛出错误，操作根本不执行。

#### API 等效性验证

迁移特定 API 时：
1. 检查 API 是否存在于 [UXP DOM](https://developer.adobe.com/photoshop/uxp/2025/ps_app/) 中——优先使用 DOM 而非 batchPlay
2. 如果不在 DOM 中，使用 Photoshop Scripting Listener 录制动作，然后将描述符转换为 batchPlay 格式
3. 使用 `ps-es-to-uxp` 日志工具（在 rules 中引用）自动转换 ExtendScript 动作描述符调用
4. 在执行前验证描述符 JSON 结构——`batchPlay` 不会因键不匹配而报错

---

### 4. 代码片段索引

规范模式请参考 `capability-groups/domain/photoshop/1.0.0/rules/photoshop.md`。以下是按任务组织的常见操作代码模板索引。

| 主题 | 层面 | 描述 |
|-------|---------|-------------|
| 文档保护 | UXP | `if (!app.activeDocument) return;` — 在任何文档操作前检查 |
| 文档保护 | ES | `if (app.documents.length > 0) { var doc = app.activeDocument; }` |
| 创建图层 | UXP | `await doc.createLayer({ name: "New Layer" })` 在 `executeAsModal` 内部 |
| 创建图层 | ES | `var layer = doc.artLayers.add(); layer.name = "New Layer";` |
| 遍历图层 | UXP | `for (const layer of doc.layers) { ... }` |
| 遍历图层 | ES | `for (var i = 0; i < doc.layers.length; i++) { ... }` |
| 保存文档 | UXP | `await doc.save()` 或带存储令牌的 `await doc.saveAs(saveToken)` |
| 保存文档 | ES | `doc.saveAs(File(folder + "/output.psd"));` |
| 批量操作 | UXP | 将多个操作分组到一次 `batchPlay([desc1, desc2, ...])` 调用中 |
| 用户消息 | UXP | `app.showAlert("消息")` |
| 用户消息 | ES | `alert("消息")` |
| 日志记录 | UXP | `console.log(value)` — 在 UDT Developer Console 中查看 |
| 日志记录 | ES | `$.writeln(value)` — 在 ESTK Console 中查看 |
| 撤消步骤 | UXP | 通过 `executeAsModal` 作用域自动实现 |
| 撤消步骤 | ES | `suspendHistory("步骤名称", "代码字符串")` |
| 滤镜图层样式 | ES | `doc.activeLayer.applyStyle(styleName)` |
| 动作描述符 | UXP | `require('photoshop').action` — `stringIDToTypeID`、`putInteger` 等 |
| 动作描述符 | ES | 全局作用域中的 `stringIDToTypeID`、`ActionDescriptor` 类 |
| 打开文件 | UXP | `require('photoshop').core.openFile(path)` |
| 打开文件 | ES | `app.open(File(path))` |
| 关闭文档 | UXP | `await doc.close()` 在 `executeAsModal` 内部 |
| 关闭文档 | ES | `doc.close(SaveOptions.DONOTSAVECHANGES)` |
| 访问 manifest host | UXP | `require('photoshop').host.descriptor` — 插件主机元数据 |

**模板变量**（使用时替换）：
- `doc` — 活动文档引用
- `path` — 文件系统路径字符串
- `saveToken` — 来自 `require('uxp').storage` 的 UXP 存储令牌
- `actionName` / `stepName` — 用户可见的撤消步骤文本

---

### 5. 外部资源

| 资源 | URL |
|----------|-----|
| Adobe Developer — Photoshop UXP | [https://developer.adobe.com/photoshop/uxp/](https://developer.adobe.com/photoshop/uxp/) |
| Adobe Developer — Photoshop Scripting | [https://developer.adobe.com/photoshop/scripting/](https://developer.adobe.com/photoshop/scripting/) |
| Adobe Developer — Photoshop SDK | [https://developer.adobe.com/photoshop/sdk/](https://developer.adobe.com/photoshop/sdk/) |
| ExtendScript API 参考 | [https://extendscript.docsforadobe.dev/](https://extendscript.docsforadobe.dev/) |
| Adobe UXP Photoshop GitHub | [https://github.com/AdobeDocs/uxp-photoshop](https://github.com/AdobeDocs/uxp-photoshop) |
| Photoshop SDK GitHub | [https://github.com/AdobeDocs/photoshop-sdk](https://github.com/AdobeDocs/photoshop-sdk) |
| Spectrum Web Components | [https://opensource.adobe.com/spectrum-web-components/](https://opensource.adobe.com/spectrum-web-components/) |
| Adobe Community — Photoshop Ecosystem | [https://community.adobe.com/t5/photoshop-ecosystem/bd-p/photoshop-ecosystem](https://community.adobe.com/t5/photoshop-ecosystem/bd-p/photoshop-ecosystem) |
