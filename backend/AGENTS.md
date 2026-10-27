# AGENTS.md —— 后端

本文件是后端模块的唯一开发指引。用户安装见根 [Install.md](../Install.md)，产品概览见根 [README.md](../README.md)。

## 1. 分层与边界

| 层 | 目录 | 导入前缀 | 规则 |
| --- | --- | --- | --- |
| 扩展契约 | `packages/extension-api/` | `deerflow_extension_api.*` | 不得导入 `deerflow` |
| Harness | `packages/harness/deerflow/` | `deerflow.*` | 不得导入 `app.*` |
| Gateway | `app/` | `app.*` | 可导入 harness |

边界测试：`tests/test_harness_boundary.py`。`deerflow.agents` / `deerflow.subagents` 包根使用惰性导入，内部模块应导入具体子模块，避免拉起重图。

## 2. 命令

```bash
make install                # 安装依赖
make dev                    # Gateway（8001，runtime-safe reload）
make gateway                # 仅 Gateway
make test                   # 离线测试
make test-live              # 显式 live 测试
make test-blocking-io       # Blockbuster 运行时门禁
make lint / format          # ruff
make migrate-rev MSG="..."  # 生成 Alembic revision
```

不要用裸 `uvicorn --reload`：`HNFLOW_HOME` 下的运行时写入会触发重启，中断正在执行的 run。

根目录另有 `make detect-thread-boundaries` / `make detect-blocking-io`，输出写入 `.deer-flow/*.json`。

## 3. 运行时总览

- Gateway 启动时装配 `RunManager` + `run_agent()` + `StreamBridge`；Nginx 把 `/api/langgraph/*` 重写为 Gateway 原生 `/api/*`。
- 单机单 worker 为默认部署（`GATEWAY_WORKERS=1`），SSE 由进程内 bridge 承担。多 worker 需要 `run_events.backend: db` 与 Redis stream bridge，启动门禁会拒绝不满足的组合。
- 支持的流模式：`values`、`messages-tuple`、`updates`、`debug`、`tasks`、`checkpoints`、`custom`；`messages` / `events` 等未支持模式在 HTTP 前拒绝。
- `Last-Event-ID` 早于保留水位或订阅者落后时，bridge 发送无 id 的 `gap` 控制帧；前端重载持久历史后从服务端保留尾部重新加入，run 不因 gap 结束。
- 调度任务必须复用同一 run 生命周期，不引入平行执行栈。
- 后台 subagent 的 `tool_call_id` 仅作关联键；`SubagentResult.task_id` 使用服务端生成的 `execution_id`。
- 长时 MCP 任务由 `McpTaskService` 租约驱动，状态落 `mcp_tasks`，数据库为唯一真相。
- 定时任务 `overlap_policy=skip` 由 `uq_scheduled_task_run_active` 部分唯一索引原子保证；服务层检查只是快速路径。

### RunManager / RunStore

- `RunManager.get()` 为 async。
- 历史批量查询默认 `user_id=AUTO`，无用户上下文时 fail-closed；管理/迁移显式传 `None`。
- 有持久 Store 时历史 run 从 Store 水合，同 `run_id` 的内存记录优先。
- `cancel()` 返回 `cancelled` / `not_active_locally` / `not_cancellable` / `unknown`。
- 线程操作（`run` / `checkpoint_write` / `artifact_write`）共享持久活跃线程唯一约束；新操作类型必须走 `RunStore.create_thread_operation_atomic()`，不要新增锁。
- Gateway 侧 checkpoint 写入必须走 `services.reserve_checkpoint_write()`。
- 启动时用 `claim_for_takeover()` 接管孤儿活跃 run；Gateway 负责发布 `END_SENTINEL` 并清理流。
- 线程 `goal` 在可见回合结束后由非 thinking 评估模型判定；未达成可追加隐藏 continuation，上限 8，连续 2 次无新增可见输出即停止。
- 运行事件契约变更必须同步：生产者代码、`deerflow/constants.py`、`runtime/events/catalog.py`、`contracts/run_event_stream_contract.json`、`docs/RUN_EVENT_STREAM.md`、`tests/test_run_event_stream_contract.py`。

## 4. Agent 系统

