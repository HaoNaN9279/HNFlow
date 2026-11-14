---
name: custom-command
description: 当用户需要创建或管理 HNFlow 自定义命令（Command）时使用
license: MIT
---

# Custom Command — 命令制作指南

指导你创建和管理 HNFlow 自定义命令。能力组中的命令定义与具体 Agent 工具解耦，由适配器转换后注入，执行预定义的提示词模板。

---

## 1. 命令概述

自定义命令是 Agent 内置操作的补充。多数 Agent 通过 `/` 后跟命令名称触发；具体入口和触发方式由适配器决定。

---

## 2. 部署位置

### 确定添加内容的位置

- **"添加常驻内容"** 或类似描述 → `capability-groups/core/0.1.0/` 目录（全局常驻配置）
- **"为 xxx domain" / "xxx 领域" / "为 xxx 添加内容"** 或类似描述 → `capability-groups/domain/<group>/<version>/` 目录（领域专属配置）
- **"为当前项目添加内容"** 或类似描述 → 在项目 `.hnflow/groups/<name>/` 新建项目能力组（无版本目录），并在 `.hnflow/stack.json` 的 `groups` 中激活
- **未明确指明位置** → **必须询问用户**具体的添加位置，绝对不允许擅自做决策

HNFlow 不写入任何 Agent 的专有配置目录，也不复制或链接内容到这些目录。项目级内容只通过 `.hnflow/stack.json` 激活能力组生效。

### 2.1 核心命令（全局可用）

放置在 `capability-groups/core/0.1.0/commands/` 目录下。

```text
capability-groups/core/0.1.0/commands/
└── <command-name>.md      # 全局命令定义
```

### 2.2 领域命令（领域专属）

放置在 `capability-groups/domain/<group>/<version>/commands/` 目录下。

```text
capability-groups/domain/<group>/<version>/
commands/
├── <domain>-process.md    # 领域处理命令
├── <domain>-export.md     # 导出命令
├── <domain>-prompt.md     # 提示管理命令
└── <domain>-utils.md      # 工具命令
```

### 2.3 项目命令（项目专属）

在 `capability-groups/domain/<group>/<version>/commands/` 中定义，然后在项目根目录激活能力组：

```bash
hnflow-stack activate <group>
hnflow-stack sync
```

激活只修改 `.hnflow/stack.json`，不向项目写入命令文件。

---

## 3. 命令定义方式

每个命令文件必须以 YAML frontmatter 开头，frontmatter **必须包含** `name`、`description` 两个字段；`agent`、`model` 可选。

```markdown
---
name: command-name                  # 必填：命令名称，建议与文件名一致
description: 命令的简要描述（在命令列表中显示） # 必填
agent: <agent-name>                 # 可选：指定执行代理
model: standard                     # 可选：平台模型层 id
---

这里是命令的提示词模板内容。支持：
- $ARGUMENTS — 所有参数
- $1, $2, $3 — 位置参数
- !`command` — shell 命令输出注入
- @filename — 文件引用
```

文件名建议与 `name` 一致：`test.md` → `name: test` → `/test`。

适配器注入规则：

- `name`、`description`、`agent` 映射为目标 Agent 的命令配置。
- `model` 是平台模型层 id（`fast` / `standard` / `strong` / `vision`），由适配器按项目 `.hnflow/models.json` 与本机覆盖解析为模型路由；省略时不主动切换。
- 正文作为命令模板。
- 缺少 `name` 或 `description` 的命令会被跳过并产生告警。
- 无法映射的字段不注入；不得写 provider、具体模型名、temperature、permission。

---

## 4. 提示词模板语法

模板正文由适配器解释。以下为常见约定，具体支持范围以目标适配器为准。

### 4.1 参数绑定

```text
$ARGUMENTS     # 所有参数的原始字符串
$1             # 第一个参数
$2             # 第二个参数
$3             # 第三个参数，以此类推
```

示例（`component.md`）：

```markdown
---
name: component
description: Create a new React component
---

Create a new React component named $ARGUMENTS with TypeScript support.
Include proper typing and basic structure.
```

使用方式：`/component Button` → `$ARGUMENTS` 替换为 `Button`

