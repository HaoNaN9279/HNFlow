---
name: hnflow-controls
description: HNFlow 对话控制面：创建、修改、提升、删除项目内流程，发现与引用通用资产，管理版本与钉住，启动、观察、取消和恢复运行，并说明哪些动作只能由人完成。当用户要求新建或修改 HNFlow 工作流、管理流程引用、查看版本、运行流程或查询运行时使用。
---

# HNFlow 控制面

本技能覆盖 `hnflow` 与 `hnflow_author` 的**全部对话动作**。节点契约、边、信封和门禁语义见 `hnflow-flows`；这里只回答“用什么动作、传什么、会得到什么、什么不能做”。

技能由 HNFlow 插件随包提供（`source: bundled`），不依赖工作区；在任意工作区、任意 HNFlow 模式会话中都可加载。所有动作作用于**当前会话的工作区**。

## 先分清两个作用域

| 作用域 | 存哪里 | 谁能看到 | 有没有 revision |
| --- | --- | --- | --- |
| `project`（项目草稿，默认） | 本工作区 `.hnflow/overrides/`，`local: true` 且无引用 | 只有本工作区 | 没有；可运行、改名、删除、提升 |
| `library`（通用资产） | 资产库；工作区另有一条引用 | 所有工作区（被引用后） | 有 r1/r2… 与不可变快照 |

- 新建时**默认建项目草稿**；只有明确要共享才用 `scope: "library"`。
- `create scope:"library"` 写的是**新资产 r1**，不是发布已有资产；已有资产的修改仍然只能先 `draft`，再由人发布。
- 项目草稿不能 `history`/`pin`/`publish`/`rollback`；先 `promote` 成库资产。

## `hnflow`：读、运行、引用

| 动作 | 参数 | 作用 / 返回 | 约束 |
| --- | --- | --- | --- |
| `list_flows` | 无 | 当前工作区的引用 + 项目草稿；项目草稿标 `project-draft`，无 revision | 不列未引用的通用资产 |
| `list_library` | 无 | 资产库全部资产（id、名称、rN、folder） | 全局，不需要工作区 |
| `describe_flow` | `flow` | 解析后的完整定义、来源、revision、drift | `flow` 可传 alias / 名称 / id |
| `run` | `flow`、`input` | 启动一次运行，立即返回 `runId` | 不等待、不轮询；输入必须匹配流程 input |
| `status` | `run_id` | 节点状态、错误、待人工数、usage、降级、产物 | 只读 |
| `list_runs` | 无 | 最近 20 条运行摘要 | 只读 |
| `cancel` | `run_id` | 协作式取消 | 终态运行返回原状态 |
| `resume` | `run_id` | 显式恢复 `interrupted` 等未终态运行 | 不会自动恢复；终态报 `run-terminal` |
| `inbox` | 无 | 待处理的门禁/交付（含审计字段） | **只读**；不能代替人决策或交付 |
| `artifact` | `artifact_id` | 一个节点产物及当前值 | id 从 `status` 取 |
| `add_ref` | `flow`、`alias?` | 把库资产引用到当前工作区 | `flow` 用资产 id 或名称；重复引用报错 |
| `remove_ref` | `flow` | 删除引用，**不删资产** | 若该引用有工作区覆盖，覆盖文件保留但不再列出 |
| `rename_ref` | `flow`、`alias` | 改引用别名 | 别名不能为空、不能与别的引用冲突 |
| `pin` | `flow`、`revision` | 把引用钉到 `"latest"` 或 `"r3"` | 仅库流程；本地草稿报 `local-flow` |
| `history` | `flow` | revision 列表、当前/钉住版本 | 仅库流程；本地草稿报 `local-flow` |

`flow` 对库流程可以是 alias、资产名称或 id；对项目草稿是名称或 `fl-local-…` id。名称有歧义时改用 id。

## `hnflow_author`：创建、修改、治理

| 动作 | 参数 | 作用 / 返回 | 约束 |
| --- | --- | --- | --- |
| `schema` | 无 | 完整定义格式、六种节点、边条件、策略说明 | 只读 |
| `validate` | `definition` 或 `flow` | 发布前静态校验（schema、契约、输入、门禁分支、preset/model 层） | 校验通过不代表已发布 |
| `create` | `definition`、`scope?`、`name?`、`folder?`、`alias?`、`reference?`、`note?` | 新建项目草稿（默认）或库资产 r1；返回 `flowId`、scope、validation | `flow.id` 可省略，插件生成；`folder` 是相对路径，支持 `a/b`，禁止 `..` 与绝对路径 |
| `draft` | `flow`、`definition`、`note?` | 写工作区草稿（项目草稿覆盖或库流程的本地覆盖） | 不产生 revision；已有库资产仍需人发布 |
| `promote` | `flow`、`folder?`、`name?`、`alias?` | 项目草稿 → 库资产 r1，并改为当前工作区引用 | 只适用于本地草稿；成功后本地草稿消失 |
| `delete` | `flow` | 删除项目草稿 | 只删本地草稿；库资产/引用用 `remove_ref`，不能删资产 |
| `rename` | `flow`、`name` | 重命名项目草稿 | 只适用于本地草稿；库流程改引用用 `rename_ref` |

