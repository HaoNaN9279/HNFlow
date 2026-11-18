---
name: entity-view
description: 需要把玩法实体接到场景对象、做数据到视图的属性绑定、或视图跟错实体时读取：EntityView 字段、PropertyBinder 派生与视图工厂接线缺口。
on_demand: true
priority: 40
---

# 实体视图接线

## 现状

`EntityManager` 只产生逻辑实体与事件，**不创建视图**；`ViewFactory` 存在但未接线，`CreateView` 传入的 `entityId` 恒为 0。

因此实体到场景对象的那一段必须项目侧自己实现。

## 推荐接线

```text
EntityManager.Spawn → EntitySpawnedEvent（自己带 id）
  → 项目侧 ViewService 按 id 从池取 EntityView 实例
  → EntityView.Bind(entityId, entityDefId)
  → PropertyBinder 把逻辑数据推到 Transform / Animator / UI
  → Despawn 时 Unbind 并归还池
```

## EntityView

- 组件携带 `EntityId` 与 `EntityDefId`，用于反查逻辑实体。
- 不要依赖 `CreateView` 的返回值，它拿不到正确 id。
- 视图不写逻辑数据，只读逻辑层并表现。

## PropertyBinder

- 只有抽象基类，按需派生：位置/旋转、Animator 参数、文本数值各一个绑定器。
- 绑定器在 `Bind` 时订阅数据变更，在 `Unbind` 时退订；退订漏了会造成"幽灵更新"。
- 高频数据（位置）不用事件驱动，直接在 `LateUpdate` 拉取，避免每帧事件开销。

## 常见错误

| 现象 | 原因 | 处理 |
|---|---|---|
| 实体生成了但看不见 | 没有视图订阅事件 | 写 ViewService |
| 视图跟错实体 | 依赖了恒为 0 的 id | 事件里带 id，自行映射 |
| 视图不更新 | 绑定器没订阅或没拉取 | 检查 Bind/Unbind |
| 复用视图残留旧数据 | 池回收未复位 | `Unbind` 时清空表现状态 |

## 检查清单

- [ ] 自己维护 entityId → view 映射
- [ ] 生成与回收成对
- [ ] 绑定器有 Bind/Unbind
- [ ] 复用视图前复位
