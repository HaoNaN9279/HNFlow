---
name: physics
description: 需要射线检测、重叠查询、刚体创建或自定义物理世界时读取：PhysXWorld 初始化、手动 Step、矢量转换与空实现补全。
on_demand: true
priority: 40
---

# 物理世界

框架只提供抽象 `IPhysicsWorld` 与 PhysX 实现，**不替玩家驱动步进**。

## 接入

```text
world.PhysicsWorld   Driver 默认注入 PhysXWorld(PhysicsDimension.D3)
```

- 2D 项目要在 `OnRegisterGameModules` 里替换为 2D 实现；Driver 默认按 3D 注入。
- `IPhysicsWorld.Step()` 在默认实现里是空的，需要在 `Tick` 后自己调用；不调用则射线与重叠查询结果不会更新。

## 接口

| 能力 | 方法 |
|---|---|
| 刚体 | `CreateBody` / `DestroyBody` |
| 查询 | `Raycast` / `OverlapSphere` / `OverlapBox` |
| 步进 | `Step` |

## 矢量转换

`PhysicsVector3` 与 `UnityEngine.Vector3` **没有隐式转换**，转换工具是 internal，项目侧用不可见。写自定义查询或刚体参数时：

- 自己在项目里写一个 `Vector3 ↔ PhysicsVector3` 的扩展方法；
- 或者只使用框架现成的查询方法，不直接操作 `PhysicsVector3`。

## 约定

- 碰撞层用 Unity Layer 常量集中定义，不要在代码里写层号数字。
- 射线检测结果用 `Physics.RaycastNonAlloc` 风格的复用数组时，注意框架的 `Raycast` 已分配好返回结构，不要额外 `new`。
- 刚体创建后必须配对销毁；场景切换前 `DestroyBody` 所有自定义刚体，否则物理世界的句柄表会残留。
- 物理查询结果依赖 `Step` 的调用频率；逻辑帧内多次查询同一帧数据可接受，跨帧不更新是预期行为。

## 常见错误

| 现象 | 原因 |
|---|---|
| 射线永远打不到 | 没有调用 `Step()` |
| 查询结果滞后一帧 | `Step` 在查询之后才调用 |
| `Vector3` 赋值编译失败 | 缺少 `PhysicsVector3` 转换，需自己写扩展 |
| 刚体不消失 | 只 `DestroyBody` 了对象，没同步销毁物理体 |
