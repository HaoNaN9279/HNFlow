# N14-切片Y §25 调试能力：节点断点 —— 执行计划

> 来源：《HNFlow 开发方案.md》§二十五『调试能力：节点断点、单步、回退重跑』（断点一项）。
> 状态：**已完成**（断点）。

## 范围

- `workflow/breakpoint.py`：`params.breakpoint` 谓词、`run_breakpoint`、`BreakpointDecision`。
- compiler：审批门之前接入；编译期 `_validate_breakpoints`。

## 决策与踩坑

- 复用 N10 审批门的 HITL 栈（同 HumanTask 行 / `interrupt()` / 行复用 / `__skip` 哨兵）。
- 刻意无 preview、无指纹复验（断点不批准任何东西）。
- **LangGraph 把假值 `Command(resume=...)` 当「未 resume」会再次挂起**（已最小复现）：
  故任务声明必填 bool 端口 `acknowledge`（enum [True]）保证 resume 载荷非空。
- 编译期拒绝非 bool 与 `flow:start`/`flow:end`（永不执行）。
- 无迁移/无新表/无新配置段/无新依赖；前端零改动。

## 验收

- 19 条新测试全过；全量 A/B 失败集与基线逐条一致；ruff 干净。
