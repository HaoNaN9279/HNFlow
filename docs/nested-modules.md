# 嵌套模块

能力组支持可选的模块层，用于「一个框架多个子系统」的场景：框架级约定放组根，每个子系统
（战斗、UI、资源管线）各自拥有 rules / agents / commands / skills。

## 什么时候用

- 内容只对一个子系统有意义 → 放模块。
- 内容对所有子系统都成立 → 放组根。
- 需要按目录自动切换规则 → 模块 + `paths`。
- 需要可选安装某个子系统 → 模块 + `stack.json` 选择。

不要为了分层而分层：一个只有 2 个文件的组，平铺在组根更省事。模块是解决「命名冲突 +
选择性激活 + 规则作用域」的手段，不是目录洁癖。

## 目录

```text
capability-groups/domain/unity-framework/1.0.0/
├── group.json
├── AGENTS.md                 # 可选，吸收为组根规则
├── rules/
│   └── conventions.md        # 组根规则：全局默认
├── agents/
├── commands/
├── skills/
└── modules/
    ├── battle/
    │   ├── module.json
    │   ├── AGENTS.md         # 可选，吸收为本模块规则
    │   ├── rules/physics.md
    │   ├── agents/battle-dev.md
    │   ├── commands/battle-build.md
    │   └── skills/battle-tips/SKILL.md
    ├── battle/ai/            # 嵌套模块
    │   └── rules/targeting.md
    └── ui/                   # 无 module.json 也是模块
        └── rules/ugui.md
```

模块路径只能用小写字母、数字和 `-`，层级用 `/`，深度 ≤3。目录路径即模块 id。

## module.json

全部字段可选：

```json
{
  "title": "战斗",
  "description": "战斗子系统约定",
  "alias": "battle",
  "paths": ["Assets/Battle/**", "Assets/Scripts/Battle/**"],
  "default": true,
  "depends": ["ui"],
  "tools": ["tool:<guid>@v1.0.0"]
}
```

| 字段 | 说明 |
|---|---|
| `title` / `description` | 展示用 |
| `alias` | 宿主命名段，默认目录各段用 `-` 连接；同组唯一 |
| `paths` | 模块默认规则作用域 |
| `default` | 未配置默认集时是否默认激活 |
| `depends` | 同组模块路径，自动补全并拓扑排序，无环 |
| `tools` | 模块级工具，合并进组工具集 |

不要写 `name`、`version`、`guid`、`permissions`、`model`：模块不单独版本化，也不跨组。
`name` 若写必须等于目录末段。

## 激活

`group.json` 可以给默认值：

```json
{ "modules_dir": "modules", "default_modules": ["battle"] }
```

项目侧 `stack.json`：

```json
{
  "schema_version": 2,
  "core": { "name": "core", "version": "0.1.0" },
  "groups": [
    { "name": "unity-framework", "version": "1.0.0", "modules": "*" },
    { "name": "hnflow-forge", "version": "0.1.0", "exclude": ["legacy"] }
  ]
}
```

- 省略 `modules`：组根 + `default_modules`。
- `"*"`：全部。
- 数组：按路径前缀包含，`"battle"` 包含 `battle/ai`。
- `exclude`：扣除；被 `depends` 需要的模块仍会补上。

组根内容始终加载，模块只在其被激活时加载。

## 命名

限定 id 是稳定标识，写进 `disable` 和文档：

```text
组根  unity-framework/conventions
模块  unity-framework/battle/physics
```

DSH 宿主名：

```text
组根  HNFlow-unity-framework-conventions
模块  HNFlow-unity-framework-battle-battle-build
```

`plan.names` 给出完整映射，插件不自行拼接。名称超过 48 字符会截断加 6 位哈希；此时
建议在 `module.json` 写短 `alias`。

Agent 与命令在计划里的键：组根用裸名，模块用 `<alias>/<name>`，因此模块内同名 Agent 不会
互相覆盖。

## 规则作用域