### 4.2 Shell 输出注入

使用 `!` + 反引号执行 shell 命令，输出注入到提示词中：

```markdown
---
name: analyze-coverage
description: Analyze test coverage
---

Here are the current test results:
!`npm test`

Based on these results, suggest improvements to increase coverage.
```

```markdown
---
name: review-changes
description: Review recent changes
---

Recent git commits:
!`git log --oneline -10`

Review these changes and suggest any improvements.
```

命令在项目根目录执行，输出成为提示词的一部分。

### 4.3 文件引用

使用 `@` 后跟文件名引用文件内容：

```markdown
---
name: review-component
description: Review component
---

Review the component in @src/components/Button.tsx.
Check for performance issues and suggest improvements.
```

文件内容会自动包含在提示词中。

---

## 5. 配置选项

| 选项 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `name` | string | 是 | 命令名称，建议与文件名一致 |
| `description` | string | 是 | 命令功能的简要描述，命令列表中显示 |
| `agent` | string | 否 | 指定执行命令的代理 |
| `model` | string | 否 | 平台模型层 id：`fast` / `standard` / `strong` / `vision` |
| 正文 | string | 是 | 执行时发送给 LLM 的提示词模板 |

---

## 6. 命令制作示例

### 6.1 核心命令示例（`capability-groups/core/0.1.0/commands/auto-git-commit.md`）

```markdown
---
name: auto-git-commit
description: commit 当前项目变更（含 submodules 支持）
model: standard
---

# `/auto-git-commit` — 自动 Git 提交

根据当前项目的 Git 变更，写出规范的 commit message 并提交，不推送到远程。

## Step 1: 检查变更

运行 `git status` 和 `git diff`，确认待提交内容。

## Step 2: 提交

按项目约定生成 commit message，执行提交。

## Step 3: 报告

输出提交哈希与变更摘要。
```

### 6.2 领域命令示例（`capability-groups/domain/data-forge/1.0.0/commands/data-forge-process.md`）

```markdown
---
name: data-forge-process
description: Execute AI data processing pipelines: resize, remove-bg, batch
---

# `/data-forge-process` — Image Processing Pipeline

## 1. Usage

/data-forge-process resize --input-dir <path> --output-dir <path>
/data-forge-process remove-bg --input-dir <path> --output-dir <path>
/data-forge-process batch --input-dir <path> --output-dir <path>

## 2. Execution Steps

1. Validate input directory exists
2. Invoke the data-forge tool with parameters
3. Report results

## 3. Notes

- Pipeline stages are atomic
- Tool access goes through `hnflow-stack tool run data-forge -- <args>`
```

---

## 7. 命令设计原则

### 7.1 职责明确

每个命令应聚焦一个具体的操作领域：

| 好的命名 | 差的命名 | 原因 |
|----------|----------|------|
| `data-forge-process` | `data-forge` | 太宽泛，不知道做什么 |
| `test-run` | `run` | 可能与其他命令冲突 |
| `component-create` | `new` | 过于通用 |

### 7.2 提示词结构

命令的提示词应遵循：

1. **用途说明**：简短描述命令做什么
2. **使用方式**：展示语法和示例
3. **参数说明**：列出所有参数及其说明
4. **执行步骤**：分步指导 AI 如何执行
5. **注意事项**：边界情况、依赖关系、错误处理
6. **使用简体中文**：确保提示词使用简体中文，保持与用户沟通一致

### 7.3 良好实践

- **参数验证**：提示 AI 先验证参数再执行
- **错误处理**：说明可能的错误及处理方式
- **输出格式**：定义标准化的输出报告格式
- **幂等性**：命令应可重复执行而不产生副作用

---

## 8. 创建命令的标准流程

```text
1. 确定命令位置：core 能力组、领域能力组，或项目能力组
2. 在能力组的 commands/ 下创建 <name>.md
3. 编写 YAML frontmatter，必须包含 name、description；agent 可选
4. 编写提示词模板正文
5. 若为项目能力组，执行 hnflow-stack activate <group> 与 hnflow-stack sync
6. 重启 Agent，通过适配器提供的入口测试
```
