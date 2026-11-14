---
name: photoshop-debug
description: 提供 Photoshop 脚本与插件的运行和调试指导，涵盖 ExtendScript、UXP 和 C++ SDK
model: strong
---

## `/photoshop-debug` — Photoshop 运行与调试指导

> **⚠️ 能力说明**：此命令提供关于如何运行和调试 Photoshop 脚本与插件的**文档指导**。它**不**直接在 Photoshop 中运行脚本、不附加到进程，也不提供实时断点调试。所有调试操作需要开发者在本地机器上使用适当的 Adobe 工具。

---

### 1. ExtendScript (.jsx) 运行与调试

#### 运行 ExtendScript

| 方法 | 步骤 |
|--------|-------|
| **Photoshop 菜单** | `File > Scripts > Browse…` → 选择 `.jsx` 文件 → 打开 |
| **命令行** | `photoshop.exe script.jsx`（注意：CLI 启动前 Photoshop 必须关闭，否则脚本将在下次启动时运行） |
| **拖放** | 将 `.jsx` 拖到 Photoshop 图标上（启动 Photoshop 并运行脚本） |
| **ESTK / ExtendScript Toolkit** | 在 ESTK 中打开 `.jsx` → `Debug > Run`（需要安装 ESTK；最后随 Photoshop CC 2019 捆绑） |

#### 调试 ExtendScript

- **ExtendScript Debugger (ESTK)**：捆绑在较旧 Photoshop 版本中。提供单步调试、变量检查以及在 **JavaScript Console** 标签页中的 `$.writeln()` 控制台输出。
- **VS Code ExtendScript Debug 扩展**：社区扩展，提供断点、调用栈和变量监视。配置指向脚本路径的启动任务。
- **Scripting Listener 插件**：Adobe 的诊断插件，将所有 Photoshop 操作记录为脚本代码。通过 Photoshop 的 `Plug-ins > Scripting Listener` 启用。输出（JavaScript 日志）显示 UI 触发的确切 API 调用——对于逆向工程工作流程非常宝贵。
- **错误捕获包装器**：将顶层代码包裹在 try-catch 中，同时写入 `$.writeln()` 和外部日志文件：
  ```javascript
  try {
      // 主脚本逻辑
  } catch (e) {
      $.writeln("错误：" + e);
      var logFile = File("~/desktop/script-error.log");
      logFile.open("w");
      logFile.writeln("错误：" + e + "\n" + e.stack);
      logFile.close();
  }
  ```

---

### 2. UXP (.psjs / panel) 运行与调试

#### 运行 UXP 插件

| 方法 | 步骤 |
|--------|-------|
| **UXP Developer Tool (UDT)** | 打开 UDT → `Add Plugin` → 选择你的 `manifest.json` 文件夹 → `Actions > Load`。插件出现在 Photoshop 的 `Plugins > <名称>` 菜单中。 |
| **侧载** | 将构建好的插件文件夹复制到 `~/Creative Cloud/CCX/Plug-ins/` —— Photoshop 在下一次重启时加载它。 |

