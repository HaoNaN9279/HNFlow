# 网络与热更 API 速查

路径相对框架仓库根。

## 帧同步

| 类型 | 路径 | 说明 |
|---|---|---|
| `LockstepManager` | `Runtime/HN.Framework.Core/Capability/Network/` | 默认 15 Hz、缓冲 3 帧 |
| `FishNetMessageBus` | `Runtime/HN.Framework.Unity/Capability/Network/` | 消息总线 |
| `LockstepNetworkDriver` | `Runtime/HN.Framework.Unity/Capability/Network/` | 锁步驱动 |
| `FrameSyncManager` | `GameWorld.FrameSyncManager` | Driver 在 `InitializeFrameSync()` 创建 |
| `HNLogicTime` | `Runtime/HN.Framework.Core/Driver/Common/HNLogicTime.cs` | 逻辑时间只读 |

消息类型：`Runtime/HN.Framework.Core/Capability/Network/Messages/`
预测回滚：`Runtime/HN.Framework.Core/Capability/Network/Prediction/`（无 Unity 传输适配）

## 网络设置

`Assets/Project/RuntimeAssets/Core/NetworkSettings.asset`，设置页在 `Project Settings`。

FishNet 源码：`Runtime/HN.Framework.Unity/Vendor/FishNet`，按官方文档使用，不改源码。

## 热更

| 类型 | 成员 | 说明 |
|---|---|---|
| `IScriptEngine` | `Execute` / `RegisterGlobal` / `CallFunction` | 统一脚本接口 |
| `LuaModManager` | ctor `(string? modBasePath)` | `Initialize()` 后可执行 |
| `HybridCLRAdapter` | ctor `(GameWorld)` | `Initialize()` → `InitializeHotUpdate()` |

源码：`Runtime/HN.Framework.Core/Capability/Scripting/`、`Runtime/HN.Framework.Unity/Capability/Scripting/`

HybridCLR 编辑器侧：`Runtime/HN.Framework.Editor/Scripting/`（4 个工具 + Settings）

配置：`Assets/Project/EditorAssets/HybridCLRSettings.asset`
菜单：`Tools/HNUnityFramework/HybridCLR/Generate AOT Metadata`

## 确定性工具

| 工具 | 用途 |
|---|---|
| `HNRandom` | 帧种子随机，替代 `UnityEngine.Random` |
| `FixedMathSharp`（Vendor） | 定点数，替代 `float` 判定 |
| `MemoryPack`（Vendor） | 状态序列化，需 `[MemoryPackable]` |
