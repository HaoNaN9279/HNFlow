# N14-切片Q 评测 CLI（§24.8 CI 接入）—— 执行计划

> 来源：《HNFlow 开发方案.md》§24.8：把 eval 挂到 CI。
> 状态：**已完成**（CLI）。

## 范围

- `workflow/eval_cli.py`：`python -m deerflow.workflow.eval_cli --definition --fixture --cases [--on-miss] [--json]`；加载 → 回放执行 → 报告；退出码 0/1/2。

## 取舍

- CLI 可挂 CI；「能力包导入/定义保存自动跑」嵌入式挂载 = 后续增量。
- 无迁移/无新表/无新配置段/无新依赖；前端零改动。

## 验收

- pass→0 / fail→1 / bad inputs→2 / --json 输出。
- 全量后端 A/B 无实质新增失败；ruff 干净。
