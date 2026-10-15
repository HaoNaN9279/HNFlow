# N14-切片P 评测 runner（§24.8）—— 执行计划

> 来源：《HNFlow 开发方案.md》§24.8：golden traces + 确定性/语义断言 + runner。
> 状态：**已完成**（库级 runner）。

## 范围

- `workflow/eval_runner.py`：`evaluate_replayed_run(definition, fixture, cases, ...)`——编译定义 → **replay 模式**执行 golden fixture（无真实模型/工具调用）→ 抽取节点输出 → 逐 case 断言 → `EvalReport`。支持 `judge`、`compile_context`、`on_miss`。

## 取舍

- 默认 `on_miss=error`（fail-loud），`live` 可选回退。
- 库级 runner；CI 挂载（能力包导入 / 定义保存自动跑）与录制 CLI = 后续增量。
- 无迁移/无新表/无新配置段/无新依赖；前端零改动。

## 验收

- replay golden 执行 + 断言通过/失败；未录制 fail-loud。
- 全量后端 A/B 失败集无新增；ruff 干净。
