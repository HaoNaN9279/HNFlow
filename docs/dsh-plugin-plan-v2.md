# HNFlow × DeepSeek Harness 约束式工作流插件开发方案（v2）

| 项 | 值 |
| --- | --- |
| 文档版本 | 2.0（基于《新开发理念》重写执行模型） |
| 日期 | 2026-11-07 |
| 分支 | `feat/dsh-plugin` |
| 目标运行环境 | DSH `0.2.1-rc.5`（桌面版 / web profile） |
| 插件 | `dsh-hnflow`（private，本地 `dsh plugin add`，不上架） |
| 依赖 | `D:\workspace\VibeStack\plugins\dsh`（`dsh-vibestack` ≥ 0.3.0，独立插件；HNFlow 单向强依赖，缺它进入 `degraded`） |
| 取代范围 | 取代 `docs/dsh-plugin-plan.md` 与 `HNFlow 开发方案.md` 的**执行模型**（LangGraph 图 + Python 引擎 + AI 节点）；保留其资产/引用/覆盖/人工治理的产品结论 |
| 文档状态 | 方案稿 v2.1；v0.3.0 已按本文落地（实现差异见附录 E） |

> 本文只讨论**一个目标**：把 HNFlow 改造成 DSH 插件，且遵循 `docs/新开发理念.md` 的三条结论——
> 用户编排的是**约束**而非步骤；**人**是有交付契约的生产能力；**验证与问责不能外包给生成者**。
> 旧 HNFlow 的 Python/LangGraph 执行栈不再作为插件地基。

---

## 0. 一句话

**插件不是"用户画流程图、AI 照着走"的执行器，而是架在 DSH subagent 之上的约束层：
用户定义节点之间的契约、门禁与交付验收；插件自己的状态机持有编排权；DSH 的 subagent 执行节点、
session 记录证据、storage 保存流程状态；人通过门禁与交付请求进入流程，且其产出同样要被验收。**

---

## 1. 判断：为什么必须换执行模型

### 1.1 来自《新开发理念》的三条硬结论

1. **操作性流程内化给 AI，约束性流程留给人。**
   固定 DAG + 节点脚本是"操作性流程"：DSH subagent 已能按任务形状自主拆分，再规定"先 A 后 B"
   边际价值很低。真正缺的是**约束的可编程性**：谁执行、能拿到什么、产出必须满足什么、什么条件下才能被下游消费。
2. **人不是阻塞点，而是有交付契约的能力节点。**
   门禁（允许/拒绝）与人工生产（提供 AI 不能生成的东西）是两种语义。后者必须携带交付物的形状、
   验收标准、不可替代性理由、等待与恢复策略——否则流程只是"暂停等一句我做好了"。
3. **生成者不能验收自己。**
   子 Agent 自报"完成"不可信。验收必须由独立判定（schema / 独立 Judge / 人）完成，
   人的交付物同样要过验收，不能"人交什么就用什么"。

### 1.2 旧方案的结构性问题

| 旧方案 | 新理念下的问题 | v2 处理 |
| --- | --- | --- |
| `WorkflowDefinition` → LangGraph `StateGraph` | 用户编排的是"执行脚本"，AI 被降级成节点里的函数 | 编排物改为**契约图**：节点=角色能力边界，边=产物契约+触发+失败语义 |
| Python `deerflow.workflow.rpc` 引擎（stdio JSON-RPC） | 第二套运行时、第二份真相、安装依赖 `uv`/Python | **删除**；插件纯 JS，运行在 DSH host |
| AI 节点由引擎调用模型（四层提示词 + model_profile + `llm/complete` 桥） | 与 DSH 的模型/凭据/预算体系重复，且绕开 subagent 的原生能力 | **删除**；节点=`ctx.subagents` 启动的子 Agent，模型走 preset/会话路由 |
| `human:task` + `/api/human-tasks` | 把人的产出当布尔值/表单字段，没有交付契约与验收 | 拆成 **gate（门禁）** 与 **request（人工交付）** 两个原语 |
| 引擎自管 checkpoint（`checkpoints.sqlite`） | 与 DSH 的 session/持久化重复 | 流程状态进 DSH storage domain；证据进子会话日志 |
| `preset-hnflow` + 全局 `hnflow-ui` 两个实例 | 两份状态、viewer 只读文件 | 一个全局 core service + 一个薄 mode 行 |

### 1.3 检验标准（本方案的验收问题）

一次运行结束后，插件必须能精确回答：

1. 这次运行用的是**哪一版**流程约束（revision + contentHash + preset/契约快照）？
2. 某个节点的产出**违反了哪一条契约**（哪条边、哪个 schema 字段、哪个门禁本该拦住）？
3. 人交付了什么、在什么条件下被接受、被下游哪个节点以什么方式消费？
4. 哪个节点的产出是**人提供的**、依据是什么（不可替代性声明）？

答不出这四问，方案就是失败的——不管它跑得多自动。

### 1.4 产品连续性：旧目标在新模型下的落点

| HNFlow 的原始目标 | v2 落点 | 变化 |
| --- | --- | --- |
| 图驱动、可复现 | 契约图 + 不可变 revision + lockfile | 拓扑仍可见，但"可复现"靠版本钉住与证据链，而不是节点内部确定性 |
| 本地软件一等（Blender/Unity/PS…） | 节点的 preset 里挂对应工具（DSH 工具/MCP/VibeStack 工具包） | 不再由 HNFlow 自建 App Bridge；工具执行回到 DSH 权限与沙箱 |
| 长期运行（天/周） | 等待是持久状态；`interrupted` + 显式 resume | 不做进程内长驻 Promise |
| 人机协同一等 | `gate` + `request` + `verify` | 从"表单/审批"升级为"交付契约 + 验收" |
| AI 受控 | 信封 + 独立 judge + 预算/重试上限 + preset 固定权限 | 控制点从"节点参数"上移到"契约与验收" |
| Agent 可替换 | 换 preset 换角色/工具；换 `model` 层换路由 | 不再有 AgentPort 适配器层 |
| 能力可治理 | preset 白名单 + 委派范围固定 + 审计表 | 治理面变薄，但边界更硬 |
| 领域无关 | 流程语言只有 6 个原语 | 领域能力通过 preset/技能/工具注入 |

---

## 2. 目标与非目标

### 2.1 目标

1. **只做 DSH 插件**：无独立后端、无独立前端、无 Nginx、无 Python；UI 走 DSH client 插件，能力走 DSH host service。
2. **约束可编程**：节点声明 `preset` / 输入契约 / 输出契约；边声明产物契约、触发条件、失败语义；发布前静态校验。
3. **编排权在插件**：插件持有状态机（活跃节点、产物、待决门禁、边判定），不把"是否完成"交给子 Agent。
4. **人是生产能力**：门禁与人工交付都是一等节点，交付物有形状、有验收、有审计。
5. **不可变版本**：发布即固定 revision；run 钉住 revision，恢复不读"最新版"。
6. **复用 DSH**：subagent / session / storage / preset / permission / userQuestions / fetch route / skills / commands / systemPrompt，不重造。
7. **强依赖 VibeStack**：`dsh-vibestack` 是独立插件；HNFlow 单向依赖它（能力组 + 模型中间层服务），缺它不进入可运行状态。
8. **可诊断**：失败默认 fail-loud，带稳定错误码与节点/边级定位。

### 2.2 非目标

- 不做可视化拖拽建图（v1 只读画布 + 表单式编辑；画布编辑见 §14）。
- 不做通用表达式语言 / 通用编程语言（只有声明式映射）。
- 不做市场分发、多租户、RBAC。
- 不把用户流程编译成 DSH `workflow` seam 的脚本（理由见 §3.3）。
- 不做云端调度；长等待不占内存、不靠轮询刷会话。
- 不做"AI 自动续跑"：恢复必须由人/模型显式触发。

---

## 3. 与 DSH 原生能力的分工

> 本机实测依据见附录 A。原则：**能由 DSH 拥有的，插件不复制。**

