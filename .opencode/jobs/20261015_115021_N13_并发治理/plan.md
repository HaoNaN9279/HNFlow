# N13 并发治理 — 执行计划

> 来源：《HNFlow 开发方案》§25 后续规划（line 984）「本地资源治理：GPU/CPU/内存/磁盘配额、应用 License 并发、独占锁；**并行分支上下文隔离与可合并规则（覆盖/数组/冲突报错）与共享变量**」；《HNFlow 开发规划.md》N13 行（line 102、160）「并行分支合并规则、共享变量、资源锁」。
> 目标仓库：`D:\workspace\work\HNFlow_deerflow-rebase`，分支 `deerflow-rebase`，起点 `286f2b9`。
> 状态：**已完成（A1 + A2，D1–D7 按建议；A3 共享变量延后）**。提交见 boulder.json `commit`。

---

## 一、现状（已核对代码）

**并行 fan-out/fan-in**：`flow:parallel` 是编译器原生透传节点；fan-out 靠「多出边」由 LangGraph 原生并行，fan-in 靠「多入边」。**没有**任何合并语义。

**真实缺陷（A1 的靶子）**：`_make_node_fn`（`compiler.py`）用
```python
for edge in incoming_edges:
    input_key_map[edge.target_port] = f"wf:{edge.source}:{edge.source_port}"
```
建**dict** —— 同一输入端口被多条边指向时**后者覆盖前者**，**静默丢掉其他并行分支的产物**。即今天「并行汇聚到同一端口」只有一个赢家，其余丢失，且无告警。

**state 通道**：`_build_state_schema` 全部声明为裸 `Any`（LangGraph `LastValue`）。同一 super-step 内两个节点写**同一通道**会触发 `InvalidUpdateError`（但普通节点的通道按 `wf:<node_id>:<port>` 天然唯一，故冲突只可能来自共享变量——即 A3）。

**已有可复用的锁原语**（N8）：`deerflow/locks/file_lock.py` 的 `resource_lock(name, *, base_dir, timeout)` / `acquire_many(names, ...)`——**可重入 + 跨进程**（`fcntl.flock`/`msvcrt.locking`），名字受 `LOCK_NAME_PATTERN` 约束。注意其 in-process 可重入靠 `_LockState.rlock`（`threading.RLock`）+ depth，**acquire/release 必须同线程**。

**`wf:shared:*`**：不存在任何实现（greenfield；与 §24.6a 协作原语重叠）。

---

## 二、Option A（推荐）：并行分支可合并规则 + 节点级资源锁

### A1 — Fan-in 合并规则（覆盖 / 数组 / 冲突报错）

**参数**：节点 `params.merge: { "<input_port>": "overwrite" | "array" | "error" }`（缺省 `overwrite` = 今天行为）。

**语义**（读侧，`_make_node_fn`）：
- `overwrite`：最后一条边的值（现状，保持兼容）。
- `array`：按**边顺序**收集该端口**所有已产出**（键存在于 state）的上游值成一个 list；全部未产出 → `[]`。
- `error`：若 >1 个上游产出**非 None** → 抛 `WorkflowExecutionError`，报出冲突来源键（"冲突报错"）。

**编译期校验**：策略值合法；`merge` 的端口名在该节点 `inputs` 内。

**不改 state schema、无迁移**；对普通节点（`_make_node_fn`）生效。

### A2 — 节点级资源锁

**参数**：节点 `params.resource_lock: str | list[str]`（锁名，受 `LOCK_NAME_PATTERN` 约束）+ `params.resource_lock_timeout: float`（默认 60）。

**语义**：编译期用 N8 `resource_lock`/`acquire_many` 包裹该节点的**整段执行**（含审批门 + 执行器），跨进程 + 进程内串行化对共享宿主资源（GPU/项目文件/license 槽）的访问。超时 → 带锁名/超时的 `WorkflowExecutionError`。

