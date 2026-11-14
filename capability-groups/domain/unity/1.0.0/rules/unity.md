---
name: unity
description: Unity 项目全局规则：工程结构与开发约定。
---

# unity 项目全局规则

这些规则适用于任何 unity 项目。

## 参考文档

### unity 文档

遇到不清楚的 unity 机制，优先查询文档，不要随意猜测。
默认使用 unity 2022.3 版本，如果使用其他版本的 unity 切换到对应版本的文档：
- unity 手册地址：https://docs.unity3d.com/2022.3/Documentation/Manual/index.html
- unity API文档地址：https://docs.unity3d.com/2022.3/Documentation/ScriptReference/index.html
- unity cs reference：https://github.com/Unity-Technologies/UnityCsReference/tree/2022.3

## MCP 工具使用

- 当当前unity项目没有安装mcp时，提醒用户安装，地址：https://github.com/CoplayDev/unity-mcp/tree/main。
- 任何 unity 中的操作**优先**使用 unity MCP ，如果该 MCP 工具无法实现，则先向用户汇报，再尝试其他方法。
- 需要对修改进行测试时，使用 unity MCP 工具来触发编译、调用Editor工具、读取Console信息来实现测试循环。
- 修改Assets目录下的代码文件时，可以使用任意外部工具，如bash等，但是**绝对禁止**使用外部工具直接修改代码文件名、类名等。
- 任何创建移动删除unity资源的操作，都通过 MCP 在unity内操作，不得使用bash命令直接在目录文件夹下操作。
- **绝对禁止**通过bash命令直接复制unity项目内的任何资源及其meta文件，会造成冲突。
- **绝对禁止**自行关闭unity进程，如果有需要，向用户提需求。
- **绝对禁止**私自下载任何插件或克隆任何项目，如果有需要，向用户提需求。
- 同一个unity实例，同一时间只允许一个任务通过MCP工具访问和操作，**绝对禁止**多个任务对同一个unity实例通过MCP工具访问和操作，会造成冲突。
- 任何时刻都**不允许**使用 `reimport all` 命令重新导入全部资源，如果必须使用，则请求用户手动操作。
