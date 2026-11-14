# HNFlow v0.8：单人化与自动化

## 0. 一句话

HNFlow 仍是"约束层"：v0.8 不新增流程原语，只补三件让约束在时间里成立的事——
**失败会留下病史、外部动作不会随进程蒸发、人知道现在最该做什么**。

## 1. 单人模型（本版的前提）

HNFlow 面向**一个操作者、一个工作区、一个 DSH 实例**：

- 没有多用户、身份映射、Principal/Membership、RBAC、白名单同步；
- "谁能发起"由本机文件（`.hnflow/triggers.json`）与门禁表达，不由账号体系表达；
- 审计字段里的 `decidedBy` 固定为 `owner`，只用于回溯，不用于鉴权；
- 因此不引入 Ticket / Mandate / Eval / Assignment / Subscription 这类授权层概念，
  避免出现两份"谁批准了什么"的真相。

## 2. 从 superagent 借的三件事

| 借什么 | 为什么借 | 不借什么 |
| --- | --- | --- |
| Report 六态（progress/waiting/ready/blocked/failed/dropped） | 运行状态需要一个"人话"出口，而不只是状态码 | 不引入 Ticket 生命周期与 Assignment 绑定 |
| Source 注册表（kind + instance） | 触发是"何时开始"的正交问题，适合插件化 | 不做跨源身份映射、不做多源路由 |
| Effects / outbox（持久副作用队列） | 通知与链式触发必须"先记账再执行"，否则崩溃即丢、重试即重 | 不做外部副作用的事务性回滚 |

## 3. 发布范围（11 项）

| # | 能力 | 优先级 | 状态 |
| --- | --- | --- | --- |
| 1 | 重试简报带上一轮诊断 | P0 | 已实现 |
| 2 | 持久副作用队列（outbox） | P0 | 已实现 |
| 3 | 收件箱阶段化 + 一句话摘要 | P0 | 已实现 |
| 4 | 运行健康诊断（health） | P1 | 已实现 |
| 5 | 独立 pass 时钟 + 停滞续推 | P1 | 已实现 |
| 6 | 运行墙钟预算 | P1 | 已实现 |
| 7 | 重启自动续跑（resumeOnStart） | P1 | 已实现 |
| 8 | 最小触发器层（cron / file / run-completed） | P1 | 已实现 |
| 9 | 扩展节点类型注册（registerNodeKind） | P2 | 已实现 |
| 10 | 通知通道注册（registerChannel） | P2 | 已实现 |
| 11 | 声明式 facts + 自动化面板 + 独立插件行 | P2 | 已实现 |

## 4. 设计

### 4.1 重试病史

`spawnNode` 的第 N 次尝试不再发同一份简报：每次失败（spawn 异常、超时、`failed` 信封、无效信封）
记录 `{attempt, code, message, violations}`，下一次简报追加：

```markdown
## 上一轮失败记录

- 第 1 次：contract-unsatisfied — value.points expects present
```

已有诊断（`node.diagnostic`）在 attempt > 1 时也会被带进简报。`run.recovery` 存在时另加"## 恢复说明"，
说明这是宿主重启后的续跑，避免子 Agent 把上一轮的中断当成本轮失败。

### 4.2 持久副作用队列

```json
{ "version": 1, "items": [
  { "id": "eff-…", "kind": "notice", "key": "notice:<runId>:<status>", "runId": "…",
    "payload": {}, "status": "pending", "attempts": 0,
    "createdAt": "…", "nextAt": "…", "lastError": null }
] }
```

- `kind + key` 幂等：同一事件的重复入队返回原记录；`dead` 记录可被新事件重新入队（新 id）。
- 退避 `min(2^attempts × 1000, 60000)`；超过 `outboxMaxAttempts` 标 `dead`，保留现场。
- 终态写 `notice`；`succeeded` 另写 `trigger`（payload 带 `chain`）。
- `pass()` 是唯一的消费者：`notice` 记完成，`trigger` 交给触发器投递，其余标 `ignored`。
- 先记账后执行：入队发生在状态落盘之后，因此崩溃后最多重放一次，不会丢。

### 4.3 收件箱阶段

| stage | 含义 | priority |
| --- | --- | --- |
| `rework` | 交付被退回，需要人改 | 0 |
| `arbitrate` | `inconclusive` 需要人裁决或仲裁 | 1 |
| `decide` | 门禁裁决 | 2 |
| `deliver` | 人工交付 | 3 |

