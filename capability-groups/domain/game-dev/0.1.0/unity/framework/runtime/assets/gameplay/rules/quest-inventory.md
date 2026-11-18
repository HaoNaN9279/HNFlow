---
name: quest-inventory
description: 需要实现任务接取/进度/领取、背包增删与装备穿戴时读取：任务与背包的初始化顺序、领取校验缺口、堆叠与装备 Buff 的未完成项。
on_demand: true
priority: 40
---

# 任务与背包

## 任务

```text
QuestManager<TId>.Initialize()          只初始化一次
RegisterRewardHandler(...)              注册发奖回调
TryAcceptQuest(id)                      接取
NotifyGameEvent(...)                    推进进度
ClaimQuest(id)                          领取奖励
```

- `Initialize` 只能调一次，重复调用不重置状态。
- 进度推进靠 `NotifyGameEvent`，事件类型与任务条件要一一对应。
- **`ClaimQuest` 先发奖后校验**：重复领取会重复发奖。调用前自己维护"已领取"标记。
- `MultiCounter` 类型条件未实现，多计数任务需用多条独立条件模拟。
- 奖励发放在 `RewardHandler` 里做，别写进任务管理器。

## 背包

```text
Container.TryAddItem(item) → 成功/失败
Equipment.Equip(...) → 穿戴
```

- 堆叠**不读** `MaxStack` 配置：加物品不检查上限。需要上限时在 `TryAddItem` 前自行判断。
- 装备提供的 Buff 尚未实现（TODO），属性加成需自己接。
- `ItemRemovedEvent` 的 `ItemDefId` 恒为 0；需要知道移除的是什么物品时，事件里自己带 id。
- 容器变更后要发事件驱动 UI，UI 不直接读容器。

## 数据流

```text
配置表(ItemDef / QuestDef) → 运行时实例(Item / Quest) → Container / QuestManager → 事件 → UI
```

- 运行时实例不持有配置表的可变引用，配置表只读。
- 存档只存 id + 数量 + 状态，不存描述文本。

## 已知缺口

| 缺口 | 影响 |
|---|---|
| `ClaimQuest` 先发奖后校验 | 重复领取 |
| `MultiCounter` 未实现 | 复杂任务条件 |
| 堆叠忽略 `MaxStack` | 无上限 |
| 装备 Buff 未实现 | 装备不改属性 |
| `ItemRemovedEvent.ItemDefId = 0` | 移除事件缺信息 |

## 检查清单

- [ ] 领取前有已领取标记
- [ ] 堆叠上限自行校验
- [ ] 装备属性加成自己接了
- [ ] 容器变更发事件，UI 只读事件
- [ ] 存档只存必要字段