- 入口：`make_lead_agent(config)`，注册于 `langgraph.json`。
- 模型：`create_chat_model()`，支持 thinking / vision / vLLM。
- 工具：`get_available_tools()` 合并 sandbox、builtin、MCP、community、subagent。
- 提示词：`apply_prompt_template()` 注入 skills、memory、subagent 说明。
- `ThreadState` 在 `AgentState` 上增加 `sandbox`、`thread_data`、`title`、`artifacts`、`todos`、`uploaded_files`、`viewed_images`、`goal`、`promoted`、`delegations`、`skill_context`、`summary_text`，并定义对应 reducer。
- 运行时配置：`thinking_enabled`、`model_name`、`is_plan_mode`、`subagent_enabled`、`max_concurrent_subagents`、`max_total_subagents`。

### 中间件链

共享基础链（`build_lead_runtime_middlewares`，subagent 复用大部分）：

1. `InputSanitizationMiddleware`
2. `ToolOutputBudgetMiddleware`
3. `ToolResultSanitizationMiddleware`
4. `ThreadDataMiddleware`
5. `UploadsMiddleware`
6. `SandboxMiddleware`
7. `DanglingToolCallMiddleware`
8. `LLMErrorHandlingMiddleware`
9. `SandboxAuditMiddleware`
10. `ReadBeforeWriteMiddleware`（可选，默认开）
11. `ToolProgressMiddleware`（可选）
12. `ToolErrorHandlingMiddleware`

Lead 专属链（`build_middlewares` 追加）：

13. `DynamicContextMiddleware`
14. `SkillActivationMiddleware`
15. `SkillToolPolicyMiddleware`
16. `DurableContextMiddleware`
17. `SummarizationMiddleware`（可选）
18. `TodoListMiddleware`（`is_plan_mode`）
19. `TokenUsageMiddleware`（可选）
20. `TitleMiddleware`
21. `MemoryMiddleware`
22. `ViewImageMiddleware`（vision 模型）
23. `McpRoutingMiddleware`（可选）
24. `DeferredToolFilterMiddleware`（可选）
25. `SystemMessageCoalescingMiddleware`
26. `SubagentLimitMiddleware`（可选）
27. `LoopDetectionMiddleware`（可选）
28. `TokenBudgetMiddleware`（可选）
29. 程序化 custom middlewares
30. `config.yaml` / `extensions_config.json` 声明的扩展中间件
31. `TerminalResponseMiddleware`
32. `ModelLengthFinishReasonMiddleware`
33. `SafetyFinishReasonMiddleware`（可选）
34. `ClarificationMiddleware`（必须最后）

关键约束：

- 重复工具调用与结果质量由 `LoopDetectionMiddleware` 与 `ToolProgressMiddleware` 分工，二者互不读取内部状态。
- `SkillToolPolicyMiddleware` 只对真实激活的 skill 生效；slash 激活抑制 `skill_context` 策略。
- `DeferredToolFilterMiddleware` 必须位于 `McpRoutingMiddleware` 之后。
- `ClarificationMiddleware` 拦截 `ask_clarification`，写入 `ToolMessage.artifact.human_input` 并通过 `Command(goto=END)` 中断。

## 5. 配置系统

统一根：`HNFLOW_HOME`（默认 `hnflow-data/`，兼容 `DEER_FLOW_HOME`）。

```text
hnflow-data/
├── config.yaml / extensions_config.json / .env / frontend.env
├── prompts/lead-agent.md
├── skills/
├── data/deerflow.db
└── users/{user_id}/threads/{thread_id}/...
```

- 主配置优先级：显式参数 → `DEER_FLOW_CONFIG_PATH` → `$HNFLOW_HOME/config.yaml` → 旧位置。
- 扩展配置优先级：显式参数 → `DEER_FLOW_EXTENSIONS_CONFIG_PATH` → `$HNFLOW_HOME/extensions_config.json` → 旧位置。
- `$VAR` 值解析为环境变量。
- `config_version` 落后时启动告警；`make config-upgrade` 合并缺失字段。修改 schema 时同步提升版本。
- `get_app_config()` 按路径 + 内容签名自动重载；Gateway 每次请求重新读取，因此模型、压缩、标题、memory、subagents、tools 等按 run 生效。
- 仅启动期字段：`plugins`、`database`、`checkpointer`、`run_events`、`stream_bridge`、`sandbox`、`log_level`、`logging`、`scheduler`、`mcp_tasks`、`apps`、`assets`，权威列表在 `config/reload_boundary.py::STARTUP_ONLY_FIELDS`。
- 能力组/工具包来自外部 VibeStack（`vibestack.repository` → `VIBESTACK_HOME` / `VIBESTACK_REPO` → `~/.config/vibestack/config.json`）；HNFlow 不播种、不写入。
- 项目激活：`<project>/.vibestack/stack.json`；Core 固定，保存工作流只增量 upsert。
- 项目运行元数据携带 VibeStack MCP 服务器与 fingerprint；`mcp/project.py` 在内存中合并到 `extensions_config.json`，不持久化。

