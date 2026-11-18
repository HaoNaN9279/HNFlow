# 玩法 API 速查

路径相对框架仓库根。

## GameplayTag

| 成员 | 说明 |
|---|---|
| `GameplayTagManager.Load` | 加载标签表 |
| `GameplayTagManager.Freeze` | 冻结；不调用则层级匹配恒 false |
| `GameplayTagManager.GetTag` | 取标签 |
| `TagQuery.Any` / `TagQuery.All` | 层级匹配查询 |

源码：`Runtime/HN.Framework.Core/Level/GameplayTag/`

## HFSM

| 成员 | 签名 |
|---|---|
| `HFSM.Initialize` | 初始化 |
| `HFSM.AddState<T>` | 注册状态 |
| `HFSM.AddTransition<TFrom, TTo>` | `(TFrom, TTo, Func<bool> condition)` |
| `HFSM.Start` | 指定初始状态 |
| `HFSM.Update` | 逐帧推进（需自己调用） |

约束：状态在 `OnCreate` 置 `isAllowedTrans = true`，否则出边不评估。

源码：`Runtime/HN.Framework.Core/Level/Logic/HFSM/`

## 实体

| 成员 | 说明 |
|---|---|
| `EntityManager.Spawn` / `Despawn` | 生成与销毁，发 `EntitySpawnedEvent` |
| 视图 | 不自动创建；`CreateView` 的 `entityId` 恒为 0 |

源码：`Runtime/HN.Framework.Core/Level/Logic/Entity/`

## 图

| 成员 | 说明 |
|---|---|
| `GraphData.AddNode` / `AddEdge` | 建图；`AddEdge` 不校验端点 |
| `GraphData.Validate` | 校验，进运行时前必须过 |
| `GraphData.Serialize` | 序列化 |
| 执行器 | 无；项目自写遍历 |

源码：`Runtime/HN.Framework.Core/Level/Logic/Graph/`
编辑器：`Runtime/HN.Framework.Editor/Graph/`（`GraphAsset`、`GraphEditorWindow`、`NodeRegistry`）

## 战斗

| 成员 | 顺序/说明 |
|---|---|
| `AttributeSet.Freeze` → `Initialize` → `Apply` | 冻结优先 |
| `BuffSystem.Tick(dt, set)` | 逐角色调用 |
| `DamagePipeline.Process` | 统一伤害结算 |
| `AbilitySystem` | 无标签门禁 |

源码：`Runtime/HN.Framework.Core/Level/Logic/Combat/`

## 任务

| 成员 | 说明 |
|---|---|
| `QuestManager<TId>.Initialize` | 只调一次 |
| `RegisterRewardHandler` | 发奖回调 |
| `TryAcceptQuest` / `NotifyGameEvent` / `ClaimQuest` | 接取、推进、领取 |
| `ClaimQuest` | 先发奖后校验，需外部防重 |

源码：`Runtime/HN.Framework.Core/Level/Logic/Quest/`

## 背包

| 成员 | 说明 |
|---|---|
| `Container.TryAddItem` | 加入，堆叠不校验上限 |
| `Equipment.Equip` | 穿戴，属性 Buff 未实现 |
| `ItemRemovedEvent` | `ItemDefId` 恒为 0 |

源码：`Runtime/HN.Framework.Core/Level/Logic/Inventory/`
