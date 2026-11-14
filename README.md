# HNFlow

HNFlow 是运行在 DeepSeek Harness 上的统一插件与能力组仓库。工作流是能力组的一种内容，
和能力组的规则、技能、Agent、命令、工具一起被解析、注入和运行。

仓库只保留一个 DSH 插件 `dsh-hnflow`。旧版独立插件、旧资产库与旧预设都不再保留；
旧仓库内容已复制进本仓库，并按 HNFlow 命名。

## 入口

| 内容 | 位置 |
| --- | --- |
| DSH 插件安装、页面、命令、工具、数据布局 | [`plugins/dsh/README.md`](plugins/dsh/README.md) |
| 统一架构、能力组、工作流解析 | [`docs/architecture.md`](docs/architecture.md) |
| 能力组与工作流开发方案 | [`docs/dsh-plugin-plan-v2.md`](docs/dsh-plugin-plan-v2.md) |
| 解析 API | [`docs/resolve-api.md`](docs/resolve-api.md) |
| 模型层 | [`docs/model-layers.md`](docs/model-layers.md) |
| 上下文预览 | [`docs/session-preview.md`](docs/session-preview.md) |
| 模块 | [`docs/nested-modules.md`](docs/nested-modules.md) |
| 为什么做约束式流程 | [`docs/新开发理念.md`](docs/新开发理念.md) |
| DSH 升级回归 | [`docs/dsh-upgrade-checklist.md`](docs/dsh-upgrade-checklist.md) |

## 快速开始

```sh
dsh plugin --profile desktop add "D:/workspace/HNFlow/plugins/dsh"
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
docs/                  架构、解析 API、模型层、预览与升级文档
tests/                 Python 测试
```

项目激活能力组只写 `.hnflow/stack.json`。工作流放在能力组的 `flows/` 下，不再有独立的
流程资产库、revision、publish 或 rollback。
