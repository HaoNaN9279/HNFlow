# N14-切片W 向量后端适配器（§24.2）—— 执行计划

> 来源：《HNFlow 开发方案.md》§24.2：本地知识检索（摄入/索引/检索/引用，本地向量后端，可插拔）。
> 状态：**已完成**（N14k 遗留的「向量后端适配器」）。

## 范围

- `workflow/embeddings.py`：`VectorKnowledgeStore`（同 `KnowledgeStore` 协议，余弦排序）。
- 注入式 embedder：`Embedder` 协议 + callable / LangChain 适配器。
- 纯函数：`normalize_vector` / `cosine_similarity`。

## 取舍

- **不引新依赖、不内置供应商**：embedder 由部署方注入（`deerflow.models` 侧无 embedding 客户端）。
- **fail-loud**：embedder 坏答案 / 维度不一致一律 `EmbeddingError`（静默空结果会掩盖检索 bug）。
- 幂等 upsert（按 chunk id 替换）、已带 embedding 不重复嵌入、不改调用方对象。
- 排序约定与关键词路径一致（`(-score, citation)`、非正分丢弃、reranker 异常降级）。
- 无迁移/无新表/无新配置段/无新依赖；前端零改动。

## 验收

- 38 条新测试全过；全量 A/B 无新增失败；ruff 干净。
