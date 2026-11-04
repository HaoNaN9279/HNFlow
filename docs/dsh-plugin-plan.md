# HNFlow × DeepSeek Harness 插件化开发规划

| 项 | 值 |
| --- | --- |
| 文档版本 | 0.3（新增三面 UI 与任务监视规划，见 §11.4–§11.6、§14.2） |
| 日期 | 2026-11-04 |
| 基线 | `v0.10.0`（`master`，DSH 改造前的最后一个 HNFlow 版本） |
| 开发分支 | `feat/dsh-plugin` |
| 范围 | 自用插件，不提交官方插件市场，不参与官方审核 |
| 状态 | M0–M5 主体完成；M6（三面 UI + 任务监视）规划中（见 §14.2） |
| DSH 插件开发文档 | <https://deepseek-harness.github.io/deepseek-harness/develop/basic/> |
| DSH 源码 | <https://github.com/deepseek-ai/deepseek-harness> |

开发遵循 DSH 官方插件规范（bundle manifest / profile 安装 / Config schema / 插件生命周期 / Tool DSL / 命令 / 事件），
唯一豁免的是上传发布相关要求（npm 发布、插件市场上架、审核用展示规范），因为本插件只自用。
逐条对照见 §3.5。

---

## 1. 摘要

HNFlow 的定位是 **Agent 的确定性执行能力**：把 AI 产出、人工审核、修改迭代固化成可复现的工作流图，由 Agent 在需要确定性的时候调用。

本次改造把 **DeepSeek Harness（DSH）作为唯一使用入口**：

- 删除 HNFlow 自研的 LeadAgent、Next.js 前端、Gateway REST/SSE 层与 Nginx 编排；
- 保留并收窄 HNFlow 的 **工作流引擎**（定义 / 编译 / 执行 / checkpoint / 人工挂起 / 规约 / 验证 / 回滚）；
- 以 DSH 插件的形式提供：**HNFlow 模式**（工作流 + 能力组）、**工作流面板**、**工作流工具与技能**；
- 工作流作为 **独立资产** 管理，工作区只保存 **引用** 与 **覆盖**，这是跨项目复用的基础；
- Agent 在工作区内对工作流的修改一律落到 **工作区覆盖**，只有用户明确要求时才回写资产。

一句话：**DSH 是驾驶舱，HNFlow 引擎是工厂，工作流是资产，工作区是引用与覆盖，会话是操作入口。**

---

## 2. 需求清单

| 编号 | 需求 | 设计落点 |
| --- | --- | --- |
| R1 | DSH 作为唯一使用入口 | §3、§8、§11 |
| R2 | 保留工作流中的人工节点 | §9 |
| R3 | 用户能明确指定工作流（直接运行 / 会话内发起） | §7 |
| R4 | 能力组功能保持不变；保留 VibeStack 模式（只用能力组、不用工作流） | §6、§12 |
| R5 | 工作流作为独立资产复用；工作区只存引用或覆盖 | §4、§5 |
| R6 | Agent 修改只落工作区，显式要求才写回资产 | §4.5、§10 |
| R7 | 面板可编辑、手动运行，并提供保存回资产 / 保存工作区覆盖的菜单 | §11 |
| R8 | 不做 `@workflow` 输入语法，遵循 DSH 习惯 | §7.1 |
| R9 | 插件自用，不走官方渠道审核 | §3.4、§14 |
| R10 | 左侧栏新增 HNFlow 页面（插件加载即出现），页内页签：工作区 / 通用工作流 / 任务监视 | §11.4 |
| R11 | 会话窗口顶部页签新增 HNFlow，左下角菜单（composer 控件）删除 | §11.4 |
| R12 | 右侧栏新增 HNFlow 任务监视面板；三处页签布局统一 | §11.4、§11.5 |
| R13 | 展示每个工作区下、由哪个会话发起的任务状态；顶部全部执行、下方待处理 | §11.5 |
| R14 | 监视面板未打开时，新待办首次出现以右下角通知显示 | §11.5 |
| R15 | 会话顶部 HNFlow 页签只在**使用 HNFlow 模式的会话**出现 | §11.4 |

---

## 3. 总体架构

### 3.1 分层

```
┌─────────────────────── DSH（唯一入口） ───────────────────────┐
│ preset-hnflow（模式）                                          │
│  会话 Agent                                                    │
│   ├─ 系统提示：工作流索引（名称 + 一句话，限额）                │
│   ├─ 工具：workflow（list/get/run/status/cancel/task_*）        │
│   ├─ 工具：workflow_author（schema/validate/save_override/…）   │
│   ├─ skill：hnflow-workflow（按需读取节点目录与规范）            │
│   └─ 命令：/workflow …                                          │
│  面板（main slot）：资产库 + 工作区 + 画布 + 运行 + 任务收件箱   │
│  会话内：run 卡片、人工任务通知                                  │
└──────────▲───────────────────────────────▲────────────────────┘
           │ cordis host service           │ Remote / commands / 文件资源
┌──────────┴───────────────────────────────┴────────────────────┐
│ dsh-hnflow 插件（host）                                        │
│  · AssetStore：全局工作流资产（读写、版本、目录）                │
│  · WorkspaceStore：引用与覆盖（.hnflow/workflows.json 等）       │
│  · Resolver：引用/覆盖 → 可运行定义；漂移检测                    │
│  · RunController：引擎事件 → job 镜像 → 通知 / 面板状态          │
│  · TaskBridge：引擎任务 ↔ userQuestions / 面板表单              │
│  · ModelBridge：model_profile → DSH 模型目录                    │
└──────────▲────────────────────────────────────────────────────┘
           │ stdio JSON-RPC（版本握手；进程随 DSH 生命周期）
┌──────────┴────────────────────────────────────────────────────┐
│ hnflow-engine（Python，无 UI）                                 │
│  定义/校验 → 编译 → LangGraph 执行                              │
│  checkpoint / 人工挂起 / 规约 / 验证 / 回滚 / undo              │
│  真相：run、task、事件、artifact                                │
└───────────────────────────────────────────────────────────────┘
```

### 3.2 五个不可动摇的边界

1. **run 的真相在引擎，不在会话。** 会话只记录工具调用与人工答复。
2. **人工节点是引擎的挂起语义，不是 DSH 审批。** `userApproval` 只用于危险执行授权。
3. **资产不可被隐式修改。** 只有用户显式触发的 `save_asset` 才提升资产 revision。
4. **Agent 不进入确定性层。** AI 节点仍由引擎调用模型，使用四层提示词，不委派 DSH subagent。
5. **运行中的定义不可变。** run 启动时快照定义、模型绑定与能力快照。

### 3.3 进程与生命周期

- 引擎由插件以 stdio 子进程方式拉起，随 DSH 退出而退出；
- 引擎入口 `python -m deerflow.workflow.rpc`（实现在 `backend/packages/harness/deerflow/workflow/rpc/`，
  复用 harness 的编译/执行栈，不另起 Python 工程）；
- run 在 checkpoint 边界持久化，DSH 重启后由插件重新挂接并续跑（**M2**：当前用进程内 checkpointer，
  重启即丢 run）；
- 引擎不可达时，工具返回明确错误（`engine-not-started` / `engine-exited`），面板显示「引擎未启动」与启动入口；
- 协议带版本握手：`plugin ↔ engine` 的 `protocolVersion` 不匹配时 fail-loud（`protocol-mismatch`）。

### 3.4 插件身份与分发

- 包名：`dsh-hnflow`，private，`type: module`；
- 安装：`dsh plugin --profile desktop add "D:/workspace/HNFlow/plugins/dsh"`；
- 不发布 npm、不上架插件市场，因此不追求官方审核所需的展示规范；
  仍保留 `locale/*.json` 与 icon，便于自用时在插件列表里识别；
- 版本约束：`engines.dsh` 绑定当前 DSH 次版本；DSH 升级时按 §16 的检查清单适配。

### 3.5 DSH 插件开发规范符合性

依据：官方文档 <https://deepseek-harness.github.io/deepseek-harness/develop/basic/>（第一个插件 / 开发 Tool /
插件配置 / 打包与安装）与 <https://deepseek-harness.github.io/deepseek-harness/develop/framework/>（生命周期 /
服务 / 事件），源码 <https://github.com/deepseek-ai/deepseek-harness>。

