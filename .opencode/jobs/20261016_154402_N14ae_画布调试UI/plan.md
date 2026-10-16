# N14-切片AE §25 画布调试 UI（单步运行 + 调试暂停）—— 执行计划

> 来源：《HNFlow 开发方案.md》§二十五「调试能力」的画布侧闭环。
> 状态：**已完成**（纯前端切片，后端零改动）。

## 范围

1. 工具栏「单步运行」→ `startRun({debugStep:true})` → `streamWorkflowRun(id, {debug_step:true})`。
2. `core/workflows/human-tasks.ts`：断点/单步暂停 = pending human task，
   复用 submit/skip 路由（`continueDebugPause` 提交 `{acknowledge:true}`）。
3. 运行面板「调试暂停」卡：继续 / 跳过；读取失败显式重试。

## 关键设计

- **不按运行过滤**：resume 会新起 run id，按运行过滤会让已单步过的运行在画布失联；
  当前运行的暂停仅**置前**（`preferredRunId`）。
- **acknowledge 必须非空**：LangGraph 把假值 `Command(resume=...)` 当「未 resume」。
- **读取失败 ≠ 没有暂停**：显式给出重试行，不静默。
- 泛型 `human:task`/`approval` 端口任意，不在本卡处理（通用表单渲染列为后续增量）。

## 验收

- 前端全量 1223 passed；`pnpm check` exit 0；`pnpm format` 全绿。
- 新增 26 条测试（node 15 + DOM 7 + 工具栏 4）。
