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
| 引用 Ref | `<workspace>/.hnflow/workflows.json` | `/hnflow ref add\|remove` |
| 覆盖 Override | `<workspace>/.hnflow/overrides/<assetId>.workflow.json` | 本项目内的修改 |

- 工作区**不复制**资产，只存引用；同一资产可被多个工作区引用；
- 解析顺序：覆盖 → 引用固定的 revision 快照 → 资产最新 revision；
- **Agent 的修改一律写覆盖**，绝不写资产；
- 运行使用启动时快照的定义，之后的编辑不影响该次运行。

## 会话只负责启动

这是本模式最重要的一条：**会话里触发工作流，只有一条路径** —— 用户输入
`/workflow <name> <提示词>`，命令把工作流引用和提示词合成一条用户消息交给 AI，
AI 用 `hnflow` 工具的 `run` 启动，然后**回一行就结束**。

- 启动后不要轮询、不要等待、不要重试、不要替用户回答人工节点；
- 运行由引擎自己推进，进度看 HNFlow 页面（任务监视）；
- 直接运行（不经对话）不属于会话，属于 HNFlow 页面。

## 工具

`hnflow`：`list` / `get` / `run` / `status` / `cancel` / `resume` / `events` / `assets` /
`task_list` / `task_submit`。

- `run` 必须显式给 `workflow`（别名或资产 id），不得猜测；
- `input` 是 start 节点端口值，从用户的提示词里推导出来；
- `run` 在引擎接受定义后立即返回，返回里就有 runId 和状态；
- `status` / `events` / `task_list` 只用于回答用户**之后**的追问，不用于轮询。

`hnflow_author`：`schema`（节点/端口目录）、`validate`（只校验不运行）、
`save_override`（把完整定义写成工作区覆盖，先校验后落盘）。**它没有写资产的动作**。

## 命令

`/workflow`（把引用变成一次 AI 轮次，本身不执行工作流）：

```text
/workflow                          列出本工作区引用的工作流
/workflow <name> <提示词>           交给 AI 启动
```

`/hnflow`（页面与资产库，任何会话可用；只有读写定义的能力，没有运行能力）：

```text
/hnflow ref list|add|remove|pin
/hnflow asset list|new|import|delete
/hnflow override diff|reset <name>
/hnflow save asset <name> [--yes]   不带 --yes 只给 diff
/hnflow node <name> <nodeId> <json>
/hnflow doctor [--save]
```

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
  `waiting_human`，`human:review` 走通过/打回；答案由用户在 HNFlow 页面提交，
  或用 `task_submit`（仅在用户明确要求时），引擎从 checkpoint 继续；
- run 的真相在引擎：会话只记录工具调用；
- 修改定义时不要改 `flow:end` 的入边端口名，否则运行结果为空。

## 人工任务与重启

```text
action="task_list"   run_id=<runId>          列出待办（含字段与类型）
action="task_submit" task_id=<taskId> input={…}  提交并继续运行
action="resume"      run_id=<runId>          续跑被中断的 run
```

重复提交返回 `task-not-pending`；字段不符返回 `task-invalid`；revision 变化返回
`task-revision-conflict`。

**重启 DSH 不会自动续跑**：被引擎重启打断的 run 停在那里，等人或模型显式 `resume`。

## 常见动作

```text
/workflow                                        列出本工作区引用的工作流
/workflow publish 把 staging 的产物发布出去          交给 AI 启动
/hnflow ref add wf-3ae1b61d98a5 --alias publish  给工作区加一个引用
```
