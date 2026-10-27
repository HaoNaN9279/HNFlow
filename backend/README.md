# HNFlow 后端

FastAPI Gateway + DeerFlow agent harness。后端同时承担两件事：

1. **对话运行时**：Lead Agent、中间件链、工具、MCP、Skills、Memory、Subagent。
2. **工作流运行时**：工作流定义/校验/编译、节点执行、断点续跑、人工挂起、运行事件流。

目录细节、约束与测试要求见 [AGENTS.md](AGENTS.md)。

## 分层

| 层 | 目录 | 导入前缀 | 说明 |
| --- | --- | --- | --- |
| 公共扩展契约 | `packages/extension-api/` | `deerflow_extension_api.*` | 不依赖 `deerflow` |
| Agent 框架 | `packages/harness/deerflow/` | `deerflow.*` | 可发布 harness |
| 应用层 | `app/` | `app.*` | FastAPI Gateway，可导入 harness，反向禁止 |

依赖方向由 `tests/test_harness_boundary.py` 强制。

## 主要模块

- `app/gateway/` —— REST 路由、run 生命周期、SSE、CORS/CSRF、健康检查。
- `app/scheduler/`、`app/mcp_tasks/` —— 定时任务与 MCP 长任务运行时。
- `deerflow/agents/` —— Lead Agent、ThreadState、中间件链、Memory。
- `deerflow/workflow/` —— 定义、编译、executor、提示词、验证、回放、撤销。
- `deerflow/runtime/` —— RunManager、worker、checkpointer、事件流、goal loop。
- `deerflow/sandbox/` —— 本地/Docker/E2B/BoxLite/Tenki 沙箱与文件工具。
- `deerflow/mcp/`、`skills/`、`tools/`、`subagents/`、`extensions/` —— 能力接入。
- `deerflow/projects/`、`apps/`、`assets/`、`environment/`、`portability/` —— 项目、本地应用、资产、环境探测、备份迁移。
- `deerflow/persistence/` —— ORM、仓库、Alembic 迁移与 bootstrap。

## 命令

```bash
make install            # 安装后端依赖
make dev                # Gateway（端口 8001，runtime-safe reload）
make gateway            # 仅启动 Gateway
make test               # 离线测试（排除 live 外部 API）
make test-live          # 显式 live 测试，需要配置与凭据
make test-blocking-io   # Blockbuster 运行时门禁
make lint               # ruff
make format             # ruff format
make migrate-rev MSG="..."  # 生成 Alembic revision
```

不要用裸 `uvicorn --reload` 替代 `make dev`：agent 会写入 `HNFLOW_HOME`，裸 reload 会在运行中重启 Gateway。

完整栈从仓库根启动：

```bash
make dev        # http://localhost:2026
make test
```

## 配置

- 用户数据根：`hnflow-data/`（`HNFLOW_HOME`）；兼容别名 `DEER_FLOW_HOME`。
- 主配置：`hnflow-data/config.yaml`；扩展配置：`hnflow-data/extensions_config.json`。
- 配置优先级：显式参数 → `DEER_FLOW_CONFIG_PATH` → `$HNFLOW_HOME/config.yaml` → 旧位置。
- `config_version` 落后时启动会告警；`make config-upgrade` 合并缺失字段。
- `plugins:` 只从 `config.yaml` 读取，不进入 API 可写的扩展配置。

## 测试

- 功能与 bug 修复必须带测试，放在 `tests/`，命名 `test_<feature>.py`。
- 默认套件离线运行；live 测试显式开启，不加入默认 CI。
- Windows 兼容：不要假设 POSIX 语义，符号链接/chmod/shell 测试需跳过。
- 运行事件契约变更需同步 `constants.py`、`runtime/events/catalog.py`、`contracts/run_event_stream_contract.json`、`docs/RUN_EVENT_STREAM.md` 与契约测试。

## 文档

- [AGENTS.md](AGENTS.md) —— 开发约束与架构唯一来源。
- [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) —— 系统架构。
- [docs/API.md](docs/API.md) —— API 参考。
- [docs/CONFIGURATION.md](docs/CONFIGURATION.md) —— 配置项。
- [docs/RUN_EVENT_STREAM.md](docs/RUN_EVENT_STREAM.md) —— 运行事件流契约。
- [docs/STREAMING.md](docs/STREAMING.md) —— 流式设计。
- [docs/FILE_UPLOAD.md](docs/FILE_UPLOAD.md) —— 文件上传。
- [docs/MCP_SERVER.md](docs/MCP_SERVER.md) —— MCP。
- [docs/BLOCKING_IO_DETECTION.md](docs/BLOCKING_IO_DETECTION.md) —— 阻塞 IO 检测。
- [docs/REPLAY_E2E.md](docs/REPLAY_E2E.md) —— 回放测试。
