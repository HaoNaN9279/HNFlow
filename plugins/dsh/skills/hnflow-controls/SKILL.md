---
name: hnflow-controls
description: HNFlow 对话控制面：列出能力组中的工作流、创建与修改项目内流程、启动/观察/取消/恢复运行、查看门禁与交付，并说明哪些动作只能由人完成。当用户要求新建或修改 HNFlow 工作流、查看可用流程、运行流程或查询运行时使用。
---

# HNFlow 控制面

本技能覆盖 `hnflow` 与 `hnflow_author` 的全部对话动作。节点契约、边、信封和门禁语义见
`hnflow-flows`；这里只回答“用什么动作、传什么、会得到什么、什么不能做”。

工作流是**能力组的内容**，不是独立资产。流程随能力组解析，可用本组及 `extends` 依赖组的
全部规则、技能、Agent、命令、工具与流程。

## 流程从哪里来

| 位置 | 路径 | 对谁可见 |
| --- | --- | --- |
| 组根流程 | `<group>/flows/<id>.flow.json` | 激活该组（含作为依赖）的工作区 |
| 模块流程 | `<group>/modules/<module>/flows/<id>.flow.json` | 激活该模块的工作区 |
| 项目本地组 | `<workspace>/.hnflow/groups/<group>/flows/<id>.flow.json` | 仅本工作区 |

流程键：组根 `<group>/<flow.id>`，模块 `<group>/<module-alias>/<flow.id>`。

## `hnflow`：读与运行

| 动作 | 参数 | 作用 / 返回 | 约束 |
| --- | --- | --- | --- |
| `list_flows` | 无 | 当前工作区激活能力组内的流程，含 `flowId`、`group`、`module`、`requires` | 只列可解析的流程 |
| `describe_flow` | `flow` | 完整定义、所属组/模块、文件路径 | `flow` 可传 `<group>/<id>`、flow id 或名称；歧义时报错 |
| `run` | `flow`、`input` | 启动一次运行，立即返回 `runId` | 不等待、不轮询；输入必须匹配流程 input |
| `status` | `run_id` | 节点状态、错误、待人工数、usage、降级、产物 | 只读 |
| `list_runs` | 无 | 最近 20 条运行摘要 | 只读 |
| `cancel` | `run_id` | 协作式取消 | 终态运行返回原状态 |
| `resume` | `run_id` | 显式恢复未终态运行 | 宿主重启后也会按 `resumeOnStart` 自动续跑 |
| `inbox` | 无 | 待处理门禁/交付，按阶段排序并带一句话摘要 | **只读**；不能代替人决策或交付 |
| `artifact` | `artifact_id` | 一个节点产物及当前值 | id 从 `status` 取 |
| `triggers` | 无 | `.hnflow/triggers.json` 的触发器与解析错误 | 只读；新增/修改触发器是改文件 |

## `hnflow_author`：创建与修改

| 动作 | 参数 | 作用 / 返回 | 约束 |
| --- | --- | --- | --- |
| `schema` | 无 | 定义格式、六种节点、边条件、策略说明 | 只读 |
| `validate` | `definition` 或 `flow` | 静态校验：schema、契约、输入、门禁分支、preset/模型层 | 通过不代表已运行 |
| `create` | `definition`、`name?`、`folder?`、`note?` | 在项目本地组新建流程文件 | 写 `.hnflow/groups/<group>/flows/`；`folder` 是组名，不含 `/` |
| `draft` | `flow`、`definition`、`note?` | 覆盖一个项目本地流程 | 仅项目本地组；仓库组流程报 `flow-not-local` |
| `delete` | `flow` | 删除项目本地流程文件 | 仅项目本地组 |
| `rename` | `flow`、`name` | 改项目本地流程的 `flow.name` | 仅项目本地组；不改 `flow.id` |

- `create` 的 `group` 来自 `folder`，缺省 `local`；自动创建
  `.hnflow/groups/<group>/group.json` 并确保 `.hnflow/stack.json` 激活该组。
- `flow.id` 可省略；省略时由名称生成 `fl-<slug>`。已存在报 `flow-duplicate`。
- 修改仓库内能力组流程请直接改仓库文件，不要用 `draft` 绕过。

## 标准做法

### 新建项目内流程

1. `hnflow_author create`，传完整 `definition`、`name`，必要时 `folder`（组名）。
2. 从返回读取 `key`（`<group>/<id>`）与 `path`。
3. 需要运行时 `hnflow run`，传 `flow` 与 `input`；立即把 `runId` 告诉用户。
4. 需要共享时，把流程文件移到对应能力组的 `flows/` 并随组版本发布；Agent 不做仓库发布。

### 修改流程

1. `describe_flow` 读当前定义，不要凭名字猜。
2. 修改后先 `validate`，再 `draft`（项目本地）或直接编辑仓库文件。
3. 运行使用启动时的定义快照；改文件不影响已启动的运行。

### 运行与观察

- `run` 只启动；不要轮询，也不要在对话里模拟节点。
- 后续用 `status` / `list_runs` / `inbox` / `artifact` 回答。
- 等待人工的门禁和交付由用户在页面或 `/hnflow inbox` 处理；`inbox` 只读。
- 宿主重启后，未终态运行会按 `resumeOnStart` 续跑；`cancel` 是显式动作。

### 自动化（`triggers`）

- 触发器写在 `<workspace>/.hnflow/triggers.json`，只决定**何时**新开一次运行；它不绕门禁、
  不接管授权、不续跑旧 run。
- 三种来源：`cron`、`file`（watch glob 签名变化）、`run-completed`（`after: <flowId>`）。
- 每次触发用幂等键去重；链式触发最多 5 层；创建触发器是改文件，不是工具动作。
- `triggers` 动作只读：看条件、目标流程、上次触发时间与解析错误。

## 只能由人完成（工具没有入口）

| 动作 | 入口 |
| --- | --- |
| 批准 / 拒绝 / 修改门禁 | 页面收件箱或原生问题卡 |
| 提交人工交付物 | 页面收件箱交付表单 |
| 激活/停用能力组、修改仓库组版本 | 人改 `.hnflow/stack.json` / 仓库文件 |
| 移动流程到仓库能力组 | 人编辑仓库并提交 |

不要声称自己完成了这些动作；也不要把“文件已写”说成“已生效”或“已运行”。

## 常见错误与处理

| 错误码 | 含义 / 下一步 |
| --- | --- |
| `flow-required` | 没传 `flow`：先 `list_flows` 看键 |
| `flow-missing` | 当前激活组里没有这个流程：确认组已激活、文件在 `flows/` |
| `flow-ambiguous` | 名称命中多个流程：改用 `<group>/<id>` |
| `flow-not-local` | 对仓库组流程做 `draft`/`delete`/`rename`：直接改仓库文件 |
| `flow-duplicate` | 项目组内已有同 id：换 id 或先删除 |
| `group-invalid` | `folder` 含 `/` 或非法字符：用单个组名 |
| `capability-unavailable` | 解析器不可用：检查 `hnflow-stack` 与 `.hnflow/stack.json` |
| `input-invalid` | 启动输入不满足流程 input：按 violations 修 |
| `definition-invalid` / `flow-invalid` | 定义或静态校验失败：按 `errors` 修，先 `validate` |
| `run-missing` | run id 不存在：用 `list_runs` 确认 |
