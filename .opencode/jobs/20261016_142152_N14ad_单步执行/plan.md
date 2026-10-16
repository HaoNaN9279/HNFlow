# N14-切片AD §25 单步执行（step mode）—— 执行计划

> 来源：《HNFlow 开发方案.md》§二十五「调试能力：节点断点、单步、回退重跑」的**单步**一项。
> 状态：**已完成**（API 级单步）。

## 范围

- `breakpoint.py`：`STEP_SNAPSHOT_KIND` / `DEBUG_STEP_CONTEXT_KEY` / `step_mode_requested`；
  `run_breakpoint(..., kind=...)`。
- `compiler`：审批门之前的 step 门（一次访问一次暂停）。
- `WorkflowRunRequest.debug_step` → `start_workflow_run` → `worker` 注入 context。
- 两条 resume 路径按任务行 `inputs_snapshot.kind` 重新推导 `debug_step`。

## 关键设计

- resume 是**新 run**：只有任务行知道这次暂停是 step 还是 breakpoint，
  故「一次一个节点推进」必须靠 resume 时重新推导该标志。
- 节点自身 breakpoint 与 step 同时命中 => 只挂起一次（`paused` 标记）。

## 取舍

- 本切片交付 **API 级单步**；画布「单步运行」按钮 = 后续增量（复用 N14ab 模式）。
- **回退重跑**需要「按节点定位 checkpoint 并从该点重跑」语义，现有只有
  cancel-rollback 与 AI continue（都不重执行任意节点）→ 单独评估，不顺手加。
- 无迁移/无新表/无新配置段/无新依赖；前端零改动。

## 验收

- 11 条新测试全过；全量 A/B 无新增失败（唯一差异为既有 flake，单跑通过）；ruff 干净。
