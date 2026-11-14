# dsh-hnflow

HNFlow 约束式流程在 DeepSeek Harness 里的模式插件。设计与边界见
[`docs/dsh-plugin-plan-v2.md`](../../docs/dsh-plugin-plan-v2.md)；v0.8 的单人化与自动化见
[`docs/hnflow-v0.8-plan.md`](../../docs/hnflow-v0.8-plan.md)。

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
| VibeStack | `dsh-vibestack` ≥ 0.8.0 / `apiVersion >= 3`（**强依赖**：能力组 + 模型层） |
| 模型层 | 节点 `model` 只写 VibeStack 平台层 id（`fast` / `standard` / `strong` / `vision`，默认 `standard`）；未在本机绑定路由报 `model-layer-unbound`，DSH 自定义层报 `model-layer-custom`，都不回落 |

没有 VibeStack 时插件进入 `degraded`：可以列流程、看运行，但**发布与启动一律拒绝**。

## 安装（自用，不上架）

```sh
dsh plugin --profile desktop add "D:/workspace/HNFlow/plugins/dsh"
dsh --profile desktop --dump-config | grep -A2 'dsh-hnflow'
```

装好后会话模式里出现 **HNFlow**（`preset-hnflow`）。VibeStack 模式不变。

## 四行装配

| 行 | 角色 | 注册内容 |
| --- | --- | --- |
| `hnflow-core` | `role: core` | `ctx.hnflow`、`/api/hnflow/*` 路由、存储与调度 |
| `hnflow-pass` | `role: pass` | 时钟：过期推进、副作用重放、`.hnflow/triggers.json`、停滞续推（默认 2 秒一次；独立行，便于故障隔离或整体关闭） |
| `preset-hnflow` → `hnflow` | `role: preset` | `hnflow` / `hnflow_author` 工具、`/hnflow`、`hnflow-controls` / `hnflow-flows` 技能、流程索引 |
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
| 运行与观察 | `hnflow` 的 `run` / `status` / `list_runs` / `cancel` / `resume` / `inbox` / `artifact` / `triggers` |

### 插件自带的两个技能

两个技能都由 `preset-hnflow` 行注册为 `source: "bundled"`，不依赖工作区，**任意工作区的任意 HNFlow 模式会话**都能加载：

| 技能 | 内容 |
| --- | --- |
| `hnflow-controls` | 对话控制面全量参考：`hnflow` 的 16 个动作、`hnflow_author` 的 7 个动作、参数与返回、常见错误、人类专属动作边界、创建/修改/提升/引用/运行的标准做法、自动化边界 |
| `hnflow-flows` | 流程定义语言：六种节点、节点信封、边契约、门禁/交付/验收规则 |

`hnflow-controls` 由 `test/controls-skill.test.js` 与工具动作表做契约校验：新增工具动作却没有写进技能时测试会失败。

约束仍然是：**发布已有资产是人的动作**。`create` 写的是新资产 r1，不提升任何已有 revision；之后修改它必须走
`draft` + 人工 publish。项目草稿（`.hnflow/overrides/` 中 `local: true` 且无引用的文件）没有版本历史，
可以运行、改名、删除或提升，但不能直接 publish/pin/rollback。

## 页面与命令

- 左侧 HNFlow 图标：**流程**（**通用资产库（唯一一段，可折叠）+ 工作区列表（可折叠）**；两者都按资产的
  多级文件夹层级显示并支持逐级折叠；项目草稿也在工作区树中，标“项目草稿”并显示“仅本工作区 · 可运行”）/
  只读画布 + **版本历史 / 发布预览 diff / 钉住 / 回滚** + 启动；项目草稿只显示画布、启动与“提升到通用资产库”；
  **运行**（节点时间线、**取消/继续、产物、token 用量、降级标记、一句话健康说明**）/
  **收件箱**（按“先做什么”排序：返工交付 → 仲裁 → 门禁裁决 → 人工交付，每项带一句话摘要与过期状态；
  底部是只读“自动化”面板：触发器、解析错误、副作用队列、上次扫描、通知通道）。
- 会话页签只显示本会话启动的运行；右栏是同一份收件箱；右下角首次出现待决项时提示一次。
- `/hnflow list|runs|status|inbox|assets|add|promote|publish|history|rollback|pin|import|open`；
  发布与回滚都需要 `confirm` 二次确认，发布预览先给出结构 diff（新增/删除/字段变化）。
  **命令在任何会话都可用**（core 行注册，作用于当前会话的工作区）；工具只属于 HNFlow 模式。
- 模型面：`hnflow`（list_flows / list_library / describe_flow / run / status / list_runs / cancel / resume /
  inbox / artifact / add_ref / remove_ref / rename_ref / pin / history / triggers）与
  `hnflow_author`（schema / validate / create / draft / promote / delete / rename，**没有 publish**）。
- `/hnflow import` 兼容旧 `WorkflowDefinition`：先转换并给出逐条报告（`flow:start/end` 丢弃、
  `data:assign` → 常量 `merge`、`ai:llm_agent` → `agent`、`human:review/task` → `gate/request`、
  `verify:gate` 降级为人工门禁），转换结果过静态校验后才写入资产库；原文件不改。

