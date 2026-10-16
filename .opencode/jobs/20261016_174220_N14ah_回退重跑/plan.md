# N14-切片AH §25 回退重跑 —— 执行计划

> 来源：《HNFlow 开发方案.md》§二十五「调试能力：节点断点、单步、回退重跑」的最后一项。
> 状态：**已完成**（§25 调试能力三块齐活）。

## 范围

- `workflow/rewind.py`：`plan_rewind`（纯）+ `locate_rewind_point`（读真实 checkpoint 历史）。
- `run_workflow(..., checkpoint_id=)` → `config["configurable"]["checkpoint_id"]` + `graph_input=None`。
- `start_workflow_run(..., checkpoint_id=)` 透传。
- `POST /api/workflows/{id}/runs/{rid}/rewind`（body `{node_id}`）。
- 前端：`rewindWorkflowRun` + 运行面板逐条「回退重跑」按钮 + i18n。

## 关键设计

- **复用 LangGraph checkpoint 续跑**，不新写重放引擎：`snapshot.next` 含 X 的 checkpoint 就是
  「X 之前」。恢复它 → X 及后继重跑、上游产物留在 state（上游副作用**不重复**，这是全部价值）。
- 新 run 落在**同一 thread**（否则就不是同一次执行状态的延续）。
- 拒绝：运行中 409 / 无 checkpointer 503 / 从未调度 422（**列出可回退节点**）/ sentinel 拒绝。
  纯 planner 抛错而非静默无操作（静默无操作与成功无法区分）。

## 取舍

- 只取最新匹配（当前 head 血脉），分支历史中较旧的 checkpoint 不被选。
- 对话侧 builtin 工具未加：画布/API 是唯一入口。
- 跨运行回退不支持（仅本 run 的 thread）。

## 验收

- 新增 19（后端）+ 7（前端）条测试全过，含**端到端 `seen == a,b,c,b,c`**（上游不重跑）。
- 全量 A/B 11435→11454 passed，失败集合与基线逐条一致（75 = 75）。
