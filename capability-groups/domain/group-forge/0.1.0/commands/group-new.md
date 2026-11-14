---
name: group-new
description: 新建一个 HNFlow 能力组骨架（group.json + 内容目录）并给出激活步骤
model: standard
---

# 新建能力组

目标：在 HNFlow 仓库中创建一个可被 `hnflow-stack resolve` 发现的新能力组。

参数：`$ARGUMENTS`（格式 `<name> [core|domain] [version]`，缺省为 `domain` 与 `0.1.0`）

执行步骤：

1. 加载 `custom-group` 技能，确认目标位置、名称与版本。
2. 检查仓库中是否已存在同名组；已存在则停止并报告。
3. 创建目录 `capability-groups/<core|domain>/<name>/<version>/`，写入 `group.json`：
   - `guid` 为新的 32 位小写十六进制；
   - `name`、`version` 与目录一致；
   - `permissions` 按内容需要填写（`fs` / `net` / `exec` / `secrets`）；
   - `extends` 与 `tools` 默认空数组。
4. 按需创建 `rules/`、`agents/`、`commands/`、`skills/`；需要分子系统时建 `modules/<path>/`（见 `custom-module`）。不要创建 `tools/` 或 `mcp/`。
5. 运行 `hnflow-stack validate` 与 `hnflow-stack resolve --json --project <project>` 验证新组可被加载（可在临时测试项目中激活）。
6. 报告创建的路径、模块树（`hnflow-stack list --tree`）、解析结果，以及项目激活命令：

```bash
hnflow-stack activate <name>@<version>
hnflow-stack sync
```
