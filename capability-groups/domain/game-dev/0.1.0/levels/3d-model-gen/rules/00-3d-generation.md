---
name: 3d-generation
description: 3D 模型生成层规则：免费优先、限流与幂等、结果校验、元数据与图像依赖。
priority: 10
---

# 3D 模型生成规则

本层只使用 three.ws 的**免费** 3D 生成 MCP 与免费 REST 检查端点；不调用任何需要付款、余额或订阅的接口。

## 免费优先

默认可用：

- 免费 3D Studio MCP：`https://three.ws/api/mcp-studio`，无账号/密钥，16 个工具全部免费，其中生成工具为 `forge_free`、`text_to_avatar`、`mesh_forge`、`rig_mesh`、`forge_avatar`、`refine_model`。
- 免费 REST：`POST https://three.ws/api/v1/ai/text-to-3d`（每 IP 10 次/天）与 `POST https://three.ws/api/3d/studio`；`/api/3d/inspect`、`/api/3d/diff`、`/api/render/glb`、print quote/prepare 也免费。
- 免费 catalog：现成 CC0 道具、绑定角色、动作片段；能直接用时优先用 catalog，不要重复生成。

## 限流与幂等

- MCP studio 限 4 次生成/分钟、30 次/小时/caller；不要并行轰炸，按 `Retry-After` 退避。
- 每个逻辑资产生成一个 `idempotency_key`（≤200 字符，24 小时内复用）；超时重试用同一个 key，改需求才换新 key。
- 返回 `status:"pending"` 时用 `check_job` 轮询，按 `etaRemainingSeconds` 等待，不重复发起新任务。

## 结果校验

- 下载 `glbUrl` 到本地，检查文件头为 `glTF`、大小合理、可被 glTF 解析器打开。
- 使用 `look_at_model` 或 `/api/render/glb` 生成预览图，确认主体、比例、材质和朝向。
- 只有下载并校验成功后才能说“已生成”；pending/failed 不得当作完成。
- 保存元数据：工具名、prompt、tier、jobId、idempotency_key、source URL、referenceImageUrl、生成时间、文件 sha256、预览图路径。

## 图像依赖

- 需要独立概念图、角色设定图或参考图时，使用本层通过 `extends` 依赖的 `image-gen` 组技能；其文生图走免费 Pollinations 端点。
- 免费 3D 结果自带的 `referenceImageUrl` 是管线内部“提示词→参考图”的产物，可用于追溯和简报，但**不能**当作通用文生图服务；需要独立图片时走 `image-gen`。
