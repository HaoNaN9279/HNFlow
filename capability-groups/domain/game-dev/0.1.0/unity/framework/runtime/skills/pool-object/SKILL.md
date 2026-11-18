---
name: pool-object
description: 当用户要池化高频生成的对象（子弹、特效、UI 项、敌人）、或遇到池取不出对象/重复释放报错时使用：建池、取还、GO 池配置与引用池清理
---

# 池化一个高频对象

## 选择哪一种池

| 对象 | 用哪个 |
|---|---|
| 普通 C# 业务对象 | `ObjectPool<T>` + `ObjectPoolManager` |
| 预制体 / 场景对象 | `GameObjectPool` |
| 短生命周期数据、流程状态、控制器 | `ReferencePool` |
| 集合（List/Dictionary 等） | 框架内置的池化集合类型 |

## 工作流（业务对象）

1. 建池类型：`public sealed class BulletPool : ObjectPool<Bullet>`，实现 `Spawn()` 与 `Despawn(Bullet)`。
2. 定设置：`PoolSettings.Default("BulletPool")`，需要预热时设初始容量。
3. 注册：`world.PoolManager.CreateObjectPool<BulletPool>(settings);`（在 `OnRegisterGameModules` 或流程 `Enter` 里）。
4. 取还：`GetObjectPool("BulletPool").Acquire()` / `.Release(bullet)`。
5. 清理：离开流程时 `RemoveObjectPool("BulletPool")` 或整体 `ClearAll()`。

## 工作流（GameObject）

1. 写 `GameObjectPoolSettings`：`BaseSettings`、`ManagerRoot`、`Prototype`。
2. `new GameObjectPool()` → `Initialize(settings)`。
3. `Acquire(parent)` 取，`Release(go)` 还。
4. 离开场景时把池节点一起销毁，或 `ClearAll()`。

## 常见错误

| 现象 | 原因 | 处理 |
|---|---|---|
| `Acquire` 返回 null | GO 池没设 `Prototype` | 补 `Prototype` |
| 建池抛异常 | 池名重复 | 复用已有池，或先 `RemoveObjectPool` |
| `Release` 抛异常 | 同一对象释放两次 | 释放后把引用置空 |
| 第二局数据残留 | 引用池没 `ClearAll` | 切场景/重开时清 |
| 对象状态错乱 | `IReference.Clear` 漏字段 | 补全复位字段 |

## 验收

- [ ] 连续 Acquire/Release 循环无异常
- [ ] 场景切换后池与引用池已清理
- [ ] 复用对象的状态已被完整复位
- [ ] 池名无重复

## 使用时机

新增高频对象、帧率因实例化抖动、或出现"取不到对象/重复释放"报错时加载。
