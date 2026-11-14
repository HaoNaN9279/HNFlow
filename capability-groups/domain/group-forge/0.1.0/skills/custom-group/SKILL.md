---
name: custom-group
description: 当用户需要创建、扩展、升级或校验 HNFlow 能力组（Core 或领域能力组）本身时使用
license: MIT
---

# Custom Group — 能力组制作指南

能力组是 HNFlow 的能力容器。它只描述“用什么能力”，不携带工具源码、宿主模型参数、凭据或 Agent 私有配置。本技能负责组这一层；组内具体内容分别由 `custom-rule`、`custom-agent`、`custom-command`、`custom-skill`、`custom-tool`、`custom-mcp` 负责。

---

## 1. 两种能力组

| 类型 | 路径 | 加载条件 |
|---|---|---|
| Core | `capability-groups/core/<version>/` | 项目模式下项目有 `.hnflow/stack.json`；HNFlow 模式下始终加载 |
| 领域 | `capability-groups/domain/<name>/<version>/` | 仅在项目 `.hnflow/stack.json` 的 `groups` 中列出时加载 |
| 项目 | `<project>/.hnflow/groups/<name>/` | 仅该项目加载，无版本目录，同名覆盖仓库组 |

领域组不默认激活。需要时在项目根目录执行：

```bash
hnflow-stack activate <name>@<version>
hnflow-stack sync
```

`activate` 只修改 `.hnflow/stack.json`，不复制内容到项目或 Agent 配置目录。

---

## 2. 目录结构

```text
capability-groups/domain/<name>/<version>/
├── group.json
├── AGENTS.md       # 可选，吸收为组根规则
├── rules/          # 递归发现 *.md，必须含 frontmatter name / description
├── agents/         # 递归发现 *.md，必须含 name / description / mode
├── commands/       # 递归发现 *.md，必须含 name / description
├── skills/         # 每个技能一个目录，内含 SKILL.md
└── references/     # 可选参考资料，不参与解析
```

硬性边界：

- 能力组内**不创建** `tools/`、`mcp/`、`pyproject.toml` 或工具源码。
- MCP 是工具包的一种 provider，放在仓库根部 `tools/<name>/<version>/tool.json`，由 `group.json` 的 `tools` 引用。
- Agent / 命令 / 技能只写可选的模型层 id（`model:`）；provider、具体模型名、温度、权限属于运行时配置，不写入。
- 不把内容复制到 `.dsh/` 等 Agent 私有目录。

---

## 3. group.json

```json
{
  "guid": "32 位小写十六进制，全仓唯一",
  "name": "group-name",
  "version": "0.1.0",
  "description": "一句话说明能力组用途",
  "permissions": ["fs"],
  "extends": [],
  "tools": ["tool:<guid>@v1.0.0"],
  "tool_permissions": {
    "tool:<guid>@v1.0.0": ["fs", "net"]
  }
}
```

| 字段 | 必填 | 说明 |
|---|---|---|
| `guid` | 是 | 跨版本保持不变，发布后不要改 |
| `name` | 是 | 必须与目录名一致 |
| `version` | 是 | 必须与版本目录名一致，语义化版本 |
| `description` | 是 | 能力组用途 |
| `permissions` | 否 | `fs` / `net` / `exec` / `secrets` 的子集 |
| `extends` | 否 | 依赖的组名；解析时依赖先于依赖者 |
| `tools` | 否 | 引用的工具包 ID：`tool:<guid>@v<version>` |
| `tool_permissions` | 否 | 按工具 ID 覆盖权限 |

`extends` 形成依赖图；同组只加载一次。依赖缺失时 `resolve` 记录告警并跳过，`sync` 直接报错。

---

## 4. 命名与版本

