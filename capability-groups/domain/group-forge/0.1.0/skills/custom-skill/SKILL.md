---
name: custom-skill
description: 当用户需要创建或管理 HNFlow 技能（Skill）时使用
license: MIT
---

# Custom Skill — 技能制作指南

指导你在 HNFlow 项目中创建和管理通用技能（Skill）。技能通过 `SKILL.md` 定义可复用的行为指令，支持技能机制的 Agent 可让智能体按需加载。

---

## 1. 技能概述

技能是封装在 `SKILL.md` 中的可复用指令集。与规则（自动加载）不同，技能**按需加载**：智能体查看可用技能列表，识别匹配的技能，并在需要时加载完整内容。具体加载机制由适配器决定。

---

## 2. 部署位置

### 确定添加内容的位置

- **"添加常驻内容"** 或类似描述 → `capability-groups/core/0.1.0/` 目录（全局常驻配置）
- **"为 xxx domain" / "xxx 领域" / "为 xxx 添加内容"** 或类似描述 → `capability-groups/domain/<group>/<version>/` 目录（领域专属配置）
- **"为当前项目添加内容"** 或类似描述 → 在项目 `.hnflow/groups/<name>/` 新建项目能力组（无版本目录），并在 `.hnflow/stack.json` 的 `groups` 中激活
- **未明确指明位置** → **必须询问用户**具体的添加位置，绝对不允许擅自做决策

HNFlow 不写入任何 Agent 的专有配置目录，也不复制或链接内容到这些目录。项目级内容只通过 `.hnflow/stack.json` 激活能力组生效。

### 2.1 核心技能（全局可用）

放置在 `capability-groups/core/0.1.0/skills/` 目录下。

```text
capability-groups/core/0.1.0/skills/
└── <skill-name>/
    └── SKILL.md
```

### 2.2 领域技能（领域专属）

放置在 `capability-groups/domain/<group>/<version>/skills/` 目录下。

```text
capability-groups/domain/<group>/<version>/
skills/
└── <skill-name>/
    └── SKILL.md
```

### 2.3 项目技能（项目专属）

在 `capability-groups/domain/<group>/<version>/skills/` 中定义，然后在项目根目录激活能力组：

```bash
hnflow-stack activate <group>
hnflow-stack sync
```

适配器校验能力组内的技能目录，把格式有效的技能目录加入搜索路径；技能目录保持原位置，不复制到项目。

---

## 3. SKILL.md 文件格式规范

### 3.1 目录结构

每个技能需要一个独立的目录，目录名即为技能名，目录内包含 `SKILL.md` 文件：

```text
<skill-name>/
├── SKILL.md
├── references/      # 可选：补充文档
├── scripts/         # 可选：辅助脚本
└── assets/          # 可选：模板、图片、数据
```

`references/`、`scripts/` 和 `assets/` 随技能目录一起被发现，不会单独注册。

### 3.2 Frontmatter（必需）

每个 `SKILL.md` 必须以 YAML frontmatter 开头：

```yaml
---
name: skill-name           # 必填：技能名称，符合命名规范
description: 技能描述      # 必填：长度 1-1024 字符
model: standard            # 可选：平台模型层 id（fast / standard / strong / vision）
license: MIT               # 可选：许可证名称或许可证文件
compatibility: 需要 Python 3.11+ 和 uv  # 可选：环境要求，1-500 字符
allowed-tools: Bash(git:*) Read         # 可选，实验性：预批准的工具列表
---
```

### 3.3 命名规范

`name` 必须满足以下条件：

- 长度为 1-64 个字符
- 仅包含小写字母和数字，可用单个连字符分隔
- 不以 `-` 开头或结尾
- 不包含连续的 `--`
- 与包含 `SKILL.md` 的目录名称一致

等效正则表达式：`^[a-z0-9]+(-[a-z0-9]+)*$`

### 3.4 描述规范

`description` 必须为 1-1024 个字符。描述句式应为“当用户需要...时使用”，不要只描述是什么。

好的描述示例：