| 能力 | DSH 原生 | 插件职责 | 明确不做 |
| --- | --- | --- | --- |
| 单节点执行 | `ctx.subagents.startActivation({provider:'spawn', request:{agentPreset, outputSchema, parent, cwd, maxDepth}, delivery:'caller'})` | 决定启动哪个 preset、传什么简报、如何解读结果 | 不自己写 agent loop、不自己调 `ctx.llm` |
| 结构化输出 | 子 Agent 内置 `structured_output` 工具 + JSON Schema 校验（失败当轮重试） | 合成"节点信封" schema（§4.2），从 `result.structured` 取值 | 不自己实现 JSON Schema 校验与修复循环 |
| 并行执行 | 同一 activation 树并发（Host `maxActiveSubagents` 默认 **8**） | 拓扑调度 + 并行上限 + 每节点取消 | 不用 `workflowEngine` 跑用户流程 |
| 会话与证据 | 子 Agent 各有持久 session（`subagent/catalog` 可从父会话发现） | run 记录引用 `childSessionId`，供审计/回看 | 不往会话日志写自定义事件 |
| 流程状态 | `ctx.storageDomain.open(defineDomain(...))`（JSON KV + zod 校验，原子写） | 声明 `hnflow` 域的表结构与迁移 | 不自己造事务/文件锁 |
| 流程定义版本 | 无（插件自有） | 不可变 revision + lockfile + contentHash | — |
| 角色与工具边界 | `agentPresets`：preset 决定 persona + 工具目录；子 Agent 只接受 preset id | 发布时校验 preset 存在；节点**只**能引用 preset | 不接受节点内联 `tools`/`toolFilter`/persona |
| 权限 | `dsh-permission-presets` + 子 Agent 的委派范围声明（启动时固定，需审批的操作自动拒绝） | 节点只做"已授权范围内"的事；把"要不要批准"提前到门禁 | 不实现权限系统、不在运行时提权 |
| 模型路由 | VibeStack 的模型中间层服务（`ctx.vibestack`）+ 子 Agent `agentOptions` | 节点声明 `model`（层 id），启动时解析成 provider/model/effort；lockfile 钉住解析结果 | 不维护模型目录、不读凭据、不直接调 `ctx.llm` |
| 人机问答 | `ctx.userQuestions.ask()`（原生问题卡，要求**活跃的 runtime root**） | 门禁/交付的两条通道之一；状态先落盘再发问 | 不把问答当流程状态唯一真相 |
| 页面读写 | `ctx.connection.fetch.register({path, methods:['GET','HEAD','POST'], requestBody:'buffered'})` | `GET /api/hnflow/inbox`；`POST /api/hnflow/gate` 与 `/api/hnflow/deliverable` | 不做 websocket、不让页面直读内部文件 |
| 提示词 | `ctx.systemPrompt.section()` | 注入流程索引（名称+一句话，限额） | 不注入长流程正文 |
| 命令 | `ctx.commands.register()` | `/hnflow`（列表/收件箱/打开页面） | 不做 `@flow` 输入语法 |
| 技能 | `ctx.skills.register()` | `hnflow-flows` 技能（节点目录、契约规则、如何起草） | 不重复 VibeStack 的规则/技能 |
| 后台任务 | `ctx.jobs`（仅 bash kind、需 controller 附着） | **不用**；run 是插件状态机，不是 job | 不把 run 映射成 job 半成品 |

### 3.1 为什么用 service 而不是只加一个 tool

`docs/新开发理念.md` 要求"编排执行权留在插件自己的状态机里"。落地为：

- 插件注册一个真正的 Cordis service（`class HnflowService extends Service { constructor(ctx){ super(ctx,'hnflow') } }`，与 `ctx.tools`/`ctx.subagents` 同构），
  全局单例，持有：run 表、调度器、门禁/交付队列、storage 句柄、路由。
- 模型面只有**薄工具**：`hnflow`（读 + 启停）与 `hnflow_author`（schema/校验/起草，无发布）。
- 页面与命令读同一个 service，不读文件、不轮询引擎。

### 3.2 为什么不用 `ctx.jobs`

`JobSpec.kind` 当前只有 `bash`，且 `start` 要求附着的 controller 服务 owner；run 需要跨会话、跨重启、带门禁挂起——语义不匹配（旧文档 §8.2 已踩过）。run 用 storage 表 + service 状态机，面板走 fetch 路由。

### 3.3 为什么不用 `workflowEngine`（workflow seam）

- 它执行的是**脚本**（`node:vm` 内的 JS），而我们的编排必须由用户定义的**数据**驱动；把用户定义编译成脚本等于把编排权交给一段代码。
- 已知存在 `agent.constructor('return process')()` 逃逸路径。即便脚本由插件自己写，也没有理由为此引入 VM 边界。
- 它不提供门禁挂起、交付验收、契约校验、版本钉住——这些正是插件要提供的。
- 唯一可能的复用点是"一次 fan-out 同构节点"，v2 用 `maxParallel` + 直接 spawn 已足够（并发上限 8）。

---

## 4. 领域模型

### 4.1 六种节点原语（克制，不膨胀）

| 原语 | 语义 | 谁执行 | 输入 | 输出（信封内 `output`） | 失败语义 |
| --- | --- | --- | --- | --- | --- |
| `agent` | 执行一个被定义清楚的任务 | 子 Agent（`preset` 指定角色） | 上游产物 + 简报 + 工作区 | 节点自己的 `output` schema | 重试 N 次 → `failed` / 走 `on_fail` 边 |
| `judge` | 独立裁决冲突/核验产物 | 子 Agent（**必须**是不同 `preset`） | 冲突产物 + 原始意图声明（不含生成者历史） | `{verdict: accept / reject / needs_more, reasons[], conditions?}` | 判定失败 → `inconclusive`，交门禁或 `on_fail` |
| `merge` | 汇合多上游产物为下游输入 | 插件（确定性，无模型） | 多端口产物 | 声明式映射结果 | 缺端口/类型不符 → `failed`（fail-loud） |
| `gate` | 暂停，等人/判定器放行 | 插件 + 人（或 Judge 预判） | 上游产物快照 + 运行上下文 + 选项 | 批准 / 拒绝（含理由）/ 修改后批准（新产物 revision） | 拒绝 → `on_fail`；超时 → 按策略 |
| `request` | 向人要"AI 生成不了的东西" | 人（交付）+ 插件（验收） | 交付物契约 + 请求简报 + 不可替代性理由 | 人交付的 artifact（过验收后） | 验收不过 → 退回（有上限）/ 降级 / 仲裁 |
| `verify` | 对人交付物做验收（可独立复用） | 插件（schema）+ 可选 Judge | request 的交付物 + 契约 | `accepted` / `rejected(violations)` | 拒绝 → 退回给人 |

**没有的东西**（刻意）：`start`/`end`（入边/出边为空即起止）、`if`/`switch`（用边条件）、`loop`（v1 只允许 DAG）、通用 `data`/`code` 节点（计算交给 `agent`，确定性聚合交给 `merge`）。

`agent` 与 `judge` 另有一个可选字段 `model`：指向 **VibeStack 模型中间层**的层 id（如 `strong` / `fast` / `audit`），不是具体 provider/model。
它只影响路由，不扩大工具与权限，因此允许写在流程定义里；解析发生在启动节点时，并写进 run 的 lockfile。
`judge` 推荐固定一个与生产者不同的层（例如 `audit`），让"独立验收"同时具备独立模型。

### 4.2 节点信封：插件与子 Agent 之间唯一的契约

每个 `agent` / `judge` 节点的 `output` schema 会被插件包进**信封**，作为 `outputSchema` 传给子 Agent：

```jsonc
// 插件合成的 schema（示意；具体由 assertObjectJsonSchema 校验子集）
{
  "type": "object",
  "oneOf": [
    {
      "type": "object",
      "required": ["status", "output"],
      "properties": {
        "status": { "const": "done" },
        "output": { /* 用户声明的节点 output schema */ },
        "evidence": { "type": "array", "items": { "type": "string" } },
        "notes": { "type": "string" }
      },
      "additionalProperties": false
    },
    {
      "type": "object",
      "required": ["status", "needsHuman"],
      "properties": {
        "status": { "const": "needs_human" },
        "needsHuman": {
          "type": "object",
          "required": ["reason", "deliverable", "whyHuman"],
          "properties": {
            "reason": { "enum": ["capability_gap", "real_world_judgement", "authority", "ambiguous_intent", "asset_unavailable"] },
            "deliverable": { "type": "object" },   // 缺口的形状（JSON Schema 片段或描述）
            "whyHuman": { "type": "string" },      // 不可替代性声明
            "blocking": { "type": "boolean" }
          },
          "additionalProperties": false
        }
      },
      "additionalProperties": false
    },
    {
      "type": "object",
      "required": ["status", "error"],
      "properties": {
        "status": { "const": "failed" },
        "error": { "type": "object", "properties": { "code": { "type": "string" }, "message": { "type": "string" } } }
      },
      "additionalProperties": false
    }
  ]
}
```

为什么要有信封：

