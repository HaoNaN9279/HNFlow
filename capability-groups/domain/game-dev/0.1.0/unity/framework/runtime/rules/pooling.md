---
name: pooling
description: 对象池与引用池的创建、取还、容量设置、场景切换清理，以及重复释放等常见错误。
priority: 20
---

# 对象池与引用池

高频创建的对象走池。框架有两套：`ObjectPoolManager` 管业务对象池（含 GameObject 池），`ReferencePool` 管引用池。

## 业务对象池

```csharp
var settings = PoolSettings.Default("BulletPool");
world.PoolManager.CreateObjectPool<BulletPool>(settings);
var pool = world.PoolManager.GetObjectPool("BulletPool");
var bullet = pool.Acquire();
pool.Release(bullet);
```

- 池类型必须继承 `ObjectPool<T>` 并实现 `Spawn` / `Despawn`（abstract，不实现编译不过）。
- 池名全局唯一，重名 `CreateObjectPool` 抛异常；先 `GetObjectPool` 判断或复用。
- `Release` 同一个对象两次抛异常；`Acquire` 拿到的对象由池负责复位，不要在业务里再 `new`。
- `RemoveObjectPool(name)` 移除单个池，`ClearAll()` 清空全部。场景切换时清掉不再需要的池。

## GameObject 池

```csharp
var settings = new GameObjectPoolSettings
{
    BaseSettings = PoolSettings.Default("EnemyPool"),
    ManagerRoot = poolRoot,      // 池节点挂载点
    Prototype = enemyPrefab,     // 必须设置
};
var pool = new GameObjectPool();
pool.Initialize(settings);

var go = pool.Acquire(parent);
pool.Release(go);
```

- `Prototype` 忘设置时 `Acquire` 静默返回 `null`，不报错——这是最常见的坑。
- `ManagerRoot` 用来把池节点收进一个父节点，避免场景层级爆炸；不设则散落在场景根。
- `Release` 之后不要再持有该实例，池会回收并复用。

## 引用池

```csharp
var data = ReferencePool.Acquire<BattleData>();
ReferencePool.Release(data);
```

- `ReferencePool` 是静态全局池，跨场景存活。切场景、重开一局必须 `ReferencePool.ClearAll()`，否则旧数据会带进新局。
- 入池类型必须实现 `IReference` 且有无参构造函数。
- `IReference.Clear()` 要把所有字段复位，漏字段会导致下一局读到上一局的残留值。
- `Add<T>(int)` / `Remove<T>(int)` 预热或收缩容量，只在加载阶段调用。
- 流程状态、控制器、数据模型都由引用池创建，业务代码不要自己 `new` 这些类型。

## 检查清单

- [ ] 池名唯一，重复创建前先判断
- [ ] `ObjectPool<T>` 的 `Spawn`/`Despawn` 已实现
- [ ] GameObject 池设置了 `Prototype`
- [ ] `Release` 只调用一次
- [ ] 场景切换时清理池与引用池
- [ ] `IReference.Clear()` 覆盖全部字段
