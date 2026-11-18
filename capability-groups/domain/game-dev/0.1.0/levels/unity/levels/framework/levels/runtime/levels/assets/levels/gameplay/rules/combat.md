---
name: combat
description: 需要做属性、伤害计算、Buff/状态效果、技能与能力时读取：AttributeSet 的 Freeze 流程、效果管线顺序、Buff 移除不回滚等已知缺口。
on_demand: true
priority: 30
---

# 战斗数值

## 启动顺序

```text
AttributeSet.Freeze() → Initialize() → Apply(...) → 每帧 Tick(dt, set)
DamagePipeline.Process(...)
```

- `Freeze()` 必须在 `Initialize` 之前；不冻结属性集合，标签与属性匹配机制不生效。
- 属性集合按"每个角色一份"创建，不要全局共享。
- `Tick(dt, set)` 传的是**受击方/被影响方**的集合；多个角色要各自调。

## 管线

| 类型 | 职责 |
|---|---|
| `AttributeSet` | 基础属性、加成、修正计算 |
| `EffectPipeline` | 效果应用顺序 |
| `BuffSystem` | 持续状态、剩余时间 |
| `AbilitySystem` | 技能触发与门禁 |
| `DamagePipeline` | 伤害结算 |

- 伤害、治疗统一走 `DamagePipeline`，不要直接改 `AttributeSet` 的最终值。
- 数值计算顺序：基础值 → 百分比加成 → 固定加成 → 最终修正。自定义规则塞进管线，不要写进 UI。
- Buff 到期或移除时**不会回滚已生效的属性变更**；需要可逆效果时自己记录并补偿。

## 能力门禁

`AbilitySystem` 没有标签门禁实现：想限制"是否可释放技能"，在项目侧用 `GameplayTag` 查询自行判断。

## 已知缺口

| 缺口 | 影响 |
|---|---|
| `RemoveBuff` 不回滚属性 | 临时加成会残留 |
| `AbilitySystem` 缺标签门禁 | 无法用标签限制技能 |
| 战斗与 `GameplayTag` 未打通（用自有 `int[]`） | 标签条件需手写桥接 |
| `RewardProcessor` 恒返回成功 | 发奖失败不可见 |

## 约定

- 数值配置全部来自配置表，不写死在代码里。
- 属性名用常量，不要字符串散写。
- 战斗日志走 `DebugHub`，正式统计另建。
- 结算逻辑与表现分离：管线只算数，飘字/特效由表现层订阅事件。

## 检查清单

- [ ] `AttributeSet` 已 `Freeze`
- [ ] 每个角色独立属性集合，逐帧 `Tick`
- [ ] 可逆 Buff 有补偿逻辑
- [ ] 技能门禁自己实现了
