# dsh-hnflow

HNFlow 确定性工作流在 DeepSeek Harness 里的模式插件。设计与边界见
[`docs/dsh-plugin-plan.md`](../../docs/dsh-plugin-plan.md)。

- 工作流是**资产**，放在库目录里；工作区只存**引用**与**覆盖**；
- 会话里触发工作流只有一条路径：`/workflow <name> <提示词>` 把引用交给 AI，AI 用 `hnflow` 工具
  启动，回报一行就结束——**会话只负责启动**；
- 运行由 Python 引擎（`python -m deerflow.workflow.rpc`）执行，插件只做呈现与编排；
- 不经对话的直接运行属于 HNFlow 页面（待实现），不属于会话。

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

### 会话里：只启动

```text
/workflow                         列出本工作区引用的工作流
/workflow publish 把 staging 的产物发布出去   交给 AI 启动
```

`/workflow` 不再直接执行工作流，也没有 `run` / `status` / `submit` 这些子命令。
它只做一件事：把 `<hnflow_workflow name="…" asset="…" />` 标签和你的提示词合成一条用户消息，
让 AI 用 `hnflow` 工具启动这次运行。启动后 AI 只回一行（runId + 状态）就结束本轮，
不轮询、不等待、不替你回答人工节点——进度看 HNFlow 页面。

### 工具

`hnflow`：`action = list | get | run | status | cancel | resume | events | assets | task_list | task_submit`，
`run` 必须带 `workflow`，`input` 从提示词推导；`run` 在引擎接受后立即返回，不等结果。
`status` / `events` / `task_list` 用于回答用户之后的追问，不用于轮询。

`hnflow_author`：`action = schema | validate | save_override`。
它**没有**写资产的动作——资产只能由用户执行 `/hnflow save asset <name>`（或 HNFlow 页面）更新，
Agent 的修改一律落到工作区覆盖。

### 页面与资产库：`/hnflow`

任何会话都能用，读写定义，但**没有任何运行能力**：

```text
/hnflow ref list|add|remove|pin
/hnflow ref add <assetId> --pin 3 --alias publish
/hnflow ref pin publish --to 4     把引用移到新 revision（不带 --to 跟最新）
/hnflow asset list
/hnflow asset new "Release flow"   新建空工作流（start → end 骨架）
/hnflow asset import ./old.workflow.json
/hnflow asset delete <assetId>
/hnflow override diff publish
/hnflow override reset publish
/hnflow save asset publish         先给 diff，加 --yes 才写回资产
/hnflow node publish greet {"value": "x"}   写工作区覆盖
/hnflow doctor [--save]            引擎安装位置
```

### 自带的冒烟工作流

`examples/smoke-test.workflow.json` 是确定性的最小流程（不需要模型）：

```text
start → greet(data:assign) → confirm(human:task) → result(data:assign) → end
```

导入并引用（在目标工作区里执行）：

```text
/hnflow asset import <插件目录>/examples/smoke-test.workflow.json
/hnflow ref add <返回的 assetId> --alias smoke
/workflow smoke 跑一遍冒烟流程
```

它会在 `confirm` 停下，任务监视里出现一条待办；在页面里处理，或让 AI 用
`task_submit` 提交，之后跑到 `end`。

## 界面

左侧栏有一个 **◆ HNFlow** 入口（`sidebar.panellist` + 主面板 `main`），点开是 HNFlow 页面。
页面顶部三个页签，统一"左树 + 右画布"布局（未选中时右侧空白）：

- **工作区**：左树按工作区分组，列出每个工作区的引用（带覆盖 / 漂移 / 缺失标记）；点一条在右侧画只读画布；
- **通用工作流**：左树是资产库里的全部内置资产；点一条画该资产的定义；
- **任务监视**：上方是全部执行（工作区 / 会话 / 工作流 / 状态 / 节点），下方是**需要你处理**的待办任务。

会话顶部页签（**仅 HNFlow 模式的会话**）列出当前工作区的引用 + 画布。

**右侧同步视图**：右栏「开始导航」页有 **HNFlow** 入口，打开的是与左栏相同的三页签页面（只是落在右侧栏）；
任务监视就是该页面的第三个页签。

**右下角提示窗**：第一次出现待办时弹一次（同一任务只弹一次），只显示信息与「关闭」，
不跳转、不写任何会话。它的数据来自宿主注册的 exact Fetch 路由 `GET /api/hnflow/tasks`
（每 15 秒一次，失败退到 60 秒），**不是**命令——命令会把 `command/run` + `command/done`
写进它点名的会话，而这个提示属于整个窗口，不属于任何会话。

页面是**常驻**的：数据来自全局命令 `/hnflow ui <op> <base64url(JSON)>`
（`tree` / `canvas` / `assetCanvas` / `monitor` / `wait`），与"当前选中哪个会话"无关，
也不需要打开任何 HNFlow 模式的会话。该命令只读、不启动引擎——它直接读引擎落盘的
`$DSH_HOME/hnflow/state/{runs,tasks}.json`，因此不会和模式内的引擎争用状态。
页面只在打开/点「刷新」时取数，所以会话里只会在你主动操作时出现一条命令记录。
客户端的取数顺序是 `/hnflow` → 旧宿主回退 `/workflow`。

画布位置优先用 `metadata.canvas.positions`，否则用编辑器同款三列网格。

参数编辑、保存回资产等写操作走 `/hnflow`：`/hnflow node <name> <nodeId> <json>`（写工作区覆盖）、
`/hnflow override reset <name>`、`/hnflow save asset <name>`（先 diff，再 `--yes`）。

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
标记为 `interrupted`，**不会自动续跑**——要续跑就让 AI 调 `hnflow` 的 `resume`（或页面的续跑入口）。

## 测试

```sh
node test/run.mjs      # 插件单元/契约测试（进程内运行，避免沙箱 piped spawn）
cd ../../backend && .venv/Scripts/python -m pytest tests/test_workflow_rpc.py -q
```

## 已知边界

- 没有画布拖拽/连线与坐标持久化，节点参数用 JSON 文本编辑；
- 没有 job 镜像：run 状态靠 `run/status` 与 `run/status` 通知，会话关闭不影响引擎里的 run；
- run 事件写入 `state/events/<runId>.jsonl`，重启后仍可 `events` 查看；不过事件只保留每个 run 最近 2000 条。
