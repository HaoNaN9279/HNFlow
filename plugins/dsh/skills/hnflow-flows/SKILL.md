---
name: hnflow-flows
description: 起草和运行 HNFlow 约束式流程：六种节点原语、节点信封三态、边契约与门禁/人工交付的规则，以及流程作为能力组内容的存放方式。当用户想新增或修改流程、解释一次运行为何被拦住、或需要构造交付请求时使用。
---

# HNFlow 流程

HNFlow 把流程定义为**约束**而不是步骤：节点声明角色与产物契约，边声明什么条件下产物才能被下游消费，人通过门禁与交付进入流程，验收不由生成者自己完成。

流程是**能力组的内容**。组根放 `flows/<id>.flow.json`；激活组后，组内流程可使用本组及 `extends` 依赖组的全部规则、技能、Agent、命令、工具与流程。

## 六种节点

| 类型 | 谁执行 | 用途 | 关键字段 |
| --- | --- | --- | --- |
| `agent` | 子 Agent（preset） | 执行被定义清楚的任务 | `preset`、`instruction`、`output`、可选 `model` |
| `judge` | 另一个 preset 的子 Agent | 独立裁决产物 | `preset`（必须与生产者不同）、`criteria` |
| `merge` | 插件（确定性） | 汇合多上游产物 / 常量 | `from`、`output`、可选 `map`、可选 `set` |
| `gate` | 人 | 批准 / 拒绝 / 修改后批准 | `title`、`detail`、`options` |
| `request` | 人 + 验收 | 要 AI 生成不了的东西 | `deliverable`、`whyHuman`、`deadline` |
| `verify` | 插件（+ 可选 judge） | 验收人的交付物 | `against`、`checks`、`onReject` |

`model` 只写 **HNFlow 平台层 id**（`fast` / `standard` / `strong` / `vision`，默认 `standard`），不是 provider/model。层名写错报 `model-layer-unknown`，层存在但本机未绑定报 `model-layer-unbound`；都不回落。

## 节点信封

子 Agent 只能提交三种结构化意图之一：

```jsonc
{ "status": "done", "output": { … }, "evidence": ["…"] }
{ "status": "needs_human", "needsHuman": { "reason": "capability_gap", "deliverable": { … }, "whyHuman": "…" } }
{ "status": "failed", "error": { "code": "…", "message": "…" } }
```

`done` 不等于流程完成：插件会按 `output` schema 校验，再由下游的 judge / verify / gate 决定放行。`needs_human` 只在节点声明 `allowHuman: true` 时被接受，插件会创建交付请求并在人提交后继续**同一个节点**。

## 边

```jsonc
{ "from": "concept", "to": "review",
  "accepts": { … },                              // 下游输入契约，与上游 output 做可赋值校验
  "when": { "kind": "status", "is": "done" },    // status | verdict | gate | artifact.accepted | always
  "onFail": { "kind": "block" } }                // block | skip | fallback
}
```

- `accepts` 写不出来就说明契约不成立——静态校验报 `contract-unsatisfiable`。
- 一个 `gate` 的三条出边必须分别覆盖 `approved`、`rejected`、`modified`，否则 `gate-branches-incomplete`。
- 同一个输入端口只允许一条入边；多个上游汇合用 `merge`。
- 图必须单起点、单终点、无环；驳回重做走 `onReject`，不要连回上游。

## 人工交付

`request` 的 `deliverable` 是人交付物的 JSON Schema，`whyHuman` 必须说明为什么模型不可替代。提交后先过 schema，再按 `verify.checks` 决定是否请独立 judge；`onReject` 的 `return` 有次数上限，超限按 `fail` / `fallback` / `arbitrate` 处理——降级必须标记，不能静默通过。judge 返回 `needs_more` 时，`verify` 默认转成人工门禁（`onInconclusive: "fail"` 可直接失败）；门禁的 `deadline.hours` + `onExpire` 决定过期后是否失败。

## 起草步骤

1. `hnflow_author schema` 看完整格式与宿主当前注册的节点类型；不要编造节点 `kind`。
2. 写出定义后先 `validate`，把错误全部修掉；常见的几个：`input-unbound`、`gate-branches-incomplete`、`judge-same-as-producer`、`model-layer-unknown`、`schema-unsupported`。
3. 项目内新建用 `create`，默认写到 `<workspace>/.hnflow/groups/<group>/flows/<id>.flow.json`；`folder` 是组名，不含 `/`。插件会创建组清单并把组加入 `.hnflow/stack.json`。
4. 修改项目内流程用 `draft`，它只允许写项目本地组；仓库组流程报 `flow-not-local`，应直接编辑仓库文件。
5. `delete` / `rename` 也只作用于项目本地组；`rename` 只改 `flow.name`，不改 `flow.id`。
6. 要把流程共享给其他项目，把文件移入仓库能力组的 `flows/` 并随该组版本发布；这是人的改动，不是工具动作。

## 运行与观察

- `run` 只启动并立即返回 `runId`，不要轮询或等它。
- `status` / `list_runs` 回答后续问题；`inbox` 列出待人工处理的门禁/交付；`artifact` 按 id 读取一个节点产物。
- 运行固定启动时的定义快照；之后改文件不影响已启动的运行。
- 页面：左栏 HNFlow 三页签（流程 / 运行 / 收件箱）；流程页只读画布；运行页显示节点状态、产物、token 用量与降级标记。
- 触发器在 `.hnflow/triggers.json`，只决定何时新开运行，不绕门禁、不接管授权；只读查看用 `triggers`，新增/修改是改文件。

## 不要做

- 不要在节点里内联工具或 persona：节点只能引用 `preset`。
- 不要用流程表达权限：`model` 与交付物都不携带工具或审批。
- 不要让 judge 用生产者的 preset（`judge-same-as-producer`）。
- 不要手改 `.hnflow/stack.json` 或资产文件来绕开解析与校验。
- 不要把“文件已写”说成“已发布”“已运行”或“已验收”。
- 不要承诺自动续跑：中断的运行需要显式 `resume`，或依宿主 `resumeOnStart` 配置。
