# P1 — 本地资源治理（切片 4：N8）执行计划

> 依据《HNFlow 开发方案》§19（本地资源治理）、《HNFlow 开发规划》§五 P1 第 4 项（N8 行）。
> 状态：**已完成（S1–S8）**，提交 `4c6a808`。

## 1. 目标与范围

N8 = **本地资源治理**：为「运行在宿主」的本地专业软件（及经其派生的脚本执行）建立**声明式配额 + 准入排队 + License 并发 + 独占锁**：

- **资源维度**：GPU / CPU / 内存 / 磁盘**配额与排队**。
- **应用 License 并发**：同一许可限制下的实例互斥/限额，避免抢占。
- **独占锁**：可重入锁 + 跨进程文件锁 + 统一加锁顺序。
- **与并行调度集成**：资源冲突时**排队 / 降级 / 告警**。

本切片只做 N8，不含 N9（资产）/N10（人机共享）/N11（环境探测），**不改前端**（与 N6/N7 同策略）。

## 2. 现状调查（可复用 vs 缺口）

**已有（复用，不重写）**
- 应用接入层：`deerflow/apps/{registry,session,driver,drivers/{cli,mock}}.py`；`AppSessionManager.launch/run_script/wait/collect/close` 是**所有 app 操作的唯一咽喉**（工作流 `app:*` 执行器与工具网关 `app` provider 都经它）。
- `AppDefinition.exclusive`（单实例应用 launch 复用已有 session）+ `session.to_port()`（`exclusive` 已在端口契约里）。
- 实例持久化（N6）：`app_instances.resources`（JSON，已累计 `scripts_run`/`artifacts`/`busy_seconds`/`last_error`），注释已标注「Deeper resource governance is N8」。
- 跨进程文件锁先例：`skills/projection.py::_projection_lock`（`fcntl.flock` / Windows `msvcrt.locking` + 进程内 `threading.RLock`）。
- 配置注入范式：`apps` 段已是 startup-only（`reload_boundary.STARTUP_ONLY_FIELDS`）；runtime context 键注入范式（`runtime/context_keys.py`：`APP_RUNTIME_CONTEXT_KEY` / `APP_INSTANCE_REPO_CONTEXT_KEY`）。
- 失败语义（N7）：节点失败 → `WorkflowExecutionError` → 运行失败；调度侧可用 `max_attempts` 退避重试 / `dead_lettered` + `/requeue`。**N8 无需新失败通道**。
- 观测：`GET /api/apps`（注册表 + `available`）、`GET /api/apps/sessions*`（实例）、`wf:node:*` SSE 事件。

**缺口（全新）**
- 无资源声明（`AppDefinition` 不知道自己要多少 GPU/CPU/内存/磁盘，也没有 license 归属）。
- 准入闸门不存在：`flow:parallel` 的 fan-out 会**无限制并发**拉起同一专业软件/License。
- 无排队/降级/告警语义（冲突即直接执行或直接失败）。
- 无通用独占锁工具（只有 skill projection 内部的私有实现）。

## 3. 设计草案

### 3.1 声明式资源模型（配置）
- `AppDefinition` 增 `resources`：`{gpu: int, cpu: int, memory_mb: int, disk_mb: int, license: str|None}`，全部可选、缺省 = 不占额度。
- `AppsConfig` 增：
  - `resources: {gpu, cpu, memory_mb, disk_mb}` = **全局总量上限**（缺省/`null` = 该维度不限制）。
  - `licenses: {<group>: {slots: int}}` = License 组并发槽位（缺省 `slots=1` = 互斥）。
  - `on_conflict: "wait"|"fail"|"degrade"`（默认 `wait`）+ `acquire_timeout_seconds`（默认 60, ge=1）。
- 校验：声明 `license` 组必须存在于 `apps.licenses`（否则配置错误，加载期 fail-fast）；数值 `ge=0`；维度名白名单。

### 3.2 资源治理器（`deerflow/resources/governor.py`，纯 harness）
`ResourceGovernor` —— 进程内准入闸门，无 DB、无新线程：

```
acquire(demand: ResourceDemand, *, on_conflict=None, timeout=None) -> Lease   # async
release(lease) -> None
snapshot() -> {limits, in_use, waiting, licenses}
```

- **两个占用层级**（对应 §19 两条要求）：
  - **实例级 license**：`launch` 成功时按 `resources.license` 申请一个 slot，实例 `close`/`stopped` 时释放（同一已有实例被 `attach` 复用**不重复占用**）。
  - **操作级配额**：`run_script`/`wait`/`collect` 执行期间按 `resources.{gpu,cpu,memory_mb,disk_mb}` 申请，操作结束释放。
