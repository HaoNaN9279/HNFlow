---
name: conventions
description: 框架代码约定：命名空间分层、命名、注释、测试命名、提交前缀，以及与 unity 通用规范的分工。
priority: 20
---

# 框架代码约定

Unity 通用编码规范由上层 `unity` 规则给出（缩进、成员顺序、生命周期写法等）。本文件只写框架特有的分层与命名，冲突时以本文件为准。

## 命名空间

| 位置 | 命名空间 |
|---|---|
| 纯逻辑、接口、数据模型 | `HN.Framework.Core.<层>.<模块>` |
| Unity 运行时实现 | `HN.Framework.Unity.<层>.<模块>` |
| 编辑器工具 | `HN.Framework.Editor.<模块>` |

项目代码使用自己的根命名空间（如 `Game.<模块>`），不往 `HN.Framework.*` 下塞。

## 命名

- 类型、方法、公共属性：`PascalCase`；接口 `I` 前缀；特性 `Attribute` 后缀。
- 私有字段 `camelCase`，不加 `m_`/`_` 前缀（框架内部历史写法混用，新代码统一不加）。
- 常量 `UPPER_SNAKE_CASE`。
- 一文件一主类型，文件名与类型名一致。
- 事件名用过去式（`EntitySpawnedEvent`），委托用 `On` 前缀。

## 注释

- 公共 API 必须有 XML 注释：`<summary>`、`<param>`、`<returns>`、`<typeparam>`；复杂行为补 `<remarks>`。
- 泛型约束显式写出，不用 `where T : class` 兜底。
- 公共 API 面向接口暴露：方法参数与返回值优先用接口类型，回调优先用委托而不是具体容器。
- 说明"为什么"的注释留在代码里；"怎么做"的说明写进 references，不塞进代码块注释。

## 测试

- 框架自带测试均为 EditMode（`Tests/` 下），新增测试放项目自己的测试程序集。
- 用例命名 `方法_场景_预期`，例如 `AddState_同名注册_抛异常`。
- 只跑与改动相关的测试；用户未要求时不跑全量。

## 提交

用户未明确要求时**不提交**。需要提交时用前缀：`feat:`、`fix:`、`docs:`、`refactor:`、`chore:`。

## 与框架示例代码的差异

框架文档里的示例可能滞后于源码（例如仍写静态 `ObjectPoolManager.Initialize()`，实际已改为 `world.PoolManager` 实例）。以源码为准；发现文档与代码不一致时按代码写，并在交付说明里记一条。