```text
当用户需要执行 ComfyUI 任务、图片缩放、图片格式转换时使用
```

差的描述示例：

```text
A skill for releases
数据处理相关工具
```

---

## 4. 技能内容编写指南

### 4.1 内容结构模板

```markdown
# 技能标题 — 简短说明

技能的核心用途和适用场景的概述。

## 模板

（可选）角色扮演模板，定义 AI 在加载此技能后应扮演的角色。

## 核心工作流

列出加载此技能后应遵循的具体步骤和规则：

- 步骤 1：...
- 步骤 2：...
- 步骤 3：...

## 参数

（可选）定义此技能支持的用户参数：
- **param1**: 说明
- **param2**: 说明

## 使用时机

明确说明此技能应在何时加载使用。
```

### 4.2 写作原则

| 原则 | 说明 |
|------|------|
| **可操作性** | 每条指令必须是 AI 可执行的步骤 |
| **完整性** | 独立完整，不依赖其他技能或规则 |
| **前置条件** | 明确列出执行前需要满足的条件 |
| **边界清晰** | 明确说明技能做什么和不做什么 |
| **错误处理** | 包含常见错误场景的处理指引 |
| **示例驱动** | 使用具体示例说明预期行为 |

### 4.3 能力组技能引用工具

> **适用于能力组技能（`capability-groups/domain/<group>/<version>/skills/`）。**

能力组内**禁止存放工具代码**：不得出现 `tools/` 目录、`pyproject.toml` 或工具源码。
工具统一放在仓库根部 `tools/<name>/<version>/`。

引用步骤：

1. 在能力组 `group.json` 的 `tools` 字段声明工具 ID
2. `SKILL.md` 只写工具名与调用方式，不写仓库绝对路径

```json
{
  "guid": "32位小写hex",
  "name": "data-forge",
  "version": "0.2.1",
  "description": "AI 训练数据处理",
  "extends": [],
  "tools": ["tool:d0794c942e7050f589ac59d3bc79a4b2@v0.2.1"],
  "tool_permissions": {
    "tool:d0794c942e7050f589ac59d3bc79a4b2@v0.2.1": ["fs", "exec", "net"]
  }
}
```

```text
工具包位于 tools/<name>/<version>/。

调用：hnflow-stack tool run <tool> -- <args>
MCP：hnflow-stack tool serve <tool>
```

**编写技能时的检查清单**：

- [ ] frontmatter 包含 `name`、`description`，且 `name` 与目录名一致
- [ ] 能力组内没有 `tools/` 目录、`pyproject.toml` 或工具源码
- [ ] `group.json` 的 `tools` 已声明所用工具 ID
- [ ] `SKILL.md` 不含硬编码的绝对路径

---

## 5. 创建技能的标准流程

```text
1. 确定技能位置：core 能力组、领域能力组，或项目能力组
2. 在能力组的 skills/ 下创建 <skill-name>/SKILL.md
3. 编写 frontmatter：name 与目录名一致，description 清晰具体
4. 编写技能内容：角色、工作流、参数、使用时机
5. 若为项目能力组，执行 hnflow-stack activate <group> 与 hnflow-stack sync
6. 重启 Agent，确认技能出现在可用列表
```

---

## 6. 设计原则与最佳实践

- **命名即标识**：技能名称是唯一标识，一旦确定不宜更改
- **描述即广告**：`description` 是智能体判断是否加载的依据，必须精准
- **自包含**：一个技能应独立完整，不依赖其他技能
- **按需加载**：不要用技能替代规则——规则是自动注入的，技能是按需加载的
- **不复制内容**：适配器只把技能目录加入搜索路径，技能始终留在能力组内
- **适度粒度**：太粗（覆盖多个领域）或太细（每个函数一个技能）都不好
- **用规则约束行为，用技能传授知识**：规则告诉 AI 不该做什么，技能告诉 AI 该怎么做
- **使用简体中文**：description 与提示词都应使用简体中文，保持与用户沟通一致
- **尽量精简**：避免冗余和复杂的描述，保持技能内容简洁明了
