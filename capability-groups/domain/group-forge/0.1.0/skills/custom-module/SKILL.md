---
name: custom-module
description: 当用户需要在能力组内创建、拆分、启用或停用模块（modules）时使用
license: MIT
---

# Custom Module — 模块制作指南

模块是能力组内的可选层，用来放「只对某个子系统成立」的内容。

## 1. 什么时候建模块

| 需求 | 结论 |
|---|---|
| 内容对全框架都成立 | 放组根，不建模块 |
| 只对某个子系统成立（战斗、UI、资源） | 建模块 |
| 规则要按目录自动生效 | 建模块并写 `paths` |
| 子系统可选安装 | 建模块并在 `stack.json` 选择 |
| 想复用另一组的内容 | 用组的 `extends`，不要建跨组模块 |

## 2. 目录

```text
capability-groups/domain/<group>/<version>/
├── group.json
├── rules/                      # 组根：全局默认
└── modules/
    └── battle/
        ├── module.json         # 可选
        ├── rules/
        ├── agents/
        ├── commands/
        ├── skills/
        └── references/
```

- 目录路径即模块 id，只能用 `[a-z0-9-]`，层级 `/`，深度 ≤3。
- 没有 `module.json` 的目录同样是模块。
- 模块内可再嵌套模块，`battle/ai` 是独立模块，不是 `battle` 的子内容。
- 不建版本目录、不写 `guid`：模块随组版本发布。

## 3. module.json

```json
{
  "title": "战斗",
  "description": "战斗子系统约定",
  "alias": "battle",
  "paths": ["Assets/Battle/**"],
  "default": true,
  "depends": ["ui"],
  "tools": ["tool:<guid>@v1.0.0"]
}
```

| 字段 | 必填 | 说明 |
|---|---|---|
| `name` | 否 | 若写必须等于目录末段 |
| `title` / `description` | 否 | 展示用 |
| `alias` | 否 | 宿主命名段，默认路径各段用 `-` 连接；同组唯一 |
| `paths` | 否 | 模块默认规则作用域 |
| `default` | 否 | 未配置默认集时是否默认激活 |
| `depends` | 否 | 同组模块路径，自动补全并拓扑排序 |
| `tools` | 否 | 模块级工具引用，合并进组工具集 |

禁止写 `version`、`guid`、`permissions`、`model`。

## 4. 组与项目的配置

`group.json` 可给默认值：

```json
{ "modules_dir": "modules", "default_modules": ["battle"] }
```

`.hnflow/stack.json` 选择：

```json
{ "name": "unity-framework", "version": "1.0.0", "modules": "*" }
```

- 省略 `modules`：组根 + `default_modules`。
- `"*"`：全部。
- 数组：按路径前缀包含（`"battle"` 含 `battle/ai`）。
- `exclude`：扣除；被 `depends` 需要的仍会补上。
- `disable`：规则限定 id 或裸名，命中即不注入。

## 5. 命名

| 对象 | 规则 |
|---|---|
| 限定 id | `<group>/<alias>/<name>` |
| 命令/技能宿主名 | `capability-<group>-<alias>-<name>` |
| Agent / 命令计划键 | `<alias>/<name>` |

名称超过 48 字符会截断加哈希；路径深时设短 `alias`（如 `battle-ai`）。
限定 id 完全相同才算重复：`resolve` 告警、`sync` / `validate` 报错。

## 6. 规则与作用域

模块规则的默认作用域：有 `paths` 用 `paths`，否则 `module`。
按目录生效建议：

```markdown
---
name: physics
scope: paths
paths: ["Assets/Battle/Physics/**"]
---
```

组根规则先注入，模块规则后注入；`overrides` 可压掉同名组根规则。
模块内 `AGENTS.md` 自动吸收为本模块规则。

## 7. 创建流程

```text
1. 判断内容是否只属于某个子系统；否 → 放组根
2. 创建 modules/<path>/ 与需要的 rules/agents/commands/skills
3. 需要按目录生效或展示信息时写 module.json（paths、alias）
4. 在 stack.json 的 groups[] 里选 modules，或用 group.json 的 default_modules
5. 运行 hnflow-stack validate
6. hnflow-stack list --tree / info <group> --modules 确认激活
7. hnflow-stack rules show --for <path> 确认规则命中
8. 需要快照时 hnflow-stack sync
```

## 8. 常见错误

| 现象 | 原因 |
|---|---|
| 模块内容没出现 | 未激活：`modules` 未列、被 `exclude`、组未在 stack 中 |
| `unsupported stack schema_version` | stack 必须为 `schema_version: 2` |
| `module path ...` 报错 | 路径含大写/下划线或深度 >3 |
| alias 冲突 | 同组两个模块 alias 相同，显式写 `alias` |
| depends 报错 | 指向不存在的模块或成环 |
| 规则没按目录生效 | 只写了 `paths` 没写 `scope` 也会生效，但 cwd 必须命中；用 `rules show --for` 核对 |
