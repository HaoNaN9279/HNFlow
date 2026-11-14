# AGENTS.md

本仓库的交付物是 **`plugins/dsh`**（DSH 插件 `dsh-hnflow`）、`capability-groups/`、`tools/`
和 `src/hnflow_stack/`（Python 解析器与 CLI）。旧 HNFlow 的 `backend/`、`frontend/`、`docker/`、
`scripts/`、`contracts/` 和旧执行引擎已移除，不要再引入。

## 先读什么

1. [`plugins/dsh/README.md`](plugins/dsh/README.md) —— 安装、三行装配、页面/命令/工具、技能、数据布局。
2. [`docs/architecture.md`](docs/architecture.md) —— 能力组、依赖、工作流与单插件架构。
3. [`docs/resolve-api.md`](docs/resolve-api.md) 与 [`docs/model-layers.md`](docs/model-layers.md) —— 解析输出契约与模型层。
4. [`docs/game-dev/`](docs/game-dev/) —— 领域能力组与流程的开发计划，能力组开发文档的写法示例。

## 修改约定

- 插件是单包 ESM，测试在 `plugins/dsh/test/`，入口 `node test/run.mjs`。
- 用户可见变更同步 `plugins/dsh/README.md`；架构变更同步 `docs/architecture.md`，解析契约变更同步 `docs/resolve-api.md`。
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
| `docs/resolve-api.md` | 解析输出契约与 CLI 参数 |
| `docs/model-layers.md` | 模型层与路由配置 |
| `docs/session-preview.md` | 上下文预览与注入顺序 |
| `docs/game-dev/` | 游戏开发能力组与流程的开发计划 |

## 能力组开发文档的目录规则

- 每个能力组一份目录：`docs/<组名>/`（如 `docs/game-dev/`），组根文档仍留在 `docs/` 顶层（`architecture.md`、`resolve-api.md`、`model-layers.md`、`session-preview.md`）。
- 只保留当前版本：旧版本的方案、迁移记录、回归清单在版本结束后删除；不建 `v1/`、`archive/`、`old/` 这类历史目录，历史由 Git 保存。
- 文件命名 `<组名>-<主题>.md`，同一组内主题不重复；一个组文档只描述该组当前设计，不写「曾经怎样」。
- 目录内互链用相对路径（`game-dev-workflow-plan.md`），跨目录用仓库相对路径，指向的必须是现存文件。
- 组内容（规则/技能/流程/工具）住在 `capability-groups/` 与 `tools/`，`docs/<组名>/` 只放计划与说明，不复制组内容。
