# P1 — 长期实例管理（切片 2：N6）执行计划

> 依据《HNFlow 开发方案》§18（长期运行与调度）、《HNFlow 开发规划》§五 P1 第 3 项。
> 状态：**已完成（S1–S7）**。

## 1. 目标与范围

N6 = **长期实例管理**：实例可持续数天/数周；提供**实例列表 / 状态 / 恢复 / 归档 / 清理**与**资源累计**；底层复用 LangGraph checkpointer（§18）。

本切片只做 N6，不含 N7（触发/调度）、N8（资源治理）、N9–N11。

切片 1（N4+N5）会话为**进程内内存态**；N6 把它升级为**可持久化的实例记录**：
- 实例生命周期跨 Gateway 重启可见（重启后旧活动实例标记 `orphaned`）；
- 提供实例 CRUD + 归档 + 清理 + 每实例资源累计；
- live 会话仍由 `AppSessionManager` 持有（进程内），DB 记录为**写穿透/兜底**，不改变驱动语义。

## 2. 现状调查

**可复用**
- 会话运行时：`apps/session.py::AppSessionManager`（live 内存 map + driver 分派）、`AppSession.to_port()`（JSON 句柄）。
- 执行器：`workflow/executors/local_app.py` 4 个 `exec_app_*`（`asyncio.to_thread` 调 manager）。
- 运行期注入：`runtime/runs/worker.py::_build_runtime_context`（先例 `human_task_repo` / `WORKFLOW_RUNTIME_CONTEXT_KEY` / `APP_RUNTIME_CONTEXT_KEY`）。
- 持久化先例：`persistence/human_tasks/`（model + sql + `__init__`）、迁移 `0013_human_tasks.py`；`deps.py` 用 `get_session_factory()` 构造 repo 挂 `app.state`（memory 后端 → None）。
- 启动恢复先例：`RunManager.reconcile_orphaned_inflight_runs`（标记孤儿，非重跑）。
- 路由先例：`routers/apps.py`（现状只读：`GET /api/apps`、`GET /api/apps/sessions`）。
- 迁移 HEAD = `0016_drop_feedback_table`（新迁移将是 `0017_*`）。

**缺口（全新）**
- 无任何实例持久化表/仓库；session 仅内存，Gateway 重启即丢。
- 无状态过滤、无归档/清理、无每实例资源累计、无启动孤儿恢复。
- `config.yaml apps:` 无保留期/持久化开关字段。

## 3. 设计草案

### 3.1 持久化（harness `persistence/app_instances/`）
新表 `app_instances`（列与既有表同风格）：
`id(session_id)` PK、`user_id`(默认 `default`, idx)、`app_name`、`driver`、`status`、`pid`、`endpoint`、`handle`(JSON)、`exclusive`、`created_at`、`last_active`、`archived_at`、`resources`(JSON：`scripts_run`/`artifacts`/`busy_seconds`/`last_error`)、`updated_at`。
迁移 `0017_app_instances.py`（`has_table` 幂等，建 `ix_app_instances_user_id` + 建议 `ix_app_instances_status`）。
`AppInstanceRepository`：`create`、`get`、`list_by_user(status=None, include_archived=…)`、`record_operation`（累加 resources + 刷新 status/last_active）、`set_status`（条件 UPDATE，镜像 human_tasks 的 `_transition` 安全写法）、`archive`（仅非 live）、`delete`、`cleanup(older_than_days, statuses)`、`mark_orphaned(active_statuses)`。
- **恢复语义（决策 3）**：无自动重连；`mark_orphaned` 把上次进程遗留的非终态行标为 `orphaned`。

### 3.2 写入路径（决策 2：写穿透 + best-effort）
- 不改 `AppSessionManager` 的同步驱动调用语义；在**异步执行器**里 op 成功后 `await repo.record_*`。
- 新 harness 模块 `apps/persistence.py`：`record_launch(repo, session)` / `record_operation(repo, session, *, resources)` 等小工具，集中处理「repo 缺省跳过 + 失败仅告警」。
- `apps/context`：沿用 `APP_RUNTIME_CONTEXT_KEY`(=manager) 不变；新增 `APP_INSTANCE_REPO_CONTEXT_KEY`（`runtime/context_keys.py`）注入 repo。工具网关 `app` provider 同样写穿透。
- **失败策略**：持久化失败**不**使 launch/script 失败（日志告警），live 操作优先。

### 3.3 读取/管理面（Gateway `routers/apps.py` 扩展）
| 端点 | 说明 |
|---|---|
| `GET /api/apps/sessions` | 扩展：`?status=`/`?include_archived=`；DB 后端返回持久化记录（并 merge live 状态），memory 后端仅 live |
| `GET /api/apps/sessions/{id}` | 单实例详情 |
| `POST /api/apps/sessions/{id}/close` | 停止 live 会话（若在内存）并落库 `stopped` |
| `POST /api/apps/sessions/{id}/archive` | 归档（仅非 live） |
| `DELETE /api/apps/sessions/{id}` | 删除记录 |
| `POST /api/apps/sessions/cleanup` | 按保留期/状态清理（`older_than_days` 缺省取配置） |

