---
name: custom-agent
description: 创建 HNFlow 智能体（Agent）的通用制作规范和完整指南
license: MIT
---

# Custom Agent — 智能体制作指南

指导你创建和管理 HNFlow 智能体（Agent）。能力组中的智能体定义与具体 Agent 工具解耦，由适配器转换后注入目标工具。

---

## 1. 智能体类型

HNFlow 区分两种智能体角色：

| 类型 | 说明 |
|------|------|
| **主代理 (Primary)** | 用户直接交互的主要助手 |
| **子代理 (Subagent)** | 由主代理或其他调用方触发的专业助手 |

具体切换与调用方式由 Agent 适配器决定。

---

## 2. 部署位置

### 确定添加内容的位置

- **"添加常驻内容"** 或类似描述 → `capability-groups/core/0.1.0/` 目录（全局常驻配置）
- **"为 xxx domain" / "xxx 领域" / "为 xxx 添加内容"** 或类似描述 → `capability-groups/domain/<group>/<version>/` 目录（领域专属配置）
- **"为当前项目添加内容"** 或类似描述 → 在项目 `.hnflow/groups/<name>/` 新建项目能力组（无版本目录），并在 `.hnflow/stack.json` 的 `groups` 中激活
- **未明确指明位置** → **必须询问用户**具体的添加位置，绝对不允许擅自做决策

HNFlow 不写入任何 Agent 的专有配置目录，也不复制或链接内容到这些目录。项目级内容只通过 `.hnflow/stack.json` 激活能力组生效。

### 2.1 核心智能体（全局可用）

放置在 `capability-groups/core/0.1.0/agents/` 目录下。

```text
capability-groups/core/0.1.0/agents/
└── <agent-name>.md      # 全局智能体定义
```

### 2.2 领域智能体（领域专属）

放置在 `capability-groups/domain/<group>/<version>/agents/` 目录下。

```text
capability-groups/domain/<group>/<version>/
agents/
├── <domain>.md                  # 主领域智能体
├── <domain>-assistant.md        # 辅助子代理
└── <domain>-specialist.md       # 专业技能代理
```

### 2.3 项目智能体（项目专属）

在 `capability-groups/domain/<group>/<version>/agents/` 中定义，然后在项目根目录激活该能力组：

```bash
hnflow-stack activate <group>
hnflow-stack sync
```

激活只修改 `.hnflow/stack.json`，不向项目写入 Agent 文件。

---

## 3. 智能体定义方式

每个 Agent Markdown 文件必须以 YAML frontmatter 开头，frontmatter **必须包含** `name`、`description`、`mode` 三个字段，缺一不可；`model` 可选。

```markdown
---
name: agent-name          # 必填：Agent 名称，建议与文件名一致
description: 简短描述智能体的功能和用途（必填）
mode: primary|subagent|all  # 必填：primary / subagent / all
model: standard            # 可选：平台模型层 id（fast / standard / strong / vision）
---

# 智能体名称 — 角色描述

你是 **AgentName**，...（具体系统提示词）
```

适配器注入规则：

- `name`、`description`、`mode` 映射为目标 Agent 的对应配置。
- `model` 是平台模型层 id；适配器把它解析为本机模型路由。省略时不主动切换会话模型。
- 正文作为系统提示词。
- 缺少必填字段或 `mode` 非法的 Agent 会被跳过并产生告警。
- 无法映射的字段不注入，不得写入能力组 Agent 定义。

---

## 4. 字段说明

| 字段 | 必填 | 说明 |
|------|------|------|
| `name` | 是 | Agent 名称，建议与文件名一致 |
| `description` | 是 | 智能体被选择调用的依据，必须准确反映能力 |
| `mode` | 是 | `primary` / `subagent` / `all` 之一 |
| `model` | 否 | 平台模型层 id：`fast` / `standard` / `strong` / `vision` |

`mode` 取值：

| 值 | 行为 |
|---|---|
| `primary` | 作为会话主智能体运行 |
| `subagent` | 仅作为子智能体被调用 |
| `all` | 两种场景均可运行 |

硬性约束：

- **只允许**写 `model: <layer id>`；**不得**写 provider、具体模型名、`temperature`、`permission`、`reasoningEffort`。
- `model` 可省略；省略表示继承会话当前模型路由，不主动切换。
- 模型层的项目默认路由在 `.hnflow/models.json`，本机可逐层覆盖；能力组只提供角色定义。

---

## 5. 智能体制作示例

### 5.1 核心智能体示例（`capability-groups/core/0.1.0/agents/hermes.md`）

```markdown
---
name: Hermes
description: 快速问答与轻量任务执行。文件查找、代码搜索、文档阅读、小型编辑任务。
mode: primary
model: fast
---

# Hermes — 迅捷信使

你是 **Hermes**，HNFlow 常驻智能体。以速度见长，快速回答问题或完成小型任务。

## 核心原则

1. **速度优先于深度** — 直接回答问题
2. **轻量任务** — 聚焦小型自包含任务
3. **一问一答** — 不超出所问范围
```

### 5.2 领域子代理示例（`capability-groups/domain/data-forge/1.0.0/agents/data-forge.md`）

```markdown
---
name: data-forge
description: Data Forge 领域智能体，专注于 AI 训练数据处理
mode: subagent
---

# Data Forge 智能体

## Spark 优化器

分析 Spark 作业并建议性能优化方案。
```

---

## 6. 创建智能体的标准流程

```text
1. 确定位置：core 能力组、领域能力组，或项目能力组
2. 在能力组的 agents/ 下创建 <agent-name>.md
3. 编写 YAML frontmatter，必须包含 name、description、mode
4. 编写系统提示词正文
5. 若为项目能力组，执行 hnflow-stack activate <group> 与 hnflow-stack sync
6. 重启 Agent，通过 @agent-name 调用测试
```

---

## 7. 智能体设计原则

- **单一职责**：每个智能体专注于一个特定领域或任务
- **明确边界**：在提示词中清晰定义 "做什么" 和 "不做什么"
- **描述精准**：`description` 字段是智能体被选择调用的依据
- **参考现有模式**：创建新智能体前，先阅读 `capability-groups/core/0.1.0/agents/hermes.md`
- **子代理隐藏原则**：仅供程序调用的内部子代理由调用方决定是否展示
- **工具无关**：只使用通用字段，不绑定具体 Agent 工具的专有配置
- **使用简体中文**：智能体的提示词和描述应使用简体中文

### 命名约定

- 文件名使用 kebab-case：`my-special-agent.md`
- `name` 是 Agent 标识，建议与文件名一致；确定后不要随意变更
