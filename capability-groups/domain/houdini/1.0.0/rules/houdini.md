---
name: houdini
---

# SideFX Houdini DCC 开发规则

用于 AI 辅助 Houdini 工具和 HDA 开发的 Python 和 VEX 规则。在所有 Houdini 脚本项目中遵循这些规则。

## 项目结构

- 将 HDA（Houdini Digital Asset）定义存储在 `otls/` 目录或版本控制的 `.hda` 文件中，与你的 Python 工具放在一起。
- 在 `scripts/python/` 下使用包命名空间（例如 `my_studio.houdini.tools`）组织 Python 代码，以避免导入冲突。
- 使用 Houdini 包（`~/houdini<version>/packages/` 中的 `.json` 文件）配置 `HOUDINI_PATH` 条目；绝不硬编码 `houdini.env` 中的路径。
- 按领域分离工具：`scripts/python/tools/` 用于架子工具，`scripts/python/pdg/` 用于 PDG 节点，`scripts/python/hdas/` 用于 HDA Python 模块。
- 将 VEX 代码放在 HDA 内的 `.vfl` 或 `.h` 头文件中；对共享的 VEX 代码使用 `#include` 指令。

## Python 编码规范

- 以 Python 3.9+（Houdini 19.0+）或 Python 3.11+（Houdini 20.5+）为目标；Houdini 自带 Python，因此在导入时检查 `sys.version`。
- 对所有 Houdini 特定操作使用 `hou` 模块；避免在运行中的会话内通过子进程调用 `hscript` 或 `hython`。
- 通过 `hou.node("/path/to/node")` 或 `hou.nodeBySessionId()` 访问节点以获得持久引用；绝不跨场景关闭存储 `hou.Node` 引用。
- 对参数组使用带关键字参数的 `hou.Parm.set()`；这比单独设置各个参数更高效。
- 将长时间运行的操作包装在 `hou.ui.displayMessage()` 或通过 `hou.ui.createProgressBar()` 创建的进度条中，以向用户传达状态。

## API 使用模式

- 使用 `hou.Node.createNode()` 以编程方式创建节点；指定 `node_name` 参数以设置可预测的名称。
- 使用 `node.setInput(index, upstream_node)` 或 `node.setNextInput(upstream_node)` 连接节点以实现链式工作流。
- 使用 `hou.ParmTemplateGroup` 和 `hou.ParmTemplate` 子类以编程方式构建 HDA 参数界面。
- 利用 `hou.PythonPanelInterface` 创建自定义面板，使用 `hou.PyPanel` 将 Python UI 嵌入 Houdini 窗格。
- 使用 `hou.HDAModule` 处理嵌入在 HDA 中的 Python 模块；通过 `hou.session` 或 `hou.hda.definitions()` 导入它们。
- 对于 PDG（程序化依赖图），使用 `pdg.TypeRegistry` 并子类化 `pdg.types.Node` 以创建自定义 PDG 节点类型。

## 性能

- 使用 `hou.Geometry.setPointFloatAttribValues()` 和 `hou.Geometry.setPrimFloatAttribValues()` 进行批量属性设置，而非逐元素迭代。
- 在节点网络内部的几何处理中优先使用 VEX/CVEX 而非 Python；Python 代码片段节点用于胶水逻辑，而非逐点计算。
- 在批量几何修改前后使用 `hou.Geometry.freeze()` 和 `hou.Geometry.unfreeze()`，以在构建期间抑制烹饪事件。
- 使用 `hou.HDAModule` 类级别变量缓存昂贵计算；Houdini 在 HDA 更新时重新加载模块，自动清除过时缓存。
- 通过 `hou.session` 集成的 `cProfile` 对 Python 代码进行性能分析；对于 VEX，使用性能监视器（Windows > Performance Monitor）。

## 常见陷阱

- `hou.Node` 对象在节点被删除或场景关闭后变为无效；在访问方法之前始终调用 `node.isValid()` 或使用 try-except。
- Houdini 的烹饪是惰性的；调用 `node.cook(force=True)` 会强制上游烹饪链。使用 `node.cook()`（不带 force）仅在脏时进行烹饪。
- 使用反引号语法（`` `chs("../other")` ``）的参数表达式在 Hscript 上下文中求值，而非 Python；使用 `hou.parm().eval()` 或 Python 表达式进行现代参数引用。
- `hou.Parm.eval()` 返回当前时间的原始参数值；使用 `hou.Parm.evalAtFrame(float)` 在特定帧求值。
- Python 的 `__file__` 属性在 HDA Python 模块内部不可靠；改用 `hou.session` 模块检查或 `inspect.getfile()`。
- 撤销仅限于 HDA 级别；Python 侧的状态更改（全局变量、文件修改）不受 Houdini 撤销系统的覆盖。

## VEX 和 CVEX

- 在 VEX 代码片段中使用 `@` 语法进行属性绑定（`@P`、`@Cd`、`@myattrib`）；使用 `f@`、`i@`、`v@`、`p@`、`s@` 前缀显式声明类型。
- 保持 VEX Wrangle 小型且专注；将复杂操作拆分到多个 Wrangle 节点中，以实现可维护性和增量烹饪。
- 使用 `setpointattrib()`、`setprimattrib()`、`setdetailattrib()` 写入属性；绝不在运行的 VEX 循环内部使用 `addattrib()`，它会使属性句柄失效。
- 在 VEX 中利用 `while()` 循环配合 `pointlist()` 进行邻居查找；当只需要连接顶点时，避免在热循环中使用 `nearpoints()`。
- 在 VEX 中使用 `chi()` 和 `chf()` 进行通道引用；它们会在 Wrangle 节点上自动创建参数界面。

## 测试

- 使用 `pytest` 配合 `hython` 进行无头 Houdini 测试执行：`hython -m pytest tests/`。
- 对不需要 Houdini 会话的场景，使用 `unittest.mock` 模拟 `hou` API 调用来编写单元测试；集成测试通过 `hou.hipFile.clear()` 创建场景。
- 通过以编程方式实例化 HDA 并使用边界值调用 `.parm().set()` 来测试 HDA 参数验证。
- 对几何输出使用基于快照的测试：对已烹饪节点的顶点位置进行哈希，并与已知正确的哈希值进行比较。

## HDA 开发

- 在类型属性对话框中明确定义 HDA 的操作符表格和标签；使用 `Create/Modify > Digital Asset > New Digital Asset From Selection`。
- 在 HDA 中嵌入 `OnCreated` Python 脚本，以设置默认参数值并创建初始内部节点网络。
- 使用 `hou.HDAOptions` 将保存模式设置为 `HDAOptions.MixedSaveMode`，以便在不重新保存 HDA 二进制文件的情况下迭代 Python 代码（除非节点发生变化）。
- 在 HDA 的 `Version` 字段中使用语义化版本控制对 HDA 进行版本管理；将版本历史以 markdown 格式存储在 HDA 的 `Help` 选项卡中。
