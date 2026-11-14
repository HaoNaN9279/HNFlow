---
name: activate
description: 为当前项目初始化并激活 HNFlow（.hnflow/stack.json）
model: standard
---

# `/capability-core-activate` — 为当前项目激活 HNFlow

在当前项目里建立 `.hnflow/stack.json`（Core 恒加载），按用户指定激活领域能力组，
最后校验并生成 lock。参数是可选的能力组列表：

```text
/capability-core-activate
/capability-core-activate unity-framework hnflow-forge
```

## 前置检查

1. `hnflow-stack --help` 能正常运行。失败说明 CLI 未安装或不在 PATH：提示用户先安装
   （`uv tool install --from <本仓库路径> hnflow-stack`），不要自行猜路径。
2. 项目根：优先 `git rev-parse --show-toplevel`，否则用当前工作目录。
   后续命令都在项目根执行，路径参数一律用 `.`。
3. 如果报 `HNFlow repository not found`，说明找不到能力组仓库：
   请用户给出仓库路径，然后在每条命令前加 `--repo <仓库路径>`（全局参数，必须放在子命令前），
   或让用户设置 `HNFLOW_HOME`。不要猜路径。

## Step 1: 检查是否已激活

```bash
hnflow-stack --project . status
```

- 输出 `no .hnflow/stack.json` → 继续 Step 2。
- 已有 `schema_version`/`core` 输出 → 已激活，跳过 Step 2，直接报告现状并进入 Step 3。

## Step 2: 初始化

```bash
hnflow-stack --project . init
```

只创建 `.hnflow/stack.json`，不写其他目录。需要换 Core 版本时才加 `--core <name@version>`；
默认取全局配置里的 Core，不擅自升级。

## Step 3: 激活领域能力组

1. 运行 `hnflow-stack --project . list` 看仓库里可用的能力组与描述。
2. 用户给了参数（`$ARGUMENTS`）→ 按参数激活；参数为空 → 根据项目内容（引擎、语言、
   目录结构、已有工具链）挑出候选组，**列出并请用户确认**，不要擅自激活。
3. 逐个激活：

```bash
hnflow-stack --project . activate <group>[@version]
```

版本省略时解析该组最高版本。输出里有 `warning: missing tool` 时原样转告用户。

## Step 4: 校验

```bash
hnflow-stack --project . validate
hnflow-stack --project . list
```

`validate` 必须成功；有告警就修 `stack.json`（组名、版本）后重跑。
`list` 用来确认激活集符合预期。

## Step 5: 生成 lock（可选）

```bash
hnflow-stack --project . sync
```

`lock.json` 是解析结果的快照（含时间戳），用于审计与比对，不是运行必需。
项目把它纳入版本管理时再执行，否则跳过。

## Step 6: 报告

- `stack.json` 路径、Core 版本、激活的组与版本、规则/技能/命令/Agent 数量。
- 下一步提示：新会话生效；之后改 `stack.json` 不需要重启 Agent，
  下一次解析会按 stack 的修改时间自动重新加载。
- 明确说明：能力组内容不复制到 `.dsh/` 等 Agent 私有目录，`.hnflow/` 是唯一入口。

## 约束

- 只写 `.hnflow/`；不改项目其他文件。`init` / `activate` 会把仓库路径记进全局配置，属预期行为。
- 不写本地绝对路径到能力组内容里；命令输出里的路径只在报告里说明用途。
- 用户没确认的组不激活。