## 6. Gateway API

端口 8001，健康检查 `GET /health`；`GATEWAY_ENABLE_DOCS=false` 可关闭 OpenAPI 文档。单用户构建：无登录/会话/CSRF/OIDC，有效用户固定为 `DEFAULT_USER_ID`（`"default"`）。

CORS 默认同源；跨源部署需设置 `GATEWAY_CORS_ORIGINS`，并暴露 `Content-Location`（SDK 从该头解析 run）。

主要路由：

| 路由 | 作用 |
| --- | --- |
| `/api/models` | 只读实际模型目录 |
| `/api/model-profiles` | AI 节点模型档案 CRUD |
| `/api/features` / `/api/environment` | 功能开关 / 环境探测 |
| `/api/backup` | 备份计划（只读；导入走 CLI） |
| `/api/apps` | 本地应用注册、presence、资源与实例管理 |
| `/api/console` | 跨线程统计、运行历史、用量 |
| `/api/mcp` | MCP 配置读取/替换/切换 |
| `/api/skills` | skills 列表、启停、安装、reload |
| `/api/memory` | 记忆数据、配置、状态、reload |
| `/api/threads/{id}/uploads` | 上传/list/删除 |
| `/api/threads/{id}` | 清理、分支、goal、compact、资源撤销 |
| `/api/threads/{id}/artifacts` | 产物下载与原子替换 |
| `/api/threads/{id}/runs` | 创建/流式/等待 run、regenerate、edit-regenerate、历史、事件、workspace-changes、token usage |
| `/api/runs` | 无状态 run |
| `/api/workflows` | 定义 CRUD、模板、评测、运行、继续、状态、成本、预览、撤销 |
| `/api/workflow-folders` | 任意层级目录树 |
| `/api/workflow-monitor` | 跨工作台运行汇总（只读） |
| `/api/human-tasks` | 待办查询、提交、跳过、打回 |
| `/api/projects` | 文件化项目与工作台 |
| `/api/scheduled-tasks` | 定时任务与运行历史 |
| `/api/specifications` | 规约列表、revision、freeze、lint |

运行相关：

- `RunCreateRequest` 只接受真实支持的子集，未实现选项返回 422，不静默丢弃。
- `POST /wait` 通过 `wait_for_run_completion()` 排空 bridge，尊重 `on_disconnect`。
- 分支/重生成使用 `checkpoint_lineage.py` 沿 `parent_config` 查找，禁止按全局时间线选兄弟分支。
- 工作区变更由 `workspace_changes/` 在 run 前后快照 `workspace`/`outputs`，排除 uploads、浏览器截图与工具输出外部化目录。

## 7. 工作流子系统

代码：`packages/harness/deerflow/workflow/`。

### 定义层

- `schema.py`：节点/边/端口/类型，Pydantic v2，不依赖 LangGraph。
- `workflow_io.py`：`validate_definition`（无环、单起点单终点、端口类型、单入边、Schema/verify 边）与 `serialize`/`deserialize`。
- 端口类型：`data/file/bool/enum/number/array/record/spec`。
- 同一输入端口只允许一条入边；`flow:end`、`flow:loop` 例外。
- `tool:bash` 必须走 sandbox；`app:*` 是宿主执行例外。
- `verify:gate` 三分支 `verified/failed/inconclusive` 必须全部接线。

### 编译层

`compiler.py`：`WorkflowDefinition → StateGraph`。

- 端口绑定到 state 字段 `wf:<node_id>:<port>`；节点执行函数与 state 解耦。
- 生成节点生命周期事件；loop/try/handoff 展开；共享工作区；资源锁；编译缓存；verify 路由。
- 编译前做嵌套深度限制（默认 ≤10）与全局依赖循环检测。
- 运行使用准入时的定义快照，编辑不热更新当前 run。

### 执行层

- `worker.py`：run 编排、checkpointer、事件流、人工挂起/恢复、取消。
- `runtime_context.py`：唯一 compile/runtime context 装配点。
- `executors/`：`flow`、`data`、`asset`、`tool`、`local_app`、`human`、`review`、`ai`、`spec`、`verify`。
- `prompts.py` / `prompt_preview.py`：identity / capability / capability_rules / capability_skills / specification / schema_contract / task / schema 桶。
- `structured_output.py`：Schema 解析、校验、修复、Envelope。
- `context_compression.py`：按模型 `context_window` 自动压缩。
- `evals.py` / `replay.py` / `budgets.py` / `costs.py` / `reliability.py` / `dispatch.py`：评测、回放、预算、成本、幂等、调度。