| 规范点 | 要求 | 本插件的落地 |
| --- | --- | --- |
| 插件形态 | 导出 `name` + `apply(ctx, config)` | `plugins/dsh/index.js` |
| 配置 | 导出 `Config` schema，禁止硬编码可调参数 | 全部可调项进 `lib/config.js`（库根、workspace 目录、解释器、超时、索引条数） |
| 依赖注入 | `inject` 声明必需服务；可选服务用 `ctx.get()` | 必需：`tools`/`commands`/`systemPrompt`/`skills`；可选：`workingDirectory`/`loader` |
| 自动清理 | 注册即 effect，卸载自动撤销 | 全部走 `ctx.inject` / `ctx.on` / `ctx.effect`；`effect` 负责停引擎 |
| 失败可降级 | 坏配置、缺依赖不得拖垮会话 | 所有注册路径 try/catch，失败只 warn |
| Tool DSL | `defineTool` + 参数/输出 schema + `execute` | `lib/tools.js`；参数用 enum 收窄 action，输出 `string` |
| Tool 命名 | 不得与内置工具重名 | 内置 `dsh-tool-workflow` 已占用 `workflow`，本插件工具名改为 **`hnflow`** |
| 命令 | `commands.register({name, description, input, handler})` | `/workflow`，返回 `{kind, text}`，不进模型上下文 |
| 事件 | 只监听既有事件；**不得新增会话事件类型** | 只监听 `agent/pre-step`；不写 session event |
| Bundle | `package.json` 的 `dsh.bundle.patch` 只贡献配置层 | `cordis.patch.yml` 只做 `insert`，不改他人行 |
| Preset | 无继承，子插件清单必须自包含 | `preset-hnflow` 镜像 `dsh-web-app/presets/standard.patch.yml` |
| 安装 | `dsh plugin --profile <name> add <path>`，层序 profile → home → `--patch` | 见 `plugins/dsh/README.md` |
| 发布 | npm / 市场 / 审核 | **不适用**（自用）；不追求展示规范，保留 icon/locale 仅便于识别 |

---

## 4. 领域模型

### 4.1 工作流资产（WorkflowAsset）

工作流本体作为 **全局资产** 独立存在，可被多个工作区引用。

```jsonc
// $DSH_HOME/hnflow/library/release/publish.workflow.json
{
  "asset": {
    "id": "wf-7f3a…",          // 稳定身份，重命名/移动不变
    "name": "发布流程",
    "description": "构建 → 审核 → 发布 → 通知",
    "revision": 12,             // 单调递增，每次 save_asset +1
    "tags": ["release"],
    "createdAt": "…",
    "updatedAt": "…"
  },
  "definition": { /* WorkflowDefinition，含 metadata.canvas */ }
}
```

- 资产根默认 `$DSH_HOME/hnflow/library/`，文件夹即分类；
- 可选只读资产根（如团队共享目录），通过配置追加，用于复用外部资产；
- 资产 id 写入文件，路径可改；引用按 id 解析；
- 资产删除前检查引用，存在引用时拒绝删除（或要求先解除引用）；
- **revision 快照**：每次 `create`/`save` 在 `<library>/.hnflow-revisions/<assetId>/r<rev>.json` 写一份
  只读副本（扫描时跳过点目录）。没有快照，`ref.revision` 就只是提示而不是契约——固定版本的引用会在资产
  升级后失效。快照缺失即 `revision-missing`。

### 4.2 工作区引用（WorkflowRef）

工作区不复制资产，只保存引用：

```jsonc
// <workspace>/.hnflow/workflows.json
{
  "version": 1,
  "refs": [
    {
      "assetId": "wf-7f3a…",
      "revision": 12,           // 固定版本；null/缺省表示跟随最新
      "alias": "publish",       // 工作区内调用名，可省略
      "enabled": true,
      "addedAt": "…"
    }
  ]
}
```

- **默认固定 revision**：资产升级不会静默改变项目行为，这是复用与确定性的契约；
- `revision: null` 表示跟随最新，用于明确接受漂移的场景；
- 引用是「这个工作区用哪些工作流」的唯一清单，面板与工具都以此为准。

### 4.3 工作区覆盖（WorkflowOverride）

工作区内的修改保存为覆盖文件：

```jsonc
// <workspace>/.hnflow/overrides/wf-7f3a….workflow.json
{
  "assetId": "wf-7f3a…",
  "baseRevision": 12,           // 覆盖所基于的资产版本，用于漂移检测
  "origin": "agent" | "user",
  "note": "本项目把发布渠道改成 staging",
  "updatedAt": "…",
  "updatedBy": "agent",
  "changeLog": [                // 有界（最近 20 条）
    { "at": "…", "by": "agent", "summary": "target 从 prod 改为 staging" }
  ],
  "definition": { /* 完整定义副本，含 metadata.canvas */ }
}
```

- 采用 **完整副本** 而不是 JSON Patch：可离线、可 diff、可独立校验，复杂度最低；
- `baseRevision` 只用于漂移提示与 rebase，不阻塞运行（覆盖本身就是工作区的固定意图）；
- 删除覆盖文件即回到资产版本。

### 4.4 运行快照（RunSnapshot）

run 启动时冻结：

```jsonc
{
  "workflowAssetId": "wf-7f3a…",
  "assetRevision": 12,
  "overrideHash": "sha256:…",   // 无覆盖时为 null
  "definitionHash": "sha256:…",
  "inputs": { },
  "modelBindings": { "default": { "provider": "deepseek", "model": "…" } },
  "capabilitySnapshot": { "stackHash": "…", "contentHash": "…" }
}
```

快照写入 run 记录；运行期间任何编辑都不影响该 run。

### 4.5 Agent 修改的落点

| 场景 | 落点 | 资产 |
| --- | --- | --- |
| Agent 为本次任务调整节点参数、输入、画布 | 工作区覆盖 | 不变 |
| 用户说「把 target 改成 staging」 | 工作区覆盖 | 不变 |
| 用户说「把这个改动保存回发布流程」 | 资产 revision +1 | 变更 |
| 用户说「另存为新工作流」 | 新资产 | 新增 |

**不变量**：

- I1：只有 `save_asset`（用户显式）能改变资产 revision；
- I2：Agent 的编辑一律写覆盖，不写资产；
- I3：run 使用快照，不受后续编辑影响；
- I4：资产重命名/移动不影响引用（按 id）；资产缺失时 fail-loud，不静默替换。

### 4.6 解析顺序

```
override（若存在且 enabled）
  → ref 固定 revision 的资产
  → ref 跟随最新的资产（若声明）
```

错误码：`asset-missing`、`revision-missing`、`override-invalid`、`ref-duplicate`、`workspace-uninitialized`。解析结果与快照写入 run 记录。

---

## 5. 存储布局

```text
$DSH_HOME/hnflow/
├─ library/                     # 全局工作流资产（可写）
│  ├─ release/publish.workflow.json
│  └─ .hnflow-revisions/<id>/r<n>.json   # 只读 revision 快照
├─ state/                       # 引擎运行态，不进仓库
│  ├─ checkpoints.sqlite        # LangGraph checkpoint（thread_id = runId）
│  ├─ runs.json                 # run 记录（状态 / 冻结定义 / 输入 / 来源）
│  └─ tasks.json                # 人工任务行（含 pending）
└─ config.json                  # 资产根、模型映射、引擎参数

<workspace>/
├─ AGENTS.md                    # 会话 Agent 与节点项目层共用
├─ .vibestack/stack.json        # 能力组激活（不变）
└─ .hnflow/
   ├─ project.json              # 项目能力配置（不变）
   ├─ content/{rules,skills,tools}/  # 项目内容（不变）
   ├─ workflows.json            # 引用清单
   └─ overrides/*.workflow.json # 工作区覆盖
```

- 资产与覆盖都是普通 JSON 文件，git 可 diff；
- `state/` 含运行数据，建议加入 `.gitignore`（由插件在初始化时提示，不自动改写仓库）；
- 工作台（workbench）不再是运行入口，仅作为面板中的保存视图保留兼容（`workbenches/*.json`）。

---

## 6. 模式设计

| 模式 | 能力组（rules/skills/MCP/人设） | 工作流工具 | 工作流面板 | 说明 |
| --- | --- | --- | --- | --- |
| `standard` 等现有模式 | 无 | 无 | 只读/隐藏 | DSH 自带 |
| `vibestack`（保留） | 有 | 无 | 隐藏 | **只用能力组、不用工作流** |
| `hnflow`（新增） | 有 | 有 | 完整 | 能力组 + 工作流 |

- `preset-hnflow` 的子插件清单 = 标准工具集 + `dsh-hnflow` + 工作流工具 + 能力组投影；
- 能力组投影 **复用现有 `dsh-vibestack` 插件**，为其增加 `presetId` 配置项，使其在 `hnflow` 模式下同样生效（决策 D3）；
- 若外部插件改造暂不可行，降级为「HNFlow 模式不含会话级能力组注入，能力组只服务于工作流节点」，并在文档中标注；
- 工作流面板的运行/会话动作只在 `hnflow` 模式可用；其他模式下如果打开面板，显示只读与「切换到 HNFlow 模式」提示；
- 模式由 DSH 的 agent preset 承担，工具目录随 preset 固定，不在会话中动态增删（保持 KV cache 稳定）。

