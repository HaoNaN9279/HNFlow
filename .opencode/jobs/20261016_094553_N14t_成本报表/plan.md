# N14-切片T 运行成本报表（§24.10）—— 执行计划

> 来源：《HNFlow 开发方案.md》§24.10 成本/预算治理（三级预算 + 成本报表）。
> 状态：**已完成**。

## 范围

- `workflow/costs.py`（纯逻辑）：定价表、用量抽取、cache-aware 计价、运行报表。
- Gateway：`GET /api/workflows/{id}/runs/{rid}/cost`。

## 取舍

- 用量通道不记模型 → 按 `default_model` 计价并逐节点回报所用模型（console 既有回退一致）。
- 未定价 `cost: null`（不伪造 0）；混合币种关闭计价。
- 无迁移/无新表/无新配置段/无新依赖；前端零改动。

## 验收

- 32 条新测试全过；全量 A/B 无新增失败；ruff 干净。