### 命令结果为什么在空白会话里看不到

这是 DSH 的统一行为，不是 HNFlow 的特殊问题：命令 handler 的返回文本由 host 写成
`command/run` + `command/done` 会话事件，`dsh-client-ui-chat` 再把它渲染成对话里的持久卡片；
空白会话还没有对话转录，卡片要等第一轮消息后才会出现。`command/executed` 只是客户端本地确认事件，
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
    passIntervalMs: 2000                   # 时钟行扫描间隔（≥500）
    runBudgetMs: 21600000                  # 单次运行墙钟预算（≥60000，默认 6 小时）
    resumeOnStart: true                    # 宿主重启后自动续跑未终态运行
    triggersEnabled: true                  # 是否读取 .hnflow/triggers.json
    outboxMaxAttempts: 8                   # 副作用队列重试上限（超过标记 dead）
```

其它字段：`workspaceDir`（默认 `.hnflow`）、`stateDir`（降级文件存储根）、`maxAttempts`、
`nodeTimeoutMs`、`maxIndexEntries`、`storage`（`false` 强制文件存储）。

### 自动化：`.hnflow/triggers.json`

触发器只决定**何时新开一次运行**，不接管授权、不跳门禁、不续跑旧 run：

```json
{
  "triggers": [
    { "id": "nightly", "source": "cron", "cron": "0 2 * * *", "flow": "demo", "input": { "brief": "夜间整理" } },
    { "id": "watch-src", "source": "file", "watch": ["src/**/*.ts"], "flow": "demo", "debounceMs": 60000 },
    { "id": "after-review", "source": "run-completed", "after": "art-review", "flow": "demo" }
  ]
}
```

- `cron`：五字段；按分钟幂等（同一分钟不会重复启动）。
- `file`：按 `数量:mtime:大小` 签名判断变化，需静置 `debounceMs`；不进入 `.git`/`node_modules`/`.hnflow` 等目录，上限 3000 文件。
- `run-completed`：`after` 写流程 id 或 `*`；链式触发最多 5 层。
- 解析错误逐条报在 `triggers` 动作与页面“自动化”面板里，不会让整份文件失效。
- 新增/修改触发器是改文件；Agent 没有创建触发器的工具动作。

## 数据布局

```text
$DSH_HOME/hnflow/library/<目录>/<name>.flow.json   资产（asset + definition）
$DSH_HOME/hnflow/library/.hnflow-revisions/<id>/rN.json   不可变快照 + lockfile
<workspace>/.hnflow/flows.json                   引用（默认钉住 revision）
<workspace>/.hnflow/overrides/<flowId>.flow.json 工作区草稿；`local: true` 且无引用 = 项目草稿
<workspace>/.hnflow/triggers.json                触发器（人写入；缺失即不启用）
<stateDir>/outbox.json                           持久副作用队列（通知、run-completed 触发）
<stateDir>/triggers-state.json                   触发器去重游标（上次触发键）
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

## 测试

```sh
node test/run.mjs
```

覆盖：schema 子集与 `type`+`oneOf` 禁止、信封、契约可赋值、调度/fallback 降级、CAS 与退回预算、
发布/lockfile（含 preset 组合摘要）、VibeStack 契约（apiVersion 门槛、未绑定层、自定义层、可路由）、
storage 降级、门禁/交付/`needs_human`/重试/取消/重启、
审计字段、交付路径越界、过期推进、verify `inconclusive` 门禁、`arbitrate`、产物与 token 归因、
旧流程导入、项目草稿创建/运行/提升/删除、引用管理、页面路由、技能动作覆盖与客户端契约；
v0.8 另覆盖 cron、运行健康、收件箱阶段排序、扩展节点类型、通道降级、副作用队列幂等/退避/dead、
触发器三种来源与幂等键、run-completed 链式启动、重试病史、运行预算、`resumeOnStart`。当前 **166 项**。

### 真机自测（隔离 web 实例）

已用隔离 `DSH_HOME` + `dsh --profile ztest --no-open --port 3999` + Playwright/Chrome
完成端到端自测（不碰桌面端真实会话）：

- 页面可打开、切换三页签、选流程、看到版本历史与发布预览；
- 从页面启动 `smoke-general`：**conductor 自动创建**、agent 子会话用 `hnflow` preset 跑通、
  `structured_output` 信封被正确解析、gate 同时走原生问题卡（`askedVia: card`）与页面收件箱；
- 页面批准后 run `succeeded`，审计字段（revision/contentHash/upstreamHash/consumerNodeIds/decidedBy）齐备；
- `node.model: flash` 的流程发布时把 VibeStack 层解析进 `lockfile.models`，spawn 的
  `agentOptions` 实际为 `deepseek-account/deepseek-flash`（`flash` 是 VibeStack 0.8 之前的旧名，
  现在同义层为 `fast`；当时自测记录保留原名）；
- 进程重启后 storage domain 里的 run 仍可读回（`storage: domain`）；
- token 用量被归因到节点（子会话销毁前采样，示例：input 5105 / output 293）。

M0 结论与已知限制见方案 §13、附录 E 与 [`docs/hnflow-v0.8-plan.md`](../../docs/hnflow-v0.8-plan.md) §7。