**async 安全实现（关键）**：N8 锁的 in-process 可重入是 `threading.RLock`，acquire/release **必须同线程**；且阻塞式获取**不能**在事件循环上跑（blocking-io gate）。采用**「锁持有线程 + 握手」**：
1. 起一个 daemon 线程，在其内部 `with resource_lock(...):` 获取锁，置 `acquired` 事件、等 `release` 事件，再自动释放；
2. 事件循环 `await asyncio.to_thread(acquired.wait)`；获取失败/超时把异常回传并 `raise`；
3. 执行节点 fn；
4. `finally:` 置 `release`，`await asyncio.to_thread(thread.join)`。
锁在同一线程内 acquire/release，事件循环不阻塞。

**范围**：编译器在 `_register` 前统一包装**所有声明了 `resource_lock` 的节点**（含控制流/try/子图节点）。

### A3 — 共享变量（本切片**不做**，见 §三）

### 兼容 / 迁移
- 纯新增参数；未声明 `merge`/`resource_lock` 的定义字节不变。
- **无 schema 迁移、无新表、无新配置段、无新依赖**（锁复用 N8）。

### 前端
- 本切片 `merge`/`resource_lock` 为参数级配置（画布表单当前不渲染这些参数，与 `iterations`/`continue_on` 一致）→ 前端零改动或仅 i18n 可选。

### 测试（TDD）
- A1：`overwrite`（现状/最后边胜）；`array` 收集全部并保序 + 未产出跳过 + 空 list；`error` 冲突报错 + 单源不报错；编译期非法策略/端口报错。
- A2：声明锁的节点串行化（两个并发 run/节点同名锁互斥，用一个计数 + 顺序断言）；超时 → 报错；未声明锁零变化。
- 回归：`flow:parallel` / loop / try / 全量离线 A/B 对拍。

### 风险
- A1 是读侧小改，低风险。
- A2 的线程握手需谨慎（异常路径、取消、超时释放）；用专门测试钉住（含 `CancelledError` 下释放）。

---

## 三、A3 共享变量（`wf:shared:*` 黑板）——建议**后续独立切片**

- 需 workflow 级共享通道 + 写策略（覆盖/合并/冲突）+ **reducer**（并发写同一共享通道必须给 reducer，否则 `InvalidUpdateError`）→ 触及 `_build_state_schema` 与 LangGraph reducer 语义。
- 与 §24.6a「协作原语（共享工作区/黑板）」、N14 #6a 强重叠，应一起设计（含 critic 回环、动态 handoff）。
- **建议本切片不碰**，避免把 N13 变成半个协作原语系统。

---

## 四、待确认决策

- **D1**：范围 = **A1 + A2（推荐）** / 含 A3 / 仅 A1。
- **D2**（A1）：策略 `overwrite|array|error`，参数 `params.merge: {port: policy}`，默认 overwrite —— 确认。
- **D3**（A1）：`array` 收集「已产出」值（按边顺序），未产出跳过，全未产出 → `[]` —— 确认。
- **D4**（A1）：`error` 在 >1 个上游产出**非 None** 时报错 —— 确认。
- **D5**（A2）：`params.resource_lock`(str|list) + `resource_lock_timeout`（默认 60），「锁持有线程 + 握手」实现 —— 确认。
- **D6**（A2）：统一包装**所有**声明锁的节点（而非仅普通节点）—— 确认。
- **D7**：无迁移/无新表/无新依赖；前端零改动（参数级，不上表单）—— 确认。

---

## 五、验收标准
- A1：扇入同端口多源时按策略合并（覆盖/数组/冲突报错）正确；旧定义行为不变。
- A2：同锁节点跨并发/跨进程串行化；超时可控报错；取消路径释放锁；未声明锁零变化。
- 全量离线回归失败集合逐条一致；ruff + 前端 `pnpm test`/`pnpm check` 绿。
- 文档同步：`AGENTS.md`（workflow 并行/锁说明）、`HNFlow 开发规划.md` N13/M2 状态。