---

## 7. 会话内交互（不做 `@workflow`）

### 7.1 原则

- 不新增输入触发语法；遵循 DSH 习惯：**斜杠命令 + 模式 + 工具调用**；
- 用户「明确指定工作流」通过三条路径实现：命令、面板、自然语言点名；
- 工具调用必须带显式 `workflow` 标识，Agent 不得猜测。

### 7.2 `/workflow` 命令（R16 后）

```text
/workflow                          列出本工作区引用的工作流
/workflow <alias|id> <提示词…>      把引用 + 提示词交给 AI，由 AI 用 hnflow 工具启动
```

命令**不再直接执行**工作流：它把 `<hnflow_workflow name="…" asset="…" />` 与用户提示词
合成一条用户消息（`agent.followup(createUserMessage(...))`），AI 在这一轮里用
`hnflow(run)` 启动，然后回一行就结束。会话只负责启动。

直接运行（不经对话）属于 HNFlow 页面；资产库与引用的管理属于 `/hnflow`（R16 新增），
任何会话可用，且**没有任何运行能力**：

```text
/hnflow ref list|add|remove|pin
/hnflow asset list|new|import|delete
/hnflow override diff|reset <name>
/hnflow save asset <name> [--yes]   先给 diff，--yes 才写
/hnflow node <name> <nodeId> <json>
/hnflow ui <op> <base64url payload> 页面取数（只读，读 state 文件）
/hnflow doctor [--python p] [--cwd d] [--save]
```

命令在宿主侧执行，返回文本结果；除 `/workflow <name> <提示词>` 之外都不进入模型上下文。

### 7.3 工具契约

**工具名是 `hnflow`，不是 `workflow`**：DSH 自带的 `@deepseek-ai/dsh-tool-workflow` 已经注册了 `workflow`，
同名会冲突。命令仍是 `/workflow`（斜杠命令与工具命名空间无关）。

```text
hnflow(
  action: "list"|"get"|"run"|"status"|"cancel"|"resume"|"events"|"assets"|"task_list"|"task_submit",
  workflow?: string,     // 必填（run/get），别名或资产 id
  input?: object,        // start 节点端口值
  run_id?: string,
  task_id?: string,
  revision?: number
)
```

- `run` 缺少 `workflow` → 直接报错（`workflow-required`），不猜候选；
- **`run` 只启动**：引擎接受定义后立即返回（runId + 状态），不等待、不轮询、不弹卡；R16 去掉了 `wait_seconds` 与 `interactive`；
- 工具失败一律返回带稳定 code 的文本（`error <code>: <message>`），不抛异常、不结束回合；
- 写覆盖走 `hnflow_author` 的 `save_override`（先校验，校验不过不落盘）；
- **工具面没有写资产的动作**：`hnflow_author` 只有 `schema | validate | save_override`，
  资产只能由用户输入 `/hnflow save asset <name>` 写入。I1 因此是「物理上无入口」而不是提示词约束。

```text
hnflow_author(
  action: "schema"|"validate"|"save_override",
  workflow?: string,       // save_override 必填
  definition?: object,     // validate / save_override 必填
  note?: string            // 写进覆盖的 changeLog
)
```

### 7.4 会话内发起

- 用户在会话里说「用发布流程跑一下」：Agent 从系统提示索引或 `workflow list` 找到对应工作流，调用 `workflow_run`；
- 面板「在会话中运行」：创建/复用 `hnflow` 模式会话，预填草稿并绑定工作流（会话投影），Agent 在下一轮看到绑定并调用工具；
- 可选输入区选择器（M5，仅当用户反馈需要）：选中后 **插入等价命令**，不引入新的 token 语法。

---

## 8. 运行模型

### 8.1 状态机

```
queued → running → waiting_human → running → succeeded | failed | cancelled
```

### 8.2 归属与呈现

- run 归 **工作区**，可选 `session_id` 作为 owner；
- 有 owner 且插件在线时注册 **job 镜像**（`ctx.jobs`）：输出环接 run 事件，`job_kill` → 引擎取消，完成通知随 job 结算；
  **M2 交付**：job 生产需要 `JobSpec`/controller owner，且会话关闭后 job 仍须存续，先用 `run/status` +
  通知轮询替代，避免半成品 job 语义；
- job 只是视图；引擎重启后由插件重新挂接；
- 面板直跑不创建会话；首次出现人工任务时懒创建/绑定会话。

### 8.3 中止与脱离

- 工具调用的 `exec.signal` 默认映射为 **detach**，run 继续；
- 取消仅由 `workflow_cancel`、`job_kill`、面板停止触发；
- 卡片明确显示「已脱离 / 仍在运行」。

### 8.4 重启与幂等

- 引擎的 checkpoint、run 记录、人工任务行、run 事件都落在 `$DSH_HOME/hnflow/state/`
  （`checkpoints.sqlite` / `runs.json` / `tasks.json` / `events/<runId>.jsonl`），DSH 重启后仍在；
- `waiting_human` 的 run 重启后直接可提交，任务行与 checkpoint 都在；
- 进程死亡时仍在 `running` 的 run，重启后标记为 **`interrupted`**（不猜、不自动重放），
  **也不会自动续跑**（R16 去掉了自动续跑）：要续跑就让模型调 `hnflow(resume)`；
- 节点使用 `<run_id>:<node_id>` 幂等键；
- 人工任务提交按 `task_id + revision` CAS，重复提交返回 `task-not-pending` / `task-revision-conflict`。

---

## 9. 人工节点

引擎是任务权威，DSH 负责呈现与收集，三条通道共用一个宿主方法 `submitTask(taskId, revision, payload)`：

| 通道 | 场景 | 说明 |
| --- | --- | --- |
| ~~turn 内问题卡~~ | — | **R16 移除**：会话只负责启动，不再在 turn 里弹卡或提交答案 |
| 面板收件箱 | 任意时刻 | 零 token；面板「待办」页签列出所有 pending 任务，点开填 JSON 提交（行内表单待做） |
| 会话自然语言 | 用户之后追问 | Agent 调 `hnflow` 的 `task_list` / `task_submit`（**已落地**） |

问题卡映射规则（`lib/questions.js` 已随 R16 删除，规则留作页面表单的参考）：
`human:review` → 通过 / 打回（打回原因走自由文本）；
`human:task` → 每个输出端口一个字段（`bool` 给 true/false，其余自由文本，按端口类型解析）。

提交语义已定：同一 `task_id` 重复提交返回 `task-not-pending`；字段不符返回 `task-invalid`；
带 `revision` 的过期提交返回 `task-revision-conflict`；取消 `waiting_human` 的 run 会清掉它的待办。

- `human:review` → 单选（通过/打回 + 意见）；
- `human:task` 简单字段 → 每字段一个问题；复杂表单 → 面板；
- `debug_step` → 继续/停止；
- 通知策略 `humanTaskPolicy: notify | wake`，默认 `notify`，可对 review 单独开 `wake`；
- 不使用 `userApproval` 承载任务数据；它只用于危险节点（`app:*`、python 工具包）的运行前授权。

---

## 10. Agent 工具与 Skill

- **workflow**：运行与观察；**workflow_author**：读取 schema、校验、写覆盖（无写资产动作）；
- 内置 skill `hnflow-workflow`：节点目录、端口规则、四层提示词、常见模式；内容由引擎 schema 生成，避免与代码漂移；
- 系统提示注入工作流索引（名称 + 一句话，≤20 条），让「用发布流程」可以被解析；
- 护栏：
  - 写资产必须显式 + 二次确认 + diff；
  - 运行必须显式 id；
  - 运行中的定义只读；
  - Agent 不得绕过工具直接改 `.hnflow/workflows.json` 与资产目录（提示词约束 + 宿主校验兜底）。

---

## 11. 面板与资产管理

### 11.1 面板结构（`main` keyed slot）

> **已被 §11.4 取代（M6）**：composer 左栏控件 + 弹层的形态作废，改为左侧栏页面 / 会话顶部页签 / 右侧栏面板三处。
> 本节保留为历史与画布数据格式说明（`layoutDefinition`、只读 SVG、`metadata.canvas.positions`）。

```
┌ 资产库 ──────────┬ 画布 ──────────────────────┬ 运行 / 任务 ──┐
│ 目录树 / 搜索     │ 节点、连线、参数、校验       │ 运行列表       │
│ 新建 / 导入       │                            │ 运行详情       │
│ 引用状态          │ 工具栏：运行 | 保存到工作区  │ 任务收件箱     │
│                  │        保存回资产 | 放弃覆盖 │                │
└──────────────────┴────────────────────────────┴───────────────┘
```

