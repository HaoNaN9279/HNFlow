# 后端贡献指南

开发约束以 [AGENTS.md](AGENTS.md) 为准，本文只列协作流程。

## 环境

- Python 3.12+，依赖用 `uv` 管理。
- Docker 可选，用于沙箱相关测试。

## 本地开发

从仓库根执行：

```bash
make config     # 首次生成 hnflow-data/config.yaml
make install    # 安装依赖与 pre-commit
make dev        # 启动完整栈
```

只开发后端：

```bash
cd backend
make dev
```

## 代码风格

- `ruff` lint + format，行宽 240，Python 3.12+ 类型标注。
- 提交前运行 `make format` 与 `make lint`；CI 强制 `ruff format --check`。

## 测试

- 功能与 bug 修复必须带测试，放在 `backend/tests/`。
- 默认离线套件：`make test`。
- live 外部 API 测试：`make test-live`，不要加入默认 CI。
- 涉及阻塞 IO 的改动运行 `make test-blocking-io`。
- Windows 上不要假设 POSIX 语义；符号链接、chmod、shell 测试需按条件跳过。

## 提交与 PR

1. 保持单一目的、小步提交。
2. 更新受影响的文档：用户可见行为更新 `README.md`，架构/约束更新 `AGENTS.md`。
3. 提交前确认：

```bash
cd backend
make lint
make test
```

4. PR 描述写清动机、行为变化、测试方式与风险；不要提交密钥或 `hnflow-data/` 内容。

## 架构边界

- `packages/harness/deerflow/` 不得导入 `app.*`。
- `packages/extension-api/` 不得导入 `deerflow`。
- 新增 ORM 字段/表必须新增 Alembic revision，不要手改生产数据库。
- 新中间件、工具、节点类型必须同时接入配置、校验、前端目录与测试。
