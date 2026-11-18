# 运行期 API 速查

路径相对框架仓库根。

## 流程

| 成员 | 签名 | 说明 |
|---|---|---|
| `ProcedureManager.AddState<T>` | `T AddState<T>(string name) where T : ProcedureState` | 返回实例；重名抛异常 |
| `ProcedureManager.Start` | `void Start(string name)` | 无当前状态时用 |
| `ProcedureManager.ChangeState` | `void ChangeState(string name)` / `void ChangeState<T>()` | 切换中被忽略 |
| `ProcedureManager.Shutdown` | `void Shutdown()` | 退出当前状态 |
| `ProcedureManager.ClearAll` | `void ClearAll()` | 清空注册表 |
| `ProcedureManager.CurrentStateName` | `string` | 当前状态名 |
| `ProcedureState` | `Enter/Tick/LateTick/Exit` | 事件，不可 override |

源码：`Runtime/HN.Framework.Core/Capability/Procedure/`

## MVC

| 成员 | 说明 |
|---|---|
| `ControllerManager.RegisterController` / `UnregisterController` | 控制器注册与注销 |
| `ControllerManager.AddUnit` / `RemoveUnit` | 数据单元挂载 |
| `Model.Value` / `SetValue(T)` / `OnValueChanged` | 数据读写与变更通知 |
| `ReadOnlyModel<T>` | 对外只读视图 |
| `ControllerUnit` / `ModelUnit` | 五个方法必须全部实现 |

源码：`Runtime/HN.Framework.Core/Level/Logic/MVC/`

## 池

| 成员 | 签名 |
|---|---|
| `ObjectPoolManager.CreateObjectPool<T>` | `T CreateObjectPool<T>(PoolSettings settings)` |
| `ObjectPoolManager.GetObjectPool` | `IObjectPool GetObjectPool(string name)` |
| `ObjectPoolManager.RemoveObjectPool` | `void RemoveObjectPool(string name)` |
| `ObjectPoolManager.ClearAll` | `void ClearAll()` |
| `ObjectPool<T>.Acquire` / `Release` | `T Acquire()` / `void Release(T item)` |
| `PoolSettings.Default` | `static PoolSettings Default(string name)` |
| `GameObjectPool.Acquire` / `Release` | `GameObject Acquire(GameObject parent = null)` / `void Release(GameObject go)` |
| `ReferencePool.Acquire<T>` / `Release` | `static T Acquire<T>() where T : IReference, new()` / `static void Release(IReference)` |
| `ReferencePool.Add<T>` / `Remove<T>` / `ClearAll` | 预热、收缩、清空 |

源码：`Runtime/HN.Framework.Core/Driver/Common/Pool/`、`Runtime/HN.Framework.Unity/Driver/Platform/ObjectPool/`

## 事件、日志、序列化

| 成员 | 说明 |
|---|---|
| `EventBus.Subscribe<T>` / `Unsubscribe<T>` / `Publish<T>` | 同步派发，异常被吞 |
| `DebugHub.Log` / `RegisterCommand` / `ExecuteCommand` | 内存环形缓冲 100 条 |
| `Json.Serialize` / `Deserialize` | 只认 public 实例字段 |
| `MemoryPackSerializer` | 需 `[MemoryPackable]` |
| `HNRandom` / `HNFixedPoint` | 随机数、定点包装（无算术） |

## 物理

| 成员 | 说明 |
|---|---|
| `IPhysicsWorld.CreateBody` / `DestroyBody` | 刚体创建销毁 |
| `IPhysicsWorld.Raycast` / `OverlapSphere` / `OverlapBox` | 查询 |
| `IPhysicsWorld.Step` | 默认空实现，需自己驱动 |
| `PhysicsVector3` | 与 `Vector3` 无隐式转换 |

源码：`Runtime/HN.Framework.Core/Capability/Physics/`、`Runtime/HN.Framework.Unity/Capability/Physics/`
