# N14-切片S 模板端点（§24.6b）—— 执行计划

> 来源：《HNFlow 开发方案.md》§24.6b：拓扑模板（画布可插入）。
> 状态：**已完成**（后端 API）。

## 范围

- `patterns.py`：`build_template(name)`（占位 instruction 的可编译骨架）+ `template_catalog()`。
- Gateway：`GET /api/workflows/templates`（声明在 `/workflows/{definition_id}` 之前）。

## 取舍

- 后端模板目录 API；前端「插入模板」按钮 = 后续增量。
- 无迁移/无新表/无新配置段/无新依赖；前端零改动。

## 验收

- 端点返回两模板且定义可反序列化；literal 路径不被动态段吞。
- 全量后端 A/B 无新增失败；ruff 干净。
