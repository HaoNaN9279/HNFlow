# 框架 API 索引

路径均相对框架仓库根（`com.hn.framework` 包目录）。`Core` = `Runtime/HN.Framework.Core`，`Unity` = `Runtime/HN.Framework.Unity`，`Editor` = `Runtime/HN.Framework.Editor`（编辑器源码在 `Editor/`）。

## 运行骨架

| 类型 | 路径 | 要点 |
|---|---|---|
| `GameWorld` | `Core/Driver/GameWorld/GameWorld.cs` | 模块容器，由 Driver 创建；`Initialize/Tick/LateTick` |
| `GameWorldDriver` | `Unity/Driver/Platform/GameWorldDriver.cs` | MonoBehaviour 入口；`OnRegisterGameModules` |
| `HNLogicTime` | `Core/Driver/Common/HNLogicTime.cs` | 逻辑时间只读，由 `LockstepManager` 推进 |
| `ITickable` / `IReference` | `Core/Driver/Common/Interfaces/` | 逐帧更新与池化对象契约 |

## 通用能力

| 类型 | 路径 | 要点 |
|---|---|---|
| `IAssetManager` / `AssetManager` | `Core/Capability/Asset/`、`Unity/Capability/Asset/` | 加载返回 void，取资源走 Addressables |
| `IAssetOperator` / `AddressablesOperator` | `Unity/Capability/Asset/` | 打包后同步加载直接报错 |
| `LocaleManager` | `Unity/Capability/Localization/` | `GetString` / `SetLocale`（async void） |
| `IInputManager` | `Core/Capability/Input/` | 需替换 Driver 注入的空资产 |
| `UIManager` | `Core/Capability/UI/`、`Unity/Level/View/UI/` | 七层 Canvas，`PushAsync` / `ShowDialog` |
| `ICameraManager` | `Core/Capability/Camera/` | 需场景有 CinemachineBrain |
| `IPhysicsWorld` | `Core/Capability/Physics/`、`Unity/Capability/Physics/` | `Step()` 空实现，需自己驱动 |
| `ICutsceneManager` | `Core/Capability/Cutscene/` | Driver 不注入 |
| `IScriptEngine` | `Core/Capability/Scripting/` | Lua / HybridCLR 适配器由项目自建 |

## 运行期基础设施

| 类型 | 路径 |
|---|---|
| `ProcedureManager` / `ProcedureState` | `Core/Capability/Procedure/` |
| `Controller` / `Model` / `ControllerManager` | `Core/Level/Logic/MVC/` |
| `ObjectPoolManager` / `ObjectPool<T>` | `Core/Driver/Common/Pool/` |
| `GameObjectPool` | `Unity/Driver/Platform/ObjectPool/` |
| `ReferencePool` | `Core/Driver/Common/Pool/ReferencePool*` |
| `EventBus` | `Core/Capability/Event/` |
| `DebugHub` | `Core/Capability/Debug/` |
| `HNRandom` / `HNFixedPoint` | `Core/Driver/Common/Math/` |
| `Json` / `JsonData` / `MemoryPackSerializer` | `Core/Driver/Common/Serialization/`、`Unity/Driver/Platform/Serialization/` |

## 设置资产与菜单

- 运行时设置：`Assets/Project/RuntimeAssets/Core/*.asset`（Global、AI、Asset、Audio、Cutscene、Localization、Network、UI）。
- 设置页：`Project Settings` 下 10 个 `[SettingsProvider]` 页面，代码在 `Editor/*/SettingsProvider`。
- 构建设置：`Assets/Editor/BuildPipeline/Settings/BuildPipelineSettings.asset`。
- HybridCLR：`Assets/Project/EditorAssets/HybridCLRSettings.asset`。

## 包信息

`package.json`：`com.hn.framework` v1.0.0，Unity 2022.3，MIT。

依赖版本：Addressables 1.22.3、Cinemachine 2.10.7、Input System 1.11.2、Timeline 1.7.6、TMP 3.0.9、Newtonsoft 3.2.1、Test Framework 1.1.33、Burst 1.8.18、Collections 2.1.4、Mathematics 1.3.2。

## Vendor 目录

`Runtime/HN.Framework.Core/Vendor`（MemoryPack、FixedMathSharp）与 `Runtime/HN.Framework.Unity/Vendor`（FishNet、LitMotion、XLua）是三方源码，不是框架 API；问题按各自官方文档处理，不改它们的代码。
