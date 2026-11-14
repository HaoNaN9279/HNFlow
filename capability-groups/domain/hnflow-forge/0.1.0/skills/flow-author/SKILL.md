---
name: flow-author
description: 当边界已定、需要写出可校验的 HNFlow 流程定义（schemaVersion 2）时使用：节点选型（内置六种 + 宿主注册的额外 kind）、三套可运行骨架、契约写法、模板变量、静态校验错误码修法，以及 create/draft 动作序列。
---

# 流程定义编写（Author）

定义是纯 JSON，`schemaVersion: 2`。**先 `validate` 通过，再 `create` / `draft`。**

## 外壳

```jsonc
{
  "schemaVersion": 2,
  "flow": { "id": "fl-…", "name": "名称", "description": "一句话；依赖能力组时写 requires:<group>", "tags": ["…"] },
  "input": { "type": "object", "required": ["…"], "properties": { "…": { "type": "string" } }, "additionalProperties": false },
  "nodes": [ /* 非空 */ ],
  "edges": [ /* 可以空，但单节点流程的节点必须既起点又是终点 */ ]
}
```

`flow.id` 与 `flow.name` **都必填非空**：`hnflow_author create` 在工具层先做形状检查，缺 id 直接报 `definition-invalid`（插件内部虽有兜底，工具面走不到）。id 建议 `fl-<域>-<用途>`，只用字母数字和 `-`。`create` 的 `name` 参数优先于 `definition.flow.name`。

## 三套骨架（可直接跑）

### A. 线性 + 末尾人工门禁

适合“产出 → 人确认一次即结束”。

```json
{
  "schemaVersion": 2,
  "flow": { "id": "fl-template-linear", "name": "线性模板", "description": "agent 节点 + 末尾人工门禁" },
  "input": { "type": "object", "required": ["brief"], "properties": { "brief": { "type": "string" } }, "additionalProperties": false },
  "nodes": [
    {
      "id": "draft",
      "type": "agent",
      "preset": "hnflow",
      "instruction": "根据 {{input.brief}} 产出要点列表。",
      "input": { "type": "object", "required": ["brief"], "properties": { "brief": { "type": "string" } }, "additionalProperties": false },
      "output": { "type": "object", "required": ["points"], "properties": { "points": { "type": "array", "items": { "type": "string" } } }, "additionalProperties": false },
      "budget": { "maxAttempts": 2, "timeoutMs": 600000 }
    },
    { "id": "approve", "type": "gate", "title": "确认要点", "detail": "批准即完成；拒绝结束本次运行并记录理由。" }
  ],
  "edges": [{ "id": "e1", "from": "draft", "to": "approve", "when": { "kind": "status", "is": "done" } }]
}
```

### B. gate 三分支 → merge 汇合

门禁在中间时，三条出边必须齐全；三条分支最终汇到**唯一**终点（流程无环，不能画回边）。

```json
{
  "schemaVersion": 2,
  "flow": { "id": "fl-template-branch", "name": "分支模板", "description": "agent → gate 三分支 → merge 汇合" },
  "input": { "type": "object", "required": ["brief"], "properties": { "brief": { "type": "string" } }, "additionalProperties": false },
  "nodes": [
    {
      "id": "draft",
      "type": "agent",
      "preset": "hnflow",
      "instruction": "根据 {{input.brief}} 写一段说明。",
      "input": { "type": "object", "required": ["brief"], "properties": { "brief": { "type": "string" } }, "additionalProperties": false },
      "output": { "type": "object", "required": ["text"], "properties": { "text": { "type": "string" } }, "additionalProperties": false },
      "budget": { "maxAttempts": 2, "timeoutMs": 600000 }
    },
    { "id": "review", "type": "gate", "title": "确认说明", "detail": "批准→定稿；修改→修订分支；拒绝→直接收尾。" },
    {
      "id": "finish",
      "type": "agent",
      "preset": "hnflow",
      "instruction": "把 {{nodes.draft.output.text}} 定稿。",
      "input": { "type": "object", "properties": { "decision": { "type": "string" } }, "additionalProperties": false },
      "output": { "type": "object", "required": ["text"], "properties": { "text": { "type": "string" } }, "additionalProperties": false }
    },
    {
      "id": "revise",
      "type": "agent",
      "preset": "hnflow",
      "instruction": "按人的修改意见修订 {{nodes.draft.output.text}}。",
      "input": { "type": "object", "properties": { "decision": { "type": "string" }, "reason": { "type": "string" } }, "additionalProperties": false },
      "output": { "type": "object", "required": ["text"], "properties": { "text": { "type": "string" } }, "additionalProperties": false }
    },
    { "id": "sink", "type": "merge", "from": ["finish", "revise", "review"], "output": { "type": "object" } }
  ],
  "edges": [
    { "id": "e1", "from": "draft", "to": "review", "when": { "kind": "status", "is": "done" } },
    { "id": "e2", "from": "review", "to": "finish", "when": { "kind": "gate", "is": "approved" } },
    { "id": "e3", "from": "review", "to": "revise", "when": { "kind": "gate", "is": "modified" } },
    { "id": "e4", "from": "review", "to": "sink", "when": { "kind": "gate", "is": "rejected" } },
    { "id": "e5", "from": "finish", "to": "sink", "when": { "kind": "always" } },
    { "id": "e6", "from": "revise", "to": "sink", "when": { "kind": "always" } }
  ]
}
```