- memory 后端（repo=None）：列表回落 live；mutations 返回 503（与 console 等路由一致）。
- 启动恢复：`deps.py` lifespan 里 `await repo.mark_orphaned(...)`（repo 存在时）。

### 3.4 配置（`config/apps_config.py` + `config.example.yaml`）
`AppsConfig` 增：`session_retention_days: int = 30`、`persist_sessions: bool = True`（DB 后端生效；memory 自动退化）。`config_version` 34 → 35。
（`apps` 仍为 startup-only，驱动生命周期不变。）

### 3.5 前端
本切片**不改前端**（决策 5）：后端 + API 先行，`/api/apps/sessions` 目前无前端消费者；实例管理 UI 另开切片。

## 4. 决策（待确认）
1. **范围**：只做 N6（持久化 + 列表/状态/恢复/归档/清理 + 资源累计）；N7–N11 各自独立计划。—— 推荐
2. **写入策略**：DB 记录写穿透、**best-effort**（持久化失败不回滚 live 操作，仅告警）。—— 推荐（也可选严格写：失败即报错）
3. **恢复语义**：重启后旧活动实例**标记 `orphaned`**，不自动重连/重拉（自动重连风险高，属 N7）。—— 推荐
4. **归档/清理**：状态机 + `DELETE` + `cleanup`（保留期配置，默认 30 天）；**不做**自动定时清理（N7 管调度）；清理仅手动 API 调用。—— 推荐
5. **前端**：本切片**不动前端**（后端 + API only）。—— 推荐（若要，可加只读实例列表，需另计工作量）
6. **资源累计**：仅每实例轻量计数（脚本次数 / 产物数 / 忙时 / 最近错误）；GPU/内存/License 并发属 N8。—— 推荐

## 5. 验收标准
- `database.backend: sqlite` 下：`app:launch`→`script`→`wait`→`collect` 后，`app_instances` 有记录，`resources` 计数随操作累加。
- `GET /api/apps/sessions?status=ready` 过滤正确；`archive`/`DELETE`/`cleanup` 生效；memory 后端 mutations 返回 503。
- 模拟重启（重建 engine + 调 `mark_orphaned`）：遗留活动行变 `orphaned`，不出现在 live 列表但仍可查/归档/删除。
- 持久化失败被吞咽且 live 操作仍成功（单测注入抛错 repo）。
- 后端 pytest 全绿（新增 `test_app_instance_repository.py`、扩展 `test_apps_router.py`/`test_workflow_app_*`）；ruff 干净。

## 6. 测试策略（TDD，强制）
- `tests/test_app_instance_repository.py`（CRUD/过滤/条件转移/archive/cleanup/mark_orphaned/资源累加、user 隔离）
- `tests/test_apps_persistence.py`（写穿透 helpers：repo 缺省跳过、失败吞咽）
- 扩展 `tests/test_workflow_app_executors.py` / `_integration`（注入 repo 后落库 + 计数）
- 扩展 `tests/test_apps_router.py`（列表过滤/详情/close/archive/delete/cleanup、memory 503）
- 迁移：`test_persistence_scaffold` 风格或 `alembic upgrade head` 冒烟（新表存在）
- `tests/test_reload_boundary.py`（apps 仍 startup-only）；`config_version` 校验随例更新。

## 7. 风险
- sync manager ↔ async repo 边界：以「执行器 op 后 await 写」而非改造 manager 为 async，避免大改与阻塞事件循环。
- 重启后 pid/handle 失效：不信任持久化 `pid`，恢复只做标记，不做健康重连。
- 与 N7/N8 边界：本切片不引入调度/资源配额，避免越界。

## 8. 执行顺序（确认后）
1. 迁移 `0017_app_instances` + `persistence/app_instances/{model,sql,__init__}.py` + 仓库测试。
2. `config/apps_config.py`（保留期/持久化开关）+ `config.example.yaml` + `config_version` + reload 边界测试。
3. `apps/persistence.py` 写穿透 helpers + `context_keys` 新键 + worker 注入 + 单测。
4. 执行器接入写穿透 + 集成测试。
5. `deps.py` 构造 `AppInstanceRepository` 挂 `app.state` + 启动 `mark_orphaned`。
6. `routers/apps.py` 扩展（list/detail/close/archive/delete/cleanup）+ 路由测试。
7. 文档同步（根/backend `AGENTS.md`、规划进度、`config.example.yaml` 注释）+ 全量回归 + 提交。
