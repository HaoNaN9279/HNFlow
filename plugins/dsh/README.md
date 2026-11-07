# dsh-hnflow

HNFlow 约束式流程在 DeepSeek Harness 里的模式插件。设计与边界见
[`docs/dsh-plugin-plan-v2.md`](../../docs/dsh-plugin-plan-v2.md)。

核心区别：流程不是"用户画图、AI 照着走"的执行脚本，而是**约束层**——节点声明角色与产物契约，
边声明消费条件，人通过门禁与交付进入流程，验收由独立 judge / verify 完成，不由生成者自报。

- 编排权在插件自己的状态机里（`ctx.hnflow`），节点执行交给 DSH `subagents`；
- 流程状态进 DSH storage domain（不可用时降级为文件，并显式告警）；
- 对话可以**创建、修改、提升、引用和运行**流程；发布已有资产仍是人的动作：
  `/hnflow publish` 或页面按钮，Agent 没有 publish 工具；
- 页面/会话/右栏读同一个 service，不读文件、不跑命令、不写会话事件。

## 依赖

| 项 | 要求 |
| --- | --- |
| DSH | `>=0.2.1-0 <0.3.0`（`engines.dsh`） |
| VibeStack | `dsh-vibestack` ≥ 0.3.0 / `apiVersion >= 2`（**强依赖**：能力组 + 模型层） |
| 模型层 | 节点 `model` 引用 VibeStack 层 id；缺层即失败，不回落 |

没有 VibeStack 时插件进入 `degraded`：可以列流程、看运行，但**发布与启动一律拒绝**。

## 安装（自用，不上架）

```sh
dsh plugin --profile desktop add "D:/workspace/HNFlow/plugins/dsh"
dsh --profile desktop --dump-config | grep -A2 'dsh-hnflow'
```

装好后会话模式里出现 **HNFlow**（`preset-hnflow`）。VibeStack 模式不变。

## 三行装配

| 行 | 角色 | 注册内容 |
| --- | --- | --- |
| `hnflow-core` | `role: core` | `ctx.hnflow`、`/api/hnflow/*` 路由、存储与调度 |
| `preset-hnflow` → `hnflow` | `role: preset` | `hnflow` / `hnflow_author` 工具、`/hnflow`、`hnflow-flows` 技能、流程索引 |
| `hnflow-ui` | `host: false` | 浏览器 bundle：侧栏页面、会话页签、右栏收件箱、右下角通知 |

## 对话创建与管理

HNFlow 模式里的模型面现在是完整的“起草 + 管理 + 运行”闭环，但仍不包含发布：

| 目标 | 工具动作 |
| --- | --- |
| 新建项目内流程 | `hnflow_author create`（`scope` 省略或 `project`；默认只在本工作区可见、可运行） |
| 新建通用流程 | `hnflow_author create` + `scope: "library"`（新资产 r1，并默认引用到本工作区） |
| 修改项目草稿 | `hnflow_author draft`；项目草稿可继续 `draft`，直到提升或删除 |
| 项目草稿管理 | `hnflow_author rename` / `delete` / `promote`（提升为库资产 r1 并改为引用） |
| 通用资产发现/引用 | `hnflow` 的 `list_library` / `add_ref` / `remove_ref` / `rename_ref` |
| 版本与回滚信息 | `hnflow` 的 `history` / `pin`；真正 publish/rollback 仍由人经命令或页面操作 |
| 运行与观察 | `hnflow` 的 `run` / `status` / `list_runs` / `cancel` / `resume` / `inbox` / `artifact` |

约束仍然是：**发布已有资产是人的动作**。`create` 写的是新资产 r1，不提升任何已有 revision；之后修改它必须走
`draft` + 人工 publish。项目草稿（`.hnflow/overrides/` 中 `local: true` 且无引用的文件）没有版本历史，
可以运行、改名、删除或提升，但不能直接 publish/pin/rollback。

## 页面与命令

- 左侧 HNFlow 图标：**流程**（**通用资产库（唯一一段，可折叠）+ 工作区列表（可折叠）**；两者都按资产的
  多级文件夹层级显示并支持逐级折叠；项目草稿也在工作区树中，标“项目草稿”并显示“仅本工作区 · 可运行”）/
  只读画布 + **版本历史 / 发布预览 diff / 钉住 / 回滚** + 启动；项目草稿只显示画布、启动与“提升到通用资产库”；
  **运行**（节点时间线、**取消/继续、产物、token 用量、降级标记**）/ **收件箱**（门禁与交付，显示审计字段与过期状态）。
- 会话页签只显示本会话启动的运行；右栏是同一份收件箱；右下角首次出现待决项时提示一次。
- `/hnflow list|runs|status|inbox|assets|add|promote|publish|history|rollback|pin|import|open`；
  发布与回滚都需要 `confirm` 二次确认，发布预览先给出结构 diff（新增/删除/字段变化）。
  **命令在任何会话都可用**（core 行注册，作用于当前会话的工作区）；工具只属于 HNFlow 模式。
- 模型面：`hnflow`（list_flows / list_library / describe_flow / run / status / list_runs / cancel / resume /
  inbox / artifact / add_ref / remove_ref / rename_ref / pin / history）与
  `hnflow_author`（schema / validate / create / draft / promote / delete / rename，**没有 publish**）。
- `/hnflow import` 兼容旧 `WorkflowDefinition`：先转换并给出逐条报告（`flow:start/end` 丢弃、
  `data:assign` → 常量 `merge`、`ai:llm_agent` → `agent`、`human:review/task` → `gate/request`、
  `verify:gate` 降级为人工门禁），转换结果过静态校验后才写入资产库；原文件不改。

