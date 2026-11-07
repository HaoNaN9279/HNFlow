---
name: hnflow-flows
description: 起草和运行 HNFlow 约束式流程：六种节点原语、节点信封三态、边契约与门禁/人工交付的规则。当用户想新增或修改流程、解释一次运行为何被拦住、或需要构造交付请求时使用。
---

# HNFlow 流程

HNFlow 把流程定义为**约束**而不是步骤：节点声明角色与产物契约，边声明什么条件下产物才能被下游消费，人通过门禁与交付进入流程，验收不由生成者自己完成。

## 六种节点

| 类型 | 谁执行 | 用途 | 关键字段 |
| --- | --- | --- | --- |
| `agent` | 子 Agent（preset） | 执行被定义清楚的任务 | `preset`、`instruction`、`output`、可选 `model` |
| `judge` | 另一个 preset 的子 Agent | 独立裁决产物 | `preset`（必须与生产者不同）、`criteria` |
| `merge` | 插件（确定性） | 汇合多上游产物 / 常量 | `from`、`output`、可选 `map`、可选 `set` |
| `gate` | 人 | 批准 / 拒绝 / 修改后批准 | `title`、`detail`、`options` |
| `request` | 人 + 验收 | 要 AI 生成不了的东西 | `deliverable`、`whyHuman`、`deadline` |
| `verify` | 插件（+ 可选 judge） | 验收人的交付物 | `against`、`checks`、`onReject` |

`model` 只写 **VibeStack 模型层 id**（如 `strong`、`fast`、`audit`），不是 provider/model。层缺失时节点不会启动，发布也会失败。

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
  "accepts": { … },                              // 下游输入契约，发布前与上游 output 做可赋值校验
  "when": { "kind": "status", "is": "done" },     // status | verdict | gate | artifact.accepted | always
  "onFail": { "kind": "block" } }                 // block | skip | fallback
```

- `accepts` 写不出来就说明契约不成立——发布时会报 `contract-unsatisfiable`。
- 一个 `gate` 的三条出边必须分别覆盖 `approved`、`rejected`、`modified`，否则 `gate-branches-incomplete`。
- 同一个输入端口只允许一条入边；多个上游汇合用 `merge`。

## 人工交付

`request` 的 `deliverable` 是人交付物的 JSON Schema，`whyHuman` 必须说明为什么模型不可替代。提交后先过 schema，再按 `verify.checks` 决定是否请独立 judge；`onReject` 的 `return` 有次数上限，超限按 `fail` / `fallback` / `arbitrate` 处理——降级必须标记，不能静默通过。judge 返回 `needs_more` 时，`verify` 默认转成人工门禁（`onInconclusive: "fail"` 可直接失败）；门禁的 `deadline.hours` + `onExpire` 决定过期后是否失败。

## 起草步骤

1. 用 `hnflow_author` 的 `schema` 看完整格式。
2. 写出定义后先 `validate`，把错误全部修掉；常见的几个：`input-unbound`、`gate-branches-incomplete`、`judge-same-as-producer`、`model-layer-unknown`。
3. 新建项目内流程用 `create`（默认 `scope: "project"`；`flow.id` 可省略，插件会生成；名称可用 `name` 参数）；确定要放进通用资产库时用 `create` + `scope: "library"`（新资产 r1，并默认引用到本工作区）。`folder` 支持 `a/b` 这样的多级路径。
4. 修改流程用 `draft`。项目草稿可以改；库流程的草稿仍是工作区覆盖，**还没发布**。
5. 项目草稿可以 `rename` / `delete` / `promote`；`promote` 把它提升为库资产 r1 并改为引用。
6. 明确告诉用户：**已有资产的发布是人的动作**（`/hnflow publish <流程>` 或页面按钮），Agent 没有 publish 入口。

## 对话管理

- `hnflow` 的 `list_library` 查通用资产库；`add_ref` / `remove_ref` / `rename_ref` 管本工作区引用；`pin` / `history` 看版本与钉住状态。
- `list_flows` 会同时列出本工作区引用和项目草稿；项目草稿标 `[project-draft]`，没有 revision，`source: "local"`。
- 运行与观察：`run` 只启动并立即返回 `runId`；`status` / `list_runs` 用于后续问题；`inbox` 列出待人工处理项；`artifact` 按 id 取节点产物。
- 不要对项目草稿调用 publish/pin/rollback：它们没有 revision，插件会返回 `local-flow`。

## 运行与观察

- `hnflow` 工具的 `run` 只启动并立即返回 `runId`，不要轮询或等它。
- `status` 用于回答后续问题；`inbox` 列出待人工处理的门禁/交付；`artifact` 按 id 读取一个节点产物。
- 页面：左侧 HNFlow 图标（流程 / 运行 / 收件箱）。运行页可看节点状态、产物、token 用量与降级标记；版本历史可钉住或回滚（回滚由人确认）。项目草稿在页面里只提供画布、运行和“提升到通用资产库”。

## 不要做

- 不要在节点里内联工具或 persona：节点只能引用 `preset`。
- 不要用流程表达权限：`model` 与交付物都不携带工具或审批。
- 不要让 judge 用生产者的 preset（`judge-same-as-producer`）。
- 不要承诺"自动续跑"：`interrupted` 必须由人/模型显式 `resume`。
