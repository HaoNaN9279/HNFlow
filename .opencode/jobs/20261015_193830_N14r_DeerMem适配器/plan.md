# N14-切片R DeerMem memory_store 适配器（§24.1）—— 执行计划

> 来源：《HNFlow 开发方案.md》§24.1：记忆读写接口 `MemoryStore`；生产经 DeerMem。
> 状态：**已完成**（适配器类）。

## 范围

- `workflow/memory_backends.py::MemoryManagerStore`：`MemoryStore` 协议实现——`search` 映射 manager facts（仅 `long_term`、仅 `supports_search`），`put` 经 `add_nowait` 排队。

## 取舍

- DeerMem 是长期记忆 → **仅服务 long_term**；session/node/workflow 返回空（需要者自行实现协议）。
- 部署方注入 `runtime.context["memory_store"]`；worker 自动注入为可选后续。
- 无迁移/无新表/无新配置段/无新依赖；前端零改动。

## 验收

- 适配器映射/透传/no-op/降级正确。
- 全量后端 A/B 无实质新增失败；ruff 干净。
