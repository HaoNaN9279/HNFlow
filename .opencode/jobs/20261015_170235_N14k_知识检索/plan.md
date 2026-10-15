# N14-切片K 知识检索（§24.2）—— 执行计划

> 来源：《HNFlow 开发方案.md》§24.2（line 629-647）：检索散落于 skill/tool，无一等能力；须契约化（摄入→索引→检索→引用）。
> 目标仓库：`D:\workspace\work\HNFlow_deerflow-rebase`；分支 `deerflow-rebase`。
> 状态：**已完成**。

## 范围（Option A：纯检索核心 + AI 节点注入）

- `workflow/knowledge.py`（纯逻辑 + 参考 store）：
  - `chunk_text`（确定性重叠分块）、`tokenize`（ASCII + CJK 逐字）、`_score`（BM25-lite 覆盖度+频率）
  - `rank_chunks`（确定性排序 `(-score, citation)`，top_k，可选 `reranker` 注入）
  - `Document`/`Chunk`/`RetrievalRecord`（带稳定 `cite:<chunk_id>` 引用标识）
  - `KnowledgeStore` 协议（`upsert`/`query`，支持异步）+ `InMemoryKnowledgeStore` 参考实现 + `ingest_document`
  - `parse_retrieval_params`（`params.retrieval = {collection, query?, top_k?, ctx_budget?, rerank?}`）
  - `format_retrieval_block`（`<context>` 块，带 `--- cite ... ---` 头，按 `estimate_tokens` 预算）
  - `aquery`（异步 store）
- `executors/ai.py`：`params.retrieval` → 从 `runtime.context["knowledge_store"]` 检索并前置 `<context>` 块；失败仅告警；与 continue 互斥。

## 取舍

- 复用已 sanitize 的 `<context>` 标签（不引入新框架标签，无需改 denylist）。
- 默认关键词排序（离线、无依赖）；embedding/向量后端为**可插拔 store**；rerank 为可注入 callable。
- **专用 `data:knowledge` 节点 + 前端 palette** 列为后续增量（避免 schema/前端计数改动；核心能力已可由 AI 节点消费）。
- 无迁移/无新表/无新配置段/无新依赖；前端零改动。

## 验收

- 检索带引用、受预算约束、确定性排序；AI 节点可消费。
- 全量离线 A/B 失败集无新增；ruff 干净。
