---
name: flow-review
description: 当流程定义与配套能力组写完、需要独立自查或评审时使用：flow 侧 13 项、能力组侧 8 项、一致性 6 项清单，报告格式与人工回归步骤。
---

# 审查（Review）

先跑机器检查，再走清单。**阻塞项清零才交付。**

## 机器检查

```bash
# 权威：宿主侧校验（HNFlow 模式）
hnflow_author validate { definition }          # 或 validate { flow: "<名称>" }
# 离线预检（任意会话，退出码 0/1/2）
hnflow-stack tool run hnflow-forge -- lint <定义文件> --json
# 能力组侧
hnflow-stack resolve --json --project <项目>
# 自动化（HNFlow 模式；只读）
hnflow triggers                                # 触发器、lastFiredAt、解析错误
```

- `lint` 的错误码与插件同名，直接引用；`warnings` 里是离线拿不到的两件事：preset allowlist、本机模型层。
- 两边结论不一致时**以插件为准**；工具跑不起来（无 `uv`）就在报告里写“未经静态校验”。
- 工具首次运行会 `uv sync`（需要 `uv`，可能联网）。

## flow 侧（13 项）

1. `validate` 返回 `ok: true`，无错误码。
2. 恰一个起点、恰一个终点；多分支用 `merge` 收口。
3. 无环；驳回/重做走 `onReject` 或修订节点向前。
4. `gate` 有出边时三分支齐全。
5. 每个 `agent` 的 `output` 足够下游消费；该写 `accepts` 的边写了。
6. 下游 `required` 字段都有来源（上游产出或 `flow.input`）。
7. `judge` / `verify.judge` 的 preset 与祖先生产者不同。
8. `request` 有 `deliverable` 与站得住的 `whyHuman`。
9. `verify.checks` 声明 `judge` 时给了 `judge.preset` 与 `criteria`。
10. `budget` / `deadline` / `onExpire` 有合理值（不无限等，不无限重试）。
11. `instruction` 只写任务与契约，手法用技能名引用；模板变量指向真实字段。
12. 输入 schema 与真实调用方匹配（字段名、必填项）。
13. 节点类型都在宿主注册表内（内置六种 + 插件 `registerNodeKind` 的额外 kind）。

## 能力组侧（8 项）

1. `group.json` 的 `name` / `version` 与目录一致；guid 32 位小写十六进制且全仓唯一。
2. 每个规则/技能/Agent/命令都有规定 frontmatter，技能目录名 = `name`。
3. 组内没有 `tools/`、`pyproject.toml`、工具源码；引用的工具有对应工具包。
4. 常驻规则足够短（只放“违反即错”的约束），细节在技能里。
5. 技能自包含：不依赖别的技能也能执行，不写绝对路径。
6. Agent 没写 `model` / `temperature` / `permission`。
7. `hnflow-stack resolve --json --project <项目>` 无告警。
8. 项目 `.hnflow/stack.json` 已加入该组并 `sync`。

## 一致性（6 项）

1. 流程里引用的技能名在激活的能力组里真实存在。
2. 流程 `description` 的 `requires:` 与实际依赖一致。
3. 节点 `preset` 在宿主 allowlist 内；`model` 层在本机存在（不确定就不写）。
4. 边界没跑偏：流程里没有长篇“怎么做”，能力组里没有“什么时候跑”。
5. 人的介入点齐全：该由人给的输入是 `request`/`gate`，不是 agent 节点。
6. 若要求自动触发：`hnflow triggers` 无解析错误、`hnflow-pass` 行启用、`run-completed` 链深 ≤5，且触发器没有替代任何 `gate`/`request`。

## 报告格式

```text
结论：可交付 / 需修改
机器检查：validate ok? lint 摘要
阻塞项（必改）：[错误码] 位置 → 问题 → 修法
建议项：位置 → 建议
依赖前提：已满足 / 缺失（缺什么，怎么补）
```

## 人工回归

```text
1. hnflow_author create（项目本地组）
2. hnflow run { flow, input }  → 立即拿到 runId，不轮询
3. 页面或 /hnflow inbox 处理门禁 / 交付
4. hnflow status { run_id } / artifact { artifact_id } 核对产物与 usage；页面运行详情看 health 说明（等人 / 等模型 / 宿主不可用 / 超预算）
5. 共享：由人把流程文件移入仓库能力组的 `flows/`，随组版本提交
6. 自动触发：人写 `.hnflow/triggers.json` 后等一个 `passIntervalMs`，`hnflow triggers` 的 lastFiredAt 前进，run 的 `trigger.source` 与预期一致
```

## 常见失败归类

| 现象 | 多半是 |
| --- | --- |
| `contract-unsatisfiable` / `input-unbound` | 契约设计问题，不是笔误：回去补 `output` 或用 `merge` 组装 |
| `graph-shape-invalid` / `cycle-unsupported` | 编排形状问题：想画回边了，改 `onReject` 或加修订节点 |
| `gate-branches-incomplete` | 忘了 rejected 也得有去处（通常汇到终点 merge） |
| `preset-not-allowed` / `model-layer-unknown` | 猜了宿主配置；改回 allowlist / 已有层，或删掉 `model` |
| 运行卡在 `needs_human` | 缺口该由 `request` 表达，或节点没开 `allowHuman` |
| 质量差但校验通过 | 能力组缺失或 instruction 没引用技能 |
| 定时任务没跑 / 只跑一次 | 触发器写进了流程，或 `.hnflow/triggers.json` 有解析错误、`hnflow-pass` 行没启用 |
| run 到达 `run-budget-exceeded` | 墙钟预算不够或节点在等人；确认门禁/交付是否被忽略，再调 `runBudgetMs` |

绝不把“校验通过”当成“流程正确”，也不代替人裁决或移动流程。
