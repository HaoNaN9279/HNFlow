---
name: flow-new
description: 端到端制作 HNFlow 工作流与配套 HNFlow 能力组
model: strong
---

# `/flow-new` — 制作工作流 + 能力组

用户需求：$ARGUMENTS

## 步骤

1. **采集**（技能 `flow-intake`）：补齐关键信息，最多 3 轮；其余标“假设”。
2. **拆分**（技能 `flow-boundary`）：先给出边界表，明确哪些进流程、哪些进能力组、哪些留项目文件。
3. **写定义**（技能 `flow-author`）：
   - 从三套骨架里选一套（线性+门禁收尾 / gate 三分支汇合 / request+verify+judge）。
   - 每个节点写清 `instruction`、`input`、`output`；边写 `when`，必要时写 `accepts`、`onFail`。
   - `preset` 只用 allowlist 内的值；`model` 只用已有层 id，不确定就不写。
4. **校验**：先 `hnflow-stack tool run hnflow-forge -- lint <file> --json`（离线、退出码 0/1），再 `hnflow_author validate`（宿主权威）。错误按错误码逐条修，直到两边都 `ok`。
5. **落库**：
   - 默认 `hnflow_author create`，写入 `.hnflow/groups/<group>/flows/`。
   - 需要共享时，由人把文件移入仓库能力组的 `flows/` 并随组版本发布。
   - 会话里没有 `hnflow_author`：把定义写到项目文件，说明它属于哪个组，由人放入仓库。
6. **配套能力组**（技能 `flow-capability`）：生成 `capability-groups/domain/<name>/<version>/`，并把组名加入项目 `.hnflow/stack.json` 的 `groups`，执行 `hnflow-stack sync`。
7. **自查**（技能 `flow-review`）：按清单走一遍，阻塞项清零再交付。

## 交付报告

```text
流程：<名称>（flowId / 组 / 模块）
节点图：node1 → node2 → …
门禁/交付：每个点一句话“为什么必须由人”
触发方式：手动 `hnflow run`｜定时/文件/流程完成（人写 `.hnflow/triggers.json`，需 `hnflow-pass` 行）
能力组：文件清单 + 激活步骤
校验：validate 结果摘要
下一步（人的动作）：运行 / 裁决 / 共享到仓库组 / 写触发器
遗留假设与风险
```

绝不：手改 `.hnflow/stack.json`、伪造校验通过、声称已共享或已运行、编造 preset 或模型层、声称已创建触发器。