`inbox()` 每项附 `stage/stageLabel/priority/summary/nodeTitle`，按 priority → `createdAt` 排序；
`summary` 是一句中文（谁在等、等什么、过期会怎样），页面与工具共用。

### 4.4 运行健康

`runHealth(run)` 返回 `{state, code, nodeId, waitingOn, message, since}`：

| code | 触发条件 |
| --- | --- |
| `waiting-delivery` / `waiting-decision` / `waiting-arbitration` | 有待决 pending |
| `host-unavailable` | `interrupted` 且错误码为 `host-unavailable` |
| `run-budget-exceeded` | 运行超过了 `runBudgetMs` |
| `node-failed` | 终态 `failed` |
| `stalled` | 开着的运行 60 秒没有推进 |
| `ok` | 其余运行中 |

### 4.5 时钟、预算与续跑

- `hnflow-pass`（`role: pass`）每 `passIntervalMs` 调 `service.pass()`；重入被跳过。
- 顺序：`sweepExpired` → outbox → 触发器 → 停滞续推。
- `step` 每轮检查预算；超时即失败（`run-budget-exceeded`），dispose 活动 activation。
- `open()` 把遗留的 `running/queued` 标 `interrupted`；`resumeOnStart` 为真时立即清错、
  写 `recovery: {reason: "host-restarted"}`、节点回 `pending`、重新入队。
- 停滞续推只处理"开着的、无触发器链、无活动 activation、`updatedAt` 超 60 秒"的运行。

### 4.6 触发器

`<workspace>/.hnflow/triggers.json`：

```json
{ "triggers": [
  { "id": "nightly", "source": "cron", "cron": "0 2 * * *", "flow": "demo", "input": {} },
  { "id": "watch", "source": "file", "watch": ["src/**/*.ts"], "flow": "demo", "debounceMs": 60000 },
  { "id": "after", "source": "run-completed", "after": "art-review", "flow": "demo" }
] }
```

- 幂等键：cron = `id:YYYY-MM-DDTHH:mm`（本地分钟桶）；file = `id:数量:mtime:大小`；
  run-completed = `id:<runId>`。
- file 源要求 `count > 0` 且 `now - maxMtime >= debounceMs`；跳过 `.git`/`node_modules`/`.hnflow`/
  `dist`/`build`/`.next`/`coverage`，上限 3000 文件、深度 6。
- 触发只新建 run（带 `trigger` 与 `chain`），不接管授权、不跳门禁、不续跑旧 run；链深上限 5。
- 解析错误逐条返回，不影响其余条目。

### 4.7 扩展节点类型

`service.registerNodeKind({id, title, run(ctx)})`：

- `id` 必须匹配 `^[a-z][a-z0-9]*(?:-[a-z0-9]+){0,4}$`，且不能覆盖内置六种；
- 执行器来源只有"插件确定性"与"子 Agent"两种，**不允许用户脚本**；
- 返回值归一为 `{status:'done', output}` 或 `{status:'failed', diagnostic}`；
- `done` 仍要过 `output` 契约（`contract-unsatisfied`），`validate` 通过 `extraNodeKinds` 放行类型；
- 注册是进程内的：DSH 重启后由插件重新注册。

### 4.8 通知通道

`service.registerChannel({id, title, send(payload)})`：

- 内置 `inbox`（空操作，权威状态）；core 行注册 `card`（会话问题卡）；
- `send` 永不抛异常，失败返回 `{ok:false, code}`，`askGate` 据此回落 `askedVia: "inbox"`；
- 通道只影响"送达尝试"，`pending` 状态仍以收件箱为准。

### 4.9 声明式 facts 与"自动化"面板

`snapshot` 增：`automation: {errors, effects, pass}`、`triggers: [{id, source, flow, enabled, lastFiredAt, workspace}]`、
`facts: {degraded, storage, vibestack, triggersEnabled, passIntervalMs, runBudgetMs, channels, nodeKinds}`。
收件箱页底部新增"自动化"面板（只读）：触发器表 + 解析错误 + 副作用队列计数 + 上次扫描结果 + 通知通道；
不新增页签、不新增 slot。运行列表与运行详情显示 `health.message`。

### 4.10 插件行拆分

