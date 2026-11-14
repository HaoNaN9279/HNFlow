---
name: photoshop
---

# Photoshop DCC 开发规则

适用于使用 ExtendScript (.jsx)、UXP (.psjs + manifest.json) 和 C++ SDK (.cpp/.h) 进行 AI 辅助 Photoshop 插件和工具开发的规则。在每个 Photoshop 脚本项目中都应遵循。目标版本：Photoshop 2022–2026 (v23–v27)。**禁止：伪造 API 签名。所有 ExtendScript、UXP 和 C++ SDK API 引用必须能够在 Adobe 文档中得到验证。**

## 项目结构

- **ExtendScript 项目**：将脚本放置在 `~/Adobe Scripts/` 或使用符号链接的版本控制仓库中。使用 `scripts/` 存放入口 `.jsx` 文件，`includes/` 存放共享的 `.jsxinc` 模块，`docs/` 存放使用文档。入口脚本必须在第 1 行包含 `#target photoshop` 以实现跨平台文件启动兼容性。对包含文件使用 `.jsxinc` 扩展名——Photoshop 的 ExtendScript 引擎会将其与独立 `.jsx` 脚本区分，且不能直接执行。
- **UXP 项目**：根目录下放置 `manifest.json`，包含 `"manifestVersion"` 4+ 和 `"host": {"app": "PS", "minVersion": "23.0.0"}`。将源代码放在 `src/` 下，构建输出放在 `dist/` 下，静态资源放在 `public/` 下。入口点通过 `"main": "index.html"` 定义。包含 `"entrypoints"` 数组用于定义命令和面板。面板插件需要 23px 和 46px 的 PNG 图标资源，分别用于深色和浅色主题。面向 Adobe Marketplace 的插件必须提供单个 `host` 定义，而非数组。
- **C++ SDK 项目**：对 AI 脚手架不透明——不要尝试生成项目文件、构建配置或平台工具链设置。识别定义插件类型（滤镜 `.8bf`、自动化、格式、导入、导出）和入口函数（滤镜用 `PluginMain`，自动化用 `AutoPluginMain`）的 PiPL `.r` 资源文件。参考：源代码在 `source/`，SDK 头文件在 `include/`，平台项目在 `projects/win/` 或 `projects/mac/`。混合 UXP+C++ 插件注册 `PSDLLMain()` 作为 Photoshop 端入口；配合包含匹配组件 ID 的 UXP `manifest.json`。
- 将 Photoshop 特定逻辑与框架层面的关注点分离：ExtendScript UI 使用 `ScriptUI` 资源字符串，UXP UI 使用带 Spectrum Web Components 设计令牌的 HTML/CSS，C++ UI 使用 Photoshop 的 `PIDialog` 套件。

## 编码规范

- **ExtendScript**：仅针对 ES3 引擎——所有变量使用 `var`，不使用 `let`、`const`、箭头函数、`Promise`、`async/await`、模板字面量或 `for...of`。在入口脚本顶部使用 `#target photoshop` 指令。将共享辅助函数分组到通过 `#include "path/to/helpers.jsxinc"` 访问的 `.jsxinc` 包含文件中。全局 `$` 对象提供 ExtendScript 扩展：`$.writeln()` 用于日志记录，`$.level` 用于解释器版本定位，`$.global` 用于跨脚本状态。将所有脚本逻辑包裹在 IIFE 中以防止全局作用域污染：`(function() { ... })()`。使用函数声明而非函数表达式，以确保在 ES3 下一致的提升行为。
- **UXP**：每个 `.psjs` 文件必须以 `"use strict"` 开头。通过 `const app = require('photoshop').app` 导入 Photoshop DOM，通过 `require('photoshop').core` 导入核心工具。所有文档修改操作都需要模态执行包装：`await require('photoshop').core.executeAsModal(async (executionContext) => { ... })`。仅在 DOM API 缺少所需功能时，才使用带动作描述符数组的 `batchPlay()`——在回退到 `batchPlay` 之前先查阅 Photoshop API 参考。manifest v5+ 需要显式的 `requiredPermissions` 块；未声明的权限在安装时被拒绝，无运行时回退。切勿在没有 `"localFileSystem"` 权限的情况下使用 `require('uxp').storage.localFileSystem.getFolder()`。
- **C++ SDK**：每次访问套件都要使用 `sSPBasic->AcquireSuite(kSuite, kVersion, (const void**)&suitePtr)`，并且必须检查 `kSPNoError` 返回值。所有函数都返回 `SPErr`。`PI*` 前缀表示 Photoshop 特定的类型（`PIActionDescriptor`、`PIActionReference`、`PIUXPSuite`）。通过套件 `Make()` 调用获取的描述符和引用内存必须通过相应的 `Free()` 调用显式释放——无垃圾回收机制。使用 `PSActionControlProcs::StringIDToTypeID()` 和 `TypeIDToStringID()` 进行运行时字符串到描述符键的转换；切勿硬编码四字符代码。

