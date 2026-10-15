# N14-切片N 运行级预算（§24.10）—— 执行计划

> 来源：《HNFlow 开发方案.md》§24.10（成本/预算治理）：预算层级 node/run/workflow；超限策略告警/降级/中止。
> 状态：**已完成**（运行/工作流级）。

## 范围

- `workflow/budgets.py`（纯逻辑）：`RunBudget` + `parse_run_budget`（`metadata.budget={max_total_tokens, on_exceed}`）+ `usage_total` + `aggregate_token_usage`（聚合 `wf:<node>:__token_usage`）+ `evaluate_budget`。
- `schema.WorkflowMetadata.budget`（可选字段，additive）。
- `compiler`：`_validate_run_budget` 编译期校验 + `_make_node_fn` 每节点后聚合 state 并按 warn/abort 强制。

## 取舍

- 节点级上限由 §24.5 autonomy 承担；本切片补运行/工作流级。
- `degrade` 刻意不设（token 已花）；仅 warn/abort。
- 成本/花费报表（node/model 归因 + currency）列后续（`models[*].pricing` + console 计价已有底座）。
- 无迁移/无新表/无新配置段/无新依赖；前端零改动。

## 验收

- 坏 `metadata.budget` 编译期报错；超预算 abort 停 run、warn 继续；额度内通过。
- 全量离线 A/B 无实质新增失败；ruff 干净。