### C. request + verify + 独立 judge

人工交付必须有 `deliverable`（交付物 schema）和 `whyHuman`（为什么模型不可替代）。

```json
{
  "schemaVersion": 2,
  "flow": { "id": "fl-template-human", "name": "人工交付模板", "description": "概念 → 人工交付 → 独立验收 → 接入" },
  "input": { "type": "object", "required": ["brief"], "properties": { "brief": { "type": "string" } }, "additionalProperties": false },
  "nodes": [
    {
      "id": "concept",
      "type": "agent",
      "preset": "hnflow",
      "instruction": "根据 {{input.brief}} 给出 3 个可行方向，每个含名称与一句话说明。",
      "input": { "type": "object", "required": ["brief"], "properties": { "brief": { "type": "string" } }, "additionalProperties": false },
      "output": {
        "type": "object",
        "required": ["directions"],
        "properties": {
          "directions": {
            "type": "array",
            "items": { "type": "object", "required": ["name", "line"], "properties": { "name": { "type": "string" }, "line": { "type": "string" } }, "additionalProperties": false }
          }
        },
        "additionalProperties": false
      },
      "budget": { "maxAttempts": 2, "timeoutMs": 900000 }
    },
    {
      "id": "craft",
      "type": "request",
      "deliverable": {
        "type": "object",
        "required": ["files", "notes"],
        "properties": { "files": { "type": "array", "items": { "type": "string" } }, "notes": { "type": "string" } },
        "additionalProperties": false
      },
      "whyHuman": "精修需要真实手感与线下工具，模型只能给方向",
      "deadline": { "hours": 72 },
      "onExpire": "remind"
    },
    {
      "id": "accept",
      "type": "verify",
      "against": "craft",
      "checks": ["schema", "judge"],
      "judge": { "preset": "standard", "criteria": "交付文件是否与已确认方向一致，命名与 notes 是否足以让下游接入" },
      "onReject": { "kind": "return", "maxAttempts": 2 }
    },
    {
      "id": "integrate",
      "type": "agent",
      "preset": "hnflow",
      "instruction": "把通过验收的交付物按项目规范接入，产出变更清单。交付物：{{nodes.craft.output}}",
      "output": { "type": "object", "required": ["changes"], "properties": { "changes": { "type": "array", "items": { "type": "string" } } }, "additionalProperties": false }
    }
  ],
  "edges": [
    { "id": "e1", "from": "concept", "to": "craft", "when": { "kind": "status", "is": "done" } },
    { "id": "e2", "from": "craft", "to": "accept", "when": { "kind": "status", "is": "done" } },
    { "id": "e3", "from": "accept", "to": "integrate", "when": { "kind": "artifact.accepted", "is": true } }
  ]
}
```

## 节点字段

下表是**内置六种**。宿主插件可通过 `registerNodeKind` 注册额外 kind（`hnflow_author schema` 的 `notes.nodeTypes` 列出当前全部）；额外 kind 必须有 `output` 契约，执行只允许插件确定性逻辑或子 Agent，不能是用户脚本。不确定就不写。

| 类型 | 必填 | 可选 |
| --- | --- | --- |
| `agent` | `id`、`preset`、`instruction`、`output` | `input`、`model`、`budget{maxAttempts,timeoutMs}`、`allowHuman`、`onReject` |
| `judge` | `id`、`preset`、`instruction`、`criteria` | `input`、`model`、`budget` |
| `merge` | `id`、`output`，且 `from[]` 与 `set{}` 至少一个非空 | `map{目标: "来源.路径"}` |
| `gate` | `id` | `title`、`detail`、`options`、`deadline{hours}`、`onExpire: remind\|fail` |
| `request` | `id`、`deliverable`、`whyHuman` | `deadline`、`onExpire`、`onReject`、`budget` |
| `verify` | `id`、`against`（必须指向 `request` 节点） | `checks: ["schema","judge"]`（默认 `["schema"]`）、`judge{preset,criteria,model}`、`onInconclusive: gate\|fail`、`onReject` |