- **串行化维度**：所有申请都走同一把 `asyncio.Condition` + 固定维度顺序（`gpu→cpu→memory_mb→disk_mb→license`，license 组名字典序）**一次性原子申请**，避免部分持有导致死锁。
- **冲突策略**：`wait`（排队，`asyncio.wait_for` 到 `acquire_timeout_seconds`，超时抛 `ResourceUnavailableError`）/ `fail`（立即抛）/ `degrade`（不排队直接放行，返回 `degraded=True` 的 Lease 并记 warning）。配额耗尽时 `wait` 队列 FIFO。

### 3.3 独占锁（`deerflow/locks/file_lock.py`，新）
跨进程**可重入**文件锁，供 app 互斥 / license 组 / 未来 N10 共享工作区复用：

```
@contextmanager resource_lock(name, *, base_dir=None, timeout=None)
@contextmanager acquire_many(names, *, base_dir=None, timeout=None)   # 按 name 排序统一加锁顺序
```

- 进程内：按 name 的 `threading.RLock`（可重入）。
- 跨进程：`fcntl.flock(LOCK_EX|LOCK_NB)` + 重试退避到 `timeout`；Windows `msvcrt.locking`（需 `seek(0)`）。
- 锁文件：`{DEER_FLOW_HOME}/locks/<safe_name>.lock`（name 经 `^[A-Za-z0-9_.-]{1,64}$` 校验，防路径注入）。
- `acquire_many` 内部排序 + 去重，保证不同调用点无法以相反顺序死锁。
- **不改** `skills/projection.py`（避免技能投影回归）；收敛为后续可选项，单测里断言两者语义一致。

### 3.4 接入点（咽喉，全局生效）
- `AppSessionManager` 增可选 `governor`（构造函数注入；缺省 `None` = 不治理，**行为与今天一致**）。
  - `launch`：license 申请；`close`：release。
  - `run_script`/`wait`/`collect`：操作级配额 acquire/release（`try/finally` 保证释放）。
- `local_app.py` 执行器：把 `ResourceUnavailableError` 翻译成 `WorkflowExecutionError`（消息带维度 + 等待时长），走既有节点失败语义；`degraded` 写入 `record_operation(resource_deltas={"degraded": 1})` + `last_error` 不动（告警而非失败）。
- **工具网关 `app` provider 经同一 `get_session_manager()`** → 自动受治理，无需改代码（补一条测试钉死）。
- Gateway lifespan 构造 `ResourceGovernor(apps_config)` 并注入 runtime context（`runtime/context_keys.py::APP_RESOURCE_GOVERNOR_CONTEXT_KEY`），worker 与执行器、工具网关共用同一实例。

### 3.5 与并行调度集成（§19 末条）
**不新增并行调度器**：`flow:parallel` 的 LangGraph 原生 fan-out 保持不变，并发度由**闸门**自然限制（排队/降级/失败）。这是与方案「不造新调度器」一致的最小实现；`max_concurrent_runs`（调度侧）与 governor 独立、各自生效。

### 3.6 观测与 API
- `GET /api/apps/resources`：`{limits, in_use, waiting, licenses:{group:{slots,in_use,waiting}}}`（无 governor 时返回 `enabled:false` 的稳定形状）。
- `GET /api/apps`：每 app 描述补 `resources` 与 `license`（前端/运维可见）。
- 告警：`degrade` 与 `wait` 超时都走 `logger.warning`（含 app/维度/耗时）；不新增事件类型。

### 3.7 配置与迁移
- **无迁移**：配额/占用不落库（`app_instances.resources` 是 JSON，直接透传新增计数）。多 worker 全局配额一致性**明确不在本切片**（与 scheduler/sandbox `memory` 单进程契约一致，记录为已知边界）。
- `config.example.yaml`：`apps` 段补 `resources`/`licenses`/`on_conflict`/`acquire_timeout_seconds` + `definitions` 示例注释；`config_version` 36 → 37。

### 3.8 前端
本切片**不改前端**（新增只读端点与描述字段，UI 另开切片）。

## 4. 决策（待确认，均推荐）
1. **范围**：只做 N8（配额/排队/License/独占锁/降级告警）；不做 N9–N11、不改前端。—— 推荐
2. **计量方式**：**声明式配额 + 准入闸门**，不做真实 GPU/显存计量（跨平台不可靠）；声明缺省 = 不占额，全局上限缺省 = 不限制；`governor` 缺省 `None` → 现有行为逐字节不变。—— 推荐（备选：真实探测 GPU，重且平台耦合）
3. **占用层级**：**实例级 license + 操作级 GPU/CPU/内存/磁盘**（贴合 §19 两条原文；`exclusive` 复用实例不再占 license）。—— 推荐
4. **冲突策略**：`on_conflict` = `wait`(默认, 超时失败) / `fail` / `degrade`(放行+告警)；超时 → 结构化 `ResourceUnavailableError` → 既有节点失败语义（可配 `max_attempts` 重试）。—— 推荐
5. **排队实现**：进程内 `asyncio.Condition` + 固定维度顺序一次性原子申请（无新线程/无轮询）；**不引入外部队列/DB**。—— 推荐
6. **独占锁**：新建 `deerflow/locks/file_lock.py`（可重入 + `fcntl`/`msvcrt` 跨进程 + `acquire_many` 统一顺序）；**不改** `skills/projection.py`（避免技能回归），收敛为后续可选。—— 推荐
7. **并行调度集成**：不改 `flow:parallel`，靠闸门限流。—— 推荐
8. **多 worker**：本切片配额为**单进程**；跨进程全局配额（DB 计量）与 GPU 实测量记为后续增量。—— 推荐
9. **前端**：本切片不动（后端 + API only）。—— 推荐

