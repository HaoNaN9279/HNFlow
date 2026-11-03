# HNFlow × DeepSeek Harness 插件化开发规划

| 项 | 值 |
| --- | --- |
| 文档版本 | 0.2（M0/M1 实施后修订） |
| 日期 | 2026-11-03 |
| 基线 | `v0.10.0`（`master`，DSH 改造前的最后一个 HNFlow 版本） |
| 开发分支 | `feat/dsh-plugin` |
| 范围 | 自用插件，不提交官方插件市场，不参与官方审核 |
| 状态 | M0 完成，M1 主体完成（见 §14.1） |
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

### 7.2 `/workflow` 命令族

```text
/workflow                          列出本工作区引用的工作流
/workflow run <alias|id> [k=v …]   直接运行（不产生模型消息）
/workflow open <alias|id>          打开面板并定位
/workflow ref add <asset> [--pin r] 添加引用
/workflow ref list                 查看引用与覆盖状态
/workflow override diff            查看工作区覆盖与资产的差异
/workflow override reset           放弃覆盖
/workflow save override            保存到工作区（Agent 编辑的确认入口）
/workflow save asset               保存回资产（要求确认）
```

命令在宿主侧执行，返回文本结果；不进入模型上下文（与 DSH 命令语义一致）。

### 7.3 工具契约

**工具名是 `hnflow`，不是 `workflow`**：DSH 自带的 `@deepseek-ai/dsh-tool-workflow` 已经注册了 `workflow`，
同名会冲突。命令仍是 `/workflow`（斜杠命令与工具命名空间无关）。

```text
hnflow(
  action: "list"|"get"|"run"|"status"|"cancel"|"assets",
  workflow?: string,     // 必填（run/get），别名或资产 id
  input?: object,        // start 节点端口值
  run_id?: string,
  wait_seconds?: number  // run 等待上限，默认 30，上限 300
)
```

- `run` 缺少 `workflow` → 直接报错（`workflow-required`），不猜候选；
- 工具失败一律返回带稳定 code 的文本（`error <code>: <message>`），不抛异常、不结束回合；
- 写覆盖 / 写资产的工具（`hnflow_author`）属 M5；当前写资产只存在宿主侧显式入口（§11.2），
  因此 I1 在 M0/M1 期间是「物理上无入口」而不是「靠提示词约束」。

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

- 引擎的 checkpoint、run 记录、人工任务行都落在 `$DSH_HOME/hnflow/state/`（`checkpoints.sqlite` /
  `runs.json` / `tasks.json`），DSH 重启后仍在；
- `waiting_human` 的 run 重启后直接可提交，任务行与 checkpoint 都在；
- 进程死亡时仍在 `running` 的 run，重启后标记为 **`interrupted`**（不猜、不自动重放），
  由 `/workflow resume <runId>` 从最后提交的 checkpoint 继续；
- 节点使用 `<run_id>:<node_id>` 幂等键；
- 人工任务提交按 `task_id + revision` CAS，重复提交返回 `task-not-pending` / `task-revision-conflict`。

---

## 9. 人工节点

引擎是任务权威，DSH 负责呈现与收集，三条通道共用一个宿主方法 `submitTask(taskId, revision, payload)`：

| 通道 | 场景 | 说明 |
| --- | --- | --- |
| turn 内问题卡 | attended run | `ctx.userQuestions.ask()`，答案回到工具，工具提交引擎（M3 剩余） |
| 面板收件箱 | 任意时刻 | 零 token；复杂表单只在这里（M3 剩余） |
| 会话自然语言 | 用户直接回复 | Agent 调 `hnflow` 的 `task_list` / `task_submit`（**已落地**） |

提交语义已定：同一 `task_id` 重复提交返回 `task-not-pending`；字段不符返回 `task-invalid`；
带 `revision` 的过期提交返回 `task-revision-conflict`；取消 `waiting_human` 的 run 会清掉它的待办。

- `human:review` → 单选（通过/打回 + 意见）；
- `human:task` 简单字段 → 每字段一个问题；复杂表单 → 面板；
- `debug_step` → 继续/停止；
- 通知策略 `humanTaskPolicy: notify | wake`，默认 `notify`，可对 review 单独开 `wake`；
- 不使用 `userApproval` 承载任务数据；它只用于危险节点（`app:*`、python 工具包）的运行前授权。