> **注意**：UDT 是一个 Electron 应用，随 Adobe UXP Developer Toolkit 提供。如果未安装，使用侧载方式或通过 [Adobe UXP Developer Tool 页面](https://developer.adobe.com/uxp/docs/tools/devtool/) 安装。

#### 调试 UXP 插件

- **UDT Developer Console**：通过 UDT 加载插件后，点击 `Developer Console` 查看来自 UXP 插件的 `console.log()`、`console.warn()` 和 `console.error()` 输出。
- **Chrome DevTools 协议**：通过 UDT 将 DevTools 连接到已加载的插件：
  1. 在 UDT 中，点击已加载插件上的 **Actions** → **Inspect**。
  2. 将打开一个 DevTools 窗口，包含 Elements、Console、Sources 和 Network 标签页。
  3. 直接在 Sources 面板中设置断点。
- **Photoshop 菜单**：`Plugins > Development > UXP Developer Tool` 在 Photoshop 中打开 UDT（必须安装并运行 UDT）。
- **日志记录最佳实践**：为多插件项目在日志前添加插件 ID 前缀：
  ```javascript
  const LOG_TAG = "[MyPlugin]";
  console.log(LOG_TAG, "正在初始化...");
  ```

---

### 3. 日志查看

| 层面 | 日志输出 | 如何查看 |
|---------|-----------|-------------|
| **ExtendScript** | `$.writeln("消息")` | ESTK JavaScript Console / VS Code Debug Console |
| **ExtendScript** | `$.global["catch"]` 错误处理器 | 包裹在 try-catch 中，写入 `File` 对象 |
| **UXP** | `console.log("消息")` | UDT Developer Console / Chrome DevTools Console |
| **UXP** | `app.showAlert("消息")` | Photoshop 警告对话框（仅面向用户，不用于调试） |
| **C++ SDK** | `FilterRecord::errorString` | Photoshop 在 UI 中显示错误；也会记录到 Windows 系统事件日志 |
| **Scripting Listener** | 动作描述符输出 | Photoshop 的 Scripting Listener 插件日志 |
| **外部文件** | 自定义文件日志 | 使用 `File` (ExtendScript) 或 `require('uxp').storage` (UXP) 写入 `~/Desktop/` 或 `~/Documents/` |

---

### 4. 常见错误场景与故障排除

#### 场景 1："权限被拒绝" — UXP 文件系统/网络 API 失败
- **原因**：Manifest v5+ 需要显式的 `requiredPermissions` —— 缺少 `"localFileSystem"`、`"network"` 等。
- **修复**：添加到 `manifest.json`：
  ```json
  "requiredPermissions": {
      "localFileSystem": "readWrite",
      "network": [ "domains" ]
  }
  ```
- **验证**：编辑 manifest 后，在 UDT 中重新加载插件。

#### 场景 2："API 不可用" — UXP DOM 方法返回 `undefined`
- **原因**：调用了目标 Photoshop 版本中不可用的 DOM API（例如 PS v22 中的 `doc.createLayer()`）。
- **修复**：对照版本兼容性表检查 API。对于 DOM 中未公开的 API，回退到 `batchPlay()`。始终进行保护：
  ```javascript
  if (typeof app.activeDocument?.createLayer === 'function') {
      await doc.createLayer({ name: "新建" });
  } else {
      // 回退到 batchPlay
  }
  ```

#### 场景 3：版本不匹配 — ExtendScript `#target` 指令被忽略
- **原因**：`#target photoshop` 丢失或拼写错误（例如 `#target photoshop2024`）。脚本在错误的主机中运行或静默失败。
- **修复**：确保入口 `.jsx` 的第一行恰好是 `#target photoshop`。这是文件启动（双击 / 拖放）跨平台兼容性所必需的。

#### 场景 4：静默失败 — 未使用 UXP `executeAsModal`
- **原因**：在 `executeAsModal` 外部调用文档修改代码（例如 `doc.createLayer()`、`doc.save()`）。不会抛出错误——操作静默地什么都不做。
- **修复**：包裹所有文档修改操作：
  ```javascript
  await require('photoshop').core.executeAsModal(async (ctx) => {
      const doc = app.activeDocument;
      const newLayer = await doc.createLayer({ name: "结果" });
  });
  ```

#### 场景 5："没有打开的文档" — ExtendScript 在 `app.activeDocument` 上抛出异常
- **原因**：当 `app.documents.length === 0` 时访问 `app.activeDocument` 会抛出运行时错误。
- **修复**：始终进行保护：
  ```javascript
  if (app.documents.length > 0) {
      var doc = app.activeDocument;
  } else {
      alert("请先打开一个文档。");
  }
  ```

#### 场景 6：UXP 加载失败 — manifest 验证错误
- **原因**：`manifest.json` 存在 schema 错误（缺少字段、错误的 `icon` 路径、无效的 `requiredPermissions` 格式）。
- **修复**：加载前进行验证：
  - UDT：对你的插件执行 `Operations > Validate`。
  - 自动化：如果使用 UXP CLI 模板，使用 `npm run validate`。检查 `manifestVersion` >= 4 且 `host.app` 包含 `"PS"`。

#### 场景 7：脚本运行但产生错误结果 — 动作描述符键不匹配
- **原因**：`batchPlay()` 或 `executeAction()` 使用了不正确的描述符键（例如使用 `"null"` 而非 `"nullUnit"`）。不会抛出错误——动作静默地应用于错误的目标。
- **修复**：在执行前记录描述符 JSON：
  ```javascript
  console.log(JSON.stringify(descriptor, null, 2));
  ```
  对照等效手动操作的 Scripting Listener 输出进行比较。

---

### 5. 快速参考

```bash
# 通过 Photoshop 文件菜单运行 ExtendScript
# File > Scripts > Browse... > 选择 .jsx

# 通过 UDT 调试 UXP
# UXP Developer Tool > Add Plugin > Actions > Load > Developer Console

# 启用 Scripting Listener
# Photoshop > Plug-ins > Scripting Listener > Enable JavaScript Logging

# 验证 UXP manifest
# UXP Developer Tool > Operations > Validate

# 常见日志位置
# ExtendScript：ESTK Console ($.writeln)
# UXP：UDT Console (console.log)
# 外部：自定义 File 写入 ~/Desktop/script-error.log
```
