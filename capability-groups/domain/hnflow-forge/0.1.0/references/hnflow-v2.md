# HNFlow 定义速查（dsh-hnflow 0.8.0 / schemaVersion 2）

来源：HNFlow 项目的 `plugins/dsh`（`lib/flow/*`、`lib/tools.js`、`lib/author.js`、`lib/commands.js`、`lib/scheduler.js`、`lib/triggers.js`、`lib/outbox.js`）。插件升级时同步本文件。

## 定义外壳

`{ schemaVersion: 2, flow: { id, name, description?, tags? }, input?, nodes[], edges[] }`

## 内置六种节点

宿主插件可通过 `registerNodeKind` 注册额外 kind；`hnflow_author schema` 的 `notes.nodeTypes` 是当前权威列表。额外 kind 必须有 `output`，执行方只允许“插件确定性”或“子 Agent”，不能是用户脚本。

| 类型 | 执行者 | 必填 | 产出（下游可见的 output） |
| --- | --- | --- | --- |
| `agent` | preset 子 Agent | `preset`、`instruction`、`output` | 自己声明的 `output` |
| `judge` | 另一个 preset 子 Agent | `preset`、`instruction`、`criteria` | 固定：`verdict`、`reasons`、`conditions?` |
| `merge` | 插件（确定性） | `output`，且 `from[]` 或 `set{}` 非空 | 自己声明的 `output` |
| `gate` | 人 | 无（`title`/`detail` 建议写） | 固定：`decision`、`reason?`、`decidedAt?` |
| `request` | 人 + 验收 | `deliverable`、`whyHuman` | `deliverable` 的实际交付物 |
| `verify` | 插件（+ 可选 judge） | `against`（指向 `request`） | 固定：`accepted`、`violations`、`judged?` |

## 边

```jsonc
{ "id": "e1", "from": "a", "to": "b",
  "when": { "kind": "status", "is": "done" },
  "accepts": { "type": "object", "properties": {…} },
  "onFail": { "kind": "block" } }
```

求值（`scheduler.js`）：

| kind | 成立条件 |
| --- | --- |
| `always` | 总是 |
| `status` | 上游 `status === is`（`done` / `failed` / `skipped`） |
| `verdict` | 上游 `done` 且 `verdict === is`（`accept` / `reject` / `needs_more`） |
| `gate` | 上游 `done` 且 `output.decision === is`（`approved` / `rejected` / `modified`） |
| `artifact.accepted` | 上游 `done` 且 `output.accepted === is` |

`onFail`：`block`（默认）/ `skip` / `fallback`（需 `node`）。

## 子 Agent 信封

```jsonc
{ "status": "done", "output": {…}, "evidence": ["…"] }
{ "status": "needs_human", "needsHuman": { "reason": "capability_gap|real_world_judgement|authority|ambiguous_intent|asset_unavailable", "deliverable": {…}, "whyHuman": "…" } }
{ "status": "failed", "error": { "code": "…", "message": "…" } }
```

`needs_human` 只在节点 `allowHuman: true` 时被接受；插件创建交付请求，人提交后继续**同一节点**。子 Agent 限制：`maxDepth 0`（不能再委派）、不能向用户提问、不能执行需审批操作。

## schema 子集

`type`、`properties`、`required`、`additionalProperties`（布尔）、`items`、`enum`、`const`、`oneOf`。顶层必须 `type: "object"`；同 schema 禁 `type` + `oneOf`；越界 → `schema-unsupported`。

## instruction 模板

`{{input.<字段>}}`、`{{nodes.<节点id>.output.<字段>}}`、`{{flow.name}}`。未命中 → 空串；上游产物超 8000 字符截断。

## 工具面

`hnflow`（10 动作）：`list_flows`、`describe_flow`、`run`、`status`、`list_runs`、`cancel`、`resume`、`inbox`、`artifact`、`triggers`。

`hnflow_author`（6 动作）：`schema`、`validate`、`create`、`draft`、`delete`、`rename`。没有 publish/rollback/promote。

工具只在 HNFlow 预设注册；`/hnflow ...` 命令在任意会话可用（作用于当前工作区）。

## 人的入口（工具没有）

