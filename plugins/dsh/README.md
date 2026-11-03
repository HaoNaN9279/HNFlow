# dsh-hnflow

HNFlow 确定性工作流在 DeepSeek Harness 里的模式插件。设计与边界见
[`docs/dsh-plugin-plan.md`](../../docs/dsh-plugin-plan.md)。

- 工作流是**资产**，放在库目录里；工作区只存**引用**与**覆盖**；
- Agent 会话通过 `hnflow` 工具与 `/workflow` 命令显式点名工作流，不猜；
- 运行由 Python 引擎（`python -m deerflow.workflow.rpc`）执行，插件只做呈现与编排。

## 依赖

| 项 | 要求 |
| --- | --- |
| DSH | `>=0.2.1-0 <0.3.0`（`engines.dsh`） |
| Python | 能 import `deerflow.workflow`；默认取 `backend/.venv` |
| 能力组 | `preset-hnflow` 里挂了 `dsh-vibestack`；不需要能力组时删掉该行 |

## 安装

```sh
# 链接进某个 profile（自用，不发布 npm）
dsh plugin --profile desktop add "D:/workspace/HNFlow/plugins/dsh"

# 确认配置层已合成
dsh --profile desktop --dump-config | grep -A2 'dsh-hnflow'
```

装好后会话模式里出现 **HNFlow**（`preset-hnflow`）。VibeStack 模式不变。

## 配置

写在 profile 的 `cordis.patch.yml`，按行 id 覆盖：

```yaml
- id: hnflow
  name: dsh-hnflow
  config:
    libraryRoot: D:/data/hnflow-library
    enginePython: C:/Python312/python.exe
    requestTimeoutMs: 120000
    maxIndexEntries: 20
```

| 字段 | 默认 | 说明 |
| --- | --- | --- |
| `libraryRoot` | `$DSH_HOME/hnflow/library` | 资产库根 |
| `workspaceDir` | `.hnflow` | 工作区状态目录 |
| `enginePython` | 自动发现 `backend/.venv`，其次 `DSH_HNFLOW_PYTHON` | 引擎解释器 |
| `engineModule` | `deerflow.workflow.rpc` | 引擎入口模块（`-m`） |
| `engineCwd` | `backend/` | 引擎进程工作目录 |
| `requestTimeoutMs` | `120000` | 单次引擎请求上限 |
| `startupTimeoutMs` | `20000` | 握手超时 |
| `maxIndexEntries` | `20` | 系统提示里注入的工作流条数 |

## 用法

```text
/workflow                         列出本工作区引用的工作流
/workflow run publish             运行并等待
/workflow run publish target=staging
/workflow status <runId>
/workflow cancel <runId>
/workflow ref add <assetId> --pin 3 --alias publish
/workflow ref remove publish
/workflow asset list
/workflow override diff publish
/workflow override reset publish
```

工具 `hnflow`：`action = list | get | run | status | cancel | assets`，`run` 必须带 `workflow`。

## 数据布局

```text
$DSH_HOME/hnflow/library/
├─ release/publish.workflow.json          # 资产（asset + definition）
└─ .hnflow-revisions/<assetId>/r3.json    # 只读 revision 快照

<workspace>/.hnflow/
├─ workflows.json                         # 引用清单（固定 revision 或 follow）
└─ overrides/<assetId>.workflow.json      # 工作区覆盖（完整副本 + baseRevision）
```

解析顺序：覆盖 → 引用固定 revision 的快照 → 资产最新 revision。

## 测试

```sh
node test/run.mjs      # 插件单元/契约测试（进程内运行，避免沙箱 piped spawn）
cd ../../backend && .venv/Scripts/python -m pytest tests/test_workflow_rpc.py -q
```

## 已知边界（M2/M3 前）

- run 使用进程内 checkpointer，引擎重启即丢 run；
- 人工节点（`human:task` / `human:review`）尚未接通任务桥，运行会明确返回 `human-tasks-unavailable`；
- 没有画布面板与保存菜单，写资产目前无工具入口（只有 `/workflow` 只读命令族）。