- **完成状态由插件解释，不由子 Agent 宣判**（回应"自审准确率接近抛硬币"）。子 Agent 只能申报三种**结构化意图**，是否算完成、是否放行下游，由状态机按契约决定。
- **`needs_human` 是"缺口声明"而不是阻塞等待**：子 Agent 报告缺口后结束本次执行；编排层决定是否激活 request 节点（只有流程在该位置声明了人工交付通道才允许），再启动新的子 Agent 消费交付物。这样避免子 Agent 空转等人。
- 信封 schema 由插件生成并**先过 `assertObjectJsonSchema`**，保证落在 DSH 支持的子集内（`type/properties/required/additionalProperties/items/enum/const/oneOf`），与 `structured_output` 的校验器一致。

### 4.3 边：流程的实质在边上

```jsonc
{
  "id": "e-art-to-review",
  "from": "concept", "port": "output",
  "to": "art-review", "port": "artifact",
  "accepts": { /* 下游输入契约：发布前与上游 output 做可赋值性校验 */ },
  "when": { "kind": "status", "is": "done" },          // 或 {"kind":"verdict","is":"accept"} / {"kind":"always"}
  "onFail": { "kind": "block" }                         // 或 {"kind":"skip"} / {"kind":"fallback","node":"concept-alt"}
}
```

三层语义（对应理念 §"数据契约与边语义"）：

1. **产物契约**：`accepts` 必须能被上游 `output` 满足（发布前静态校验，不等到运行时才发现没人能消费）。
2. **触发条件**：`status` / `verdict` / `artifact.accepted` / `always`。门禁的所有出边必须覆盖"批准/拒绝/修改"三种结果（否则发布失败）。
3. **失败语义**：`block`（默认，下游不可执行，阻断 run）/ `skip`（下游标记 skipped 并继续）/ `fallback`（切到声明的降级节点）。

### 4.4 流程定义（示例）

```jsonc
// $DSH_HOME/hnflow/library/game/art-review.flow.json
{
  "flow": { "id": "fl-7f3a…", "name": "美术评审", "revision": 7,
            "description": "概念 → 人交付精修稿 → 验收 → 集成", "tags": ["art"] },
  "input": { "type": "object", "required": ["brief"], "properties": { "brief": { "type": "string" } } },
  "nodes": [
    { "id": "concept", "type": "agent",
      "preset": "hnflow",
      "model": "strong",
      "instruction": "根据 {{input.brief}} 产出 3 个概念方向，每个含一句话定位、视觉关键词、风险。",
      "input":  { "type": "object", "properties": { "brief": { "type": "string" } } },
      "output": { "type": "object", "required": ["directions"],
                  "properties": { "directions": { "type": "array", "items": { "type": "object" } } } },
      "budget": { "maxAttempts": 2, "timeoutMs": 900000 } },

    { "id": "request-art", "type": "request",
      "deliverable": {                       // 人交付物契约
        "type": "object",
        "required": ["files", "notes"],
        "properties": {
          "files": { "type": "array", "items": { "type": "string" } },
          "notes": { "type": "string" },
          "styleTags": { "type": "array", "items": { "type": "string" } }
        },
        "additionalProperties": false
      },
      "whyHuman": "精修稿需要真实美术判断与手感，当前模型无法可靠产出",
      "deadline": { "hours": 72 },
      "onExpire": "remind" },

    { "id": "accept-art", "type": "verify",
      "against": "request-art",
      "checks": ["schema"],
      "judge": { "preset": "hnflow-judge", "criteria": "是否满足 concept 的方向与风格约束" },
      "onReject": { "kind": "return", "maxAttempts": 2 } },

    { "id": "integrate", "type": "agent",
      "preset": "hnflow",
      "model": "fast",
      "instruction": "把通过验收的精修稿按项目规范接入，产出变更清单。",
      "input":  { "type": "object", "properties": { "artifact": { "type": "object" } } },
      "output": { "type": "object", "required": ["changes"], "properties": { "changes": { "type": "array" } } } }
  ],
  "edges": [
    { "from": "concept", "to": "request-art", "when": { "kind": "status", "is": "done" } },
    { "from": "request-art", "to": "accept-art", "when": { "kind": "artifact.accepted", "is": true } },
    { "from": "accept-art", "to": "integrate", "when": { "kind": "status", "is": "done" } },
    { "from": "accept-art", "to": "request-art", "when": { "kind": "status", "is": "rejected" },
      "onFail": { "kind": "skip" } }
  ]
}
```

### 4.5 版本与发布（不可变）

- 草稿可改；**发布**产生 `revision + contentHash`，并写只读快照 `<library>/.hnflow-revisions/<flowId>/r<rev>.json`（复用现有资产库的 revision 设计）。
- 发布时冻结 **lockfile**：每个节点的 `preset` id + 该 preset 当时的组装摘要（`agentPresets.inspectCompositions()` / `compositionInventory()` 可取）、每个 output schema 的 hash、**每个 `model` 层解析出的 `{layer, provider, model, reasoningEffort}`**、插件版本、VibeStack 版本与 `apiVersion`、DSH 版本。
- run 钉住 `revision + contentHash + lockfile`；恢复只读该快照，缺失或不匹配即 `revision-missing` / `lockfile-mismatch`，**不回退最新版**。
- 层定义属于用户、可被编辑；run 只认 lockfile 里解析过的路由，因此改层不会改变在跑 run（与 HNFlow 的"不可变版本"一致）。
- 引用（`.hnflow/flows.json`）默认固定 revision；`revision: null` 才跟随最新，且界面必须显式标注"跟随"。

### 4.6 发布前静态校验（全部阻塞发布）

| 检查 | 失败码 |
| --- | --- |
| schema 落在 DSH 支持子集（`assertObjectJsonSchema`） | `schema-unsupported` |
| 每个 `output` 与所有下游 `accepts` 可赋值 | `contract-unsatisfiable` |
| 每个节点的必填输入都有来源（入边或 flow.input） | `input-unbound` |
| 门禁出边覆盖 批准/拒绝/修改 | `gate-branches-incomplete` |
| `judge.preset ≠ 生产者 preset` | `judge-same-as-producer` |
| 节点 `preset` 存在于 `agentPresets` 且在使用者白名单内 | `preset-unknown` / `preset-not-allowed` |
| 节点的 `model` 层在 `ctx.vibestack` 中存在且可路由 | `model-layer-unknown` / `model-layer-unroutable` |
| VibeStack 服务可用（`apiVersion >= 2`）；否则引用 `model` 的节点不得发布 | `vibestack-unavailable` |
| `request` 节点声明了 `deliverable` 与 `whyHuman` | `request-contract-missing` |
| 无环（v1）；单起点单终点 | `cycle-unsupported` / `graph-shape-invalid` |
| 节点 id 唯一且不含路径字符 | `node-id-invalid` |

校验器只做**声明层**检查，不调用模型；页面、工具、发布共用同一个实现。

---

## 5. 编排器：插件的 host service

### 5.1 状态机

```
queued ──start──▶ running ──node done / edges satisfied──▶ running
                    │  ▲
        gate/request│  │ submit / approve / deliver
                    ▼  │
                waiting_human
running ──▶ succeeded | failed | cancelled
running ──(宿主消失 / 进程重启)──▶ interrupted ──resume(显式)──▶ running
```

- `interrupted` 是诚实的失败态：不猜、不自动重放、不自动续跑。
- 终态必须写一条结构一致的 `run.end`：`status`、`error`、`flowRevision`、`contentHash`、节点耗时、产物摘要。
- 取消：协作式。`dispose()` 子 Agent activation（会等待子树停稳），关闭待决门禁/交付（`cancelled`），写终态。

### 5.2 调度算法

1. 由 `flow.input` 校验启动输入 → 建 run（钉住 revision/lockfile）。
2. 收集**就绪节点**：所有入边的 `when` 已满足且上游产物可用；`onFail=block` 的上游 `failed` 时节点不可就绪。
3. 按拓扑序 + 节点 id 稳定排序；同时可跑节点数不超过 `maxParallel`（默认 3；硬上限受 `maxActiveSubagents`=8 约束，配置不得超）。
4. 每个就绪节点启动 → 等 `result` → 解析信封 → 写产物/诊断 → 重新求值边。
5. 遇到 `gate`/`request` → 写待决记录并落盘 → run 进入 `waiting_human` → 等待提交事件（无内存 Promise 依赖）。
6. 所有节点终态且无待决 → 汇总终态。
7. 调度循环用**串行化 mutation 队列**（同一 run 的推进串行执行），避免并发写同一 run 记录。

### 5.3 节点执行（NodeRunner）