- 组名、技能名使用小写 kebab：`^[a-z0-9]+(-[a-z0-9]+)*$`。
- Agent 名可以大写（如 `Athena`），但同一能力组内不要重复。
- 命令名会被 DSH 适配器规范化为 `capability-<group>-<name>`；能力组里写原始短名即可。
- 新组从 `0.1.0` 开始；破坏性变更升次版本或主版本，按仓库约定执行。
- **已发布版本目录不可修改**：升级时新建 `<new-version>/`，复制并修改内容，`guid` 不变，然后更新项目 `stack.json` 的引用版本。

生成 GUID（标准库）：

```bash
python -c "import uuid; print(uuid.uuid4().hex)"
```

---

## 5. 新建组的完整流程

```text
1. 确认位置：Core / 领域组 / 项目激活
2. 选择名称与版本，确认仓库中没有同名同版本目录
3. 创建 <root>/group.json（guid、name、version、description）
4. 按需创建 rules/、agents/、commands/、skills/
5. 内容是否只对某些目录生效：是 → 该规则加 scope: paths + paths；正文长且按需查阅 → on_demand: true
6. 每个内容文件写 frontmatter（见对应 custom-* 技能）
7. 在临时项目激活该组，运行 hnflow-stack validate 与 resolve --json 验证
8. 发布：提交仓库；项目侧更新 stack.json 版本并 sync
```

验证命令：

```bash
hnflow-stack list
hnflow-stack activate <name>@<version>
hnflow-stack validate
hnflow-stack resolve --json --project <project>
hnflow-stack sync
```

`resolve` 只读，不写 `lock.json`；`validate` 严格校验不写文件；`sync` 严格校验并写 `lock.json`。


---

## 6. 解析与合并规则

1. 加载顺序：Core → `groups` 数组顺序 → 每个组的 `extends` 依赖优先。
2. 组内内容按 `rules/`、`agents/`、`commands/`、`skills/`、`flows/` 收集，组间按加载顺序追加。
3. 同名组只加载一次。
4. 规则按作用域注入（`global` / `paths`），`on_demand: true` 只注入摘要行，`priority` 排序，`overrides` 压掉同名早期规则，`stack.disable` 剔除。
5. 技能路径追加；宿主名重复保留后者并告警，`sync` 报错。
6. Agent、命令、MCP 同名时后加载者覆盖。
7. 同一个限定 id 重复才算真重复：`resolve` 告警、`sync` / `validate` 报错。
8. 单个文件或工具失败只跳过该项并记 `warnings`，退出码仍为 0。

设计跨组内容时优先避免同名；无法避免时明确“后加载覆盖”的意图，并在文档中写清楚。


---

## 7. 常见问题

| 现象 | 原因 | 处理 |
|---|---|---|
| `capability group '<name>' not found` | 目录名或版本不对 | 检查 `capability-groups/domain/<name>/<version>/group.json` |
| `name/version must match the directory` | `group.json` 字段与目录不一致 | 改成一致 |
| `unsupported stack schema_version` | `stack.json` 还是旧格式 | 改为 `"schema_version": 2` |
| 规则/技能不出现 | frontmatter 缺 `name`，或技能目录名不匹配 | 补 frontmatter；技能目录名与 `name` 一致 |
| `resolve` 有告警但退出码 0 | 内容被跳过 | 按告警逐条修复；`sync` 会严格报错 |
| 新组激活后没内容 | 项目没 `sync`，或 DSH 插件缓存未失效 | 运行 `sync`；改 `stack.json` 会触发插件重新解析 |
| 目录限定规则不生效 | 当前工作目录不在 `paths` 内 | `hnflow-stack rules show --for <path>` |
| 工具缺失 | `group.json` 引用了不存在的工具 ID | 检查 `tools/` 与 `tool_permissions` |

---

## 8. 与 DSH 模式的关系

- 在 DSH 的 HNFlow 模式中，Core 始终加载；领域组按项目并集加载。
- 能力组命令在 DSH 里是 `capability-<group>-<name>`；技能名同样带命名空间。
- 插件只消费 `hnflow-stack resolve --json`，不扫描能力组目录；所有修正都应落在能力组文件和项目 `stack.json` 上。
