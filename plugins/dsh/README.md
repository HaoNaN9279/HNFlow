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
| `models` | `[]` | 引擎使用的模型目录；留空则用引擎自己的 `config.yaml` |

AI 节点（`ai:llm_agent`）需要模型，两种接法：

1. **走 DSH 的模型与凭据（推荐）**——`use` 指向桥接类，凭据不用写进 HNFlow：

```yaml
models:
  - name: work
    use: deerflow.workflow.rpc.llm_bridge:BridgeChatModel
    model: deepseek-flash       # DSH 里的模型 id
    provider: deepseek          # 可选，DSH 里的 provider 路由
    context_window: 65536       # 必填：AI 节点按它做上下文压缩
```

桥接模型只做「消息 → 纯文本」，不接受工具调用（`bind_tools` 是空操作），也不带思考控制。

2. **走 HNFlow 自己的 provider 配置**——`use` 指向真实 provider 类，此时 `api_base` / `api_key` 要写全：

```yaml
models:
  - name: work
    use: deerflow.models.patched_deepseek:PatchedChatDeepSeek
    model: doubao-seed-1-8-251228
    api_base: https://ark.cn-beijing.volces.com/api/v3
    api_key: $VOLCENGINE_API_KEY
    context_window: 262144
```

两条路都没有模型时，含 AI 节点的工作流在 `run/start` 就会返回 `models-unavailable` 并列出节点。

## 用法

```text
/workflow                         列出本工作区引用的工作流
/workflow run publish             运行并等待（完成或等待人工）
/workflow run publish target=staging
/workflow status <runId>
/workflow events <runId>          节点时间线（重启后仍在）
/workflow cancel <runId>
/workflow resume <runId>          续跑被引擎重启打断的 run
/workflow tasks [runId]           待办人工任务
/workflow submit <taskId> note=ok 提交并继续运行
/workflow ref add <assetId> --pin 3 --alias publish
/workflow ref remove publish
/workflow ref pin publish --to 4   把引用移到新 revision（不带 --to 跟最新）
/workflow asset list
/workflow asset new "Release flow" 新建空工作流（start → end 骨架）
/workflow asset import ./old.workflow.json
/workflow asset delete <assetId>
/workflow override diff publish
/workflow override reset publish
```

工具 `hnflow`：`action = list | get | run | status | cancel | resume | assets | task_list | task_submit`，
`run` 必须带 `workflow`。run 停在人工节点时工具会弹问题卡并提交答案；`interactive:false` 可改为只报告待办。

工具 `hnflow_author`：`action = schema | validate | save_override`。
它**没有**写资产的动作——资产只能由用户执行 `/workflow save asset <name>` 更新，
Agent 的修改一律落到工作区覆盖。

### 自带的冒烟工作流

`examples/smoke-test.workflow.json` 是确定性的最小流程（不需要模型）：

```text
start → greet(data:assign) → confirm(human:task) → result(data:assign) → end
```

导入并引用（在目标工作区里执行）：

```text
/workflow asset import <插件目录>/examples/smoke-test.workflow.json
/workflow ref add <返回的 assetId> --alias smoke
/workflow run smoke
```

它会在 `confirm` 停下，任务监视里出现一条待办；提交后跑到 `end`：

```text
/workflow submit <taskId> note="ok"
```

## 界面

左侧栏有一个 **◆ HNFlow** 入口（`sidebar.panellist` + 主面板 `main`），点开是 HNFlow 页面。
页面顶部三个页签，统一"左树 + 右画布"布局（未选中时右侧空白）：

- **工作区**：左树按工作区分组，列出每个工作区的引用（带覆盖 / 漂移 / 缺失标记）；点一条在右侧画只读画布；
- **通用工作流**：左树是资产库里的全部内置资产；点一条画该资产的定义；
- **任务监视**：上方是全部执行（工作区 / 会话 / 工作流 / 状态 / 节点），下方是**需要你处理**的待办任务。

会话顶部页签（**仅 HNFlow 模式的会话**）列出当前工作区的引用 + 画布。

**右侧同步视图**：右栏「开始导航」页有 **HNFlow** 入口，打开的是与左栏相同的三页签页面（只是落在右侧栏）；
任务监视就是该页面的第三个页签。面板没打开时，**第一次出现**的待办会在右下角弹一次通知
（同一任务只弹一次），点「查看」打开右栏 HNFlow 页。

数据一律经 `/workflow ui <op> <base64url(JSON)>` 取回（`tree` / `canvas` / `assetCanvas` / `monitor`），
客户端不读文件、不连引擎，所以页面能做的事和手敲命令一致。
画布位置优先用 `metadata.canvas.positions`，否则用编辑器同款三列网格。

参数编辑、保存回资产等写操作仍走命令：`/workflow node <name> <nodeId> <json>`（写工作区覆盖）、
`/workflow override reset <name>`、`/workflow save asset <name>`（先 diff，再 `--yes`）。

## 数据布局

```text
$DSH_HOME/hnflow/library/
├─ release/publish.workflow.json          # 资产（asset + definition）
└─ .hnflow-revisions/<assetId>/r3.json    # 只读 revision 快照

$DSH_HOME/hnflow/state/                   # 引擎运行态（可配置 stateDir 覆盖）
├─ checkpoints.sqlite                     # LangGraph checkpoint
├─ runs.json                              # run 记录
└─ tasks.json                             # 人工任务行

<workspace>/.hnflow/
├─ workflows.json                         # 引用清单（固定 revision 或 follow）
└─ overrides/<assetId>.workflow.json      # 工作区覆盖（完整副本 + baseRevision）
```

解析顺序：覆盖 → 引用固定 revision 的快照 → 资产最新 revision。

重启语义：`waiting_human` 的 run 与待办原样保留、可直接提交；被进程中断的 `running` run
标记为 `interrupted`，用 `/workflow resume <runId>` 从最后 checkpoint 继续。

## 测试

```sh
node test/run.mjs      # 插件单元/契约测试（进程内运行，避免沙箱 piped spawn）
cd ../../backend && .venv/Scripts/python -m pytest tests/test_workflow_rpc.py -q
```

## 已知边界

- 没有画布拖拽/连线与坐标持久化，节点参数用 JSON 文本编辑；
- 没有 job 镜像：run 状态靠 `run/status` 与 `run/status` 通知，会话关闭不影响引擎里的 run；
- run 事件写入 `state/events/<runId>.jsonl`，重启后仍可 `events` 查看；不过事件只保留每个 run 最近 2000 条。
