# N14-切片V 前端画布「插入模板」（§24.6b）—— 执行计划

> 来源：《HNFlow 开发方案.md》§24.6b：拓扑模板（画布可插入）。
> 状态：**已完成**（前端插入一侧；后端端点为 N14s）。

## 范围

- `core/workflows/api.ts`：`fetchWorkflowTemplates()`（解析后端序列化 definition）。
- `core/workflows/canvas/templates.ts`（**纯变换**）：id 去重重映射 + 边重映射 + 位置偏移。
- `workflow-toolbar.tsx`：「模板」按钮 + 下拉列表（按需拉取，插入后标脏）。
- i18n（en-US/zh-CN/types）+ 工具栏 DOM 测试的文案 mock。

## 取舍

- 纯函数插入（确定性，无随机/时间）：同画布 + 同模板恒等。
- 空画布原样插入（保留可读 id）；有冲突才加 `-2/-3` 后缀。
- 位置：显式 position > 现有内容右侧（`maxX + 320`，与最上节点对齐）> 原点。
- 模板列表按需拉取（`enabled: templatesOpen`），不打开不发请求。
- 前端零后端改动；无新依赖。

## 验收

- 15 条新单测全过；`pnpm test` 1180 passed；`pnpm check` 与 `pnpm format` 全绿。
