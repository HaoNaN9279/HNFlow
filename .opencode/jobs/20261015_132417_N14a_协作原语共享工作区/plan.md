# N14-切片A 协作原语：共享工作区（黑板）— 执行计划

> 来源：《HNFlow 开发方案》§24.6a（line 722-741）「协作原语：共享工作区 / 有界评审回环 / 受控动态 handoff」；承接《HNFlow 开发规划.md》N13 行延后的「共享变量」（line 102/160）与方案 line 984「并行分支…与共享变量」。
> 目标仓库：`D:\workspace\work\HNFlow_deerflow-rebase`，分支 `deerflow-rebase`，起点 `bd671ce`。
> 状态：**已完成（Option A 共享黑板，D1–D8 按建议）**。提交见 boulder.json `commit`。

---

## 一、现状（已核对代码）

- 图的端口是**点对点**：节点 A 的输出端口只能喂给被边连到的下游；**没有**工作流级、可被多个（并行）节点共同读写的共享状态。
- `_build_state_schema` 把每个输出端口声明为**裸 `Any`（LastValue）**通道，**无 reducer**。因此：
  - 两个并行分支若写**同一通道**（共享变量），同一 super-step 内会触发 LangGraph `InvalidUpdateError`（冲突）；
  - 顺序写同一通道则后者覆盖前者。
- N13 已落地「同端口多入边合并规则」（`params.merge`）与「节点级资源锁」，但**共享变量（`wf:shared:*` 黑板）按决议延后**到本切片（与 §24.6a 一起做）。

**§24.6a 完整范围**：① 共享工作区（黑板）② 有界评审回环（producer↔critic）③ 受控动态 handoff。**本切片只做 ①（地基）**；② / ③ 列为后续（②依赖本切片的黑板 + 预算，③依赖协作白名单）。

---

## 二、Option A（推荐）：共享工作区（黑板）v1

### A1. 共享通道命名与声明
- 共享变量通道命名 **`wf:shared:<name>`**；`<name>` 受与锁名/应用名同族的安全标识约束（`^[A-Za-z0-9_][A-Za-z0-9_.-]{0,63}$`）。
- 通道在**编译期**按「所有节点声明的读写」汇总声明进 state schema（`_build_state_schema`）。

### A2. 读写面：新增 `data:shared` 节点
- `NodeType.DATA_SHARED = "data:shared"`（category `data`）。
- `params.operation`：`read` | `write` | `append`。
  - `write`：把输入端口 `in`（或 `params.value` 字面量）写入 `wf:shared:<name>`（覆盖）。
  - `append`：把值追加进共享数组（需要 `array` 通道，见 A3）。
  - `read`：输出端口 `out` = 当前 `wf:shared:<name>`。
- `params.name`：共享变量名（A1 语法）。
- 幂等：`read` 幂等；`write`/`append` 幂等（纯状态写，无宿主副作用）——按 `registry` 幂等标注登记。

### A3. 写策略 / reducer（并发安全）
- 每个共享变量 → 一个写策略（**全局声明**，避免同一通道两种语义）：
  - `overwrite`（默认）：LastValue 通道——**跨步**后者覆盖，**同一步**（并行分支同时写）→ LangGraph `InvalidUpdateError`（即天然「冲突报错」）。
  - `array`：给 `wf:shared:<name>` 挂 **reducer**（`(cur, new) -> (cur or []) + [new]` 或 concat list），**并行 append 合并**成列表。
  - `conflict`：显式要求「任何并发写即报错并给友好信息」——实现为默认通道 + 在 `data:shared` 写入前检查本步是否已有写（best-effort），或直接复用 `overwrite` 的 `InvalidUpdateError`（包一层更清晰的节点级错误）。
- 策略声明位置（决策点 D3）：workflow 顶层 `metadata.shared` 或节点参数携带。

### A4. 状态 schema / reducer
- `_build_state_schema` 对每个被引用的 `wf:shared:<name>` 建通道；`array` 策略用 `Annotated[Any, reducer]`（LangGraph 支持动态 TypedDict 的 `Annotated` reducer）。
- **无迁移**（纯 schema 生成期逻辑，定义 JSON 未变）。

### A5. 前端
- `types.ts` `NODE_TYPES` + `node-catalog.ts` 增 `data:shared`（入 `in`；出 `out`）；`node-catalog.test.ts`/`types.test.ts` 计数同步。

### A6. 测试（TDD）
- `write`→`read` 往返；`append`（`array`）并行分支合并成列表（顺序确定）；`overwrite` 顺序覆盖；并行同写 `overwrite` → 冲突报错；`read` 未初始化 → None/[]；非法名/非法 operation → 编译期报错。
- 回归：并行/loop/try/全量离线 A/B 对拍。

### A7. 风险
- 低：新增节点类型 + 编译期 schema 生成；不改执行主路径（LangGraph reducer 是原生语义）。
- 需确认 reducer 在动态 TypedDict 的运行行为（用测试钉）。并行 append 的**顺序**：LangGraph reducer 对同一步并发更新的合并顺序可能不保证定义序——测试只断言「集合/多重集」而非严格顺序（决策点 D5）。

---

## 三、Option B：§24.5 自主度预算（备选）

- `ai:llm_agent` 增 `params.autonomy: {mode: template|bounded, budgets: {...}}`：`template`=现状；`bounded`=放开工具循环 + 预算。
- **限制**：`SubagentConfig` 只有 `max_turns`/`timeout_seconds`；**token / tool_calls 预算无 per-node 管道**（走全局 `subagents.token_budget` 中间件），要做需改 subagent 内部（新增 config 字段 + 中间件接线）。
- 好处：`stop_reason`（`token_capped`/`turn_capped`/`loop_capped`）已在 `SubagentResult` 现成，可暴露到输出端口。
- 代价：跨模块（workflow→subagents），改动面比 A 大且更脆。

> 建议：**先做 Option A（自包含、承接 N13 延后）**；§24.5 单列，先补 subagent 预算管道设计。

---

## 四、待确认决策

- **D1**：范围 = **Option A（共享黑板，推荐）** / Option B（§24.5 自主度预算） / 两者。
- **D2**：读写面 = 新增 **`data:shared`** 节点（`read`/`write`/`append`）—— 还是扩展现有 `data:assign`（`params.target: "shared:<name>"`）？建议**新节点**（语义清晰）。
- **D3**：写策略声明位置 = workflow 顶层 `metadata.shared: {name: 策略}`（全局、避免同通道双语义）—— 还是每节点参数？建议**顶层 metadata**。
- **D4**：策略集合 = `overwrite|array|conflict`（默认 overwrite；array 用 reducer 合并）—— 确认。
- **D5**：`array` 并行 append 的**顺序**不作严格保证（只保证全部元素在、多重集正确）—— 确认。
- **D6**：`conflict` 策略的语义 = 并行同写即报错（复用 LangGraph 冲突 + 节点级友好错误）；顺序写覆盖 —— 确认。
- **D7**：(§24.6a 其余) **有界评审回环**与**受控动态 handoff** 列为后续增量 —— 确认。
- **D8**：无迁移/无新表/无新配置/无新依赖；前端接入目录 —— 确认。

---

## 五、验收标准
- `data:shared` 可读/写/追加；`array` 策略下并行分支产物合并无丢失；`overwrite` 并行同写报冲突；旧定义行为不变；全量离线回归失败集合逐条一致；ruff + 前端 `pnpm test`/`pnpm check` 绿。
- 文档同步：`AGENTS.md`（workflow 节点类型 / 共享通道）、`HNFlow 开发规划.md` N13 共享变量 + N14 状态。