### 命令结果为什么在空白会话里看不到

这是 DSH 的统一行为，不是 HNFlow 的特殊问题：命令 handler 的返回文本由 host 写成
`command/run` + `command/done` 会话事件，`dsh-client-ui-chat` 再把它渲染成对话里的持久卡片；
空白会话还没有对话转录，卡片要等第一轮消息后才出现。`command/executed` 只是客户端本地确认事件，
`conversation.input.notify` 只用于“未知命令”这类准入失败——插件不应自行再弹一份结果。

所以在**全新会话**里执行 `/hnflow list` 看不到输出时：先发一句话，或直接使用左侧 HNFlow 页面
（流程/运行/收件箱本来就在那里，且不依赖会话转录）。

## 配置

```yaml
- id: hnflow-core
  name: dsh-hnflow
  config:
    role: core
    libraryRoot: D:/data/hnflow-library   # 空 = $DSH_HOME/hnflow/library
    presetAllowlist: [hnflow, standard]    # 节点可引用的 preset
    maxParallel: 3                         # 同时推进的节点数（不超过宿主 maxActiveSubagents=8）
```

其它字段：`workspaceDir`（默认 `.hnflow`）、`stateDir`（降级文件存储根）、`maxAttempts`、
`nodeTimeoutMs`、`maxIndexEntries`、`storage`（`false` 强制文件存储）。

## 数据布局

```text
$DSH_HOME/hnflow/library/<目录>/<name>.flow.json   资产（asset + definition）
$DSH_HOME/hnflow/library/.hnflow-revisions/<id>/rN.json   不可变快照 + lockfile
<workspace>/.hnflow/flows.json                   引用（默认钉住 revision）
<workspace>/.hnflow/overrides/<flowId>.flow.json 工作区草稿；`local: true` 且无引用 = 项目草稿
$DSH_HOME/hnflow/state/runs/<runId>.json         仅 storage domain 不可用时的降级
```

运行记录本身进 storage domain（域 `hnflow`，一张 `runs` 表，一条 run 一个文档——
domain 没有跨表事务，一次推进必须原子）。

## 示例

```sh
# 把示例导入工作区并跑一次（先确保 hnflow 模式下有 VibeStack 模型层）
/hnflow import 冒烟流程 /path/to/examples/smoke.flow.json
/hnflow publish 冒烟流程 confirm
```

`examples/art-review.flow.json` 演示 `request` + `verify` + 独立 judge。

### 已预置的两条测试流程（本机）

| 引用（alias） | 位置 | 做什么 |
| --- | --- | --- |
| `smoke-general` | 通用资产库 `library/test/general-smoke.flow.json` | `agent` 写摘要与要点 → `gate` 人工确认；验证启动、信封、门禁、终态 |
| `project-delivery` | 通用库 `library/test/project-delivery.flow.json` + **本工作区覆盖** `.hnflow/overrides/fl-demo-project-delivery.flow.json` | 人工交付 `{files, notes}` → `verify` schema 验收 → `agent` 变更清单；验证投递、CAS、覆盖优先 |

使用：

```text
/hnflow list
```

- `smoke-general`：页面「流程」选中 → 输入 `{"brief":"随便写一段测试说明"}` → 运行 → 收件箱批准。
- `project-delivery`：运行后在收件箱提交 `{"files":["a.txt"],"notes":"测试交付"}`；它带工作区覆盖，列表里显示「草稿」，运行记录标「草稿覆盖」，child 简报里能看到“（本项目覆盖）”。

两条流程都不写 `model`，直接用会话当前模型，不需要先在 VibeStack 里定义模型层。

`smoke-general` 是**通用**资产：别的项目里用 `/hnflow assets` 找到它，再 `/hnflow add fl-demo-general-smoke smoke` 就能引用；`project-delivery` 只在本工作区被引用，并带了一份工作区覆盖。


## 测试

```sh
node test/run.mjs
```

覆盖：schema 子集与 `type`+`oneOf` 禁止、信封、契约可赋值、调度/fallback 降级、CAS 与退回预算、
发布/lockfile（含 preset 组合摘要）、storage 降级、门禁/交付/`needs_human`/重试/取消/重启、
审计字段、交付路径越界、过期推进、verify `inconclusive` 门禁、`arbitrate`、产物与 token 归因、
旧流程导入、项目草稿创建/运行/提升/删除、引用管理、页面路由与客户端契约。当前 **134 项**。

### 真机自测（隔离 web 实例）

已用 `DSH_HOME=temp/dshhome` + `dsh --profile ztest --no-open --port 3999` + Playwright/Chrome
完成一轮端到端自测（不碰桌面端真实会话）：

- 页面可打开、切换三页签、选流程、看到版本历史与发布预览；
- 从页面启动 `smoke-general`：**conductor 自动创建**、agent 子会话用 `hnflow` preset 跑通、
  `structured_output` 信封被正确解析、gate 同时走原生问题卡（`askedVia: card`）与页面收件箱；
- 页面批准后 run `succeeded`，审计字段（revision/contentHash/upstreamHash/consumerNodeIds/decidedBy）齐备；
- `node.model: flash` 的流程发布时把 VibeStack 层解析进 `lockfile.models`，spawn 的
  `agentOptions` 实际为 `deepseek-account/deepseek-flash`；
- 进程重启后 storage domain 里的 run 仍可读回（`storage: domain`）；
- token 用量被归因到节点（子会话销毁前采样，示例：input 5105 / output 293）。

M0 结论与已知限制见方案 §13 与附录 E。