## API 使用模式

- **ExtendScript DOM**：始终使用 `app.documents.length > 0` 保护 `app.activeDocument`——在没有打开文档的情况下访问 `.activeDocument` 会抛出运行时错误。通过 `app.activeDocument.layers` 访问图层；使用 `for (var i = 0; i < layers.length; i++)` 进行迭代。使用带动作名称和描述符的 `app.doScript()` 执行记录的 Actions 面板操作。通过 `app.activeDocument.suspendHistory("undoName", "actionString")` 为面向用户的工具添加撤消步骤。对于滤镜操作，按照 Photoshop JavaScript 参考文档使用 `app.activeDocument.activeLayer.applyStyle()` 和 `applyChannelMixer()`。
- **UXP DOM`：通过 `app.activeDocument` 访问文档——当没有文档打开时返回 `undefined`，因此使用前要检查。图层创建使用 `await doc.createLayer({name, opacity, blendMode})`，放在 `executeAsModal` 内部。使用 `require('uxp').storage` 令牌 API 通过 `await doc.save()` 或 `await doc.saveAs()` 保存文档。对于 DOM 中没有的 API，使用带动作描述符的 `batchPlay()`，通过 `require('photoshop').action` 构建：`charIDToTypeID()`、`stringIDToTypeID()`、描述符 `putString()`、`putInteger()`、引用 `putProperty()`。使用 `app.showAlert()` 显示面向用户的消息，因为 `window.alert()` 不可用。
- **C++ SDK`：通过传递给入口函数的 `SPBasicSuite` 获取套件。使用 `PSActionControlProcs::Play()` 分发事件，使用 `::Get()` 读取属性。使用 `PIActionReference` 套件构建引用，使用 `PIActionDescriptor` 套件构建描述符。对于 UXP 互操作，使用 `PsUXPSuite1::SendUXPMessage()` 传递 UXP 插件的 `manifest.json` 的 `id` 字符串。混合插件注册 `PSDLLMain()` 入口供 Photoshop 在加载时调用。使用 `SPAccessRef` 与宿主应用集成的文件选择器。
- 所有层面的空安全是一致的：空集合（`layerSets`、`channels`、`pathItems`）返回零长度数组/集合，而非 `null`。始终检查 `.length` 或安全迭代。

## 性能

- **ExtendScript**：避免在循环内逐层调用 API——使用 `app.doScript()` 将整个工作流包装为单次动作执行来批量操作。将开销大的文件 I/O 放在 `#include` 加载的模块中，这些模块在初始化时只解析一次。ExtendScript 是单线程且同步的；任何长时间运行的脚本都会完全阻塞 Photoshop UI。对于批量处理大量文件，使用 `app.open()` / `app.activeDocument.close(SaveOptions.DONOTSAVECHANGES)` 模式，并注意资源清理。
- **UXP**：`batchPlay()` 接受动作描述符数组——将多个 Photoshop 操作分组到单个 `batchPlay()` 调用中以获得最佳吞吐量。DOM API 方法（`doc.layers`、`doc.createLayer()`）在可能的情况下使用内部批处理，因此在支持该功能时优先使用它们而非 `batchPlay`。将非 Photoshop 的重型计算卸载到 web workers；UXP 面板运行基于 Chromium 的运行时，支持用于 CPU 密集型任务的 workers。避免使用带 `synchronousExecution: true` 的同步 `batchPlay()`——它会同时阻塞 UXP 面板和 Photoshop UI 线程。
- **C++ SDK**：通过 Photoshop 的 `PIBufferSuite`（`New64`、`GetSize64`）请求大内存分配，而非直接使用 `malloc`/`new`——Photoshop 的内存管理器处理跨插件的碎片化。对像素级缓存缓冲区使用 `BufferProcs::AllocateBufferProc64`。格式插件应设置 `SupportsBackgroundSave` PiPL 属性，以启用异步文档保存而不阻塞主线程。在现代 Photoshop 中使用 `FilterRecord::bufferSpace64` 和 `maxSpace64` 进行 64 位缓冲区请求。

## 常见陷阱