规则 frontmatter 全部可选，只有 `name` 必填：

```markdown
---
name: physics
description: 战斗物理与碰撞约定
scope: paths
paths: ["Assets/Battle/Physics/**"]
always: true
priority: 10
overrides: ["conventions"]
---

正文...
```

| 字段 | 默认 | 说明 |
|---|---|---|
| `scope` | 组根 `global`；模块有 `paths` 则 `paths`，否则 `module` | `global` / `module` / `paths` |
| `paths` | 无 | 项目相对 glob，支持 `**` |
| `always` | `true` | `false` 时只进索引，不注入正文 |
| `priority` | `0` | 越大越靠后注入 |
| `overrides` | 无 | 压掉同组已收集的同名规则 |

注入判定以会话工作目录为准（宿主在 pre-step 只提供 cwd）：`global` 恒注入；
`module` / `paths` 只在 cwd 命中时注入；未命中且 `always: false` 的规则只出现在索引里。

需要精确到「当前编辑的文件」时，用 `rules show --for <path>` 查询，不依赖自动注入。

排序：组根规则 → 模块规则（父模块先于子模块）→ 吸收的 `AGENTS.md`；同层按 `priority`。

## AGENTS.md

- 能力组根 `AGENTS.md` → 组根规则，`kind: agents`。
- 模块内 `AGENTS.md` → 该模块规则。
- 项目根 `AGENTS.md` 由宿主负责，不重复吸收。
- 项目子目录 `AGENTS.md` 需要 `stack.json` 写 `"agents_md": "nested"`，默认关闭。
  吸收后作用域为 `paths: ["<dir>/**"]`，最多 4 层、64 个文件。

规则是 `AGENTS.md` 的上位替代：作用域、优先级、覆盖、索引能力都在规则层，但
`AGENTS.md` 仍然可用，适合已经存在的项目约定。

## Unity 实战骨架

```text
capability-groups/domain/unity-framework/1.0.0/
├── group.json                  # guid、version、tools
├── rules/
│   ├── 00-conventions.md       # 命名、目录、asmdef、序列化约定
│   └── 01-build.md             # 构建与打包
├── agents/
│   └── unity-architect.md      # 框架级 Agent
├── commands/
│   └── unity-verify.md
└── modules/
    ├── battle/                 # 战斗
    ├── ui/                     # UI / UGUI
    ├── resource/               # Addressables / 资源管线
    └── editor/                 # 编辑器扩展
```

建议：

- 组根只放跨模块成立的约定，避免每个模块重复。
- 每个模块的 `paths` 指向该子系统的代码与资源目录，规则才能自动生效。
- 模块 Agent 用 `subagent`，由组根主 Agent 调度，避免人设膨胀。
- 模块技能名保持子系统前缀（`battle-tips`），便于阅读宿主名。

## 手工维护流程

```bash
# 看有哪些模块
hnflow-stack list --tree
hnflow-stack info unity-framework --modules

# 启用 / 停用
hnflow-stack module enable unity-framework:battle
hnflow-stack module disable unity-framework:ui

# 某路径会注入哪些规则
hnflow-stack rules show --for Assets/Battle/Enemy.cs
hnflow-stack rules list --json

# 校验与快照
hnflow-stack validate
hnflow-stack sync
```

所有内容都是纯文本，直接编辑目录即可；解析器不做生成式索引，版本管理就是普通的 git 流程。

## 常见问题

**模块要不要单独升版本？** 不要。模块随组版本发布，`guid` 属于组。

**两个模块需要共享规则怎么办？** 放组根，或用模块 `depends` + 组根规则。

**跨组复用模块？** 不支持。用组的 `extends` 复用整组。

**模块内容会不会和别组同名冲突？** 限定 id 含组名与 alias；宿主名冲突由 resolver 统一检测，
`sync` 会报错而不是静默丢弃。

**旧组需要改造吗？** 不需要。没有 `modules/` 的组行为不变，组根内容就是全局默认。
