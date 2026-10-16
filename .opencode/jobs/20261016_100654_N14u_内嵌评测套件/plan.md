# N14-切片U 定义内嵌评测套件 + opt-in 保存门（§24.8）—— 执行计划

> 来源：《HNFlow 开发方案.md》§24.8：golden traces + 断言 + runner（可挂能力包导入与定义保存）。
> 状态：**已完成**（定义保存一侧）。

## 范围

- `workflow/definition_evals.py`（纯解析 + 一处 runner 调用）：`metadata.evals` → replay 夹具 + 断言。
- `schema.WorkflowMetadata.evals`（additive）。
- Gateway：`require_pass` 保存门 + `POST /workflows/{id}/evaluate`。

## 取舍

- 保存门 **opt-in**（`require_pass: true`），「只记录期望」的套件永不阻塞保存。
- 规格非法一律 422（fail-loud），绝不静默关掉门。
- 能力包（skill）导入时自动挂载 = 后续增量。
- 无迁移/无新表/无新配置段/无新依赖；前端零改动。

## 验收

- 35 条新测试全过；全量 A/B 无新增失败；ruff 干净。