- 读取：`remote.workspaceFiles`（分页、目录列表、`changes` 监听），Agent 或外部编辑器的改动实时反映；
- 写入：宿主服务（引擎校验 → 写覆盖/资产），不直接落盘；
- 无路由：面板选择存浏览器本地，用 `/workflow open` 作为深链替代。

**MVP 已落地**：面板不是独立页面，而是 composer 左栏的一个控件 + 弹层（`client.js`）。
它通过 `/workflow panel [name]` 拿一次性 JSON（引用清单 + 一个已解析定义），用 **只读 SVG 画布**
画节点与边（优先用 `metadata.canvas.positions`，否则用编辑器同款三列网格），点节点看/改参数；
其余按钮（待办 / 资产）直接执行命令并显示文本。
参数编辑走 `/workflow node <name> <nodeId> <json>`：宿主改一个节点的 `params` → 引擎校验 → 写工作区覆盖，
**资产不动**；旁边还有「撤销覆盖」。**没有**拖拽、连线、画布坐标保存、保存回资产的图形入口。

### 11.2 保存菜单

| 菜单项 | 作用 | 确认 |
| --- | --- | --- |
| 运行 | 手动触发（输入表单来自 start 节点） | 否 |
| 保存到工作区 | 写/更新 override（面板节点编辑走 `/workflow node`） | 否 |
| 保存回资产 | 资产 revision +1 | 是：`/workflow save asset` 先返回 diff，必须带 `--yes` 才写 |
| 放弃覆盖 | 删除 override（面板「撤销覆盖」） | 是 |
| 更新引用 | 把 ref 固定到新 revision / 切换 follow（`/workflow ref pin`） | 是 |
| 另存为新资产 | fork 成新资产 | 是（未实现） |

**已落地**：运行（命令/工具/问题卡）、保存到工作区、撤销覆盖、更新引用、保存回资产的**两步确认**
（工具面依然没有写资产的动作；面板也只是把同一命令点两次）。

### 11.3 资产管理页

- 资产库的增删改查、目录、标签、使用情况（哪些工作区引用）、版本历史；
- 删除受引用保护；重命名/移动不改变 id；
- 可选导出/导入（文件即格式）。

**已在命令层落地**：`/workflow asset list|new|import|delete` 与 `/workflow ref pin <name> [--to N]`。
导入接受三种文件形态（资产信封 / 引擎 `serialize()` 信封 / 裸定义），这就是现存 HNFlow 工作流的迁移入口；
删除在**本工作区仍引用**时拒绝（`asset-in-use`），并顺带清理遗留覆盖。
**剩余**：面板形态的资产库、跨工作区使用情况统计、版本历史浏览。

### 11.4 三面统一布局（M6）

三个宿主面，一套组件。

| 面 | DSH 接入点（已核对 0.2.1-rc.5 客户端源码） | 内容 |
| --- | --- | --- |
| 左侧栏页面 | `sidebar.panellist`（列表项，点击由宿主调 `ctx.layout.selectPanel(id)`）+ `main`（keyed，`key` 同名） | 页签：**工作区** / **通用工作流** / **任务监视** |
| 会话顶部页签 | `conversation.view`（列表项，`id`+`label` 即页签名） | 左：当前工作区工作流；右：画布 |
| 右侧栏面板 | `ctx.sidebarRightTabs.register({id, kind, priority, title})` + `sidebar.right.pane.tab` / `sidebar.right.pane.tab.title`（keyed，key=kind） | 任务监视（与页面第三页签同组件） |

- **工作区页签**：左树 = 全部工作区 → 每个工作区下**激活的工作流**（引用清单，带覆盖 / 漂移 / 缺失标记）；
  右侧 = 选中工作流的只读画布，**未选中时空白**。
- **通用工作流页签**：左树 = 资产库里的全部内置工作流（全局，不分工作区）；右侧同画布。
- **会话页签**：左树只有一个分组——当前会话的工作区；右侧同画布。
  **只在 HNFlow 模式的会话出现**：按当前会话的 `projectionValues.agentPreset` 动态注册 / 注销
  `conversation.view` 条目（页签栏是全局槽，没有"按会话过滤"的选项，所以用注册生命周期实现）。
- 服务访问：一律 `ctx.get(name)`。属性式 `ctx.foo` 只对 `inject` 声明过的服务有效，
  未声明的访问直接抛 `cannot get property … without inject`（M6.0 实测）。
- 三处共用：`PanelTabs`（页签条）、`WorkspaceTree`（左树）、`CanvasStage`（画布）、空态与字体/间距 token；
  页签条对齐 DSH 的 `SegmentedTabs` / `Menu` 视觉，不另造一套控件。
- 删除：`conversation.input.left` 的 HNFlow 控件与整个弹层（0.1.3 的行为）。命令与工具面不变，面板仍是"命令的图形壳"。

### 11.5 任务监视与通知

数据都来自引擎持久态（`run/list`、`task/list`），因此跨重启可见：

| 列 | 来源 |
| --- | --- |
| 工作区 | run metadata `workspace` |
| 会话 | run metadata `sessionId`（新增） |
| 工作流 | run metadata `workflowAlias` / `workflowAssetId` |
| 状态 | run `status`（queued/running/waiting_human/succeeded/failed/cancelled/interrupted） |
| 节点 | 当前 / 最后节点 `nodeId` |
| 时间 | `startedAt` / `endedAt`（`createdAt` 用于任务） |

布局：

```
┌ 全部执行 ────────────────────────────────────────────────┐
│ 12 进行中 · 3 等待人工 · 40 已完成        [工作区筛选 ▾]    │
│ 工作区    会话      工作流      状态      节点     开始     │
├ 需要你处理（3）──────────────────────────────────────────┤
│ 工作区    会话      任务      节点      要求      操作     │
│ …                                       查看/处理  → 表单  │
└──────────────────────────────────────────────────────────┘
```

- 分组顺序：工作区 → 会话 → 任务；会话标题取客户端 `ctx.sessions.list`（引擎只存 id）。
- 「处理」复用既有提交通道（`/workflow submit <taskId> <json>`），另给「在会话中打开」（`ctx.uiWorkspace.openSession`）。
- **通知**：`shell.overlay` 常驻一个通知入口（root scope，与页面/面板是否打开无关）。
  轮询 `monitor`（默认 5s，页面/面板可见时也复用同一份快照，避免三处各查一次）；
  用 `taskId` 集合判重，**首次出现**弹右下角 Toast（primitives `Toast`），点击跳任务监视，关闭后同一 `taskId` 不再弹。
  一次只展示一条，避免刷屏。

### 11.6 客户端 ↔ 宿主契约：`/workflow ui`

面板是"命令的图形壳"，页面同样如此：一条命令，一个 JSON payload。命令行为与手敲命令一致，便于测试与排错。

```
/workflow ui <op> <base64url(JSON 参数)>
```

| op | 参数 | 返回 |
| --- | --- | --- |
| `tree` | `{workspaces:[{id,name,path}]}` | `{workspaces:[{…, workflows:[ref…]}], assets:[…]}` |
| `canvas` | `{workspace, key}` | `{definition, source, revision, override, checksum}` |
| `assetCanvas` | `{assetId, revision?}` | 同上（资产侧） |
| `monitor` | `{}` | `{runs:[…], tasks:[…]}` |

- 用 base64url 是为了规避 Windows 路径的反斜杠、空格与引号，命令解析器只需要切 token；
- `tree` 的**工作区清单由客户端提供**（客户端本来就持有 `ctx.workspaces.list`），宿主不猜；
- `ui` 必须**无会话可用**（左侧栏页面不属于任何会话）：`commands.js` 现在从 `invocation.agent` 取 cwd，
  需要让 `ui` 走"参数自带路径"分支。这是 M6 的宿主侧改动之一。
- 不引入 typert Remote（D5 不变）；若后续需要推送，再评估 host 事件。

---

## 12. 模型与能力组

- 会话模型：完全使用 DSH（`dsh-llm` 适配器 + 设置页），这就是「支持其他 LLM」的落点；
- 节点模型（阶段一，**已落地**）：插件配置里的 `models[]` 在 `engine/initialize` 时随握手发给引擎，
  引擎用它替换 `AppConfig.models` 后交给 AI 节点；工作流里没有 AI 节点时不需要配置，
  有 AI 节点却没配模型时 `run/start` 直接返回 `models-unavailable`（带节点名），不会跑到一半崩；