| 动作 | 入口 |
| --- | --- |
| 门禁裁决 / 人工交付 | 页面收件箱 / 原生问题卡 |
| 项目流程移入仓库能力组 | 人编辑 `capability-groups/.../flows/` 并提交 |
| 创建/修改自动触发 | 人直接编辑 `<workspace>/.hnflow/triggers.json`；`hnflow triggers` 只读 |
| 激活/停用能力组 | 人改 `.hnflow/stack.json` |

## 自动化（`.hnflow/triggers.json`）

```jsonc
{ "triggers": [
  { "id": "nightly",  "source": "cron", "cron": "0 2 * * *", "flow": "demo", "input": { "brief": "…" } },
  { "id": "watch-src","source": "file", "watch": ["src/**/*.ts"], "flow": "demo", "debounceMs": 60000 },
  { "id": "after-a",  "source": "run-completed", "after": "flow-a", "flow": "demo" }
] }
```

- `cron` 五字段，按分钟幂等；`file` 用 `数量:mtime:大小` 签名并需静置 `debounceMs`；`run-completed` 的 `after` 写流程 id 或 `*`，链式最多 5 层。
- 触发器只**新开** run：不接管授权、不跳 `gate`/`request`、不续跑旧 run。
- 需要插件 `hnflow-pass` 行启用（默认 2 秒一次）；它同时做过期推进、副作用重放、停滞续推。
- 解析错误逐条报在 `hnflow triggers` 与页面“自动化”面板，不会让整份文件失效。

## 作用域与存储

```text
<repo>/capability-groups/<group>/<version>/flows/<id>.flow.json          组根流程
<repo>/capability-groups/<group>/<version>/modules/<module>/flows/<id>.flow.json  模块流程
<workspace>/.hnflow/groups/<group>/flows/<id>.flow.json                  项目本地流程
<workspace>/.hnflow/stack.json                                          激活的根组
<workspace>/.hnflow/lock.json                                           解析闭包与 flow 文件清单
<workspace>/.hnflow/triggers.json                                       触发器（人写；缺失即不启用）
<stateDir>/outbox.json                                                  持久副作用队列（通知 / run-completed）
<stateDir>/triggers-state.json                                          触发器去重游标（上次触发键）
```

流程键：组根 `<group>/<id>`，模块 `<group>/<module-alias>/<id>`。修改仓库流程直接改仓库文件；项目流程用 `draft`。运行使用启动时的定义快照，不读取后续改动。

## 执行语义

- `run` 立即返回 `runId`；不要轮询、不要在对话里模拟节点。
- 宿主重启后默认自动续跑（`resumeOnStart`，带 `recovery.reason = host-restarted`）；关掉时需显式 `resume`。
- 并发受宿主 `maxParallel`（默认 3）与 `maxActiveSubagents`（8）约束；单次运行有墙钟预算 `runBudgetMs`（默认 6 小时），超时报 `run-budget-exceeded`。
- 收件箱按阶段排序（返工 → 仲裁 → 裁决 → 交付），一次只突出最该人处理的一条；`inbox` 项带 `stageLabel` 与 `summary`。
- `status` / 页面有 run 级 `health`（`ok` / `waiting-*` / `host-unavailable` / `run-budget-exceeded` / `node-failed` / `stalled`）与一句话说明。
- 降级（fallback / arbitrate）会被标记，不静默通过；`verify` 的 `onInconclusive` 决定 judge 不确定时转门禁还是失败。
- token 用量归因到节点。

## 校验错误码

`definition-invalid`、`node-id-invalid`、`node-type-invalid`、`contract-unsatisfiable`、`input-unbound`、`gate-branches-incomplete`、`judge-same-as-producer`、`preset-not-allowed`、`preset-unknown`、`preset-broken`、`model-layer-unknown`、`model-layer-unroutable`、`cycle-unsupported`、`graph-shape-invalid`、`request-contract-missing`、`reject-policy-invalid`、`merge-map-invalid`、`schema-unsupported`、`schema-invalid`、`HNFlow-unavailable`。

## 静态约束小结

单起点 + 单终点；无环；gate 有出边必须三分支齐全；judge preset ≠ 任一祖先 agent preset；`preset` 必须在 allowlist 且可解析；`model` 必须是可解析的层；非 agent/judge 不能写 preset；`merge.map` 的源必须是自己的 `from` 成员。
