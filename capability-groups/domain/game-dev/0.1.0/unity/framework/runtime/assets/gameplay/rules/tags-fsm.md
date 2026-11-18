---
name: tags-fsm
description: GameplayTag 的加载与冻结、层级匹配，以及 HFSM 状态机的注册、转移与逐帧推进约定。
priority: 10
---

# 标签与状态机

## GameplayTag

```text
Load(表) → Freeze() → GetTag(...) 查询
```

- 标签表加载后必须 `Freeze()`，否则层级匹配恒为 false——最常见"标签查不到"的原因。
- 标签只在初始化时加载一次；冻结后不可再改。
- 层级匹配用 `TagQuery.Any` / `TagQuery.All`：`Any` 命中任一子标签，`All` 要求全部命中。
- 标签用 `父.子.孙` 点分命名，父子关系由表定义，不要在代码里手拼字符串做前缀判断。

## HFSM

```csharp
var fsm = new HFSM();
fsm.AddState<IdleState>(...);
fsm.AddTransition<IdleState, MoveState>(Func<bool> condition);
fsm.Start(initial);
// 每帧
fsm.Update();
```

- 状态必须实现 `OnCreate` 并把 `isAllowedTrans = true`，否则出边永不评估——状态卡死的第一嫌疑。
- 转移条件是 `Func<bool>`，每帧对当前状态的出边顺序求值；返回 true 的第一条生效。
- `Update` **不会**被 `GameWorld` 自动调用，自己在流程 `Tick` 里推进。
- 状态共享一份 HFSM 实例；每个实体需要独立状态时各自 `new HFSM()`。

## 选择建议

| 需求 | 用哪个 |
|---|---|
| 全局大阶段（登录/大厅/战斗） | `Procedure` |
| 单个对象的行为状态（巡逻/追击/攻击） | `HFSM` |
| 条件判定、能力门禁 | `GameplayTag` 查询 |
| 可视化节点编排 | `Graph` |

## 常见错误

| 现象 | 原因 |
|---|---|
| 标签查询恒 false | 没调用 `Freeze` |
| HFSM 不转移 | 状态没置 `isAllowedTrans`，或忘调 `Update` |
| 所有对象共享状态 | 共用了同一个 `HFSM` 实例 |
| 转移抖动 | 多个条件同时为 true，靠顺序而非优先级决定 |

## 检查清单

- [ ] 标签表已 `Freeze`
- [ ] 状态 `OnCreate` 置了 `isAllowedTrans`
- [ ] 每个状态机实例独立
- [ ] `Update` 在某处被逐帧调用