- 节点模型（阶段二，**已落地**）：模型条目的 `use` 指向 `deerflow.workflow.rpc.llm_bridge:BridgeChatModel` 时，
  AI 节点的消息经 `llm/complete` 反向请求送到插件，由 DSH 的 `ctx.llm.stream` 执行并回传文本——
  模型目录与凭据只存在于 DSH，HNFlow 侧不需要再写一份 api_key；
  条目仍需 `context_window`（AI 节点按它压缩上下文），桥接模型只回答文本、`bind_tools` 为空操作；
- 能力组：节点侧解析与四层提示词保持不变；会话侧复用 `dsh-vibestack`（见 §6）；
- 项目内容（`AGENTS.md`、`.hnflow/content`）保持不变，作为能力组之外的项目级来源。

---

## 13. 数据迁移

| 现有数据 | 迁移方式 |
| --- | --- |
| SQL 中的工作流定义 | 一次性脚本导出为资产文件（含 `metadata.canvas`） |
| 工作台成员 | 转为工作区引用；布局保留为面板视图 |
| run / human_tasks / 规约 | 留在引擎库，面板只读展示历史 |
| 能力组 / 项目内容 | 不动 |

迁移脚本必须幂等，输出报告（成功/跳过/冲突），失败不删除原数据。

---

## 14. 里程碑

### 14.1 已落地（2026-11-03）

| 项 | 结果 |
| --- | --- |
| 引擎 headless | `deerflow.workflow.rpc`：stdio JSON-RPC 2.0，`engine/initialize|ping|shutdown`、`workflow/validate|describe`、`run/start|status|cancel|events|list`、`task/list|submit`（M3 前明确 `human-tasks-unavailable`） |
| 引擎执行 | 复用 `compile_definition` + 默认 executor 注册表 + 每 run `MemorySaver`；节点事件翻译为 `run/event` |
| 插件骨架 | `plugins/dsh`：bundle manifest、`cordis.patch.yml`、`preset-hnflow`（含 `dsh-vibestack` 行） |
| 资产/引用/覆盖 | `AssetStore`（含 revision 快照）、`WorkspaceStore`、`Resolver`（override → pinned → latest + drift 判定） |
| 会话面 | `hnflow` 工具、`/workflow` 命令族、系统提示工作流索引、内置 skill `hnflow-workflow` |
| 测试 | 引擎 `backend/tests/test_workflow_rpc.py` 24 项；插件 `plugins/dsh/test` 71 项；`dsh plugin add` + `--dump-config` + Web 启动冒烟 |
| 人工节点（M3 主体） | 引擎内存任务库 + `interrupt` 挂起（`waiting_human`）+ `task/list|submit` 恢复；插件 `task_list`/`task_submit` 与 `/workflow tasks|submit`；重复提交与字段校验有稳定错误码 |
| 运行持久化（M2 主体） | `checkpoints.sqlite`（AsyncSqliteSaver）+ `runs.json` + `tasks.json`，`$DSH_HOME/hnflow/state/`；`waiting_human` 跨重启可提交，`running` 跨重启转 `interrupted` 并可 `run/resume` |
| 写入面（M4/M5 的一部分） | `hnflow_author`（schema / validate / save_override）；`/workflow save asset` 是唯一写资产入口；覆盖先校验后落盘 |
| 资产库生命周期 | `/workflow asset new|import|delete`、`/workflow ref pin`；导入支持资产/引擎/裸定义三种形态，删除受当前工作区引用保护 |
| 问题卡（M3 通道之一） | `hnflow` 在 `waiting_human` 时用 `ctx.userQuestions.ask()` 弹卡：review 一卡两选项，task 一端口一卡；未作答不提交；`interactive:false` 可关 |
| 面板 MVP（M4 一部分） | `client.js` + `dsh.client` manifest；composer 左栏 HNFlow 控件，弹层含工作流列表、只读 SVG 画布（`/workflow panel` 供数）、节点参数编辑（`/workflow node` → 覆盖）、撤销覆盖与命令按钮；仅 `hnflow` 模式渲染；`dsh plugin add` 后 boot 图里可见 `dsh-hnflow/client.js` |
| 保存回资产（M4 验收项） | `/workflow save asset` 先给 diff 与 `rN → rN+1`，必须 `--yes` 才写；面板「保存回资产…」→「确认写入资产」是同一命令的两次点击；工具面仍无写资产动作 |
| 模型桥（M5 阶段一） | 插件 `models[]` 随 `engine/initialize` 下发，引擎替换 `AppConfig.models` 交给 AI 节点；无模型且含 AI 节点时 `run/start` 返回 `models-unavailable` |
| 模型桥（M5 阶段二） | `llm_bridge.BridgeChatModel` + 反向 RPC `llm/complete`：AI 节点的消息送到插件，由 `ctx.llm.stream` 在 DSH 侧执行、回传文本；凭据只存在 DSH；端到端由 `test_an_ai_node_completes_through_the_plugin_over_stdio` 覆盖 |
| 面板收件箱（M3 通道二） | 面板「待办」页签读 `/workflow inbox`（JSON），点任务给模板 JSON，提交走 `/workflow submit <id> {json}`；`submit` 同时支持 `k=v` 与 JSON 两种写法 |
| 运行时间线 | `run/events` 追加写入 `state/events/<runId>.jsonl`，重启后仍可回放；`hnflow` 的 `events` 动作与 `/workflow events <runId>` 渲染节点时间线 |
| 未做 | job 镜像与 run 卡片（M2 剩余）、面板收件箱与 turn 内问题卡（M3 剩余）、画布与保存菜单 UI（M4）、模型桥（M5） |

### M0 引导（1 周）

- 仓库目录调整：`plugins/dsh/`（插件）、`docs/`；**引擎放在 harness 内**（`deerflow/workflow/rpc/`），
  不新建顶层 `engine/`——复用同一 venv、lint 与测试，避免第二套 Python 工程；
- 引擎 headless 协议（validate/run/status/cancel/events）与版本握手；
- 插件骨架：bundle、host 入口、preset 行、安装脚本；
- 验收：`dsh plugin add` 后出现 HNFlow 模式；`/workflow` 可列空列表。

### M1 资产、引用、覆盖与首次运行（2 周）

- AssetStore / WorkspaceStore / Resolver；
- `/workflow ref add|list`、`hnflow` 工具 run、面板只读；
- run 快照（定义 + 来源 + revision 写入 run metadata）与 job 镜像（顺延到 M2）；
- 验收：引用资产 → 运行 → 完成通知；改覆盖不影响资产。

### M2 运行呈现（1 周）

- run 卡片、面板运行详情（节点时间线、日志、artifact）；
- detach/cancel、重启挂接；
- 验收：关闭会话不杀 run；DSH 重启后 run 继续。

**已落地（引擎侧）**：SQLite checkpoint + run/task 记录落盘；重启后 `waiting_human` 可直接提交，
`running` 转 `interrupted` 并由 `run/resume` 续跑；插件 `/workflow resume` 与 `hnflow` 的 `resume`。
**剩余**：job 镜像（`ctx.jobs` producer 契约）、run 卡片与面板时间线。

### M3 人工节点（2 周）

- 任务收件箱、`workflow_task_*` 工具、question 卡（review）、通知策略；
- 复杂表单只走面板；
- 验收：跨重启提交、双通道幂等、review 打回续跑。

**已落地（引擎侧 + 会话侧）**：`MemoryTaskStore` 作为执行器仓库、`interrupt` 挂起检测（`waiting_human`）、
`task/list` / `task/submit`（CAS：`task-not-pending` / `task-revision-conflict`，字段校验走
`human_task_state.validate_human_task_submission`）、`hnflow` 的 `task_list`/`task_submit`、
`/workflow tasks|submit`。
**剩余**：通知策略 `notify|wake`；复杂表单仍是 JSON 文本而非结构化控件。
（三条通道都已可用：turn 内问题卡、面板收件箱、会话命令与工具。）

### M4 画布与保存菜单（2–3 周）

- React Flow 画布、校验、读 watch、写宿主服务；
- 保存到工作区 / 保存回资产 / 放弃覆盖 / 更新引用 / 另存为；
- 验收：面板改参数 → 只改覆盖；显式保存 → 资产 revision +1。

**已落地（面板 MVP）**：`client.js` 在 `conversation.input.left` 注册一个 HNFlow 控件（仅 `hnflow` 模式显示），
弹层里是工作流列表 + 只读 SVG 画布 + 节点参数编辑器，另有「保存到工作区 / 撤销覆盖 / 保存回资产」。
数据来自 `/workflow panel` 一次调用，参数保存走 `/workflow node`（改一个节点 → 引擎校验 → 写覆盖），
写资产走 `/workflow save asset`（先 diff，再 `--yes`），客户端不读文件、不直连引擎。
**剩余**：拖拽与连线编辑、画布坐标保存、另存为新资产、`/workflow open` 深链。

