# AGENTS.md

本仓库的交付物是 **`plugins/dsh`**（DSH 插件 `dsh-hnflow`）、`capability-groups/`、`tools/`
和 `src/hnflow_stack/`（Python 解析器与 CLI）。旧 HNFlow 的 `backend/`、`frontend/`、`docker/`、
`scripts/`、`contracts/` 和旧执行引擎已移除，不要再引入。

## 先读什么

1. [`plugins/dsh/README.md`](plugins/dsh/README.md) —— 安装、三行装配、页面/命令/工具、技能、数据布局。
2. [`docs/architecture.md`](docs/architecture.md) —— 能力组、依赖、工作流与单插件架构。
3. [`docs/dsh-plugin-plan-v2.md`](docs/dsh-plugin-plan-v2.md) —— 统一方案与迁移记录。
4. [`docs/新开发理念.md`](docs/新开发理念.md) —— 约束式流程、人的交付契约、独立验收。

## 修改约定

- 插件是单包 ESM，测试在 `plugins/dsh/test/`，入口 `node test/run.mjs`。
- 用户可见变更同步 `plugins/dsh/README.md`；架构/契约变更同步 `docs/dsh-plugin-plan-v2.md`。
- 门禁裁决、人工交付是人的动作；工作流没有 publish/rollback，Agent 只能创建/起草/删除/改名项目本地流程。
- 模型面动作变化时同步 `plugins/dsh/skills/hnflow-controls/SKILL.md`；`test/controls-skill.test.js` 会从动作表反查技能全文。
- 不重新引入 Python 后端、Next.js 前端、Nginx、Docker Compose 或旧 `WorkflowDefinition` 编译器。
- 提交前运行：

```sh
cd plugins/dsh
node test/run.mjs

# Python 解析器测试（Linux/macOS 或可写临时目录）
python -m pytest tests -q
```

## 文档地图

| 文档 | 用途 |
| --- | --- |
| `plugins/dsh/README.md` | 使用手册 |
| `docs/architecture.md` | 当前架构与边界 |
| `docs/dsh-plugin-plan-v2.md` | 统一方案与迁移记录 |
| `docs/新开发理念.md` | 设计理念来源 |
| `docs/dsh-upgrade-checklist.md` | DSH 版本升级回归清单 |
