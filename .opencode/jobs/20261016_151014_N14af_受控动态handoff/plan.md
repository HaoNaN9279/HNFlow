# N14-切片AF §24.6a 受控动态 handoff —— 执行计划

> 来源：《HNFlow 开发方案.md》§24.6a（line 722-746）「协作原语」的第三块。
> 状态：**已完成**。

## 范围

新增 `flow:handoff` 节点 + `deerflow/workflow/handoff.py`：

- `params.candidates = [{value, node}, ...]`：白名单（node 必须在同一定义）。
- `params.max_handoffs`（默认 8，1..50）：本节点每 run 交接预算。
- `decision` 输入 / `target` 输出；其余已声明输入**原样转发**同名输出（结构化消息）。

## 关键设计与取舍

- **路由边由 params 生成**：handoff 出发的定义边 = 编译期错误（防两个真相源）。
- **没有 default 边**：未命中/未设置 → `WorkflowRouteError`/`HandoffError` 并列出允许值。
  「收工」用 handoff **之前**的 `flow:if` 显式表达（switch 的 default 回落 = 静默跑错分支）。
- 计数走保留通道 `wf:<node>:__handoffs`；executor 靠 compiler 注入 `node_id` 读计数。
- 预算是**每 handoff 节点**（跨节点全局预算未做；run 级 token 预算已由 §24.10 覆盖）。
- 前端仅加 palette/catalog 条目；`candidates` 沿用既有 JSON 值编辑器（与 switch `cases` 同 UX）。

## 验收

- 新增 24 条测试全过；全量 A/B 11378→11403 passed，**失败集合与基线逐条一致（75 = 75）**。
- registry 23→24；前端 NODE_TYPES 28→29（flow 8→9）；ruff / pnpm check / format 干净。