### M5 模式、Agent 创作与模型桥（2 周）

- `preset-hnflow` 与 `dsh-vibestack` 组合：**已提前落地**——不改造 `dsh-vibestack` 的 `presetId`，
  而是把它的 host 行直接挂在 `preset-hnflow` 里（插件行为由工作区 `.vibestack` 决定，与 preset id 无关）；
- `workflow_author` 全量、skill、系统提示索引（skill 与索引已在 M1 落地）；
- 模型绑定/桥接；资产库页；
- 验收：VibeStack 模式无工作流入口；HNFlow 模式能力组与工作流同时可用。

**已落地（阶段一 + 二）**：`models[]` 配置 → 引擎 `AppConfig.models`；AI 节点前置检查 `models-unavailable`；
`BridgeChatModel` + `llm/complete` 反向 RPC 让节点完成在 DSH 侧执行（凭据不落 HNFlow）。
**剩余**：资产库独立页。

### M6 三面 UI 与任务监视（规划，2026-11-04）

目标：把"一个 composer 弹层"升级为**一个页面 + 两个页签 + 一块监视面板**，三处布局一致；
删掉 composer 控件；新增任务监视与右下角通知。版本号 `0.1.x → 0.2.0`（破坏性：删除 composer 控件）。

#### M6.0 前置验证（0.5 天）

| # | 未知 | 验证 | 失败退路 |
| --- | --- | --- | --- |
| S1 | 第三方插件注册 `main` 面板 + `sidebar.panellist` 图标能否出现在左栏并被点击切换 | 注册一个空面板，重启后看左栏 | 退化：`shell.leading` 按钮 + 全屏覆盖层页面 |
| S2 | 只注册 `conversation.view` 而不注册 `uiConversation.views` builder 时页签能否渲染 | 注册一个静态页签 | 注册空 builder（`create` 返回静态快照） |
| S3 | `shell.overlay` 内能否稳定定位右下角 Toast | 渲染固定定位容器 | 自绘 toast（`position:fixed; right/bottom`） |
| S4 | 第三方 bundle 能否 `require('@deepseek-ai/dsh-client-ui-primitives')`（Menu/Tooltip/Toast/图标） | 用其中一个图标渲染 | 自绘全部控件，只依赖 react |
| S5 | `sidebarRightTabs` / `sidebarRight` 是否注入给第三方插件 | 注册一个 tab 类型并打开 | 退化：只在页面内做任务监视，不做右栏 |

**M6.0 结果（2026-11-04，探针 0.1.9 → 0.1.14，四次实机重启）**

| 检查 | 结果 |
| --- | --- |
| S1 左栏图标 / S1b `main` 页面 + `selectPanel` | **通过** |
| S3 `shell.overlay` 右下角通知 | **通过** |
| S4 `primitives` 平台模块（`Toast` / `SegmentedTabs` 可用） | **通过** |
| S2/S6 会话页签 + 按模式开关 | **通过**：按当前会话 `projectionValues.agentPreset` 动态注册/注销；`preset=vibestack` 时不注册 |
| S5 右栏页签 | **通过**，但要过三关：<br>1. `ctx.sidebarRightTabs` 属性访问 → 抛 `without inject`；<br>2. `ctx.get("sidebarRightTabs")` → `undefined`（不注入就取不到）；<br>3. **必须** `ctx.inject(["sidebarRightTabs"], scope => …)` 拿到服务 |
| S5 打开方式 | 类型注册**不会**自动出现页签；必须 `sidebarRight.openTab(kind, {params})`。而且只能在**已挂载会话面**时调用（从全局页面调用报 `no session surface is mounted`），所以入口放在会话头部按钮 |
| 命令行通道 | 全局页面发命令必须带**真实会话 id**（从注入的 `sessions`/`uiSession` 取）；`execute(undefined, …)` 返回 ok 但宿主不执行（假阳性） |
| 结论 | 五个面全部可用；右栏的入口依赖会话面，M6.5 按此设计 |

#### M6.1 宿主契约（1 周）

- `lib/ui.js`：`tree` / `canvas` / `assetCanvas` / `monitor` 四个 op + base64url 解码，纯函数可测；
- `commands.js`：`ui` 走"参数自带路径"，**无会话也可执行**（其余命令保持需要 cwd）；
- 记录扩展：`runs` 增加 `sessionId`、`updatedAt`；`tasks` 增加 `sessionId`、`createdAt`、`answeredAt`；
  命令行 `run … --session <id>`；工具面用 `agent.session.id`；
- 引擎 `runner.py`：metadata 透传 `sessionId`，`run/list` 返回 `createdAt`/`updatedAt`；
- 验收：`/workflow ui tree <b64>` 在无会话命令行可用；重启两次后 `monitor` 仍返回同一条待办。

**已落地（2026-11-04）**

| 项 | 结果 |
| --- | --- |
| `ui` 四个 op | `tree`（多工作区 + 资产库，单个工作区读失败只标 `error` 不中断）、`canvas`、`assetCanvas`（可按 revision）、`monitor` |
| 无会话执行 | `commands.js` 的 `ui` 分支在 cwd 解析之前，`list` 等其它命令仍要求工作区 |
| 会话归属 | `startRun({sessionId})` → metadata；命令行 `--session <id>` / `--session=<id>`；工具面自动取 `exec.agent.session.id` |
| 引擎字段 | `RunState.summary()` 增加 `metadata` + `updatedAt`；`_summary(row)` 增加 `createdAt`/`updatedAt`；`monitor()` 把任务 join 到 run 的 workspace/session |
| 测试 | 引擎 34 通过（新增 run/list metadata、task createdAt 两条）；插件 146 通过（新增 6 条：tree 容错、canvas 参数校验、assetCanvas revision、monitor、无 service、`--session` 解析） |
| 实机冒烟 | `tree` 读到 1 个资产、`assetCanvas` 读到该资产 4 个节点（`wf-3ae1b61d98a5`） |

#### M6.2 客户端重构（1 周）

- 删除 `conversation.input.left` 注册与弹层；保留纯函数（`layoutDefinition` / `placeMenu` / `menuItems` 里仍有用到的）；
- 拆 `lib/ui/`：`panelTabs.js`、`workspaceTree.js`、`canvasStage.js`、`taskBoard.js`、`commands.js`（`props.run` 封装）、`store.js`（三处共享一份快照 + 轮询）；
- `client.js` 只做注册与装配；
- 验收：测试数 134 → ≥150；代码里不再有 composer 入口。

**已落地（2026-11-04，0.2.0）**：composer 控件与弹层整体删除（含 `placeMenu`/`menuItems`/节点编辑）；
`client.js` 收敛为「数据层（`runUi`/`commandTarget`/`listWorkspaces`）+ 组件（`HnflowIcon` / `HnflowPage` / `CanvasStage` / `TaskBoard`）+ 注册」；
纯函数 `readText`/`encodePayload`/`parseJson`/`workspaceItems`/`layoutDefinition`/`edgePath`/`isHnflowPreset`/`shortPath`/`shortSession` 由测试覆盖。
（单文件而非 `lib/ui/`：客户端 bundle 只允许一个入口文件，拆目录需要在 bundle 内自带打包器。）

#### M6.3 HNFlow 主页面（1 周）

- `sidebar.panellist` 图标（`id: "hnflow"`）+ `main` keyed 面板 + 页内页签（工作区 / 通用工作流 / 任务监视）；
- 左树两级（工作区 → 工作流），右侧画布，未选中空白；
- 验收：插件加载即出现左栏图标；点开是页面；三页签切换正确；画布与所选一致。

**已落地（2026-11-04，0.2.0）**：左侧栏 `◆ HNFlow` 入口 + `main` 面板；三页签；
工作区页签按工作区分组列出引用（覆盖/漂移/缺失标记），通用工作流页签列资产库，任务监视页签复用 `TaskBoard`；
画布未选中时显示空态；数据全部走 `tree` / `canvas` / `assetCanvas` / `monitor`。
**待实机验收**：图标与页面需要重启 DSH 后确认。

#### M6.4 会话顶部页签（0.5 周）

- `conversation.view`（`id: "hnflow"`，`label: "HNFlow"`，`order` 排在 chat 之后）；
- 内容：当前工作区左树 + 画布；每会话独立选择；
- 验收：顶部出现页签；切回对话无副作用；换个会话互不影响。

**已落地（2026-11-04，0.2.1）**：页签按**当前会话**的 `projectionValues.agentPreset` 动态注册 / 注销（`preset === "hnflow"` 才注册）；
视图内容用 `sessionId` 反查该会话的 `cwd`（不是"当前会话"，所以多开不会串），左树只列该工作区的引用。
**待实机验收**：需要在 HNFlow 模式的会话里看页签；切到其它模式会话应消失。

