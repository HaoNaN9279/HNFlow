# Copilot 工作指引

本仓库是 HNFlow：图驱动的确定性 AI 工作流编排引擎，内核为 DeerFlow harness（LangGraph super agent 底座）。

开发约束以模块文档为准，不要在本文重复维护：

- 仓库导览与跨切约定：[../AGENTS.md](../AGENTS.md)
- 后端：[../backend/AGENTS.md](../backend/AGENTS.md)
- 前端：[../frontend/AGENTS.md](../frontend/AGENTS.md)
- 安装：[../Install.md](../Install.md)
- 使用：[../README.md](../README.md)

## 快速命令

```bash
make check / install / dev       # 根目录
make test / lint / format        # 后端
pnpm check / test / test:e2e     # 前端
```

## 基本要求

- 功能与 bug 修复必须带测试。
- 后端提交前 `make format`；前端提交前 `pnpm check`。
- `tool:bash` 必须走 sandbox；`app:*` 是宿主执行例外。
- 不要提交密钥或 `hnflow-data/` 内容。
- 架构、命令、约定变化时同步更新对应 `AGENTS.md`。
