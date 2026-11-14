---
name: maya
---

# Autodesk Maya DCC 开发规则

用于 AI 辅助 Autodesk Maya 工具和插件开发的 Python 和 C++ 规则。在所有 Maya 脚本项目中遵循这些规则。

## 项目结构

- 将 Maya 脚本放在 Maya 脚本目录 (`~/maya/<version>/scripts/`) 或自定义的 `MAYA_SCRIPT_PATH` 下，以实现版本控制开发。
- 将工具组织为 Maya 模块（`.mod` 文件），包含 `scripts/`、`plug-ins/`、`icons/` 和 `presets/` 子目录。
- 使用 `userSetup.py` 进行会话初始化，仅在需要 MEL 独占 API 时才使用 `userSetup.mel`。
- 将 UI 代码（PySide2/PySide6 或 PyMel UI 命令）与核心逻辑分离；绝不将 Maya API 调用直接耦合到小部件回调中。
- 为自定义节点和命令添加项目特定的命名空间前缀，以避免与其他工具冲突。

## Python 编码规范

- 以 Python 3.9+（Maya 2022+）或 Python 3.7+（Maya 2020-2021）为目标；在使用更新的 Python 功能之前检查目标 Maya 版本。
- 所有新的 C++ API 包装器优先使用 `maya.api.OpenMaya`（OpenMaya 2.0）而非 `maya.OpenMaya`（OpenMaya 1.0），它返回 Python 对象而非 MScriptUtil 值。
- 使用 `cmds` 进行高层场景操作，使用 `pymel` 进行面向对象的工作流，使用 `OpenMaya` 进行性能关键的低层操作。
- 始终将 `cmds.file()` 操作包装在 try-except 块中；文件操作是未处理 Maya 异常的最常见来源。
- 使用 `contextlib.contextmanager` 创建具有自动清理功能的撤销块；将 `cmds.undoInfo(openChunk=True)` 与调用 `cmds.undoInfo(closeChunk=True)` 的 `finally` 子句配对使用。

## API 使用模式

- 使用 `maya.api.OpenMaya.MFnDependencyNode` 和相关 `MFn*` 函数集进行 C++ API 级别的节点操作；这些在批量操作中比 `cmds` 更快。
- 使用 `cmds.evalDeferred()` 将 UI 或场景操作延迟到下一个空闲事件；这对于避免场景构建期间的 "Object does not exist" 错误至关重要。
- 原型设计时优先使用 `pymel.core.PyNode` 进行便捷的字符串到节点解析；在生产代码中切换到 `OpenMaya.MObject` 句柄以保持稳定性。
- 使用 `maya.api.OpenMaya.MDGModifier` 以编程方式构建依赖图连接；它避免了重复调用 `cmds.connectAttr()` 的开销。
- 利用 `cmds.scriptJob()` 进行事件驱动的回调；始终存储任务 ID 并在工具关闭时终止它，以防止僵尸回调。

## 性能

- 批量操作：使用 `cmds.select()` 加多对象命令，而非循环遍历单个对象操作。
- 使用 `maya.api.OpenMaya.MItMeshVertex` / `MItMeshPolygon` 迭代器，而非在循环中逐组件调用 `cmds.getAttr()`。
- 在性能关键的代码中避免使用 `cmds.refresh()`；仅在视口必须在继续执行前更新时才调用它。
- 对于繁重的网格或动画处理，在 C++ 插件（`MPxNode` 或 `MPxCommand`）中完成工作；Python 在密集数据处理中慢 10-100 倍。
- 使用 `maya.mel.eval("timerX")` 或在关键代码路径上使用 `cProfile` 进行性能分析；Maya 的 `dgtimer` 不适用于细粒度测量。

## 常见陷阱

- Maya 的撤销系统会在新建/打开/导入场景时刷新；绝不要让撤销块跨越文件操作保持打开状态。
- `cmds.select()` 会更改全局选择状态；使用 `cmds.ls(selection=True)` 包装在 try-finally 中保存和恢复选择。
- `cmds.listRelatives()` 和 `cmds.listConnections()` 在没有结果时返回 `None`；在迭代之前始终检查 `None`。
- DAG 路径与依赖节点名称：同一个节点如果被实例化，可能拥有多个 DAG 路径；使用 `MFnDagNode.getPath()` 枚举所有路径。
- MEL 和 Python 的命名空间作用域不同；无论 Python 的命名空间如何，MEL 命令都在全局 MEL 作用域中运行。
- `cmds.confirmDialog()` 会阻塞主线程；使用 `cmds.layoutDialog()` 或 PySide 对话框实现非阻塞 UI。

## 测试

- 使用 `pytest` 配合 `maya-standalone` Python 解释器进行无头测试；通过 `mayapy -m pytest tests/` 调用。
- 对纯逻辑组件的单元测试使用 `unittest.mock` 模拟 Maya 依赖项；集成测试应针对真实的 Maya 会话运行。
- 将工具注册和注销作为单独的测试用例进行测试，以捕获泄漏的回调和孤立 UI 元素。
- 在测试夹具中使用通过 `cmds.file(new=True, force=True)` 创建的临时场景；测试后绝不让 Maya 会话处于脏状态。

## UI 开发

- 对所有工具 UI 使用 PySide2（Maya 2017-2024）或 PySide6（Maya 2025+）；避免对复杂 UI 使用 `cmds.window()` / `cmds.columnLayout()`。
- 子类化 `QWidget` 或 `QDialog`，并使用 `maya.OpenMayaUI.MQtUtil.mainWindow()` 包装 Maya 主窗口，以实现正确的父子窗口管理。
- 对可停靠工具窗口使用 Maya 的 `workspaceControl`（Maya 2017+）；仅在遗留兼容性需要时回退到 `cmds.window()`。
- 使用 Maya 内部样式表类而非硬编码颜色来设置工具 UI 样式；使用 `cmds.themeColor()` 查询当前主题颜色。