#### M6.5 右侧任务监视 + 通知（1 周）

- `sidebarRightTabs.register` + 两个 keyed 槽；`ctx.sidebarRight.openTab(kind, {params})`；
- `shell.overlay` 通知入口（轮询 + 判重 + 右下角）；
- 验收：右栏出现 HNFlow 页签；面板未打开时新待办弹通知一次；点通知能打开面板并定位任务。

**已落地（2026-11-04，0.2.1）**：

| 项 | 结果 |
| --- | --- |
| 页签类型 | `ctx.inject(["sidebarRightTabs","sidebarRight"])` → `register({id, kind, priority:"extension", title})` |
| 面板正文 | `sidebar.right.pane.tab`（key=kind）里复用 `TaskBoard`，每 5 秒自刷一次 |
| 打开入口 | 会话头部 `conversation.session.header.utilities` 的「◆ 任务」按钮 → `openTab(kind)`；类型注册本身不产生页签，且只能在已挂载会话面时打开 |
| 通知 | `shell.overlay` 常驻入口，独占轮询（页面与面板不再各查一次）；`taskId` 判重，**首次出现**弹右下角一次，一次一条，点「查看」打开右栏 |
**待实机验收**：右栏页签与通知（通知要求真有新的 pending 任务）。

#### M6.6 收尾（0.5 周）

- 三处对齐（同一组件、同一空态、同一字号与间距）、README/本规划同步、打 `0.2.0`、实机验收；
- 回归：`plugins/dsh/test`、引擎 `backend/tests/test_workflow_rpc.py`。

**已落地（2026-11-04，0.2.2）**：`WorkflowTree` / `AssetTree` / `CanvasStage` / `TaskBoard`
四处共用，页面与会话页签的树结构、空态、字号一致；切页签清空选区，画布不会串到另一页签；
会话页签加了工作区名 + 刷新。版本号 `0.2.0 → 0.2.2`。
**待实机验收**：三处 UI 与通知（通知需要真有 pending 任务）。

总计约 5 周（按交付顺序：M6.0 → M6.1 → M6.3 → M6.4 → M6.5 → M6.2 收尾，M6.2 与 M6.3 可并行）。

### M7 常驻页面（规划，2026-11-04）

**问题**：页面数据取自 `/workflow ui`，而这条命令只注册在 **HNFlow 模式**的会话里
（插件行挂在 `preset-hnflow.plugins` 下）。于是"选中哪个会话"决定了页面有没有数据，
与"插件存在即存在"的预期不符。

**约束**：不能把 `hnflow` 工具暴露给所有模式（R4：VibeStack 模式只用能力组）；
也不能让两个插件实例各起一个引擎（同一 `checkpoints.sqlite` / `runs.json` 会互相踩）。

#### 方案对比

| 方案 | 做法 | 代价 |
| --- | --- | --- |
| **A（推荐）** | 新增**全局 viewer 行**：只注册 `/hnflow ui …`，只读；`monitor`/`wait` 直接读 `state/runs.json` + `state/tasks.json`，**不启动引擎** | 监视数据来自文件最后一次落盘（引擎在 start/status/任务变化时都会 `_persist`），不是实时事件订阅 |
| B | 全局行同样走引擎，两个实例共享模块级 engine 单例 | 依赖"同进程同模块实例"；页面首次打开要等引擎启动 |
| C | 整个插件改全局行（命令 + 工具都全局） | 最简单，但工具进入所有模式，破坏 R4 |

**推荐 A**：页面是只读视图，读文件足够；不碰引擎就不会和模式内实例抢状态。

#### M7.1 宿主（0.5–1 天）

- `config.role = 'all' | 'viewer'`（默认 `all`）；
- 新 `lib/state.js`：读 `state/runs.json` / `state/tasks.json`，产出与 `monitor` 相同的 payload；
  把现有 `service.monitor()` 的整形抽成纯函数 `shapeMonitor(runs, tasks)`，两处共用、单测覆盖；
- `commands.js` 加 `/hnflow <op> <b64>`：`viewer` 角色只放行 `ui` 的
  `tree / canvas / assetCanvas / monitor / wait`，其它一律 `viewer-readonly`；
- `cordis.patch.yml`：`hnflow-ui` 行改 `host: true` + `config: { role: viewer }`
  （同包第二个实例，不注册工具）；
- 测试：整形纯函数、文件缺失/损坏容错、viewer 白名单、`/hnflow` 注册形状。

#### M7.2 客户端（0.5 天）

- 页面与右栏改调 `/hnflow ui …`；保留"逐会话尝试"作为旧宿主兜底；
- 错误区分：`/hnflow` 不存在（宿主未更新）与「没有会话可执行命令」。

#### M7.3 验收（0.5 天）

- 全新启动、**不打开任何 HNFlow 会话**：左栏页面有工作区/资产；任务监视显示
  `state/` 里那条 `waiting_human`；新待办出现时右下角弹一次；
- 打开 HNFlow 会话：`/workflow smoke 跑一遍冒烟流程` 会把引用交给 AI 启动（R16 后不再直跑）；
- VibeStack 模式会话里 `/workflow` 与 `hnflow` 工具**都不出现**（R4 守住）。

#### 风险与回退

| 风险 | 缓解 |
| --- | --- |
| 文件格式与引擎实现耦合 | 单测用引擎的 `EngineStore` 写、`lib/state.js` 读，格式一变立刻失败 |
| 文件比内存状态旧 | 引擎在 start/status/任务变化时 `_persist`；验收覆盖"等待人工"这一关键状态 |
| 第二个实例的副作用 | viewer 不注册工具、不起引擎、不写文件 |
| 回退 | `hnflow-ui` 行改回 `host: false`，客户端退回 `/workflow ui` |

**已落地（2026-11-04，0.2.13）**

| 项 | 结果 |
| --- | --- |
| 全局 viewer 行 | `hnflow-ui` 行 `role: viewer`：只注册 `/hnflow ui …`，不注册工具 |
| 只读命令 | `createViewerCommand` + `VIEWER_OPS`（`ping/tree/canvas/assetCanvas/monitor/wait`），`run` 等拒绝 |
| 监视数据 | `lib/state.js` 读 `state/runs.json` + `state/tasks.json`；`shapeMonitor` 与引擎路径共用（兼容 camelCase / snake_case 两种记录） |
| 状态目录 | 顺带修掉一个真问题：引擎此前读不到 `DSH_HOME`，状态落到了 `<cwd>/.hnflow-engine`；现在显式传 `DSH_HOME` + `HNFLOW_ENGINE_STATE`，与页面读的是同一个目录 |
| 客户端 | 先调 `/hnflow ui`，旧宿主回退 `/workflow ui`；会话 id 仍然逐个尝试 |
| 测试 | 插件 151（新增 5 条：两种记录整形一致、缺文件/半写文件容错、状态目录解析、viewer 只放行只读 op） |


---

## 15. 测试策略

- 引擎：协议契约、快照、checkpoint 续跑、人工任务状态机；
- 插件 host：内存 cordis 上下文（参考 `dsh-vibestack` 的 `plugin.test.js`）；
- 解析优先级：override/ref/缺失/漂移/重复引用；
- 保存语义：agent 编辑只写覆盖、`save_asset` 才提升 revision；
- 客户端：面板 DOM 测试、命令与工具绑定；
- M6 新增：`/workflow ui` 四个 op 的纯函数（含 base64url 解码与非法输入）、`monitor` 记录字段、
  三面注册形状（槽名/id/order/key）、通知判重（同一 `taskId` 只弹一次）、共享 store 不重复查询；
- 手工验收：Windows 桌面版 + Web profile 各一遍（三面各点一遍：左栏图标、会话页签、右栏面板 + 通知）。

---

## 16. 风险与缓解

| 风险 | 影响 | 缓解 |
| --- | --- | --- |
| DSH 处于 rc，slot/preset/事件可能变 | 插件失效 | 绑定次版本；preset 清单镜像标准；升级检查清单 |
| 画布包体与性能 | 面板卡顿 | 懒加载、按需渲染、只打包必要模块 |
| Python 引擎打包 | 安装体验 | `uv` 引导 + 健康检查 + 明确错误 |
| 两个真相源（会话/引擎） | fork 不含 run | run 卡片只读回放；文档写明 |
| 覆盖漂移 | 用户误以为是最新资产 | 面板徽标 + diff + 一键 rebase；run 记录 baseRevision |
| 资产误删/误改 | 引用断裂 | 引用保护、revision 快照、二次确认 |
| 宿主执行节点（app/python） | 安全边界 | 运行前审批、工具包信任开关、引擎仅本机 |
| 主面板 / 会话页签 / 右栏 API 属 rc，可能变（M6 依赖 4 个客户端扩展点） | 某面失效 | §14.2 M6.0 前置验证；每面留退化路径（见退路列） |
| 三处面各挂一份查询，重复读盘 / 重复轮询 | 卡顿、日志噪音 | 一份共享 store（单例），轮询器只在通知入口里跑 |
| 轮询通知在高频任务下刷屏 | 打扰 | 只对"首次出现的 pending taskId"弹一次；一次一条，5s 节流 |

