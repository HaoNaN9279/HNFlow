---
name: custom-rule
description: 当用户需要创建或管理 HNFlow 规则文件（rules）时使用
license: MIT
---

# Custom Rule — 规则制作指南

指导你创建和管理规则文件。规则为 AI 智能体提供常驻或按需加载的指令，全部通过独立 `.md` 文件定义。

---

## 1. 部署位置

### 确定添加内容的位置

- **"添加常驻内容"** 或类似描述 → `capability-groups/core/0.1.0/` 目录（全局常驻配置）
- **"为 xxx domain" / "xxx 领域" / "为 xxx 添加内容"** 或类似描述 → `capability-groups/domain/<group>/<version>/` 目录（领域专属配置）
- **"只为某些目录生效"** 或描述只对部分路径成立 → 领域组的 `rules/` 下写 `scope: paths` + `paths`
- **"为当前项目添加内容"** 或类似描述 → 在项目 `.hnflow/groups/<name>/` 新建项目能力组（无版本目录），并在 `.hnflow/stack.json` 的 `groups` 中激活
- **未明确指明位置** → **必须询问用户**具体的添加位置，绝对不允许擅自做决策

判定口诀：对全框架都成立 → core；只对某个领域成立 → 领域组 `rules/`；只对部分目录成立 → 同文件加 `scope: paths`。

HNFlow 不写入任何 Agent 的专有配置目录，也不复制或链接内容到这些目录。项目级内容只通过 `.hnflow/stack.json` 激活能力组生效。

### 1.1 核心规则（全局生效）

放置在 `capability-groups/core/0.1.0/rules/` 目录下。

```text
capability-groups/core/0.1.0/rules/
├── 00-global.md          # 适用于所有会话的全局规则
└── <category>-<name>.md  # 其他全局规则
```

### 1.2 领域规则（领域专属）

放置在 `capability-groups/domain/<group>/<version>/rules/` 目录下。目录按主题平铺，
按目录生效的规则用 `scope: paths` 表达，不建子目录树。

```text
capability-groups/domain/<group>/<version>/rules/
├── <domain>.md
└── <topic>.md            # 可用 scope: paths 限定生效目录
```

### 1.3 项目规则（项目专属）

在项目的 `.hnflow/groups/<name>/rules/` 定义，然后在项目根目录激活能力组：

```bash
hnflow-stack activate <group>
hnflow-stack sync
```

---

## 2. 规则文件格式规范

每个规则文件必须以 YAML frontmatter 开头。`name` 与 `description` 必填，其余可选：

```markdown
---
name: physics                              # 必填：规则标识，kebab-case
description: 战斗物理与碰撞约定              # 必填：一句话说明，索引行使用
scope: paths                               # 可选：global（默认）/ paths
paths: ["Assets/Battle/Physics/**"]        # 可选：项目相对 glob，scope=paths 时必填
on_demand: true                            # 可选：true 时只注入摘要行，正文按需读取
priority: 10                               # 可选：越大越靠后注入
overrides: ["conventions"]                 # 可选：压掉同组已收集的同名规则
---

# 规则标题

规则内容。
```

| 字段 | 默认 | 说明 |
|---|---|---|
| `name` | 必填 | 规则标识；同一组内唯一 |
| `description` | 必填 | 一句话说明；`on_demand: true` 时就是注入给 Agent 的摘要行 |
| `scope` | `global` | 只能取 `global` / `paths` |
| `paths` | 无 | 写了 `paths` 没写 `scope` 时自动视为 `paths`；`scope: paths` 却没写 `paths` 会告警并降级为 `global` |
| `on_demand` | `false` | `true` 时默认只注入摘要行（含文件路径），Agent 需要时读全文 |
| `priority` | `0` | 同组排序，越大越靠后 |
| `overrides` | 无 | 后加载规则压掉早期同名规则 |

格式要求：

- **文件名**：使用 `<name>.md`，数字前缀控制加载顺序（如 `00-global.md`）
- **frontmatter**：位于文件开头，必须包含 `name` 与 `description`
- **内容**：frontmatter 之后以 `# 规则标题` 开头，后续为具体规则内容
- **语言**：使用简体中文，专有名词保留原文
- **结构建议**：按主题分节，使用 `##` 二级标题

不要写 `model` 以外的宿主参数；provider、具体模型名、temperature、permission 都不属于规则。

---

## 3. 规则如何注入

适配器按能力组读取 `rules/` 目录：

