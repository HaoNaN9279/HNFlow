---
name: blender
---

# Blender DCC 开发规则

用于 AI 辅助 Blender 插件和工具开发的 Python 规则。在所有 Blender 脚本项目中遵循这些规则。

## 项目结构

- 开发时将插件放在 Blender 插件目录 (`~/.config/blender/<version>/scripts/addons/`) 下；使用符号链接指向你的源代码仓库。
- 以 `__init__.py` 作为入口点组织插件目录，包含 `bl_info` 字典、`register()` 和 `unregister()` 函数。
- 分离关注点：`operators.py` 用于 `bpy.types.Operator` 子类，`panels.py` 用于 `bpy.types.Panel`，`properties.py` 用于 `bpy.types.PropertyGroup`，`utils.py` 用于共享辅助函数。
- 将 UI 布局逻辑放在专用函数中；绝不将操作符执行逻辑与面板绘制混在一起。
- 使用语义化版本在 `bl_info["version"]` 中标记插件版本，并为预发布或实验性插件添加 `bl_info["warning"]` 字段。

## Python 编码规范

- 以 Blender 自带的 Python 版本为目标（检查 `bpy.app.version`）；力求兼容最近 2 个主要 Blender 版本。
- 所有 UI 暴露的属性优先使用 `bpy.props`：`StringProperty`、`FloatProperty`、`IntProperty`、`BoolProperty`、`EnumProperty`、`PointerProperty`、`CollectionProperty`。
- 使用基于 `Annotation` 的属性声明（类级别的 `:` 语法），而非旧式的 `=` 赋值方式。
- 始终在操作符上实现 `poll()` 类方法，以防止无效上下文状态；除非满足操作符的前置条件，否则返回 `False`。
- 对 `poll()` 使用 `@classmethod`，且内部绝不引用 `self`。
- 将文件 I/O 操作包装在 try-except 块中，并通过 `self.report({'ERROR'}, message)` 报告错误。

## API 使用模式

- 在操作符和面板中通过 `context.scene` 访问场景数据；绝不直接使用 `bpy.context.scene`，始终使用上下文参数。
- 使用 `bpy.data` 创建/访问数据块（`bpy.data.objects.new()`、`bpy.data.meshes.new()` 等）。
- 类型引用优先使用 `bpy.types`（`bpy.types.Object`、`bpy.types.Mesh`），而非基于字符串的查找。
- 使用 `bpy.ops` 调用内置操作符；当操作符需要特定上下文时，通过 `context_override` 字典传递上下文覆盖。
- 使用 `bpy.ops.ed.undo_push()` 收集撤销步骤，或仅在用户期望手动撤销分组时将操作包装在 `context.temp_override()` 和 `bpy.ops.ed.undo` 中。
- 对事件驱动的逻辑使用 `@persistent` 装饰的处理函数（`bpy.app.handlers.load_post`、`save_pre`、`depsgraph_update_post`），并在 `unregister()` 中取消注册。

## 性能

- 避免在紧循环中遍历 `bpy.data.objects` 或 `bpy.data.meshes`；缓存频繁访问的数据块引用。
- 对网格数据进行大量数值计算时使用 `numpy`（Blender 自带 numpy）；通过 `mesh.vertices[i].co` 进行单个访问，或使用 `foreach_get`/`foreach_set` 进行批量操作。
- 谨慎使用 `bpy.types.Mesh.validate()`，它开销很大；仅在破坏性拓扑更改后调用。
- 批量更新网格：使用 `mesh.vertices.foreach_set("co", flat_array)` 修改网格数据，而非逐顶点赋值 `.co`。
- 通过 `bpy.app.handlers.load_post` 检测来分析插件启动时间；最小化 `register()` 期间的工作。

## 常见陷阱

- Blender 的 API 不是线程安全的；所有 `bpy` 操作必须在主线程上执行。使用 `ApplicationTimer` 或 `bpy.app.timers` 进行延迟执行，而非线程。
- 使用 `bpy.utils.register_class()` 注册的属性在同一会话中无法在不重启 Blender 的情况下取消注册；始终使用 `--factory-startup` 标志测试干净状态。
- `context.active_object` 可能为 `None`；在访问其属性之前始终进行检查。
- `bpy.ops` 可能静默失败或更改上下文状态；在结果不确定时，将操作符调用放在 try-except 块中。
- 撤销系统：Blender 的撤销跟踪数据块的更改；创建/销毁数千个数据块可能使撤销变得极其缓慢。尽可能批量操作。
- `bpy.types.Panel.bl_space_type` 和 `bl_region_type` 必须匹配有效的组合；请查阅 Blender Python API 文档了解有效的配对。

## 测试

- 使用 `pytest` 配合 `pytest-blender` 插件对无头 Blender 实例进行自动化插件测试。
- 为不依赖 `bpy` 的工具函数编写单元测试；通过构建模拟上下文来测试操作符逻辑。
- 测试插件注册 (`register()`/`unregister()`) 以尽早捕获导入错误和属性冲突问题。
- 在测试夹具中以编程方式使用 `addon_utils.enable()` 和 `addon_utils.disable()` 来干净地加载/卸载插件。

## 导出与互操作性

- 对文件导出操作符使用带有 `filepath` 的 `StringProperty(subtype='FILE_PATH')` 的 `bpy.types.Operator`。
- 编写导出器时，使用 `bpy.ops.object.convert()` 或通过 `bpy.types.Mesh` 计算方法三角化网格并应用修改器。
- 在写入需要特定单位的文件格式之前，通过 `bpy.utils.units.to_value()` 进行单位换算，以尊重场景的单位系统。
