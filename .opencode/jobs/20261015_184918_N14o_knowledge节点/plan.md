# N14-切片O `data:knowledge` 节点 + 前端 palette（§24.2）—— 执行计划

> 来源：《HNFlow 开发方案.md》§24.2：检索作为一等节点类型（`data:retrieve`/`data:knowledge`）：输入 query/集合，输出 records（含来源、分数、片段）。
> 状态：**已完成**。

## 范围

- 后端：`NodeType.DATA_KNOWLEDGE`；`workflow/executors/knowledge.py::exec_knowledge`（`operation=retrieve|ingest`，从 `runtime.context["knowledge_store"]` 读写；retrieve 输出 `records`（带 `cite:` 引用）+ `out`；ingest 分块 upsert 输出块数）；注册（idempotent）。
- 前端：`types.ts` NODE_TYPES + `node-catalog.ts` Knowledge 条目。
- 测试：后端新增 10 条 + 计数更新；前端 node-catalog/types 计数更新。

## 取舍

- 无 store 时 **fail-loud**（显式知识工作节点不得静默空转）。
- 复用 N14k 的 `knowledge.py` 纯核心（分块/排序/引用/预算）+ `InMemoryKnowledgeStore`；向量后端为可插拔 store（后续）。
- 无迁移/无新表/无新配置段/无新依赖。

## 验收

- 节点 retrieve/ingest 正确；非法参数与无 store fail-loud。
- 全量后端 A/B 失败集无新增；前端 pnpm test + check 全绿；ruff 干净。