---

## 10. Agent 工具与 Skill

- **workflow**：运行与观察；**workflow_author**：读取 schema、校验、写覆盖、显式写资产；
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

### 11.2 保存菜单

| 菜单项 | 作用 | 确认 |
| --- | --- | --- |
| 运行 | 手动触发（输入表单来自 start 节点） | 否 |
| 保存到工作区 | 写/更新 override | 否 |
| 保存回资产 | 资产 revision +1 | 是（diff + 二次确认） |
| 放弃覆盖 | 删除 override | 是 |
| 更新引用 | 把 ref 固定到新 revision / 切换 follow | 是 |
| 另存为新资产 | fork 成新资产 | 是 |

### 11.3 资产管理页

- 资产库的增删改查、目录、标签、使用情况（哪些工作区引用）、版本历史；
- 删除受引用保护；重命名/移动不改变 id；
- 可选导出/导入（文件即格式）。

---

## 12. 模型与能力组

- 会话模型：完全使用 DSH（`dsh-llm` 适配器 + 设置页），这就是「支持其他 LLM」的落点；
- 节点模型：`params.model_profile` → 插件解析为 `modelBindings` 传给引擎（阶段一）；阶段二改为 `llm.complete` RPC 桥接，让节点复用 DSH 的模型目录与凭据；
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
| 测试 | 引擎 `backend/tests/test_workflow_rpc.py` 21 项；插件 `plugins/dsh/test` 57 项；`dsh plugin add` + `--dump-config` + Web 启动冒烟 |
| 人工节点（M3 主体） | 引擎内存任务库 + `interrupt` 挂起（`waiting_human`）+ `task/list|submit` 恢复；插件 `task_list`/`task_submit` 与 `/workflow tasks|submit`；重复提交与字段校验有稳定错误码 |
| 运行持久化（M2 主体） | `checkpoints.sqlite`（AsyncSqliteSaver）+ `runs.json` + `tasks.json`，`$DSH_HOME/hnflow/state/`；`waiting_human` 跨重启可提交，`running` 跨重启转 `interrupted` 并可 `run/resume` |
| 未做 | job 镜像与 run 卡片（M2 剩余）、面板收件箱与 turn 内问题卡（M3 剩余）、画布与保存菜单（M4）、`hnflow_author` / 模型桥（M5） |

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
**剩余**：面板收件箱、turn 内问题卡（`userQuestions`）、通知策略 `notify|wake`、跨重启持久化（依赖 M2 存储）。

### M4 画布与保存菜单（2–3 周）

- React Flow 画布、校验、读 watch、写宿主服务；
- 保存到工作区 / 保存回资产 / 放弃覆盖 / 更新引用 / 另存为；
- 验收：面板改参数 → 只改覆盖；显式保存 → 资产 revision +1。

### M5 模式、Agent 创作与模型桥（2 周）

- `preset-hnflow` 与 `dsh-vibestack` 组合：**已提前落地**——不改造 `dsh-vibestack` 的 `presetId`，
  而是把它的 host 行直接挂在 `preset-hnflow` 里（插件行为由工作区 `.vibestack` 决定，与 preset id 无关）；
- `workflow_author` 全量、skill、系统提示索引（skill 与索引已在 M1 落地）；
- 模型绑定/桥接；资产库页；
- 验收：VibeStack 模式无工作流入口；HNFlow 模式能力组与工作流同时可用。

---

## 15. 测试策略

- 引擎：协议契约、快照、checkpoint 续跑、人工任务状态机；
- 插件 host：内存 cordis 上下文（参考 `dsh-vibestack` 的 `plugin.test.js`）；
- 解析优先级：override/ref/缺失/漂移/重复引用；
- 保存语义：agent 编辑只写覆盖、`save_asset` 才提升 revision；
- 客户端：面板 DOM 测试、命令与工具绑定；
- 手工验收：Windows 桌面版 + Web profile 各一遍。

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
- 外部插件参考：`dsh-vibestack`（`D:/workspace/VibeStack/plugins/dsh`）。