`hnflow-pass` 是独立行：时钟崩溃不拖垮页面与工具；可以单独禁用（此时仍可用 `resume`、页面操作与
`hnflow` 工具推进运行）。

## 5. 兼容与迁移

- run 记录只增字段（`trigger`、`chain`、`recovery`、`updatedAt`），旧记录按缺省值读。
- storage domain 结构不变（仍是 `runs` 表一个文档），不需要版本迁移。
- `triggers.json` / `outbox.json` / `triggers-state.json` 都是新增文件，缺失即空。
- 新增配置全部有默认值：`passIntervalMs=2000`、`runBudgetMs=21600000`、
  `resumeOnStart=true`、`outboxMaxAttempts=8`、`triggersEnabled=true`。
- 版本号 0.7.0 → 0.8.0。

## 6. 测试计划

- 纯函数：cron 匹配/校验、health 推导、inbox 阶段排序、重试段落渲染。
- 组件：outbox 幂等/退避/dead；triggers 三种源与幂等键；kinds 注册与未知类型；
  channels 注册与失败降级。
- 集成（fake runner）：重试简报含上一轮 code；run 终态写 notice；
  run-completed 触发新 run 且链深受限；pass 推进停滞 run；预算超限失败；`resumeOnStart` 续跑。
- 回归：`cd plugins/dsh && node test/run.mjs` 全绿；页面路由 200 冒烟由 contract 测试覆盖。

## 7. 实施记录

实现日期 2026-11-14，版本 0.8.0。

### 7.1 新增文件

| 文件 | 职责 |
| --- | --- |
| `lib/cron.js` | 五字段 cron 解析、匹配、分钟桶幂等键 |
| `lib/health.js` | `runHealth(run)`：一句话说明卡在哪、等谁 |
| `lib/inbox.js` | pending 阶段（返工/仲裁/裁决/交付）、排序、摘要 |
| `lib/kinds.js` | 额外节点类型注册表 + 返回值归一 |
| `lib/channels.js` | 通知通道注册表（内置 `inbox`；`card` 由 core 行注册） |
| `lib/outbox.js` | 持久副作用队列（kind+key 幂等、指数退避、dead） |
| `lib/triggers.js` | `.hnflow/triggers.json` 解析、文件签名、cron/file/run-completed 求值 |
| `test/automation.test.js` | 上述纯函数与两个队列的测试 |
| `test/v08.test.js` | 重试病史、扩展节点、预算、触发器启动与链式、通道降级 |

### 7.2 改动要点

- `lib/service.js`：pass 循环（过期 → 副作用 → 触发器 → 停滞续推）、预算检查、
  `recordRunEffects`、`registerNodeKind` / `registerChannel` / `triggers()`、
  `open()` 自动续跑与 outbox/trigger 状态加载、`inbox()` 阶段化、`snapshot()` 自动化切片、
  `summariseRun()` 增 `health`。
- `lib/prompt.js`：`renderRetrySection` + `run.recovery` 恢复说明。
- `lib/flow/validate.js`：`extraNodeKinds` 放行注册类型，仍要求 output schema。
- `lib/tools.js` / `lib/routes.js` / `lib/author.js`：`triggers` 动作与路由、schema 透出 `nodeKinds()`。
- `index.js` + `cordis.patch.yml`：新增 `hnflow-pass` 行（独立时钟，故障隔离）。
- `client.js`：运行健康、触发器/恢复说明、收件箱阶段与摘要、自动化面板。
- `skills/hnflow-controls/SKILL.md`：`triggers` 动作、自动化边界、自动续跑说明。

### 7.3 测试

`cd plugins/dsh && node test/run.mjs` → 166 tests / 166 pass（本机 Windows，Node 22）。

### 7.4 已知限制

- 自动化只在 `hnflow-pass` 行运行时推进；该行默认启用，可单独关闭。
- 触发器只能新建 run，不能续跑既有 run，也不能跨过门禁/交付。
- 扩展节点类型通过插件 API 注册，**不对流程作者开放脚本**；DSH 重启后需要插件重新执行注册。
- 通知通道只做"送达尝试"，无外部凭据管理；失败按通道隔离，`inbox` 始终是权威状态。
- 文件触发器以签名（数量+mtime+大小）判断变化，不递归进 `.git`/`node_modules` 等目录，上限 3000 文件。
