---
name: group-authoring
description: 能力组制作规则：目录边界、路径写法、版本标识、校验与交付。
---

# 能力组制作规则

本能力组用于开发 HNFlow 自身的能力组内容。以下规则只在本能力组激活时注入。

## 目录与边界

- Core：`capability-groups/core/<version>/`；领域：`capability-groups/domain/<name>/<version>/`。
- 能力组只放 `group.json`、`AGENTS.md`、`rules/`、`agents/`、`commands/`、`skills/`、`references/`。
- 不在能力组内创建 `mcp/`、`tools/`、`pyproject.toml` 或工具源码；工具放在仓库根部 `tools/<name>/<version>/`，由 `group.json` 的 `tools` 引用。
- 能力组 Agent / 命令 / 技能只写可选的 `model: <layer id>`（平台默认层）；provider、具体模型名、温度、权限等宿主参数不写入。

## 路径

- 任何内容都不写本地绝对路径（含盘符路径、用户主目录路径、本机安装路径）。
- 组内引用一律用相对路径：相对组根（`rules/xx.md`、`skills/xx/SKILL.md`）或相对项目根（`Assets/Battle/**`）。
- 必须提到外部位置时，用占位符或环境变量（`<project-root>`、`<repo>`、`$HOME`、`%ProgramFiles%`），并说明由用户按自己的安装位置替换。
- 涉及用户自定义路径时，只描述「由用户在 `stack.json`、命令参数或环境变量中提供」，不假设固定目录。
- 示例、日志、命令输出里也不要粘贴本机路径；需要举例时用假路径并以 `<...>` 标注可替换部分。

## 版本与标识

- `group.json` 的 `name`、`version` 必须与目录名一致；`guid` 跨版本保持不变。
- 已发布版本目录不可修改；升级新建版本目录，并更新项目 `stack.json` 的引用版本。
- 新组的 `guid` 使用 32 位小写十六进制，且全仓唯一。
- 技能目录名、技能 `name`、`SKILL.md` 必须一致，且匹配 `^[a-z0-9]+(-[a-z0-9]+)*$`。

## 校验与交付

- 内容必须带 frontmatter：规则 `name`/`description` 必填（`scope`/`paths`/`on_demand`/`priority`/`overrides` 可选）；Agent `name`/`description`/`mode`；命令 `name`/`description`；技能 `name`/`description`。
- 完成后运行 `hnflow-stack validate` 与 `hnflow-stack resolve --json --project <project>`，确认新内容出现且无告警；必要时运行 `hnflow-stack sync` 写 `lock.json`。
- 项目激活只改 `.hnflow/stack.json`；不把能力组内容复制到项目或 Agent 配置目录。
- 规则按作用域与 `priority` 注入；`on_demand: true` 的规则默认只注入摘要行，正文由 Agent 按需读取，`overrides` 压掉同名早期规则；Agent / 命令 / MCP 同名后加载者覆盖，设计命名时优先避免跨组同名。


## 本能力组的定位

- `group-forge` 是领域能力组，不默认加载；需要在项目中显式激活。
- 它不包含任何常驻规则，只有开发能力组时才有意义。
