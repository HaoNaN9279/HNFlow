---
name: animation-view
description: 表现层消费动画快照：AnimationLogicAgent 装配、快照应用顺序、Layers/Montages 消费范围与需要自接的通道。
priority: 20
---

# 动画表现层

## 装配

```csharp
// 场景对象上的组件
animationLogicAgent.Initialize(def);
```

`AnimationLogicAgent` 内部会创建逻辑实例并注册进 `AnimationLogicSystem`，所以**不要**再手动 `Create`，否则同一实体会有两份实例。

`LateUpdate` 顺序固定：

```text
PushWorldSnapshot → AnimationLodDriver.TickLod → AnimationRepresentation.ApplySnapshot
```

顺序不能改：先写输入快照，再按 LOD 调整，最后应用到表现。

## 快照消费范围

框架自带的两个 `AnimationRepresentation` 只消费 **Layers + Montages**。

以下通道需要项目自接：

| 通道 | 需要做什么 |
|---|---|
| `Additives[]` | 自写 Representation 处理叠加层 |
| `Events[]` | 订阅并分发动画事件（脚步声、攻击判定） |
| `MotionIntent` | 自写根运动应用 |
| `Inertialization` | `InertializationBlender` 无人引用，需自接 |

## 读取快照

- 先判 `Version` 是否变化，变了才重建缓存；直接读 `Layers` 引用会拿到上次的数组。
- `NormalizedTime` / `Speed` 用于外部驱动（如让特效跟随），不要反写。
- 过渡期间 `TransitionPolicy` 描述混合方式，表现层按此选择混合器。

## 限制

- 逻辑层暂停（LOD Culled）时表现层仍会应用上一帧快照，表现为"定格"，属预期。
- Montage 上限 2，Additive 上限 4，超出部分不会有表现。
- 逻辑层动画时间与 Unity 时间不完全同步，表现层插值用 `Time.deltaTime`。

## 检查清单

- [ ] 没有重复创建逻辑实例
- [ ] `LateUpdate` 三步顺序正确
- [ ] 需要的事件/根运动/叠加层已自接
- [ ] 快照读取判了 `Version`
