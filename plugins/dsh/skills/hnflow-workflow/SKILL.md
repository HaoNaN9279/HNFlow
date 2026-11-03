---
name: hnflow-workflow
description: 在 HNFlow 模式中运行、修改或排查工作流。需要了解工作流资产 / 工作区引用 / 覆盖的关系、节点类型、端口规则，或要用 `hnflow` 工具与 `/workflow` 命令时加载。
---

# HNFlow 工作流

HNFlow 是**确定性执行层**：工作流定义（JSON）经编译成为图，由引擎执行；Agent 负责在
需要确定性时调用它，而不是自己重放步骤。

## 三层关系（最重要）

| 层 | 位置 | 谁写 |
| --- | --- | --- |
| 资产 Asset | `$DSH_HOME/hnflow/library/**/*.workflow.json` | 只有用户显式「保存回资产」 |
| 引用 Ref | `<workspace>/.hnflow/workflows.json` | `/workflow ref add\|remove` |
| 覆盖 Override | `<workspace>/.hnflow/overrides/<assetId>.workflow.json` | 本项目内的修改 |

- 工作区**不复制**资产，只存引用；同一资产可被多个工作区引用；
- 解析顺序：覆盖 → 引用固定的 revision 快照 → 资产最新 revision；
- **Agent 的修改一律写覆盖**，绝不写资产；写资产需要用户明确要求（且当前版本尚未开放）；
- 运行使用启动时快照的定义，之后的编辑不影响该次运行。

## 工具与命令

`hnflow` 工具：`list` / `get` / `run` / `status` / `cancel` / `resume` / `assets` / `task_list` / `task_submit`。
`run` 必须显式给 `workflow`（别名或资产 id），不得猜测；`input` 是 start 节点端口值。
run 停在人工节点时，工具会自动弹问题卡（review 一张卡，task 每端口一张）并提交答案；
传 `interactive:false` 则只报告待办，交给你手动 `/workflow submit`。

`hnflow_author` 工具：`schema`（节点/端口目录）、`validate`（只校验不运行）、
`save_override`（把完整定义写成工作区覆盖，先校验后落盘）。**它没有写资产的动作**：
想让改动进入共享资产，只能请用户执行 `/workflow save asset <name>`。

`/workflow` 命令（宿主执行，不进模型上下文）：
`run <name>`、`status <runId>`、`cancel <runId>`、`resume <runId>`、`tasks [runId]`、
`submit <taskId>`、`ref list|add|remove|pin`、`asset list|new|import|delete`、
`save asset <name> [--yes]`（不带 `--yes` 只给 diff）、`node <name> <nodeId> <json>`、
`panel [name]`、`override diff|reset`。

## 节点与端口

- 节点类型为 `category:name`，例如 `flow:start`、`data:assign`、`tool:bash`、
  `ai:llm_agent`、`human:task`、`verify:gate`；
- 端口类型：`data` / `file` / `bool` / `enum` / `number` / `array` / `record` / `spec`，
  只允许同类型连边；
- 同一输入端口只允许一条入边（`flow:end`、`flow:loop` 例外）；
- 必须有且只有一个 `flow:start` 与一个 `flow:end`；
- `tool:bash` 必须走沙箱；`app:*` 是宿主执行的显式例外；
- `verify:gate` 的 `verified` / `failed` / `inconclusive` 三个分支必须全部接线。

## 语义边界

- 人工节点是**引擎的挂起**，不是 DSH 审批：`human:task` 生成待办并让 run 进入
  `waiting_human`，`human:review` 走通过/打回；答案用 `task_submit` / `/workflow submit`
  提交，引擎从 checkpoint 继续；
- run 的真相在引擎：会话只记录工具调用；
- 修改定义时不要改 `flow:end` 的入边端口名，否则运行结果为空。

## 人工任务

```text
/workflow tasks <runId>                列出待办（含字段与类型）
/workflow submit <taskId> note=ok      提交并继续运行
/workflow resume <runId>               续跑被引擎重启打断的 run
```

工具等价：`action="task_list"`（带 `run_id`）、`action="task_submit"`（带 `task_id` 与 `input`）、
`action="resume"`（带 `run_id`）。
重复提交返回 `task-not-pending`；字段不符返回 `task-invalid`；revision 变化返回 `task-revision-conflict`。
引擎重启后，正在等待的 run 与待办仍在；被中断的 run 状态为 `interrupted`，需要显式 `resume`。

## 常见动作

```text
/workflow                     列出本工作区引用的工作流
/workflow run publish target=staging
/workflow override diff publish
/workflow override reset publish
```
