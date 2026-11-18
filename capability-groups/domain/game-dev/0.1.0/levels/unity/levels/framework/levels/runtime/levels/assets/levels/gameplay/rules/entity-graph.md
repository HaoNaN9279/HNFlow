---
name: entity-graph
description: 实体的生成销毁与事件、图数据的建图校验，以及实体到视图的接线缺口说明。
priority: 20
---

# 实体与图

## 实体

```text
EntityManager.Spawn(...) → EntitySpawnedEvent
EntityManager.Despawn(...)
```

- 生成与销毁要成对；`Despawn` 后不要再持有实体引用。
- 实体生成只发事件，**不创建视图**：视图由项目侧订阅 `EntitySpawnedEvent` 后自行实例化。
- `CreateView` 传的 `entityId` 恒为 0，是已知接线缺口；需要按实体定位视图时自己在事件里带上 id 并映射。
- 实体数据挂在 `EntityManager` 上，逐帧更新由玩法系统驱动，不要塞进 `MonoBehaviour`。

## 图（Graph）

```text
GraphData
  AddNode(...) / AddEdge(...)
  Validate()
  Serialize()
```

- `AddEdge` 不校验端点存在，写完必须 `Validate()`；校验不过的图不要进运行时。
- 图只是数据结构，**没有执行器**。行为树、任务链、对话流要去驱动它：由项目写遍历逻辑，按节点类型分派。
- 图的编辑器入口在 `HNFramework` 菜单下，节点类型通过 `NodeRegistry` 注册。

## 图的使用场景

| 场景 | 用法 |
|---|---|
| 行为树 | 节点 = 条件/动作/组合，项目侧写 tick 遍历 |
| 任务链 | 节点 = 任务步骤，边 = 前置依赖 |
| 对话/过场编排 | 节点 = 片段，边 = 分支 |
| 技能编排（ControlRig） | 框架自带动画模块已在用 |

## 常见错误

| 现象 | 原因 |
|---|---|
| 图载入后跑不动 | 只序列化了，没有执行器 |
| 边指向不存在的节点 | `AddEdge` 不校验，`Validate` 会报 |
| 实体生成后看不见 | 没有视图订阅事件 |
| 视图跟错实体 | 依赖了恒为 0 的 `CreateView` id |

## 检查清单

- [ ] `Spawn`/`Despawn` 成对
- [ ] 图在保存前 `Validate`
- [ ] 实体到视图的映射由项目侧维护
- [ ] 执行器逻辑有独立的逐帧入口