- 节点 id 正则：`^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$`，不可重复。
- `preset` 只写在 `agent` / `judge`（及 `verify.judge`）；其它节点写 preset 会报 `definition-invalid`。
- `model` 只写 HNFlow 层 id，不写 `provider/model`。
- `onReject.kind`：`return`（重试，需 `maxAttempts`）、`fallback`、`arbitrate`（独立仲裁）、`fail`。

## 边字段

```jsonc
{
  "id": "e1",
  "from": "上游节点 id",
  "to": "下游节点 id",
  "when": { "kind": "status", "is": "done" },   // 见下
  "accepts": { "type": "object", "properties": {…} }, // 可选；缺省用下游 input
  "onFail": { "kind": "block" }                  // block | skip | fallback(node)
}
```

`when.kind` 取值：`always`、`status`（`done|failed|skipped`）、`verdict`（`accept|reject|needs_more`）、`gate`（`approved|rejected|modified`）、`artifact.accepted`（`true|false`）。

契约规则：上游 `output` 必须能被 `accepts`（或下游 `input`）消费；下游 `required` 字段必须有来源（上游产出或 `flow.input.properties`），否则 `input-unbound` / `contract-unsatisfiable`。

## schema 子集

只支持 `type` / `properties` / `required` / `additionalProperties` / `items` / `enum` / `const` / `oneOf`。顶层必须 `type: "object"`；同一 schema 禁 `type` + `oneOf` 同用；`additionalProperties` 只接受布尔。

## 模板变量

`instruction` 里可用：`{{input.<字段>}}`、`{{nodes.<节点id>.output.<字段>}}`、`{{flow.name}}`。未命中渲染为空串；单个上游产物超过 8000 字符会被截断，子 Agent 需自己按节点 id 去读。

信封（子 Agent 只能三选一）：`done` + `output`；`needs_human` + `needsHuman`（需要节点 `allowHuman: true`）；`failed` + `error`。`done` 不等于流程完成——还要过契约与下游判定。

## 动作序列

```text
hnflow_author schema                         # 需要时回看格式（notes.nodeTypes = 当前可用节点类型）
hnflow_author validate { definition }        # 必做；有错先修
hnflow_author create { definition, name, folder? }
hnflow_author draft { flow, definition }     # 改项目本地组流程
hnflow_author rename / delete                # 仅项目本地组
hnflow run { flow, input }                   # 启动一次，立即返回 runId，不轮询
hnflow status / list_runs / inbox / triggers # 观察：健康、待决项、触发器与解析错误
```

作用域：`create` 写到 `.hnflow/groups/<group>/flows/`，只在本工作区可见、可运行。要共享给其他项目，由人把文件移入仓库能力组的 `flows/` 并随组版本提交。**触发器的创建/修改是人的动作**：`hnflow triggers` 只读，触发器写在项目 `.hnflow/triggers.json`。

## 错误码 → 修法

| 错误码 | 修法 |
| --- | --- |
| `definition-invalid` | 对照必填字段表补全；注意非 agent/judge 不能写 preset |
| `node-id-invalid` | id 不匹配正则或重复 |
| `node-type-invalid` | 类型不在宿主注册表：用内置六种，或先用 `hnflow_author schema` 确认插件已注册该 kind |
| `contract-unsatisfiable` | 上游 output 缺下游 required 字段：补 output 或用 `merge` 组装 |
| `input-unbound` | required 字段无来源：加进 `flow.input.properties` 或让上游产出 |
| `gate-branches-incomplete` | 给 gate 补齐 approved / rejected / modified 三条出边 |
| `judge-same-as-producer` | 换 judge 的 preset（校验会查所有祖先 agent） |
| `preset-not-allowed` / `preset-unknown` / `preset-broken` | 只用 allowlist 内可解析的 preset（默认 `hnflow`、`standard`） |
| `model-layer-unknown` / `model-layer-unroutable` | 换已有层 id，或干脆不写 `model`；不要猜 |
| `cycle-unsupported` | 去掉回边；重做走 `onReject` 或另设修订节点 |
| `graph-shape-invalid` | 必须恰一个起点、恰一个终点；多分支用 `merge` 收口 |
| `request-contract-missing` | `request` 补 `deliverable` 与 `whyHuman` |
| `reject-policy-invalid` | `onReject.kind` 合法值 + `maxAttempts` 正整数 |
| `merge-map-invalid` | `map` 的值必须以 `from` 里的节点 id 开头 |
| `schema-unsupported` / `schema-invalid` | 收回到支持的 8 个关键字 |

## 绝不

- 节点里内联工具、persona 或权限；`instruction` 只描述任务与契约，手法交给能力组技能。
- 让 `judge` 与生产者同 preset；把验收交给生产者。
- 手改 `.hnflow/stack.json` 或仓库能力组文件。