---

## 17. 待决策

| 编号 | 问题 | 结论 |
| --- | --- | --- |
| D1 | 资产根默认位置 | `$DSH_HOME/hnflow/library`，可配置追加只读根（**已定**） |
| D2 | 覆盖格式 | 完整副本 + `baseRevision`（**已定**） |
| D3 | HNFlow 模式如何获得能力组 | 不改造 `dsh-vibestack`：把它的 host 行挂进 `preset-hnflow`（**已定**，见 §3.5、M5） |
| D4 | 引用默认固定还是跟随 | 默认固定 revision + 快照，显式 follow（**已定**） |
| D5 | 面板编辑器的 Remote 通道 | v1 用命令 + `workspaceFiles` 读；稳定后再评估 typert Remote |
| D6 | 定时运行 | 先由引擎调度并在面板展示；不复用 DSH schedule，避免模型轮次 |
| D7 | 引擎代码放哪里 | 放 harness（`deerflow/workflow/rpc/`），不建顶层 `engine/`（**已定**） |
| D8 | 工具名 | `hnflow`（`workflow` 已被内置工具占用，**已定**） |
| D9 | 只自用时的发布面 | 不做 npm 发布/市场上架；`dsh plugin add <path>` 本地链接（**已定**） |
| D10 | 会话页签是否只在 `hnflow` 模式显示 | 是：只在 HNFlow 模式会话注册该页签；页面与右栏仍全局可见（**已定**，R15） |
| D11 | 通知如何送达客户端 | 客户端轮询 `monitor`（5s）；不引入 typert Remote（**已定**，后续可换 host 事件） |
| D12 | 页面数据通道 | 单条 `/workflow ui <op> <base64url JSON>`，客户端不直读文件、不直连引擎（**已定**） |
| D13 | 删除 composer 控件 | 是，`0.2.0` 破坏性变更，README 记录迁移（**已定**） |
| D14 | 任务「处理」入口 | 面板内表单提交（复用 `/workflow submit`）+ 「在会话中打开」（**已定**） |
| D15 | 通用工作流的范围 | 资产库全部内置资产（全局）；工作区页签只列该工作区引用（**待确认**） |

---

## 18. 附录

### 18.1 术语

- **资产（Asset）**：全局工作流定义，带 revision；
- **引用（Ref）**：工作区对资产的指向与版本固定；
- **覆盖（Override）**：工作区内的修改副本；
- **快照（Snapshot）**：run 启动时冻结的定义、输入、模型与能力；
- **模式（Preset）**：DSH 的 agent preset，决定工具目录与提示词。

### 18.2 参考

- HNFlow：`README.md`、`backend/AGENTS.md`、`backend/packages/harness/deerflow/workflow/`、`projects/`；
- DSH 插件开发文档：<https://deepseek-harness.github.io/deepseek-harness/develop/basic/>
  （第一个插件 / 开发 Tool / 插件配置 / 打包与安装）；
- DSH 框架文档：<https://deepseek-harness.github.io/deepseek-harness/develop/framework/>
  （插件与生命周期 / 服务与依赖 / 事件系统）；
- DSH 源码：<https://github.com/deepseek-ai/deepseek-harness>；
- DSH 包（本机 0.2.1-rc.5）：`dsh-tools`、`dsh-tool-workflow`、`dsh-jobs`、`dsh-user-questions`、
  `dsh-user-approval`、`dsh-agent-preset`、`dsh-client-ui-layout`、`dsh-api-workspace-files`；

### 18.3 M6 依赖的客户端扩展点（已核对 0.2.1-rc.5 源码）

| 用途 | 接入方式 | 依据 |
| --- | --- | --- |
| 左栏图标入口 | `slots.register({name:"sidebar.panellist", id, order, label})` | `dsh-client-ui-sidebar`：`PanelRow` → `selectPanel(id)` |
| 主页面 | `slots.inject("main", ...)` + `register({name:"main", key})`；`ctx.layout.selectPanel(key)` | `dsh-client-ui-layout`：`main` 为 keyed root 槽，`LayoutController.selectPanel` 校验 key 已注册 |
| 会话顶部页签 | `slots.register({name:"conversation.view", id, label, order})` | `dsh-client-ui-conversation`：`viewTabs()` 由 `conversation.view` 槽项生成页签 |
| 右栏页签类型 | `ctx.sidebarRightTabs.register({id, kind, priority, title})` | `dsh-client-ui-sidebar-right`：`SidebarRightTabRegistry.register` |
| 右栏内容 | `slots.register({name:"sidebar.right.pane.tab", key:kind})` / `…tab.title` | 同上（schedule 插件同款接法） |
| 右下角通知 | `slots.register({name:"shell.overlay", id})` | `dsh-client-ui-layout`：`overlayLayer` 绝对定位覆盖层、`pointer-events:none`，子元素可交互 |
| 原生控件 | `require('@deepseek-ai/dsh-client-ui-primitives')`（`Toast`/`Menu`/`Tooltip`/`Button`/`SegmentedTabs`/图标） | `dsh-web-frontend` 启动映射表里作为平台模块暴露 |
| 读服务 | `ctx.get("<service>")`，不要用 `ctx.<service>` | 未在 `inject` 声明的属性访问会抛 `cannot get property … without inject`（M6.0 实测）；DSH 自身用 `ctx.get("uiWorkspace")` |
| 当前会话 preset | `ctx.get("uiSession").adapter.current.getSnapshot().key` + `ctx.get("sessions").list` 的 `byId[id].projectionValues.agentPreset` | 页签注册需要按会话模式开关 |
- 外部插件参考：`dsh-vibestack`（`D:/workspace/VibeStack/plugins/dsh`）。

---

## 15. R16：会话只负责启动（覆盖 §7.2 / §7.3 / §9 / §11.1 的旧描述）

四条规则，均已落地（`dsh-hnflow` 0.2.15）：

1. **会话里触发工作流只有一条路径**：`/workflow <name> <提示词>`。
   命令不执行工作流，它解析引用、把
   `<hnflow_workflow name="…" asset="…" revision="…" source="…" />` 和提示词合成一条
   普通用户消息（`agent.followup(createUserMessage(...))`），由 AI 在下一轮识别引用、
   按提示词内容推导 `input`、调用 `hnflow` 工具启动。
   - 引用必须**当前工作区已引用**的名称或资产 id（`ref-missing` 直接拒绝并列出现有引用）；
   - 提示词按原始文本原样带入（引号、换行、空格都保留）；
   - 系统提示的索引段写明：「这条消息以 `<hnflow_workflow …/>` 开头就是要点名的流程，
     启动后只回一行」。
2. **启动即结束**：`hnflow` 的 `run` 在引擎接受定义后立即返回（runId + 状态），
   不等待、不轮询、不弹问题卡；`wait_seconds` 与 `interactive` 参数已删除，
   `lib/questions.js`（问题卡）随之删除。`status` / `events` / `task_list` 只用于回答
   用户之后的追问。
3. **删除直接执行**：`/workflow run|status|events|cancel|tasks|inbox|submit|resume|panel|list`
   全部移除。直接运行（不经对话）由 HNFlow 页面发起（**待做**）。
   资产库与引用的管理改挂到 `/hnflow`：`ref` / `asset` / `override` / `save asset` / `node` /
   `doctor`，任何会话可用，但**没有任何运行能力**（`VIEWER_OPS` 只读，且没有 run/submit 分支）。
4. **不再自动续跑**：删除了 `config.autoResume` 与 `Service.resumeInterrupted()`。
   引擎重启把残留 `running` 标成 `interrupted` 之后，状态就停在那里，要续跑必须显式
   `hnflow(action="resume")`。

| 旧（≤0.2.14） | 新（0.2.15） |
| --- | --- |
| `/workflow run <name>` 宿主直跑并等待 | 删除；页面直跑（待做） |
| `/workflow submit <taskId>` | 删除；页面表单（待做）或 AI `task_submit` |
| `/workflow ref|asset|override|save|node|doctor …` | 改为 `/hnflow …` |
| 工具 `run` 默认等 30s、可弹卡 | 只启动，立即返回 |
| 启动 4s 后自动 `resumeInterrupted()` | 删除 |