### AI 节点契约

- `params.model_profile` 是唯一模型选择器；profile 指向 `config.yaml -> models[]`，不可链式。
- `template_prompt` 是本轮唯一任务输入；`continue_prompt` 续接节点会话。
- `input_schema` / `output_schema` 都是 `record` 输入，来自同一个 `data:schema` 节点；编译器注入 `__input_schema` / `__output_schema`。
- 输出为 AI Result Envelope：`protocol/source_node/run_id` + `summary/status/content/artifacts/metadata/error` + `custom`。
- Schema payload：`{"version": 1, "max_repairs": 1, "custom_fields": [...]}`；旧 `fields` 格式不支持。
- `template_prompt` 用 `[schema.summary]` / `[schema.custom.<name>]` 引用输入；未知引用 fail-loud。
- 无 `output_schema` 时原文本包装为 common-only envelope；schema 模式不支持 continue。
- AI 节点不委派 subagent、无 token 预算、无节点级记忆/知识检索。

### 人工、验证、容错

- `human:task`：挂起生成 `human_tasks` 行；提交校验后恢复，支持 skip/reopen。
- `human:review`：`approved` 前向、`rejected` 回跳到上游 AI 的 `continue_prompt`；review 任务不可 skip。
- `verify:gate`：冻结规约 + verifier 工具（`spec_lint`、`dafny_verify`、`tla_model_check`、`lean_check`、`cel_evaluate`、`mock_verifier`）；verifier 崩溃/超时为 `inconclusive`，不是失败证据。
- `flow:handoff`：`params.candidates` 白名单，离开节点的定义边是编译错误；`max_handoffs` 默认 8。
- `debug_step`：run 级单步开关，每节点前生成 `kind="step"` 待办。
- 幂等键由编译器注入 `<run_id>:<node_id>`，`tool:bash`/`tool:http` 透传。
- 补偿：`data:file`、`data:asset`、`app:script` 默认快照/回滚；undo 记录按最新优先恢复。
- 重生成、编辑重跑、分支严格使用 checkpoint lineage。

## 8. Sandbox

接口：`execute_command` / `read_file` / `write_file` / `list_dir` / `glob` / `grep`。

- Provider：`LocalSandboxProvider`、`AioSandboxProvider`（Docker）、`E2BSandboxProvider`、`BoxliteProvider`、`TenkiSandboxProvider`。
- 虚拟路径：`/mnt/user-data/{workspace,uploads,outputs}`、`/mnt/skills`；物理目录在 `hnflow-data/users/{user_id}/threads/{thread_id}/`。
- `env_policy.build_sandbox_env()` 清洗 `*KEY*`/`*SECRET*`/`*TOKEN*`/`*PASS*`/`*CREDENTIAL*`，再叠加请求级 secrets。
- Bash 在独立进程组中运行，默认超时 600s（`sandbox.bash_command_timeout`），超时杀整个组。
- 工具：`bash`、`ls`、`glob`、`grep`、`read_file`、`write_file`、`str_replace`。
- `read_before_write.enabled` 时，写入前必须存在匹配的读取哈希。
- AIO 跨实例容器所有权：`sandbox.ownership.type = memory | redis`；多实例必须 Redis。`memory` 明确单实例。
- 新增 provider 必须实现异步 acquire/release、健康检查、清理与测试。

## 9. MCP / Skills / Memory / Models

### MCP

- `deerflow/mcp/`：客户端、缓存、session pool、OAuth、`tool_search` 懒加载。
- `DeerFlowClient` 与 Gateway 共用工具装配。
- 配置写操作会重置进程级 MCP 缓存。
- MCP 长任务与 Agent loop 解耦，由 `McpTaskService` 驱动。

### Skills

- 目录：内置 `skills/public/` 种子到 `hnflow-data/skills/public/`；用户/集成视图在 `hnflow-data/users/{user_id}/skills_view/`。
- 发现、解析、启用、安装、安全扫描在 `deerflow/skills/`。
- 只有激活的 skill 才应用 `allowed-tools`；`tool_search` / `describe_skill` 始终可用。
- `/skill-name task` 与 Lead Agent 菜单的 `context.active_skills` 都会触发激活。

### Memory

- 后端可插拔：`deermem`（默认）、`noop`、`openviking`、`honcho`、`mem0`。
- `mode: middleware` 为被动提取；`tool` 暴露 `memory_search` / `memory_add` / `memory_update` / `memory_delete`。
- 存储按用户隔离：`users/{user_id}/memory.json` + `users/{user_id}/agents/{agent_name}/facts/`。
- 网络后端必须实现 `a*` 异步方法或将 IO offload；mem0 默认要求 HTTPS。
- 关闭时 `shutdown_flush(timeout)` 排空待写入。