## 5. 验收标准
- `AppDefinition.resources` + `apps.resources`/`licenses`/`on_conflict`/`acquire_timeout_seconds` 可配置并通过校验；未声明的应用不受影响。
- 全局 `gpu: 1` + 两个 `app:script` 并（在不同 run/线程）→ 第二个**排队**；`acquire_timeout_seconds` 内第一个结束则第二个执行，超时则失败且错误信息含维度。
- `licenses: {fl: {slots: 1}}`：同组合法实例第二个 launch 被拒/排队；`exclusive` 应用 attach 复用**不**增占。
- `on_conflict: degrade`：配额耗尽仍执行，结果带 `degraded` 标记 + warning 日志。
- `acquire_many(["b","a"])` 与 `["a","b"]` 不互相死锁；跨进程（两进程）互斥成立；`resource_lock` 同一 name 可重入。
- `GET /api/apps/resources` 返回 limits/in_use/waiting/licenses；无 governor 时形状稳定。
- 现有 `app:*` 行为不变（governor 缺省不注入时）；后端 pytest 全绿（仅既有平台失败）；ruff 干净；`config_version` 校验随例更新。

## 6. 测试策略（TDD，强制）
- `tests/test_app_resources_config.py`（新）：`resources`/`licenses`/`on_conflict` 校验、未知 license 组 fail-fast、缺省不占额、`config_version` 37。
- `tests/test_resource_governor.py`（新）：单/多维度申请、FIFO 排队、超时、`fail`/`degrade`、license slots、release 后可再取、并发 acquire 无超额、`snapshot`。
- `tests/test_file_lock.py`（新）：可重入、跨进程互斥（子进程）、`acquire_many` 顺序无关、超时、name 校验（路径注入拒绝）。
- `tests/test_local_app_resources.py`（新）：执行器接入——license 申请/释放、配额排队/超时 → `WorkflowExecutionError`、`degrade` 标记写回。
- `tests/test_apps_router_resources.py`（新）：`GET /api/apps/resources` 形状 + `GET /api/apps` 描述补字段。
- `tests/test_tool_gateway_app_resources.py`（新，可并入既有 gateway 测试）：工具网关 app provider 经同一 manager 受治理（钉死咽喉唯一）。
- 回归：`tests/test_apps_session.py`/`test_app_session_manager.py`（若存在）在 governor 缺省下不变；`tests/test_local_app*.py` 全绿。

## 7. 风险
- **死锁**：多维度 + license 若分别申请会互相等待 → 固定顺序 + 一次性原子申请 + `acquire_many` 排序；补并发测试。
- **超卖（degrade）**：显式配置才启用，默认 `wait`；`degrade` 只告警不失败。
- **单进程边界**：多 worker 下配额不全局一致（记录为已知边界，与 scheduler/sandbox `memory` 契约一致）。
- **Windows 文件锁语义**：`msvcrt.locking` 需 `seek(0)` 且为字节范围锁；跨进程测试要在 Windows/POSIX 都通过（POSIX 分支在 CI 上被视为既知平台差异）。
- **`exclusive` 与 license 叠加**：attach 复用不得重复占 slot（补测试）。
- **不改 `flow:parallel`/`skills/projection.py`**：降低回归面。

## 8. 执行顺序（确认后）
1. `deerflow/locks/file_lock.py`（可重入 + 跨进程 + `acquire_many`）+ 单测。
2. 配置：`AppDefinition.resources` + `AppsConfig.resources/licenses/on_conflict/acquire_timeout_seconds` + 校验 + `config.example.yaml` + `config_version` 37 + 版本/边界测试。
3. `deerflow/resources/governor.py`（容量/占用/FIFO 等待/license slots/策略）+ 单测。
4. `AppSessionManager` 接入（license 实例级 + 操作级配额，`try/finally` 释放）+ 单测。
5. `local_app.py` 执行器错误翻译 + `degraded` 标记写回 + 单测。
6. `runtime/context_keys.py` 新键 + Gateway `app.py` 构造/注入 governor + 工具网关路径测试。
7. `GET /api/apps/resources` + `GET /api/apps` 描述补字段 + 路由测试。
8. 文档同步（根/backend `AGENTS.md`、规划进度、`config.example.yaml` 注释）+ 全量离线回归 + ruff + 提交。
