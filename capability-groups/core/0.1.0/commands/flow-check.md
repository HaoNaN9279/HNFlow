---
name: flow-check
description: 体检既有 HNFlow 流程及其配套能力组，跑离线 lint 与审查清单，输出问题清单
model: strong
---

# `/flow-check` — 流程体检

检查对象：$ARGUMENTS（流程名 / flowId / 定义文件路径；为空时先 `hnflow list_flows` 让用户选）

只读：不改定义、不移动流程、不裁决门禁。

## 1 取定义

| 场景 | 做法 |
| --- | --- |
| 有 hnflow 工具 | `hnflow describe_flow { flow }`，拿返回的 `definition` |
| 用户给了文件 | 直接读该 JSON（只读，不要写回仓库或项目配置） |
| 都没有 | `hnflow list_flows` 让用户选，不猜内容 |

## 2 跑离线预检

```bash
hnflow-stack tool run hnflow-forge -- lint <定义文件> --json
```

- 退出码 `0` = 通过，`1` = 有错误，`2` = 用法/IO 失败。
- `--json` 输出 `{ "file", "ok", "errors": [{ code, message, nodeId?, edgeId? }], "warnings": [...] }`；错误码与插件同名，**原样引用**，不要改写成自己的话。
- 从 `describe_flow` 拿到的是内联定义：先落到工作区临时文件再 lint（例如 `.hnflow-forge/check.flow.json`，用完删除），不要写进 `.hnflow/`。
- 首次运行会 `uv sync` 工具环境（需要 `uv`，可能联网）。
- 工具不可用（无 `uv`、无 `hnflow-stack`）时：跳过本步，在报告里明写“未经静态校验”，改用技能 `flow-review` 的清单人工过一遍。

同时按需跑一次宿主校验（权威）：

```text
hnflow_author validate { definition }
```

离线 lint 与插件校验不一致时，**以插件为准**（离线不知道 preset allowlist 与本机模型层）。

## 3 走审查清单

加载技能 `flow-review`：flow 侧 12 项、能力组侧 8 项、一致性 5 项。

## 4 依赖核对

- `hnflow-stack status` 看当前工作区激活组。
- 流程 `description` 里的 `requires:<group>` 是否都已激活；缺失标“运行前提不满足”。
- 节点 `preset` 是否在宿主 allowlist；`model` 层是否在本机存在（不确定就问用户，别猜）。

## 5 运行与自动化现状（可选，只读）

`hnflow list_runs` / `status { run_id }` / `inbox`：看 `health`（卡在等人、等模型、宿主不可用、超预算、停滞）、降级标记、过期待决项、token 用量异常。

`hnflow triggers`：触发器解析错误、`lastFiredAt` 是否前进、`run-completed` 链是否过深。触发器文件是 `<workspace>/.hnflow/triggers.json`，**只读不改**；要人自己改。

## 输出

```text
结论：通过 / 有阻塞项（N）
静态预检：lint ok=true|false（工具: 可用 / 不可用-未校验）；宿主 validate：通过 / 未跑
阻塞项（必改）：[错误码] 位置 → 问题 → 修法
建议项：位置 → 建议
依赖与前提：已满足 / 缺失（缺什么，怎么补）；自动化：手动 / 已配置（错误 N 条）
下一步：项目流程用 `hnflow_author draft`；仓库流程直接改仓库文件；改能力组后 `hnflow-stack sync`
```

绝不把“校验通过”当“流程正确”，也不代替人裁决或移动流程。