### Models

- `create_chat_model()` 通过反射实例化；支持 `thinking_enabled`、`supports_vision`、`$ENV`。
- vLLM 使用 `VllmChatModel`，保留 `reasoning` 字段与可选 `cumulative_stream_usage`。
- 实际模型配置由运维维护；AI 节点只引用 model profile。

## 10. 项目、应用、资产与迁移

- `projects/`：文件化项目；`project.json` 与 workbench 文件是数据源，SQL 行只是镜像。
- `apps/`：宿主应用驱动（CLI/mock）、presence、资源治理、实例持久化；`app:*` 节点走此层。
- `assets/`：跨软件资产引用与 hash。
- `environment/`：只读环境探测；无法回答时返回 `unknown`，不 5xx。
- `portability/`：备份/导出/导入 CLI：`python -m deerflow.portability export|inspect|import`。
- `workspace/`：Lead Agent 的会话级资源编辑与撤销。

## 11. 持久化与迁移

- 应用表（`runs`、`threads_meta`、`run_events`、工作流、待办、撤销等）由 Alembic 管理；LangGraph checkpointer 表由 LangGraph 管理并从 Alembic 视图中排除。
- 新增 ORM 字段/表必须新增 `persistence/migrations/versions/` revision；Gateway 启动自动 `alembic upgrade head`。
- Bootstrap 三分支：空库 `create_all + stamp head`；旧库 `create_all(baseline) + stamp 0001 + upgrade`；已版本化直接 upgrade。
- 迁移使用 `safe_add_column` / `safe_drop_column` 幂等辅助；Postgres 用 advisory lock，SQLite 用进程锁 + busy timeout。
- 生成 revision：`make migrate-rev MSG="..."`。
- Checkpoint 模式：`full`（默认）/ `delta`；进程冻结、切换需重启，模式标记写入 checkpoint metadata，跨模式读取失败即 409/503。
- 线程状态访问必须走 `CheckpointStateAccessor`，不要直接 `get_tuple`。
- 多 worker 必须共享数据库与事件存储。

## 12. 扩展系统

- `config.yaml` 顶层 `plugins:` 是启动期、运维可控的代码执行边界；不得加入 API 可写的 `extensions_config.json`。
- 公共契约在 `packages/extension-api/`，贡献类型：middleware、task lifecycle、system model-call observer。
- 扩展中间件由 `IsolatedMiddleware` 包装，失败 fail-open 并记录诊断。
- Gateway 只加载一次插件，变更需重启。

## 13. 测试与代码风格

**TDD 强制**：每个功能/修复必须带测试。

```bash
make test            # 离线全套
make test-live       # 显式 live
PYTHONPATH=. uv run pytest tests/test_<feature>.py -v
```

- 命名 `test_<feature>.py`，放 `backend/tests/`。
- Windows：不要假设 POSIX；符号链接 `OSError`/`NotImplementedError` 跳过，chmod/PWD 断言仅 POSIX，路径用 `Path(...).as_posix()`；无 POSIX shell 时跳过 shell 测试。
- 阻塞 IO：`tests/blocking_io/` 用 Blockbuster 包裹 `app.*` 与 `deerflow.*`；异步路径上的同步阻塞 IO 必须 offload。
- 运行事件、工作流定义、Gateway 响应模型都有契约测试；改契约必须同步测试。
- 风格：ruff，行宽 240，双引号，Python 3.12+ 类型标注。

## 14. 文档索引

- [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)
- [docs/API.md](docs/API.md)
- [docs/CONFIGURATION.md](docs/CONFIGURATION.md)
- [docs/RUN_EVENT_STREAM.md](docs/RUN_EVENT_STREAM.md)
- [docs/STREAMING.md](docs/STREAMING.md)
- [docs/FILE_UPLOAD.md](docs/FILE_UPLOAD.md)
- [docs/PATH_EXAMPLES.md](docs/PATH_EXAMPLES.md)
- [docs/MCP_SERVER.md](docs/MCP_SERVER.md)
- [docs/BLOCKING_IO_DETECTION.md](docs/BLOCKING_IO_DETECTION.md)
- [docs/REPLAY_E2E.md](docs/REPLAY_E2E.md)
- [docs/summarization.md](docs/summarization.md)

用户可见变更同步根 `README.md`；架构、命令、约束变更同步本文件。
