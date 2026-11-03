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

AI 节点（`ai:llm_agent`）需要模型：既没有 `models` 也没在 `config.yaml` 里配过时，`run/start` 会直接返回
`models-unavailable` 并列出 AI 节点，不会跑到一半才失败。条目就是 HNFlow 的模型配置：

```yaml
models:
  - name: work
    use: deerflow.models.patched_deepseek:PatchedChatDeepSeek
    model: doubao-seed-1-8-251228
    api_base: https://ark.cn-beijing.volces.com/api/v3
    api_key: $VOLCENGINE_API_KEY
    context_window: 262144
```

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

## 界面

HNFlow 模式下，输入框左栏会出现一个 **HNFlow** 控件（`conversation.input.left`）。
点开后是一个弹层，两个页签：

- **工作流**：引用列表（带覆盖 / 漂移 / 缺失标记）、只读 SVG 画布（点节点改参数）、撤销覆盖、保存回资产；
- **待办**：所有 pending 人工任务，点一条给出模板 JSON（review 是 `{"decision":true,"feedback":""}`，task 是各端口空值），
  改完点提交即可继续运行。

画布数据来自 `/workflow panel [name]` 的一次调用：位置优先用 `metadata.canvas.positions`，
否则用编辑器同款三列网格。点节点可编辑它的 `params`：

- **保存到工作区** → `/workflow node <name> <nodeId> <json>`，宿主改一个节点 → 引擎校验 → 写工作区覆盖（资产不动）；
- **撤销覆盖** → `/workflow override reset <name>`；
- **保存回资产** → 先执行 `/workflow save asset <name>` 看 diff（`rN → rN+1`），再点「确认写入资产」执行 `--yes`。

客户端不读文件、不连引擎，所以面板能做的事和手敲命令完全一致；写资产永远是两步。

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