1. 递归扫描组根的 `rules/**/*.md`，并吸收组根 `AGENTS.md`
2. 解析 frontmatter，缺少 `name` 的文件跳过；缺少 `description` 产生告警
3. 按 `scope` 过滤：`global` 恒生效；`paths` 只在会话工作目录命中时生效
4. 通过过滤的规则按 `priority`、路径排序；`global` 规则排在同组 `paths` 规则之前
5. `on_demand: true` 的规则只进摘要索引（`- <文件路径>: <description>`），不占正文预算
6. 其余规则注入正文；超出字节预算时截断并留下省略标记
7. 多个能力组的规则按加载顺序追加，不覆盖

因此：

- 规则文件必须位于能力组内，不要写入 Agent 的专有规则目录。
- 不需要通过 Agent 的规则引用机制手动挂载规则文件。
- 规则只增不减；同一主题的多条规则应放在同一文件，避免重复约束。
- 想按目录生效就用 `scope: paths`；`global` 规则会进入每个会话，控制篇幅。
- 正文长、只需少数任务查阅的规则（长清单、速查表、故障记录）用 `on_demand: true`，
  由 `description` 决定 Agent 何时去读；摘要行必须写清主题。
- 需要精确到某个文件时，用 `hnflow-stack rules show --for <path>` 查询，不要指望自动注入。

---

## 4. 规则内容写作指南

### 4.1 规则结构模板

```markdown
---
name: rule-category
description: 一句话说明这条规则管什么
---

# [规则类别]

简明描述这些规则的适用范围和目的。

## [具体主题 1]
- 规则点 1
- 规则点 2

## [具体主题 2]
- 规则点 1
- 规则点 2
```

### 4.2 写作原则

- **指令明确**：每条规则必须是可执行的指令，而非泛泛而谈
- **示例驱动**：复杂规则附带代码示例
- **负面清单**：明确禁止的行为用 "绝不" 强调
- **避免冗余**：不在多个规则文件中重复相同内容
- **版本相关**：涉及版本限制时标注版本号

### 4.3 规则类型建议

| 规则类型 | 放置位置 | 示例 |
|----------|----------|------|
| 全局行为规范 | `capability-groups/core/0.1.0/rules/00-global.md` | 沟通风格、安全策略 |
| 编码规范 | `capability-groups/core/0.1.0/rules/01-coding.md` | TypeScript 规范、命名约定 |
| 领域通用规则 | `capability-groups/domain/<group>/<version>/rules/<name>.md` | 框架级目录约定 |
| 目录限定规则 | 同组 `rules/<name>.md` + `scope: paths` | Unity 战斗物理规范 |
| 按需长文档 | 同组 `rules/<name>.md` + `on_demand: true` | 已知 bug 清单、API 速查 |
| 工作流规则 | `capability-groups/core/0.1.0/rules/02-workflow.md` | Git 流程、PR 规范 |

---

## 5. 添加新规则的完整流程

```text
1. 确定作用范围：core、领域组，还是项目能力组
2. 在对应 rules/ 下创建 <name>.md
3. 写 frontmatter：name + description 必填；按目录生效加 scope: paths + paths；长文档加 on_demand: true
4. 写正文；能上移到 core 的通用约束不要留在领域组
5. 若为项目能力组，执行 hnflow-stack activate <group>
6. 运行 hnflow-stack validate；必要时 hnflow-stack sync
7. hnflow-stack rules show --for <path> 确认作用域命中符合预期
```

---

## 6. AGENTS.md 与规则的关系

规则是 `AGENTS.md` 的上位替代，但 `AGENTS.md` 仍然可用：

| 文件 | 处理方式 |
|---|---|
| 能力组根 `AGENTS.md` | 吸收为组根规则，`kind: agents` |
| 项目根 `AGENTS.md` | 交给宿主，不重复吸收 |
| 项目子目录 `AGENTS.md` | 需 `stack.json` 写 `"agents_md": "nested"`，默认关闭 |

新写内容优先用规则：可以用 `scope`、`priority`、`overrides`、`on_demand` 精确控制。
已有项目的 `AGENTS.md` 不必迁移，除非需要作用域或覆盖能力。

---

## 7. 最佳实践

- **规则文件保持专注**：每个文件只关注一个主题领域
- **组根只放通用约束**：只对部分目录成立的内容用 `scope: paths` 收窄
- **大段参考材料不进常驻正文**：放 `references/` 或标 `on_demand: true`，规则里只写指针
- **摘要必须可判断**：`description` 写清"什么时候需要读这条规则"
- **定期审查**：移除过时规则，更新版本依赖
- **配合 skill 使用**：需要多步流程的操作指南封装为 skill，规则只做约束
