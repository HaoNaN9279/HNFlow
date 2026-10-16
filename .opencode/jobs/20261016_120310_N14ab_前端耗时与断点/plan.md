# N14-切片AB §25 前端：节点耗时读数 + 断点开关 —— 执行计划

> 来源：§二十五「调试能力」与「执行数据分析」的前端半边（把 N14x/N14y 的后端能力接到画布）。
> 状态：**已完成**。

## 范围

- `core/workflows/run-durations.ts`（**纯逻辑**）：从运行通道抽 `wf:<node>:__duration_ms`。
- `core/workflows/api.ts`：`fetchWorkflowRunState`。
- `workflow-run-panel.tsx`：终态后读耗时 + 逐条显示 + 最慢节点。
- `workflow-properties-panel.tsx`：断点勾选框（写 `params.breakpoint`）。
- i18n：`run.panel.slowestNode`、`properties.breakpoint{Label,Hint}`。

## 取舍

- 耗时读数用**命令式 effect**（仅终态 + 有 runId；不引入 query provider），
  既有 DOM 测试无需改造；读取失败一律丢弃（观测不是运行失败）。
- 耗时**不从节点事件取**（N14x 刻意把保留通道排除在事件外），state 端点为权威源。
- 断点关闭时**删键**，不留 `breakpoint: false`。
- 无后端改动/无新依赖。

## 验收

- 16 条新测试全过（10 纯逻辑 + 3 run-panel + 3 properties-panel）；
  `pnpm test` 1196 passed、`pnpm check` exit 0、`pnpm format` 全绿。
