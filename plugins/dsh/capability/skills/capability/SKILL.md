---
name: capability
description: 使用 HNFlow 能力组、项目 .hnflow 配置与 hnflow-stack CLI。需要激活、排查或扩展能力组，了解当前 Agent 人设、模型层或工作流来源时加载。
---

# 能力组

HNFlow 用能力组组织 Agent 配置与工作流。插件调用
`hnflow-stack resolve --json --mode capabilities`，把返回的注入计划映射到会话：规则、技能、
命令、MCP、Agent 人设与工作流。插件不扫描能力组、不选版本、不解析 frontmatter。

## 加载顺序

1. Core 能力组（始终加载，与项目是否有 `.hnflow/stack.json` 无关）
2. `.hnflow/stack.json` 中 `groups` 数组顺序
3. `extends` 依赖先于依赖者，按组名去重
4. 同名 Agent / 命令 / MCP 后加载者覆盖
5. 规则、技能路径追加

因此 HNFlow 会话里的 Agent、命令、技能、工作流列表始终是 **Core + 当前工作区并集**。
项目没有 `.hnflow/stack.json` 时只有 Core。

## 工作流

- 仓库组：`<group>/flows/<id>.flow.json`
- 项目本地：`<project>/.hnflow/groups/<group>/flows/<id>.flow.json`
- 流程可使用本组及 `extends` 依赖组的全部规则、技能、Agent、命令、工具与工作流。
- 页面的流程页只读；新建/修改用 `hnflow_author`，运行用 `hnflow`。

## Agent 人设

会话输入区左下的 **Agent** 菜单切换本会话人设，列出 Core 与当前工作区的能力组 Agent
并集（`mode: subagent` 的 Agent 留在名册，不进入人设菜单），并标注来源组。默认 `Athena`。

```text
/capability-agent          # 列出可选 Agent
/capability-agent athena   # 切换人设
```

人设只改变系统提示词，不限制工具。

## 项目配置

```json
{
  "schema_version": 2,
  "core": { "name": "core", "version": "0.1.0" },
  "agents_md": "auto",
  "groups": [
    { "name": "data-forge", "version": "1.0.0" }
  ]
}
```

改 `stack.json` 后无需重启：下一次请求会重新解析。不要手动复制规则、技能或 Agent。

## 常用命令

```bash
hnflow-stack status                 # 查看当前项目激活项
hnflow-stack list                   # 列出能力组
hnflow-stack activate <group>[@version]
hnflow-stack deactivate <group>
hnflow-stack sync                   # 严格校验并写 .hnflow/lock.json
hnflow-stack resolve --json         # 只读注入计划，供插件消费
hnflow-stack preview                # 会话注入清单
hnflow-stack tool list
hnflow-stack tool run <tool> -- <args>
hnflow-stack tool serve <tool>      # MCP stdio
```

能力组命令与技能统一发布为 `capability-<group>-<name>`：

- `/capability-core-group-new`
- `/capability-core-flow-new`

命令模板支持 `$ARGUMENTS`、`$1`..`$9`；`` !`cmd` `` 与 `@file` 在 DeepSeek Harness 中
不展开。Core 命令在任何会话可执行；领域组命令只有在当前工作区激活了该组时才执行。

## 模型层

模型层是平台级路由档位：`fast` / `standard` / `strong` / `vision`，默认 `standard`。
目录由 `hnflow-stack models catalog --json` 提供；能力组 Agent / 命令 / 技能可以写可选的
`model: <layer>`，省略即继承当前会话路由。

四层的默认 provider/model 在项目 `.hnflow/models.json`，本机可在
`~/.config/hnflow-stack/config.json` 的 `models.bindings.dsh` 逐层覆盖。
`hnflow-stack models show --json` 返回生效绑定、默认层与 `config` 路径。
设置页「模型层」写本机覆盖，也可新增仅在 DSH 可用的自定义层；自定义层不能写进共享能力组。
输入框右下角的模型位切换当前会话的层，左下角始终是 Agent 选择。`/capability-layer` 可列出层，
`/capability-layer strong` 直接切换。未绑定层只告警，不阻断提示词；层只影响会话路由。
切到 HNFlow 模式时插件会自动为当前工作区补写 `.hnflow/stack.json` 并解析一次计划，
不需要手工跑 `hnflow-stack init`；只有 `autoActivate: false` 或 `resolveMode: project` 时才跳过。

## 开发能力组

需要创建或修改能力组时，加载 `custom-group` 技能（以及 `custom-agent` /
`custom-command` / `custom-rule` / `custom-skill` / `custom-tool` / `custom-mcp`）。
这些技能住在 Core，随 HNFlow 会话固定加载，不需要额外激活能力组。

## 工具

能力组通过统一工具 ID 引用工具包：

```text
tool:<guid>@v<version>
```

不要依赖工具目录的绝对路径。MCP 工具包会以 `capability:<group>_<server>` 出现在解析结果里，
对应 `mcp__capability_<group>_<server>__<tool>` 工具名。

## 扩展能力组

- Core：`capability-groups/core/<version>/group.json`
- 领域：`capability-groups/domain/<name>/<version>/group.json`
- 项目：`<project>/.hnflow/groups/<name>/group.json`（无版本目录，同名覆盖仓库组）
- 内容目录：`rules/`、`agents/`、`commands/`、`skills/`、`references/`、`flows/`
- 工具包：`tools/<name>/<version>/tool.json`
- 版本目录发布后不可修改；升级新建版本目录，`guid` 不变

## 排查

```bash
hnflow-stack status
hnflow-stack sync
hnflow-stack resolve --json --mode capabilities
cat .hnflow/lock.json
```

插件自己调用 CLI 时都会显式带上 `--repo <仓库> --project <工作区>`（仓库从工作区或插件包
路径向上找 `capability-groups`），所以宿主进程的当前目录不影响解析；手工排查时若不在仓库
根，也请同样带上 `--repo`。

插件告警写在宿主日志（`capability:` 前缀），常见原因：`hnflow-stack` 未安装或不在
`PATH`、解析超时（`CAPABILITY_RESOLVE_TIMEOUT_MS`）、schema 版本不兼容、仓库路径未配置、
组版本不存在、工具包缺失。当前目录不是项目根时 Core 仍然生效，只是没有领域组。
