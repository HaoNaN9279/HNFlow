---
name: hnflow-forge
---

# HNFlow 工作流制作

适用：用户要求“做一套 HNFlow 工作流”“把某个需求变成可运行流程”“给流程配能力组”。
不适用：只运行/排查一次运行，直接用 `hnflow` 工具即可。

## 铁律：先拆分，再落笔

需求闭合 → 边界拆分 → 流程定义 → 配套能力组 → 校验 → 交付。缺关键信息先问，最多 3 轮；其余写“假设”，并在交付说明里列出。

## 边界一句话

| 放哪 | 装什么 | 复用范围 |
| --- | --- | --- |
| 能力组 | 怎么做：规则 / 技能 / 人设 / 命令 / 工具 | 跨流程、跨项目 |
| HNFlow 流程 | 何时、谁、拿什么、交出什么、谁来验收 | 一次可编排的执行 |
| 项目文件 | 只在本项目成立的约定 | 单项目 |
| `flow.input` / run input | 这次运行的数据 | 单次运行 |
| 模型层 | 路由（条目只写层 id） | 本机 |
| 节点 `preset` | 宿主已注册的 preset | 能力组不能新增 |

## HNFlow 硬约束

- 内置六节点：`agent` / `judge` / `merge` / `gate` / `request` / `verify`；宿主插件用 `registerNodeKind` 注册的额外 kind 也算合法，以 `hnflow_author schema` 返回的 `nodeTypes` 为准，**不要编造**（未注册报 `node-type-invalid`）。
- 单起点 + 单终点；禁止环——驳回重做走 `onReject`，或另设节点继续向前。
- `gate` 有出边时 `approved` / `rejected` / `modified` 三分支必须齐全。
- `judge`（含 `verify.judge`）的 preset 不能与任一祖先 `agent` 的 preset 相同。
- schema 只支持 `type` / `properties` / `required` / `additionalProperties` / `items` / `enum` / `const` / `oneOf`；顶层必须 `type: "object"`；同一 schema 禁 `type` + `oneOf` 同用。
- `preset` 必须在宿主 allowlist（默认 `hnflow`、`standard`）；`model` 只写 HNFlow 平台模型层 id（`fast` / `standard` / `strong` / `vision`）。
- 节点不能内联工具或 persona；流程不表达权限。

## 自动化边界

- “什么时候自动跑”不是流程内容：写在项目 `.hnflow/triggers.json`（`cron` / `file` / `run-completed`），由人维护；Agent 没有创建触发器的工具动作。
- 触发器只**新开** run：不接管授权、不跳 `gate` / `request`、不续跑旧 run；`run-completed` 链式触发最多 5 层。
- 自动化要生效，插件 `hnflow-pass` 行必须启用（默认 2 秒一次）；它同时负责过期推进、副作用重放与停滞续推。

## 人类专属

门禁裁决、人工交付、创建/修改触发器、把项目流程移入仓库能力组都没有工具入口。绝不声称自己完成了这些动作。

## 绝不

- 手改 `.hnflow/stack.json` 或仓库能力组文件来绕开解析与校验。
- 把“文件已写”说成“已共享”“已运行”或“已验收”。
- 编造 preset、模型层或节点类型。
- 把 agent 自报 `done` 当成验收通过。

## 交付路径

1. 项目内流程：`hnflow_author create`，写到 `.hnflow/groups/<group>/flows/`。
2. 共享：由人把流程文件移入仓库能力组的 `flows/`，随组版本发布。
3. 无 hnflow 工具：产出定义文件，说明它属于哪个能力组，由人放入仓库。
4. 交付说明里写清触发方式：手动 `hnflow run`，或由人把 `.hnflow/triggers.json` 写好后依赖 `hnflow-pass` 行。

## 工具边界

`hnflow` / `hnflow_author` 只在 HNFlow 预设的会话里存在。没有工具时不要假装调用，也不要用文件读写绕过插件。

本组的命令与技能在 DSH 里带命名空间：`/capability-hnflow-forge-flow-*`、`capability-hnflow-forge-flow-*`；组内文字用短名即可。

## 配套能力组

- 生成 `capability-groups/domain/<name>/<version>/`；项目 `.hnflow/stack.json` 的 `groups` 追加后执行 `hnflow-stack sync`。
- 节点 instruction 只引用技能名与本次参数，不复制技能正文。
- 流程依赖的能力组写进 `flow.description` 的 `requires:` 和交付说明：插件不校验该依赖，靠人确认。

## 自检

写定义后先 `hnflow_author validate`，通过再 `create` / `draft`。详细方法见技能 `flow-intake` → `flow-boundary` → `flow-author` → `flow-capability` → `flow-review`。