```js
// runner.js 的核心调用形态（示意，不是最终代码）
const activation = await ctx.subagents.startActivation({
  provider: 'spawn',
  label: `${run.id}/${node.id}#${attempt}`,
  delivery: 'caller',                       // 不向父会话发完成通知，编排器自己等结果
  signal: nodeAbort.signal,
  request: {
    parent: hostAgent,                      // 会话宿主或 conductor
    cwd: workspaceRoot,
    agentPreset: node.preset,               // 只允许 preset id
    outputSchema: envelopeSchema,           // 插件合成并已校验
    maxDepth: 0,                            // 节点默认不得再委派（防预算爆炸）
    // node.model 存在时，由 ctx.vibestack 解析为具体路由（lockfile 已钉住）
    ...nodeRoute === undefined ? {} : { agentOptions: nodeRoute },
    prompt: [{ type: 'text', text: brief }] // 自包含简报（spawn 不继承父对话）
  }
})
const result = await activation.result        // { output, structured, stopReason, diagnostic }
```

| 结果 | 插件判定 |
| --- | --- |
| `stopReason === 'completed'` 且 `structured.status === 'done'` | 校验 `output` → 写产物 |
| `structured.status === 'needs_human'` | 仅当流程在该位置允许人工交付时创建 request；否则记为 `human-not-allowed` 并按 `on_fail` 处理 |
| `stopReason !== 'completed'` / 无 `structured` | `node-failed`（带 `diagnostic`）；按 `maxAttempts` 重试 |
| 超时 | `node-timeout`；`dispose()` 取消 |

**关键设计点：**

- **简报自包含**：`spawn` 子 Agent 没有父对话上下文，节点简报必须包含任务、上游产物（大产物给引用而非全文）、输出契约摘要、以及"不得请求越权工具"的说明。
- **模型路由在启动时固定**：`node.model` 在 run 启动时解析为 `agentOptions`；子 Agent 是 subagent 会话，DSH 不向它公开模型选择入口，所以只能在 spawn 时指定，不能事后切换（这正是"节点路由必须可钉住"的另一个理由）。
- **层缺失即失败**：解析不到层或层不可路由 → `model-layer-unknown` / `model-layer-unroutable`，节点不启动（不静默回落到 preset 默认模型）。
- **幂等键**：`<runId>:<nodeId>:<attempt>`；节点成功一次即写产物，恢复时**不重跑**已成功节点。
- **并发**：节点并行度受 `maxActiveSubagents`（默认 8）约束；不做"先占坑再等"的排队。
- **不重试确定性失败**：`contract-unsatisfiable`、`preset-unknown` 类错误直接 `failed`，不重试。
- **人不在节点内等待**：子 Agent 不弹问题卡、不阻塞；缺口通过信封上抛。

### 5.4 持久化

用 DSH 的 storage domain（`defineDomain` + `storageDomain.open`），表结构（zod 校验、原子写）：

| 表 | key | 内容 |
| --- | --- | --- |
| `flows` | `flowId` | 当前 revision 指针 + 元数据 |
| `flowRevisions` | `flowId@rev` | 完整定义 + contentHash + lockfile（不可变） |
| `refs` | `workspaceId` | 工作区引用清单（固定 revision） |
| `overrides` | `workspaceId/flowId` | 工作区覆盖（完整副本 + baseRevision） |
| `runs` | `runId` | 状态、钉住的 revision、lockfile、宿主会话、时间 |
| `nodes` | `runId/nodeId/attempt` | 状态、childSessionId、产物、诊断、耗时 |
| `artifacts` | `artifactId` | 产物值/引用、schema hash、来源（agent/human/judge） |
| `gates` | `gateId` | 快照、选项、revision(用于 CAS)、决定、审计 |
| `requests` | `requestId` | 交付契约、不可替代性理由、状态、尝试次数 |
| `deliveries` | `deliveryId` | 人交付内容、校验结果、消费者节点 |

- 领域名 `hnflow`；**单实例打开**（storageDomain 对同名域只允许一个打开者）→ 由全局 core service 独占，viewer/页面不打开域，只走 service/fetch 路由。
- 若 `storageDomain` 不可用（极简组合），降级为 `$DSH_HOME/hnflow/state/*.json` 原子写；启动日志显式标注 `storage-degraded`。
- **不写自定义 session 事件**（未知事件类型会导致会话重启后无法打开，VibeStack 已踩过）。

### 5.5 重启恢复

1. 启动时扫描 `runs`：`running` 或 `waiting_human` 且宿主进程已换代 → 标 `interrupted`。
2. `waiting_human` 的门禁/交付仍可提交（记录完整、revision 匹配），提交后 run 回到 `running`。
3. `resume`（人或模型显式调用）→ 重新绑定宿主 → 跳过已成功节点 → 从第一个未完成节点继续。
4. 不可恢复项（revision 缺失、lockfile 不匹配、schema 版本过高）→ 拒绝并给出 `revision-missing` / `lockfile-mismatch` / `store-version-unsupported`。

### 5.6 诊断模型

每个失败都产出结构化诊断（写入 run，页面与工具都能读）：

```jsonc
{
  "code": "contract-unsatisfied",
  "runId": "run-…", "nodeId": "integrate", "edgeId": "e-art-to-review",
  "flowRevision": 7, "contentHash": "sha256:…",
  "expected": { "path": "artifact.files", "type": "array" },
  "actual":   { "path": "artifact.files", "type": "string" },
  "gateShouldHaveCaught": "accept-art",     // 若无门禁，指认缺失的约束位置
  "hint": "在 accept-art 增加 schema 校验或把 files 声明为数组"
}
```

`gateShouldHaveCaught` 是刻意设计的字段：它把"这次错误本应在哪被拦住"写进数据，而不是留在人的记忆里。

### 5.7 宿主模型（run host）

子 Agent 必须有一个父 Agent（`SubagentStartRequest.parent`），因此每个 run 都要绑定一个**宿主**：

| 启动方式 | 宿主 | 说明 |
| --- | --- | --- |
| 会话内由模型调 `hnflow(run)` | 该会话的 root Agent | 零额外会话；run 记录 `hostSessionId`；关闭会话后 run 转 `interrupted` |
| 页面直跑（不经对话） | workspace 级 **conductor** 会话（惰性创建、单例复用） | conductor 无对话内容，只作子 Agent 的父与问人锚点；节点子会话仍可在其 catalog 中发现 |

- 宿主只是"启动子 Agent 的锚点"，**不参与推理**：插件不会向宿主会话追加模型轮次，也不会把 run 进度写成对话消息（避免成本与会话污染）。
- 宿主不可用（窗口关闭、会话归档、`agents.create` 不可用）时：已开始的 run 标 `interrupted`；页面直跑降级为"请在会话中启动"并给出稳定错误码 `host-unavailable`。
- 恢复时重新解析宿主：会话存在则复用；否则新建 conductor，再继续未完成节点（已成功节点不重跑）。

---

## 6. 人工面：门禁与人工交付

### 6.1 两个原语，两种语义

| | `gate` | `request` |
| --- | --- | --- |
| 人的角色 | 裁决者（允许/拒绝/修改） | 生产能力（提供 AI 不能生成的东西） |
| 产出 | 决定 + 可选修改后的产物 | 有形状的交付物（artifact） |
| 是否验收 | 决定本身即验收 | 交付物必须过 `verify`（schema + 可选 judge） |
| 失败 | 拒绝 → `on_fail` | 退回/降级/仲裁 |
| 典型场景 | 发布前签字、危险操作授权、规格冻结 | 精修美术、手感调校、法务/IP 决策 |

用门禁承载"A 向人要东西"会把人的产出压成布尔值——这是理念第 3 节明确反对的。

### 6.2 两条送达通道（同一份状态）

```
                      ┌─ 原生问题卡 ctx.userQuestions.ask()（宿主为活跃 root 会话时）
待决 gate/request ────┤
                      └─ 页面收件箱（GET /api/hnflow/inbox → POST 提交）
```

- **先落盘、后发问**：待决记录写 storage 之后再调 `ask`；问题卡丢失/超时不影响状态（重新打开页面仍可处理）。
- `ask` 的约束（实测）：必须由**活跃的 runtime root** 发起，被委派的子 Agent 会被拒（`DELEGATED_CALLER`）。因此只有 run 宿主（会话或 conductor）能发问，节点子 Agent 永远不发问。
- **零 token 通道**：页面收件箱通过 fetch 路由取数与提交，不经过任何会话、不产生 `command/*` 事件（旧版已因每 25 秒发命令把会话日志刷到 10MB）。
- `POST` 路由使用 `requestBody: 'buffered'`；写操作全部校验 `runId + nodeId + revision`（CAS），重复提交返回 `already-decided`，过期 revision 返回 `stale-revision`。

### 6.3 人交付的验收（不能无条件接受）

```
提交 → schema 校验（validateJsonSchemaValue）
        ├─ 不通过 → rejected(violations) → 退回（最多 maxAttempts）→ 仍不过：降级/仲裁/失败
        └─ 通过 → 可选 Judge（独立 preset，只看交付物+契约+意图）
                    ├─ accept → artifact accepted → 下游可消费
                    ├─ reject → 退回或仲裁
                    └─ needs_more → 生成"补充要求"再次请求
```

- **退回**：保留每次尝试（`deliveryAttempt`），第 N 次失败后按 `onReject` 策略（`return | fallback | arbitrate | fail`）。
- **降级**：`fallback` 产出必须标记 `degraded: true`，并记录"哪条验收没过"——降级不是静默通过。
- **仲裁**：由 `judge` 节点裁决"部分满足是否可接受"，裁决必须给理由与条件；仲裁结果同样进审计。
- **人的产出是数据，不是执行权**：交付物进入 `artifacts`，不能改变 run 的权限、工具、门禁结论；流程定义里没有"给人授权"的字段（schema `additionalProperties:false`）。

### 6.4 等待与离线

- 等待是**状态**，不是内存里的 Promise：`waiting_human` 的记录在 storage 里，进程重启仍在。
- 超时用 `expiresAt` + 一次 `ctx.timer.interval` 扫描（effect 作用域内），不 `sleep`、不轮询会话。
- 通知：收件箱路由被客户端每 15 秒轮询一次（失败退到 60 秒），首次出现才弹右下角一次（复用旧版判重逻辑）。

### 6.5 审计字段

每个 gate/request 记录：`flowId@revision`、`contentHash`、上游产物 hash、`askedAt`、`askedVia`（card/inbox）、`decidedAt`、`decision`、`decidedBy`（owner）、`deliveryId`、`consumerNodeIds`。这直接支撑 §1.3 的第 3、4 问。

---

## 7. 安全边界

| 威胁 | 机制 | 依据 |
| --- | --- | --- |
| 流程通过节点声明拿到用户没有的工具 | 节点只能引用 `preset` id；schema 禁止内联 `tools`/`toolFilter`/persona；发布时校验 preset 存在且在白名单内；运行时 `agentPresets.resolve(id)` 再校验一次 | DSH 已把 persona/工具从工具配置迁到 preset（`dsh-tool-subagent` 对 `persona`/`toolFilter` 直接报迁移错误） |
| 通过 `agentPreset` 选择未授权角色 | `nodePresets` 白名单（默认 `['hnflow','standard']`），发布+启动双重校验 | 与 `allowedAgentPresets` 的既有模式一致 |
| 子 Agent 运行时提权 | 子 Agent 的权限范围在启动时固定；需要审批的操作自动拒绝（原生委派范围声明） | 因此"要不要批准"必须提前到门禁，节点内不做需审批动作 |
| 门禁挂起期间流程被静默改版 | 门禁记录绑定 `flowRevision + contentHash + 上游产物 hash`；恢复只认该版本 | 理念 §"门禁审批的产物快照应与流程版本绑定" |
| 人的交付被当成权限白名单 | 交付物只写 `artifacts`；无"授权"字段；`additionalProperties:false` | 理念 §"人不能成为权限提升通道" |
| 交付物越界写文件 | 交付物里的路径必须是工作区相对路径并通过 `fs.contains` 校验；越界即 `path-outside-workspace` | 复用 `ctx.fs` |
| 模型伪造"完成" | 信封 + 插件判定 + 独立 judge/verify + 门禁 | 理念 §"生成者不能验收自己" |
| 运行中定义漂移 | run 钉 revision；编辑产生新草稿不影响在跑 run | 不可变版本 |
| 通过 `model` 层提权 | 层只映射 provider/model/effort，不携带工具或权限；发布只校验"层存在且可路由" | 层是路由选择，不是能力授权 |
| 用户流程变成任意代码 | 不引入表达式语言；`merge` 只有声明式映射；不编译成 workflow VM 脚本 | 理念 §"不把用户编排转交给模型或 VM" |

---

## 8. 资产、工作区与 VibeStack

### 8.1 资产 / 引用 / 覆盖（复用现有实现）

沿用 `plugins/dsh/lib/{assets,workspace,resolve,paths,json}.js` 的产品语义，只换对象类型（`workflow` → `flow`）：

- 资产库 `$DSH_HOME/hnflow/library/<分类>/<name>.flow.json` + 只读 revision 快照；
- 工作区引用 `<workspace>/.hnflow/flows.json`（默认固定 revision）；
- 工作区覆盖 `<workspace>/.hnflow/overrides/<flowId>.flow.json`（完整副本 + `baseRevision`）；
- 解析顺序：override → ref 固定 revision → ref 跟随最新；
- 不变量：只有用户显式发布能提升资产 revision；Agent 的修改一律先落草稿/覆盖；run 用快照。

### 8.2 VibeStack 依赖边界（强依赖，保留其独立性）

| 项 | 约定 |
| --- | --- |
| 依赖强度 | **强依赖**：HNFlow 的能力组、模型层、Agent 人设都来自 VibeStack；缺 VibeStack 或 `apiVersion < 2` 时，HNFlow 进入 `degraded`：可列流程与资产，但**发布/运行一律拒绝**（`vibestack-unavailable`） |
| 方向 | HNFlow → VibeStack（单向）。VibeStack 不知道 HNFlow 存在，也不为 HNFlow 改代码 |
| 独立可用 | `dsh-vibestack` 仍可单独安装、单独 `preset-vibestack` 使用；HNFlow 只引用其模块名、服务与 preset 行 |
| 接入方式 | `preset-hnflow` 的子插件清单里放一行 `dsh-vibestack`；HNFlow core 行 `ctx.get('vibestack')` 取模型层服务 |
| 节点侧生效 | 节点以 `agentPreset: 'hnflow'` 启动 → 子会话按 cwd 解析 `.vibestack/stack.json` → 规则/技能/命令/MCP/人设对该节点生效；节点 `model` 走 `agentOptions` |
| 命名空间 | VibeStack 的能力组命令/技能在 DSH 里统一是 `vibestack-<group>-<name>`；HNFlow 自己的工具（`hnflow`、`hnflow_author`）、命令（`/hnflow`）、技能（`hnflow-flows`）**不使用** `vibestack-` 前缀 |
| 版本门槛 | 需要 VibeStack ≥ `0.3.0`（含 `resolve` schema v2 与 `ctx.vibestack` 服务）；插件启动时校验 `apiVersion`，不满足即 `degraded` |
| 禁止 | HNFlow 不读 `.vibestack/` 内部结构、不解析能力组、不代管规则/技能/MCP、不自己维护模型目录 |
| OpenCode 退场 | VibeStack 删除 OpenCode 适配器不影响 HNFlow；HNFlow 从未依赖它，文档只需更新版本门槛 |

### 8.3 项目内容归属

旧 HNFlow 自己管 `.hnflow/content/{rules,skills,tools}` 与 `AGENTS.md`。v2 明确：**规则/技能/工具/人设归 VibeStack 能力组与项目内容**；HNFlow 只 own 流程资产、运行状态与人工交付。避免同一份规则两处解析。

---

## 9. 三面 UI 与通知（复用现有接入点）

| 面 | DSH 接入点 | 内容 |
| --- | --- | --- |
| 左栏页面 | `sidebar.panellist` + `main` | 三个页签：**流程**（资产树 + 只读画布 + 版本）/ **运行**（run 列表 + 节点时间线）/ **收件箱**（gate + request） |
| 会话顶部页签 | `conversation.view` | 当前会话相关的 run（若有）及其画布；只在 `hnflow` 模式会话出现 |
| 右栏面板 | `sidebarRightTabs` + `sidebar.right.pane.tab` | 收件箱（与页面第三页签同组件） |
| 网页通知 | `shell.overlay` + `GET /api/hnflow/inbox` | 首次出现的新待决项，右下角一次 |

- 画布复用现有 `layoutDefinition` / `edgePath` 的只读 SVG 渲染，节点按 run 状态着色（待执行/运行中/完成/失败/等待人）；**没有拖拽与连线**。
- 页面数据全部来自 service 的只读快照（命令 + fetch 路由），不直读 storage 文件。
- 收件箱表单由交付 schema 生成（简单 JSON 编辑器 + 文件路径选择），门禁表单是"批准 / 拒绝（理由）/ 修改后批准"。
- 运行中画布只读；编辑草稿不影响在跑 run。
- **不注册自定义会话投影、不写自定义会话事件**：三个面都从 service 取数，会话日志只保留 DSH 原生事件（子 Agent 的 catalog/descriptor）。

### 9.1 模型面与命令契约（薄）

| 面 | 名称 | 动作 / 参数 | 约束 |
| --- | --- | --- | --- |
| 工具 | `hnflow` | `list_flows`、`describe_flow{flow}`、`run{flow,input}`、`status{runId}`、`cancel{runId}`、`artifact{artifactId}`、`inbox` | `run` 只启动并立即返回 `runId`，不等结果；错误返回 `error <code>: <message>`，不抛异常、不结束回合 |
| 工具 | `hnflow_author` | `schema`、`validate{definition}`、`draft{flow,definition,note}` | **没有 publish**：发布只能由人经 `/hnflow publish` 或页面按钮完成（I1 物理上无入口） |
| 命令 | `/hnflow` | `list`、`inbox`、`runs`、`publish <flow>`、`open` | 除 `publish` 外都不进模型上下文；`publish` 先给 diff 再二次确认 |
| 提示词 | section `hnflow:flows` | 流程索引（≤20 条：名称 + 一句话 + 何时用） | 不注入流程正文；索引由资产库生成并缓存 |
| 技能 | `hnflow-flows` | 节点目录、信封三态、契约/边规则、起草步骤 | 大块参考资料按需加载，常驻上下文只留一行摘要 |
| 命名空间 | `hnflow` / `hnflow_author` / `/hnflow` / `hnflow-flows` | 与 VibeStack 的 `vibestack-*` 命名空间并列、互不遮蔽 | 不占用 `vibestack-` 前缀 |

---

## 10. 代码落点与复用清单

```text
plugins/dsh/
├─ package.json            # dsh-hnflow 0.3.0；engines.dsh 绑定 0.2.x；不再有 Python
├─ cordis.patch.yml        # 根级 hnflow-core（全局 service + 路由）+ preset-hnflow（薄 mode 行）
├─ index.js                # 角色装配：core / mode / client
├─ lib/
│  ├─ config.js            # Config（schemastery z）：preset 白名单、并发、超时、存储降级开关
│  ├─ service.js           # HnflowService extends Service('hnflow')：编排器
│  ├─ store.js             # defineDomain('hnflow') + 降级文件存储
│  ├─ flow/schema.js       # FlowDefinition（zod）+ 六原语 + 边
│  ├─ flow/envelope.js     # 信封 schema 合成/解析
│  ├─ flow/validate.js     # 发布前静态校验（复用 dsh-tools 的 schema 断言）
│  ├─ flow/publish.js      # revision、lockfile、contentHash、快照
│  ├─ scheduler.js         # 纯状态机 + 拓扑调度（无 IO，可单测）
│  ├─ runner.js            # subagents.startActivation(delivery:'caller') 封装
│  ├─ layers.js            # ctx.vibestack → 节点 agentOptions；lockfile 记录
│  ├─ gates.js             # GateBroker：ask 卡片 + inbox + CAS
│  ├─ requests.js          # 交付请求/退回/降级/仲裁
│  ├─ judge.js             # 独立 preset 的证据视图
│  ├─ merge.js             # 声明式汇合 + 端口校验
│  ├─ assets.js  workspace.js  resolve.js  paths.js  json.js   # 复用
│  ├─ tools.js             # hnflow（薄）
│  ├─ author.js            # hnflow_author（schema/validate/draft，无 publish）
│  ├─ commands.js          # /hnflow
│  ├─ routes.js            # GET inbox / POST gate / POST deliverable
│  └─ state.js             # 页面只读快照
├─ client.js               # 三面 UI（复用画布/监视/通知骨架）
├─ skills/hnflow-flows/SKILL.md
├─ examples/*.flow.json
└─ test/                   # node:test
```

### 10.1 复用 / 改造 / 删除

| 现有文件 | 处理 | 说明 |
| --- | --- | --- |
| `lib/assets.js`、`workspace.js`、`resolve.js`、`paths.js`、`json.js` | **复用** | 只换对象类型与 schema 版本 |
| `lib/skill.js`、`lib/route.js`（模式）、`lib/commands.js`（壳） | 复用 | 路由改 `routes.js`，增加 POST |
| `client.js` 的画布/监视/通知 | 复用 | 组件名与槽位注册照旧；数据源改为 service |
| `lib/service.js`（引擎 RPC） | **替换** | 改为 `HnflowService`（状态机 + storage） |
| `lib/engine.js`、`lib/tools.js`（engine action）、`lib/author.js`（engine validate）、`llmAdapter`、`models[]` | **删除** | 不再有 Python 引擎与模型桥 |
| `lib/state.js`（读 `state/*.json`） | 改造 | 读 service 快照 |
| `backend/packages/harness/deerflow/workflow/rpc/` | **停用**（不删代码，仅解除依赖） | 插件不再启动它；后续可整体归档 |
| `docs/dsh-plugin-plan.md` | 保留为历史 | 本文取代其执行模型 |

净效果：

- 安装依赖从「DSH + Python + uv + venv」降为「DSH」；
- 运行真相从两份（会话 + 引擎）降为一份（DSH session + hnflow domain）；
- 编排权从 LangGraph 移到插件状态机，节点执行从引擎移到 subagent。

---

## 11. 里程碑

| 里程碑 | 交付 | 验收标准 |
| --- | --- | --- |
| **M0** 原生能力探针（0.5–1 天） | 五个探针脚本/临时插件：① `subagents.startActivation(spawn, agentPreset, outputSchema, delivery:'caller')` 端到端；② `agents.create` 创建 conductor（无父）并作为 spawn 的 parent；③ `storageDomain.open` 声明域并跨重启读回；④ 在同一宿主上 `userQuestions.ask` 与 POST fetch 路由；⑤ `ctx.get('vibestack')` 服务可读、`agentOptions` 能在 spawn 时改变实际路由 | 五项均在本机 0.2.1-rc.5 + VibeStack 0.3 上通过，或给出明确降级路径；结论写入文档 §13 |
| **M1** 定义层与发布 | `flow/schema.js`、`envelope.js`、`validate.js`、`publish.js`；资产/引用/覆盖复用；`hnflow_author`（无发布） | 静态校验覆盖 §4.6 全部条目；发布产生不可变 revision + lockfile；Agent 无法发布 |
| **M2** 编排器 + agent 节点 | `service.js`、`scheduler.js`、`runner.js`、`store.js`；`hnflow` 工具（list/describe/run/status/cancel） | 单节点流程可跑；信封三态被正确解释；已成功节点不重跑；重启后 `running` → `interrupted` |
| **M3** 门禁 + 通知 | `gates.js`、`routes.js`、页面收件箱、右下角通知 | 门禁先落盘后发问；卡片与页面两条通道都能裁决；CAS 生效；零会话事件污染 |
| **M4** 人工交付 + 验收 | `requests.js`、`judge.js`、`merge.js`；`verify` 节点 | 交付物 schema 校验、退回上限、降级标记、仲裁理由全部落库；审计四问可答 |
| **M5** 三面 UI + 页面直跑 | `client.js` 改造、`state.js`、conductor 启动、版本历史 | 三个面共用同一数据源；页面可发起 run 并处理收件箱；画布显示节点状态 |
| **M6** 迁移与收尾 | 旧 `WorkflowDefinition` 导入器（best-effort + 报告）、示例流程、文档、DSH 升级回归清单 | 旧示例可导入为新原语并跑通 1 条；文档与代码一致；`node test/*.test.js` 全绿 |

---

## 12. 测试策略

1. **纯函数层（无 IO，快）**：定义 schema、信封合成、调度、边条件求值、CAS 语义、诊断构造。
2. **静态校验层**：每个失败码一个反例（contract-unsatisfiable、gate-branches-incomplete、judge-same-as-producer、preset-not-allowed、model-layer-unknown、vibestack-unavailable…）。
3. **编排集成（内存 CTX + fake seams）**：`runner` 与 `gateBroker` 作为可注入 seam；用 fake runner 构造成功/失败/needs_human/超时/取消，断言状态机与产物落库。
4. **端到端（真 DSH）**：一条流程 = 1 个 agent 节点（`standard` preset）+ 1 个 gate + 1 个 request；手测桌面版与 web profile 各一遍。
5. **升级回归清单**：subagent 服务签名、`structured_output` 行为、`agentPresets` 校验、storage domain 版本、`userQuestions` 的 root 约束、client 槽位名。
6. **反例测试**：Agent 尝试提升 preset、页面伪造 revision、交付物路径越界、重复提交、revision 漂移。

---

## 13. 风险与开放问题

| 风险 | 影响 | 缓解 |
| --- | --- | --- |
| DSH 处于 rc，subagent/storage/slot 契约可能变 | 插件失效 | `engines.dsh` 绑定次版本；M0 探针做成可复跑的回归脚本；每面留降级路径 |
| `agents.create` 在插件上下文创建 conductor 未验证 | 页面直跑不可用 | M0 验证；失败则页面直跑降级为"请在会话中启动"，其余功能不受影响 |
| storage domain 单实例/后端缺失 | 状态不可写 | core service 独占打开；缺失时降级到文件存储并显式告警 |
| 子 Agent 里需要审批的操作会被自动拒绝 | 某些节点"半路失败" | 把审批提前到门禁；节点简报明示"不得请求越权"；preset 选择以 workspace-write 为基线 |
| 每个节点都是新上下文 | token 成本、简报膨胀 | 简报自包含但克制；大产物给 artifact 引用；`maxAttempts` 有界；并发上限 3 |
| 人交付验收变成无限退回 | 流程卡死 | `maxAttempts` + 退出策略（降级/仲裁/失败），每次尝试有记录 |
| 长等待 | 进程重启丢失 | 等待是持久状态；不依赖内存 Promise；超时扫描幂等 |
| 画布只读被误认为"不支持编排" | 体验落差 | v1 以 JSON/工具起草 + 页面表单；画布编辑列入 v2（§14 D3） |
| 与 VibeStack 的升级耦合 | 能力组或模型层失效 | 只依赖 preset 行 + `ctx.vibestack` 服务；`apiVersion` 门槛 + `degraded` 态；缺层 fail-loud |
| 层定义被用户改动 | 在跑 run 路由漂移 | run 的 lockfile 钉住解析结果；改层只影响新 run |
| VibeStack 命名空间化改变用户习惯 | 命令找不到 | VibeStack 内部提供迁移表与可选旧名别名；HNFlow 不代管其命名 |

**开放问题（M0 后回答）：**

1. conductor 会话是否出现在会话列表？若会，是否可标注/归档？
2. 子 Agent 的 token 用量能否从 session 读到并归因到节点（用于成本面板）？
3. `ask` 卡片在 conductor（无对话历史）上是否可正常渲染？
4. 大产物（美术文件）走 attachments 还是工作区路径引用？
5. `judge` preset 是否需要独立的只读工具集（v1 无工具）。

---

## 14. 待决策

| 编号 | 问题 | 建议结论 |
| --- | --- | --- |
| D1 | 编排物是流程图还是契约图 | 契约图（本文 §4） |
| D2 | 是否保留 Python 引擎 | 否，插件纯 JS |
| D3 | 画布是否可编辑 | v1 只读；v2 再评估拖拽/连线 |
| D4 | 节点能否内联工具列表 | 否，只能引用 preset |
| D5 | 人工交付通道 | 页面收件箱为主，`ask` 卡片为辅（同一状态） |
| D6 | 缺口如何上报 | `needs_human` 信封，由编排层决定是否激活 request |
| D7 | 流程状态存哪 | DSH storage domain；缺失时文件降级 |
| D8 | 页面直跑如何拿宿主 | 会话宿主优先；否则 workspace 级 conductor（M0 验证） |
| D9 | 是否用 workflow seam | 否（VM 逃逸 + 编排权外移） |
| D10 | 是否用 jobs | 否（kind 仅 bash、语义不匹配） |
| D11 | VibeStack 关系 | 单向**强依赖**；不 fork、不改其 preset；`apiVersion` 不足即 `degraded` |
| D12 | 发布权 | 只有人能发布；Agent 只能起草与校验 |
| D13 | 节点模型如何指定 | 引用 VibeStack 层 id（`model`），启动时解析为 `agentOptions`，lockfile 钉住 |
| D14 | 缺层时是否回落 | 否，fail-loud（`model-layer-unknown`）；回落会让"可复现"失效 |

---

## 附录 A：本机 DSH 0.2.1-rc.5 原生接口事实（方案依据）

> 来源：Host Inspect 契约（`Service` 目录）与本机安装包源码（`resources/app.asar` 抽取的包 README/实现）。

| 事实 | 证据 |
| --- | --- |
| `ctx.subagents.startActivation({provider,label,request,signal,delivery})` 返回 `{childId,messageId?,result,dispose}` | `dsh-subagent` 服务契约 + README.zh |
| `spawn` 支持 `agentPreset`、`outputSchema`、`agentOptions`、`depthLimit` | `dsh-subagent-spawn-in-process` 的 `capabilities` |
| `fork` 不支持 `agentPreset` | 同上（`agentPreset: false`） |
| `delivery:'caller'` 让调用方等待结果、不向父会话发完成通知 | `dsh-subagent` README.zh |
| 每棵 activation 树并发上限 `maxActiveSubagents` 默认 8 | 同上 |
| 委派深度默认 1；`maxDepth: 0` 禁止子 Agent 继续委派 | `dsh-tool-subagent` README.zh |
| 子 Agent 权限启动时固定，需审批操作自动拒绝 | `dsh-subagent` README.zh（委派范围声明） |
| 结构化输出由子级 `structured_output` 工具 + JSON Schema 校验，结果在 `result.structured` | `dsh-subagent/lib/types/structured.js` |
| schema 子集与校验复用 `@deepseek-ai/dsh-tools`：`assertObjectJsonSchema`、`validateJsonSchemaValue`、`defineTool` | `dsh-tools/lib/index.js` 导出表 |
| `userQuestions.ask` 只接受活跃 runtime root，`DELEGATED_CALLER` 拒绝子 Agent | `userQuestions` 服务契约 |
| 审批策略与沙箱模式由 `permission-presets` 捆绑；会话创建时固定 | `dsh-permission-presets` README.zh |
| fetch 路由支持 `GET/HEAD/POST`、`buffered` body | `HostConnectionFetch` / `ConnectionFetchRoute` 契约 |
| storage domain 支持 zod 表、单实例打开、原子写 | `storageDomain` 契约 |
| preset 只能声明 persona/工具组合；工具配置里的 `persona`/`toolFilter` 会报迁移错误 | `dsh-tool-subagent` README.zh |
| 自定义 session 事件必须 `ignorable`，活跃会话无法写该标记 → 插件不写自定义事件 | VibeStack README（踩坑记录） |
| 内置 `workflow` 工具名已被占用 | 工具清单；故插件工具名用 `hnflow` |
| VibeStack 提供 `ctx.vibestack`（`apiVersion` / `listLayers` / `resolveLayer`），是 HNFlow 唯一的模型层入口 | VibeStack 方案 `docs/dsh-plugin-plan.md` §7.6 |
| 模型层只存 `provider/model/reasoningEffort/展示文案`；能力组只写 `model: <layer id>` | 同上 §7.1 |
| 子 Agent 会话不公开模型选择入口 → 节点路由只能在 spawn 时用 `agentOptions` 指定 | `dsh-client-ui-model-selection` 已知限制 |
| VibeStack 命令/技能统一为 `vibestack-<group>-<name>`（DSH 只接受小写 kebab，`VibeStack-` 大写无法注册） | VibeStack 方案 §3/§6 |

---

## 附录 B：旧节点类型 → 新原语（迁移映射）

| 旧 `WorkflowDefinition` | 新原语 | 备注 |
| --- | --- | --- |
| `ai:llm_agent`（AgentPort + model_profile） | `agent` | preset 取代 model_profile；四层提示词由节点简报 + VibeStack 规则承担 |
| `human:task` / `human:review` | `request` / `gate` | 有交付物 → request；只裁决 → gate |
| `verify:gate` | `verify` + `gate` | 三值验证 → `accepted/rejected/inconclusive`；`inconclusive` 交门禁 |
| `flow:if` / `flow:switch` | 边 `when` | 不再有独立分支节点 |
| `flow:parallel` / 多入边 | 调度器并行 + `merge` | 并行是调度属性，不是节点 |
| `flow:loop` | 暂不支持（DAG） | 需要时用多次 run 或外层 request 重试 |
| `flow:try` / 补偿 / undo | `on_fail` + 人工回滚门禁 | 不做自动补偿（副作用不可逆时要求门禁） |
| `data:assign/convert/json/regex/...` | `merge` 声明式映射 | 不引入表达式语言 |
| `tool:bash/http/invoke` | `agent`（由 preset 提供工具） | 工具执行回到 DSH 沙箱与权限体系 |
| `app:*` | 暂不迁 | 本地应用驱动需另行设计（宿主执行是显式例外） |
| `nested:subworkflow` | 暂不支持 | 可用"父流程调用子流程 run"在 v2 评估 |

迁移是 **best-effort + 报告**：不自动改写旧数据；导入失败逐条报告，不删除原文件。

---

## 附录 C：术语

| 术语 | 含义 |
| --- | --- |
| 流程（Flow） | 用户编排的约束图：节点 + 边 + 契约 + 版本 |
| revision | 一次发布的不可变版本，run 钉住它 |
| 节点信封 | 插件与子 Agent 之间的三态契约（done / needs_human / failed） |
| 缺口声明 | 子 Agent 报告"此处需要人"的结构化对象 |
| 门禁（gate） | 暂停等人裁决的节点 |
| 交付请求（request） | 向人要一个有形状的产物的节点 |
| 验收（verify） | 对人交付物的 schema/judge 校验 |
| 宿主（run host） | run 借以启动子 Agent 的活跃会话（对话或 conductor） |
| conductor | 页面直跑时由插件创建/复用的无对话头会话，仅作子 Agent 的父与问人锚点 |
| 契约快照（lockfile） | 发布时冻结的 preset/版本/schema hash 集合 |

---

## 附录 D：与旧文档的差异摘要

| 主题 | `docs/dsh-plugin-plan.md`（v0.4） | 本文（v2） |
| --- | --- | --- |
| 执行 | Python + LangGraph + 引擎 RPC | DSH subagent（spawn）+ 插件状态机 |
| 流程形态 | 节点图（含 ai/tool/data 节点） | 契约图（6 原语，边承载语义） |
| 编排权 | 引擎 | 插件 service |
| 人 | `human:task`（表单/审批） | `gate` 与 `request` 分离，交付物有契约与验收 |
| 完成判定 | 节点返回 | 信封 + 插件判定 + judge/verify |
| 模型 | `models[]` + `llm/complete` 桥 | VibeStack 模型层（`model` → spawn `agentOptions`），lockfile 钉住 |
| 状态 | `runs.json`/`tasks.json`/checkpoint sqlite | storage domain 表 + 子会话证据 |
| 版本 | 资产 revision + run 快照 | 同上 + lockfile（preset/契约 hash） |
| 引擎依赖 | 必须 | 无 |
| 页面直跑 | 待做 | conductor 宿主（M0 验证） |
| 工具名 | `hnflow` / `hnflow_author` | 保留 |

---

## 附录 E：v0.3.0 实现落地（分支 `feat/dsh-v2`）

> 本节记录**实际实现**与上文设计的差异。凡与上文冲突之处，以本节为准。

### E.1 落点

```text
plugins/dsh/
├─ index.js                  # core / preset / ui 三行装配；Config（schemastery）
├─ cordis.patch.yml          # hnflow-core + hnflow-ui + preset-hnflow
├─ lib/
│  ├─ config.js  paths.js  json.js  assets.js  workspace.js  resolve.js
│  ├─ store.js               # storage domain（runs 表）+ 文件降级
│  ├─ flow/{definition,schema,envelope,validate,publish}.js
│  ├─ scheduler.js           # 纯状态机：就绪/边条件/skip·block/fallback/终态
│  ├─ runner.js              # subagents.startActivation(delivery:'caller') 封装
│  ├─ layers.js              # ctx.vibestack → agentOptions / 可路由检查
│  ├─ prompt.js              # 节点简报 / judge 简报 / {{...}} 渲染
│  ├─ gates.js  requests.js  # 门禁与交付的 CAS、验收、退回预算
│  ├─ service.js             # 编排器（唯一状态持有者）
│  ├─ tools.js  author.js  commands.js  routes.js
│  └─ skill.js
├─ skills/hnflow-flows/SKILL.md
├─ examples/{smoke,art-review}.flow.json
└─ test/                     # node:test（92 项，`node test/run.mjs`）
```

相对 §10 的合并：`judge.js`/`merge.js` 并入 `service.js`（它们只有几十行且必须共享 run 记录）；
`state.js` 删除——页面快照由 `service.snapshot()` 直接生成，不再读文件。

### E.2 设计差异（逐条理由）

| 编号 | 差异 | 理由 |
| --- | --- | --- |
| E-1 | **revision 只存资产库快照**，不再复制进 storage 的 `flowRevisions` 表 | 解析器（refs）已经只读快照；两份副本会让 run 钉住一个 workspace 解析不到的快照 |
| E-2 | run 文档（节点/待决/审计）是 `runs` 表的**一个文档** | storage domain 没有跨表事务，而一次推进必须是原子的 |
| E-3 | **门禁无出边即终态**：批准/修改 → run 成功，拒绝 → run 失败 | "单终点"与"门禁必须覆盖三结果"在审批型流程里冲突；空出边即声明"这一步就是交付点" |
| E-4 | `agent` 节点新增 `allowHuman: true` | 把理念里的"流程在该位置允许人工交付"变成可校验的声明；未声明时 `needs_human` 记为 `human-not-allowed` 失败 |
| E-5 | 人工交付验收后，`request` 节点直接产出交付物；`verify` 是独立节点 | 与 §6.1 一致；`request` 自身的 schema 校验在提交时完成，verify 负责"要不要请 judge"与退回 |
| E-6 | `verify` 的 judge 用**内置 judge 简报**，不要求先有 judge 节点 | 验收是插件动作；独立 judge 仍可写成 `judge` 节点用于裁决冲突 |
| E-7 | `onReject.kind: 'arbitrate'` **暂未实现**，按 `fail` 处理 | 仲裁需要第三份裁决契约；先保证"退回有上限、降级有标记" |
| E-8 | 新增 `GET /api/hnflow/flow` 与 `POST /api/hnflow/start` | 页面要画布与"用这份输入运行"，不能只靠命令 |
| E-9 | 门禁额外走 `userQuestions.ask()` 卡片 | 卡片是便利通道，待决记录先落盘；无人回答/超时/渲染失败只影响卡片，收件箱仍是权威 |
| E-10 | lockfile 不记录 DSH 版本 | 没有稳定可读的版本 API；记录 `pluginVersion` + VibeStack `apiVersion`，`engines.dsh` 管住大版本 |
| E-11 | `model` 路由按**层 id** 去重存于 `lockfile.models` | 同一层被多个节点引用时只解析一次；节点级 `model` 仍逐节点记录 |
| E-12 | 新增 `POST /api/hnflow/publish` | 发布仍是人的动作（页面按钮），不是 Agent 工具 |
| E-13 | run 记录内嵌 `definition` 快照（含来源 `source`） | 草稿覆盖没有发布 revision，却必须可执行；快照同时保证库文件／revision 之后的改动不影响已启动的 run |
| E-14 | 工具定义用本地 `lib/tool-schema.js`，不 import `@deepseek-ai/dsh-tools` | linked 插件解析不到 harness 包（Loader 内部 import 不对外），import 失败会连工具一起丢掉；该包在本项目只用于「DSL → 原始 JSON Schema + 参数校验」，本地实现等价 |
| E-15 | `/hnflow` 由 core 行注册（全局），不下沉到 preset | 命令是人的数据面（list/assets/publish/pin），在任何会话都该能用；工具仍只属于 HNFlow 模式 |
| E-16 | 客户端监听 `command/executed`，把 `/hnflow` 结果镜像到右下角提示 | DSH 的命令输出是会话转录里的卡片；空白会话没有转录，命令执行了也“看不见”（实测：首轮之后所有命令卡片才一起出现）。提示让命令在空白会话里即时可见 |

### E.3 状态机（实现）

```text
queued ─start─▶ running ─┬─ node done ─────────────▶ running
                         ├─ gate/request 待决 ─────▶ waiting_human ──submit──▶ running
                         ├─ 全部结束 ──────────────▶ succeeded | failed
                         └─ 取消 ──────────────────▶ cancelled
running ─(宿主进程结束)─▶ interrupted ─resume(显式)─▶ running
```

- 同一 run 的推进串行化（每 run 一条 mutation 链）；节点批内并行，批上限 `maxParallel`。
- 每个推进递增 `revisionCounter`，并把打开的待决记录刷新到该版本；页面提交携带它，过期即 `stale-revision`。
- `open()` 把上次进程留下的 `running` 标为 `interrupted`；`waiting_human` 原样保留，提交后继续。

### E.4 未执行的 M0 探针

单元/集成测试覆盖了状态机与契约，但以下三条需要真机验证（不改设计，只影响降级路径）：

1. `agents.create` 在插件上下文创建 conductor，且 `spawn` 以它为父可启动；
2. storage domain 的 `runs` 表跨进程重启可读回（本次实现按契约编写，未跑真机重启）；
3. `userQuestions.ask` 在 conductor（无对话历史）上是否渲染；不能渲染时收件箱仍完整可用。

三条都有明确的失败降级：页面直跑报 `host-unavailable`、文件存储显式 `storage-degraded`、卡片失败只记日志。

### E.5 测试

`plugins/dsh/test/`，`node test/run.mjs`：92 项，覆盖 schema 子集、契约可赋值、信封三态、调度
（就绪/边条件/skip·block/fallback）、CAS 与退回预算、发布与 lockfile、storage 降级、
编排（门禁/交付/needs_human/重试/取消/重启）、工具/命令/路由/装配/客户端契约。

