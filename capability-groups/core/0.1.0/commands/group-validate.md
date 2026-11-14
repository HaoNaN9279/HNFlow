---
name: group-validate
description: 校验一个或多个能力组的解析结果、目录边界与版本一致性
---

# 校验能力组

目标：在发布或激活前发现能力组内容问题。

参数：`$ARGUMENTS`（空格分隔的组名；为空时校验当前项目激活的全部组）

执行步骤：

1. 运行 `hnflow-stack status` 确认当前项目激活项；如指定组，先确认其存在。
2. 运行 `hnflow-stack validate`（严格解析、不写文件）；如指定组，用 `hnflow-stack list` 与 `hnflow-stack info <group>` 对照内容清单。
3. 检查解析结果：
   - `warnings` 是否涉及目标组；
   - 目标组的规则、Agent、命令、技能是否出现；规则是否都带 `description`，限定 id 是否为 `<group>/<name>`；
   - `group.json` 的 `name` / `version` 是否与目录一致；
   - `scope: paths` 的规则是否写了合法 `paths`；
   - 能力组内是否误放 `tools/`、`mcp/`、`pyproject.toml` 或工具源码；
   - 已发布版本目录是否被修改。
4. 需要写快照时运行 `hnflow-stack sync`；它会写 `.hnflow/lock.json`，缺失组或缺失工具直接报错。
5. 按问题类型给出修复建议；不要自行修改已发布版本目录，升级请新建版本目录。


报告格式：

```text
组：<name>@<version>
解析：通过 / 告警（逐条）
边界：通过 / 问题（路径）
版本：通过 / 问题
```
