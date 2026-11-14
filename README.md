# HNFlow

HNFlow 是运行在 DeepSeek Harness 上的统一插件与能力组仓库。工作流是能力组的一种内容，
和能力组的规则、技能、Agent、命令、工具一起被解析、注入和运行。

仓库只有一个 DSH 插件 `dsh-hnflow`；能力组内容住在 `capability-groups/`，解析器与 CLI 在
`src/hnflow_stack/`。

## 入口

| 内容 | 位置 |
| --- | --- |
| DSH 插件安装、页面、命令、工具、数据布局 | [`plugins/dsh/README.md`](plugins/dsh/README.md) |
| 统一架构、能力组、工作流解析 | [`docs/architecture.md`](docs/architecture.md) |
| 解析 API | [`docs/resolve-api.md`](docs/resolve-api.md) |
| 模型层 | [`docs/model-layers.md`](docs/model-layers.md) |
| 上下文预览 | [`docs/session-preview.md`](docs/session-preview.md) |
| 游戏开发能力组与流程开发计划 | [`docs/game-dev/`](docs/game-dev/) |

## 快速开始

```sh
dsh plugin --profile desktop add "<仓库路径>/plugins/dsh"
```

安装后在会话模式中选择 **HNFlow**。

```sh
cd plugins/dsh
node test/run.mjs
```

## 目录

```text
capability-groups/     Core 与领域能力组（规则/技能/Agent/命令/工作流）
tools/                 MCP 与工具包
src/hnflow_stack/      Python 解析器与 CLI（hnflow-stack）
plugins/dsh/           唯一的 DSH 插件 dsh-hnflow
docs/                  架构、解析 API、模型层、预览，以及按能力组归置的开发计划
tests/                 Python 测试
```

项目激活能力组只写 `.hnflow/stack.json`；工作流放在能力组的 `flows/` 下，由 `hnflow-stack`
解析、校验与同步。