- `create` 的 `name` 参数优先于 `definition.flow.name`；名称重复（项目草稿）报 `name-duplicate`。
- `create scope:"library"` 默认同时 `add_ref`；`reference:false` 可只建资产不引用。
- `draft` 会保留解析出的 flow id 与名称；改名请用 `rename` / `rename_ref`，不要在定义里偷偷改。
- 项目草稿与库流程的 `draft` 都**不进版本历史**；只有人执行 publish 才产生新 revision。

## 标准做法

### 新建项目内流程

1. `hnflow_author create`，传完整 `definition`、`name`，必要时 `folder`。
2. 从返回中读取 `flowId`（或名称）。
3. 需要运行时调用 `hnflow run`，传 `flow` 与 `input`；立即把 `runId` 告诉用户，不等待。
4. 需要共享时再 `promote`。

### 新建通用流程

1. 确认用户要放进通用库；调用 `create` 时加 `scope: "library"`，可加 `folder` 与 `alias`。
2. 返回 `flowId`、`revision: 1`、`referenced`；之后修改它仍走 `draft` + 人工发布。

### 修改已有流程

1. `describe_flow` 读当前定义（不要凭名字猜）。
2. 修改后先 `validate`，再 `draft`。
3. 明确告诉用户：草稿可运行，但**发布是人的动作**；Agent 没有 publish 工具。

### 提升、引用、版本

- 本地草稿 → `promote`；成功后用返回的新 `flowId`。
- 库资产 → `list_library` 找 id/名称 → `add_ref`（可给 alias）。
- 版本 → `history` 看 rN；`pin` 钉 `latest` 或 `rN`。
- 只移除项目引用 → `remove_ref`；**不会删除库资产**。

### 运行与观察

- `run` 只启动；不要轮询，也不要在对话里模拟节点。
- 后续用 `status` / `list_runs` / `inbox` / `artifact` 回答。
- 等待人工的门禁和交付由用户在页面或 `/hnflow inbox` 处理；`inbox` 只读。
- `cancel` / `resume` 是显式动作；`interrupted` 不会自动续跑。

## 只能由人完成（工具没有入口）

| 动作 | 人的入口 |
| --- | --- |
| 发布已有库资产 | `/hnflow publish <flow>` 预览后 `confirm`，或页面「发布新版本」 |
| 回滚到旧 revision | `/hnflow rollback <flow> rN confirm`，或页面按钮 |
| 批准/拒绝/修改门禁 | 页面收件箱或原生问题卡 |
| 提交人工交付物 | 页面收件箱交付表单 |
| 导入旧格式定义 | `/hnflow import <名称> <文件>` |

不要声称自己完成了这些动作，也不要把“草稿已写”说成“已发布”。

## 常见错误与处理

| 错误码 | 含义 / 下一步 |
| --- | --- |
| `ref-missing` | 当前工作区没有这个流程：`list_flows` 确认，或先 `add_ref` |
| `asset-missing` | 资产库没有这个 id/名称：`list_library` 确认 |
| `local-flow` | 对项目草稿做了 publish/pin/history/rollback：改用 `promote` |
| `not-local` | 把库流程当本地草稿删/改名：用 `remove_ref` / `rename_ref` |
| `name-duplicate` | 项目草稿重名：换名或先处理已有草稿 |
| `folder-invalid` | folder 含 `..` 或绝对路径：改成库/项目相对路径 |
| `definition-invalid` / `flow-invalid` | 定义或静态校验失败：按返回的 `errors` 修，先 `validate` |
| `input-invalid` | 启动输入不满足流程 input：按 violations 修 |
| `ref-duplicate` | 引用/别名冲突：换 alias，或先移除旧引用 |
| `revision-missing` / `lockfile-mismatch` | 版本快照或 lockfile 不可用：不要回退猜测，报告给用户 |
| `run-missing` | run id 不存在：`list_runs` 确认 |
| `run-terminal` | 运行已结束，不能 resume：如需新结果重新 `run` |
| `vibestack-unavailable` | 缺 VibeStack 或 apiVersion 不足：发布/运行会被拒绝，不要重试绕过 |

## 不要做

- 不要自己调用不存在的 `publish` / `rollback` / `decide` / `deliver` 工具；它们不在工具面上。
- 不要用文件读写绕过 `hnflow_author` 去改 `.hnflow/` 或资产库；那会绕开校验、版本和人工发布。
- 不要在 `run` 后循环 `status` 等结果；把 runId 交给用户和页面。
- 不要发明节点类型、preset 或 model 层；只用 `schema` 列出的六种节点和 VibeStack 已有层。
- 不要承诺子流程嵌套；当前执行层没有 subflow 节点，文件夹层级只是展示。

## 示例

```text
# 项目草稿
hnflow_author create { definition: { schemaVersion: 2, flow: { name: "周报" }, nodes: [...], edges: [...] }, name: "周报", folder: "team/reports" }
→ { created: true, scope: "project", flowId: "fl-local-…" }

# 运行
hnflow run { flow: "周报", input: { week: "2026-W45" } }
→ started run-…（立即返回；不要等待）

# 后续
hnflow status { run_id: "run-…" }
hnflow inbox {}
hnflow artifact { artifact_id: "art-…" }
```

```text
# 提升并引用
hnflow_author promote { flow: "fl-local-…", folder: "shared/reports" }
→ { promoted: true, flowId: "fl-…", revision: 1 }

# 版本
hnflow history { flow: "周报" }
hnflow pin { flow: "周报", revision: "r2" }
```
