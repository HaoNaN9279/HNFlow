---
name: group-authoring
description: 能力组制作规则：目录边界、路径写法、版本标识、校验与交付。
on_demand: true
---
# 能力组制作规则

适用：开发 HNFlow 自身的能力组内容（规则、Agent、命令、技能、工具引用）。
本规则属于 Core，随 HNFlow 会话固定加载，按需读取全文。

## 目录与边界

- Core：`capability-groups/core/<version>/`；领域：`capability-groups/domain/<name>/<version>/`。
- 能力组只放 `group.json`、`AGENTS.md`、`rules/`、`agents/`、`commands/`、`skills/`、`references/`。
- 不在能力组内创建 `mcp/`、`tools/`、`pyproject.toml` 或工具源码；工具放在仓库根部 `tools/<name>/<version>/`，由 `group.json` 的 `tools` 引用。
- 能力组 Agent / 命令 / 技能只写可选的 `model: <layer id>`（平台默认层）；provider、具体模型名、温度、权限等宿主参数不写入。

## 层级边界

- 祖先层（根与父层）只写该层通用、与子层和具体工具无关的内容；不引用子层名称、路径、工具、端点、接口或流程。
- 根层内容用正面陈述，不写否定式标注：子层会继承根层，标注在具体引擎里会显得矛盾。
- 子层自动继承祖先全部内容（规则、技能、Agent、命令、流程、工具），只写自己的增量；不复制祖先已有内容。
- 引擎、工具、接口等专用知识只放在使用它的层；要跨层复用就上移到共同祖先，上移时删掉专用名词。
- 引用方向只能从子层指向祖先（祖先内容天然可见）；祖先不反向引用子层，否则子层一变祖先就失效。
- 判断标准：把子层整棵目录删掉，祖先层内容仍应完整自洽；不成立说明有内容放错了层。

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


## 内容归属

- 能力组制作内容（本规则与 `custom-*` 技能）住在 Core，随 HNFlow 会话固定加载，不需要激活领域组。
- Core 规则全部按需加载：上下文里只有摘要行，动其主题前先读本文件全文。
