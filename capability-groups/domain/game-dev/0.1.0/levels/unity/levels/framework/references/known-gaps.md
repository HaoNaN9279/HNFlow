# 已知缺口与文档偏差

截至框架 v1.0.0 的核实结果。写代码前先看这里，避免按文档实现后发现功能不存在。

## 未实现

| 模块 | 现状 | 依据 |
|---|---|---|
| 音频 | 只有 `Runtime/HN.Framework.Unity/Capability/Audio/Settings/AudioSettings.cs`，无接口、无管理器、`GameWorld` 无属性 | 全仓 grep `IAudioManager` / `AudioManager` 零命中 |
| 场景流送 (C19) | 无源码目录 | grep `SceneStreaming` 零命中 |
| 时间天气 (C20) | 无源码目录 | grep `TimeWeather` 零命中 |
| 安全 (C18) | 无源码目录 | grep `ISecurity` 零命中 |
| 性能 (C21) | 无源码目录 | grep `PerformanceMonitor` 零命中 |

## 半实现

| 模块 | 缺口 |
|---|---|
| 资源 `IAssetManager` | 全部加载方法返回 void，**没有取回资源的 API**；真正的释放延迟 30 秒 |
| `AddressablesOperator.LoadAsset` | 打包后直接 `Debug.LogError("AddressablesOperator does not support synchronous loading.")` 并返回 null，只有 `LoadAssetAsync<T>` 可用 |
| `AssetManager.LoadSceneGroup` | `m_LoadRecords` 的 `SceneLabels` 从未写入，过滤后恒为 0 条，静默返回 |
| 存储 | 只有 `IStorageProvider` 接口，无默认实现 |
| 物理 | `PhysXWorld.Step()` 空实现，需要自己驱动；`PhysicsVector3` 与 `Vector3` 无隐式转换，转换工具为 internal |
| MVC | 单元须实现全部五个方法；`PropertyBinder` 只有抽象 |
| 实体 | `EntityManager` 不建视图，`CreateView` 传 `entityId=0`，视图工厂接线缺失 |
| 战斗 | `RemoveBuff` 不回滚已生效属性；`AbilitySystem` 缺标签门禁；`RewardProcessor` 恒返回 Success |
| 任务 | `ClaimQuest` 先发奖后校验，重复领取会重复发奖；`MultiCounter` 未实现 |
| 背包 | 堆叠不读 `MaxStack`；装备 Buff 是 TODO；`ItemRemovedEvent.ItemDefId` 恒为 0 |
| 构建 | `BuildReportGenerator` / `VersionManager` 是死代码，`Build Reports` 窗口永远空 |
| 动画 | 混合空间无专门类型；`InertializationBlender` 无人引用；Facial 无运行时；Skeleton2D 只取 X 轴 |
| 固定点 | `HNFixedPoint` 只包装 `Fixed64`，无算术运算 |
| 热更 | `HybridCLRAdapter` 与 `LuaModManager` 均需项目自建；网络预测无 Unity 传输适配 |

## 文档与代码不一致

| 文档说法 | 实际 |
|---|---|
| `ObjectPoolManager.Initialize()` 静态调用（`docs/dev/code-standard.md`） | 已改为 `world.PoolManager` 实例 |
| quick-start 的 `CreateObjectPool<MyObjectPool>("MyPool")` | 参数是 `PoolSettings`，不是字符串 |
| `reference-pool.md` 称 16 种池化集合 | 实际 13 种 |
| `core.md` 称固定步长由 `GameWorld` 管理 | 逻辑帧由 `LockstepManager` 推进 |
| guide 提到 `ObjectPoolViewer` 组件 | 该组件不存在 |
| guide 提到 `HNDictionaryDrawer` | 实际是 `SerializableDictionaryDrawer` |
| `guide/index.md` 标 EventBus / Entity / ViewFactory 为 Stub | 三者在源码中均已实现（ViewFactory 仍有接线缺口） |
| 全局设置 `LogicRate` / `MaxStepsPerFrame` / `MaxFrameTime` | 定义存在，无运行时消费者 |

## 使用方式

- 遇到上表模块，先按「半实现」处理：确认缺哪一段，再决定是补项目侧代码还是绕开。
- 文档偏差类问题以源码为准，不按文档改代码。
- 新发现缺口写回本文件，写明源码路径与复现方式。