- **ExtendScript**：当没有文档打开时，`app.documents[0]` 会抛出异常——始终使用 `app.documents.length > 0` 保护。ScriptUI 对话框阻塞主线程并冻结 Photoshop；切勿在 `onClick` 处理函数内运行文档处理循环。`$.setenv()` 和 `$.getenv()` 状态在同一 Photoshop 会话中跨脚本调用持久存在——使用后清除临时键。描述符键不匹配的 `executeAction` 不会产生错误——对照 Photoshop Scripting Listener 输出验证描述符字符串。
- **UXP**：忘记在文档修改代码上使用 `executeAsModal` 会导致静默失败——不会抛出错误，操作仅是什么都不做。Manifest `apiVersion` 默认值变化：`minVersion < 23.0` → `apiVersion: 1`（已弃用的同步模型），`minVersion >= 23.0` → `apiVersion: 2`（必需的模态模型）。面板插件不能访问文件系统或网络 API，除非在 `requiredPermissions` 中声明了相应的权限。从 manifest v4 升级到 v5 而不添加 `requiredPermissions` 会破坏之前所有工作的文件系统/网络访问。
- **C++ SDK**：`Make()` 后 `PIActionDescriptor` 和 `PIActionReference` 泄漏 → 内存随每次调用增长，直到 Photoshop 重启。路径分隔符因平台而异：Windows 上为 `\\`，macOS 上为 `/`——切勿硬编码单一分隔符。`SPPluginRef` 和 `SPBasicSuite` 指针在 Photoshop 重启后失效；切勿跨会话缓存。显示 UI 的套件（`PIDialog`）只能从主线程调用——从后台保存/导出处理程序调用会导致未定义行为。

## 测试

- **ExtendScript**：使用 ExtendScript Debugger（捆绑在 ESTK 中或通过 VS Code ExtendScript 扩展）进行单步调试和 `$.writeln()` 控制台输出。将顶层脚本包裹在 try-catch 中，使用 `$.global["catch"] = function(e) { $.writeln(e) }` 在开发期间报告未捕获的异常。通过 Photoshop 的 `File > Scripts > Browse` 或命令行 `photoshop.exe script.jsx` 运行脚本。使用 Photoshop Scripting Listener（插件）在开发期间将动作记录为脚本代码供参考。
- **UXP**：通过连接到正在运行的 Photoshop 实例的 UXP Developer Tool (UDT) 加载插件。`console.log()` 输出出现在 UDT 的 Developer Console 面板中。通过 Photoshop 菜单 `Plugins > Development > UXP Developer Tool` 检查 DOM 状态。在打包前使用 `UXP Developer Tool > Validate` 验证 manifest。通过切换连接的实例在多个 Photoshop 版本上测试。对于 `batchPlay()` 调试，在执行前记录描述符 JSON 以验证键/值结构。
- **C++ SDK**：加载 C++ 插件需要将构建好的 `.8bf`（或 macOS 上的 `.plugin`）复制到 Photoshop 的 `Plug-ins/` 目录并重启应用程序。通过 `FilterRecord::errorString` 缓冲区报告错误。没有无头测试框架——通过在 Photoshop 中进行视觉比较或导出的文件校验和来验证滤镜输出。
- **跨层面测试**：ExtendScript 和 UXP 共享相同的 Photoshop 文档模型；对照等效的 ExtendScript 脚本测试 UXP 插件，以验证行为一致性。C++ 混合插件必须与其对应的 UXP 前端同时加载测试。

## 迁移与互操作性

- **ExtendScript 到 UXP**：`executeAction` / `executeActionGet` API 映射到 UXP 的 `batchPlay()`——使用 ExtendScript `ps-es-to-uxp` 日志工具自动转换动作描述符调用。ExtendScript 是同步的；所有迁移后的 UXP 代码必须在之前同步的文档操作周围使用 `executeAsModal` 包装。
- **UXP 到 C++ 混合**：UXP 插件通过 `require('photoshop').messaging.sendSDKPluginMessage(componentId, messageContent)` 与 C++ 端通信。C++ 端通过 `PsUXPSuite1::AddUXPMessageListener()` 接收消息，使用 `PIUXPMessageNotifier` 回调。消息负载是使用 PICA 套件构建的 `PIActionDescriptor` 对象。
- **版本桥接**：当同时面向较旧（ExtendScript）和现代（UXP v5+）层面时，维护单独的入口脚本，这些脚本共享由两个环境解析的相同 `.jsxinc` 文件中的业务逻辑。UXP 的 DOM 覆盖范围逐版本扩展——在假设某个 DOM 方法存在之前，始终对照目标 `minVersion` 验证 API 可用性。

## 版本兼容性

| 层面 | PS 2022 (v23) | PS 2023 (v24) | PS 2024 (v25) | PS 2025 (v26) | PS 2026 (v27) |
|---------------|:---:|:---:|:---:|:---:|:---:|
| ExtendScript  | ✓   | ✓   | ✓   | ✓   | ✓   |
| UXP (manifest v4, apiVersion 2) | ✓   | ✓   | ✓   | ✓   | ✓   |
| UXP (manifest v5, permissions model) | ✓ (v23.3+) | ✓   | ✓   | ✓   | ✓   |
| UXP (manifest v6) | — | — | ✓   | ✓   | ✓   |
| UXP (batchPlay) | ✓   | ✓   | ✓   | ✓   | ✓   |
| C++ SDK (PIUXPSuite v1) | ✓ (v23.3+) | ✓   | ✓   | ✓   | ✓   |
| C++ SDK (filter/automation) | ✓   | ✓   | ✓   | ✓   | ✓   |
