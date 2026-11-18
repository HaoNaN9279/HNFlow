---
name: libraries
description: 需要事件总线、日志与调试、JSON 序列化、随机数或定点数时读取：各自的入口、序列化限制与常见误用。
on_demand: true
priority: 30
---

# 通用工具库

## 事件总线

```csharp
world.EventBus.Subscribe<EntitySpawnedEvent>(OnEntitySpawned);
world.EventBus.Publish(new EntitySpawnedEvent(...));
world.EventBus.Unsubscribe<EntitySpawnedEvent>(OnEntitySpawned);
```

- 同步派发：`Publish` 返回时所有订阅者已执行完毕。
- 订阅者抛异常会被吞掉，不影响其他订阅者，也不回报调用方——关键逻辑自己 try/catch。
- 没有队列、优先级、弱引用、粘性事件。需要延迟派发就自己在 `Tick` 里发。
- 必须成对退订；对象销毁时不退订会导致后续调用打到已销毁对象上。
- 高频事件（每帧位置同步之类）不要走事件总线，直接调用。

## 日志与调试

- 日志统一走 `LogProvider`（Driver 注入 `UnityLogProvider`），不要在框架代码里散落 `Debug.Log`。
- `world.DebugHub.Log(...)` 进的是内存环形缓冲（100 条），**不会**写进 LogProvider；排查现场用它，正式日志用 LogProvider。
- `DebugHub.RegisterCommand` 注册控制台命令，同名静默覆盖——重名时后者生效，不报错。
- 运行时控制台 `RuntimeDebugConsole` 需要场景里有 UGUI Canvas 和 TextMeshPro，反引号呼出。

## 序列化

- `Json.Serialize` / `Json.Deserialize` 只认 **public 实例字段**：不支持属性、不支持私有字段；枚举按 int 存。
- 需要属性序列化时用 Newtonsoft（框架已依赖）。
- `JsonData` 必须以 `JsonObject` 为基类，否则不入结构。
- `MemoryPackSerializer` 要求类型标 `[MemoryPackable]`，且生成器已跑过；不标会运行时抛异常。
- 字典类（`HNDictionary` / `SerializableDictionary`）要能被 Inspector 序列化，必须标 `[Serializable]`。

## 随机与定点

- `HNRandom` 非线程安全；异步任务、多线程里各用各的实例。
- `HNFixedPoint` 只包装 `Fixed64`，没有算术运算封装——需要定点数学时直接用 FixedMathSharp。

## 时间

- `HNLogicTime.Time` / `DeltaTime` / `LogicFrameCount` 只读，由 `LockstepManager` 推进。
- 表现层动画、UI 动效用 `Time.deltaTime`，不要用逻辑帧时间做插值。
