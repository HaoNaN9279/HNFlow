# N14-切片M 注入防御（§24.12 / N15）—— 执行计划

> 来源：《HNFlow 开发方案.md》§24.12：Agent 专属威胁（间接提示注入/工具投毒/越权/记忆投毒）；本地单机重点收缩为「不可逆本地操作确认边界 + 注入与记忆投毒防御」。
> 状态：**已完成**（注入块中和部分）。

## 现状（§24.12 各子项落点）

- 不可逆操作确认边界：N10 预览/审批/undo + 沙箱（已落地）。
- 请求级密钥隔离：`required-secrets` + `runtime.secret_context`（已落地）。
- 工具结果注入中和：`ToolResultSanitizationMiddleware`（已落地）。
- 记忆投毒：提取 scope/durability/authority 门（已落地）。
- **新暴露面**：AI 节点**自行拉入提示词**的内容——§24.2 检索块、§24.1 记忆块——未经框架标签中和，可伪造 `<system-reminder>` 等权威块。

## 范围

- `workflow/sanitize.py`（纯助手）：`neutralize_untrusted(text)` 复用输入净化中间件的 `neutralize_untrusted_tags`（单一 denylist 来源，延迟导入）。
- `knowledge.format_retrieval_block` / `memory.format_memory_block` 的**正文**经此中和（外围块仍为引擎生成）。

## 取舍

- 复用既有净化器，不新造 denylist（避免漂移）。
- 失败降级原文：**纵深防御，非硬边界**。
- 完整威胁模型 / 工具级权限裁决深化 = 后续（P3）。
- 无迁移/无新表/无新配置段/无新依赖；前端零改动。

## 验收

- 检索/记忆块内伪造框架标签被中和，正常内容不变。
- 全量离线 A/B 无实质新增失败；ruff 干净。
