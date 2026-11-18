---
name: entry
description: 框架接入与启动骨架：GameWorldDriver 装配链、逻辑帧来源、程序集边界、必装依赖、模块实现状态表。
priority: 10
---

# 框架入口与运行骨架

本项目使用 HNUnityFramework（`com.hn.framework`，Unity 2022.3+，C# .NET Standard 2.1）。所有代码在框架既有骨架上扩展，不要另起一套入口、事件总线或模块管理。

## 启动链

```text
场景挂 GameEntry（继承 GameWorldDriver）
  → Awake：Driver 内部 new GameWorld，注入 Log/Asset/Input/UI/Locale/Physics/FrameSync/Camera
  → 重写的 OnRegisterGameModules(GameWorld world)
  → world.Initialize()
  → Update → world.Tick()；LateUpdate → world.LateTick()
```

- `GameWorld` 是普通 C# 类，**绝不**自行 `new`，也不要把它做成单例；唯一入口是 `GameWorldDriver.World`。
- `OnRegisterGameModules` 里注册流程、控制器、池等自定义模块；此时 `World` 已注入内置模块但尚未 `Initialize()`。
- `Awake` 之前、`OnRegisterGameModules` 之前不要访问 `World`。
- 重写 `OnRegisterGameModules` 后必须调用基类实现，否则内置模块注入链断裂。

## 生命周期接口

- `Initialize()`：一次性初始化，`world.Initialize()` 只调用 `ProcedureManager` 与 `ControllerManager`，其余模块自行处理。
- `Tick()` / `LateTick()`：每帧两次遍历，顺序固定（FrameSync → Pool → Procedure → Controller → AI → AnimationLogic → Asset → Input → UI → Physics → Cutscene → Quest）。
- `Driver.OnDestroy` 不关闭流程与对象池；需要清理的内容在 `OnDestroy` 或退出流程里自行处理。

## 逻辑帧

- `HNLogicTime.Time` / `DeltaTime` / `LogicFrameCount` 只读，唯一推进者是 `LockstepManager`（默认 15 Hz）。
- 不要自己写累加器伪造逻辑帧；需要固定步长时用 `FrameSyncManager`。
- 全局设置里的 `LogicRate` / `MaxStepsPerFrame` / `MaxFrameTime` 当前没有运行时消费者，改了不生效。

## 程序集边界

```text
HN.Framework.Core   纯 C#，noEngineReferences，禁止出现 UnityEngine 引用
   ↑
HN.Framework.Unity  MonoBehaviour、Addressables、Cinemachine、Input System、FishNet
   ↑
HN.Framework.Editor 仅编辑器，UnityEditor
```

- 项目代码按用途建 asmdef：运行时程序集引用 `HN.Framework.Core` 与 `HN.Framework.Unity`；编辑器程序集额外引用 `HN.Framework.Editor`。
- 不修改框架自身的 asmdef 与命名空间。
- 需要引擎类型（`Vector3`、`Transform`、`ScriptableObject`）的代码只能落在引用 `HN.Framework.Unity` 的程序集里。

## 必装依赖

Addressables、Cinemachine、Input System、Timeline、TextMeshPro、Newtonsoft Json、HybridCLR（`com.code-philosophy.hybridclr`）。

HybridCLR 缺失会导致编辑器程序集整体编译失败——不是可选包。

## 模块状态表

任务开始前按此表判断能力是否可用；标「部分」的先看 `module-check` 技能里的替代路线。

| 状态 | 模块 |
|---|---|
| 完整可用 | 流程 Procedure、对象池、引用池、事件总线、调试、本地化、UI、输入、相机（场景需 CinemachineBrain）、HFSM、GameplayTag、图数据、配置表、动画核心 |
| 部分可用 | 资源管理、存储、脚本热更、MVC、实体、战斗、任务、背包、构建管线、物理（需手动 `Step`） |
| 未实现 | 音频运行时（只有设置资产）、场景流送、时间天气、安全、性能监控 |

过场管理器不会被 Driver 注入，使用时自行构造并赋给 `world.CutsceneManager`。

## 禁止项

- 不新增第二套入口类、事件总线、资源管理器、对象池。
- 不在业务代码里写 `Resources.Load` 或 `AssetDatabase.LoadAssetAtPath` 直连（编辑器工具除外）。
- 不把 `Vendor/` 下的三方库（MemoryPack、FixedMathSharp、FishNet、LitMotion、XLua）当框架 API 使用时的替身——用它们各自的官方用法。
