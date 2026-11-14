# Resolve API v2

`hnflow-stack resolve --json` 是能力组解析的唯一边界。插件调用它获取注入计划，
不在插件内扫描目录、选择版本、解析 frontmatter 或拼宿主名。

## 调用

```bash
hnflow-stack resolve --json [--mode project|capabilities] [--project <project-dir>]
```

- `--repo` 可选，默认按全局配置和环境变量定位仓库。
- `--json` 输出机器可读 JSON；省略时输出摘要。
- `--mode` 默认 `project`：
  - `project`：无 `.hnflow/stack.json` 时返回 `active=false`，不加载 Core。
  - `capabilities`：Core 始终加载；无 stack 时也返回 `active=true`，只含 Core。
- 没有版本协商参数。`schema_version` 恒为 `2`，形状只有一种。
- `stdout` 只包含 JSON，UTF-8 编码。
- 命令只读，不创建或修改 `.hnflow/lock.json`。
- 非致命内容问题写入 `warnings`，退出码仍为 `0`。
- 仓库缺失、stack JSON 损坏等致命错误写 `stderr`，退出码为 `1`。

## 响应

```json
{
  "schema_version": 2,
  "active": true,
  "mode": "capabilities",
  "repository": "D:/workspace/HNFlow",
  "project": "D:/workspace/UnityGame",
  "core": { "name": "core", "version": "0.1.0", "root": "...", "extends": [] },
  "groups": [
    {
      "guid": "32hex",
      "name": "unity-framework",
      "version": "1.0.0",
      "root": ".../capability-groups/domain/unity-framework/1.0.0",
      "extends": [],
      "tools": ["tool:..."]
    }
  ],
  "rules": [
    {
      "name": "global",
      "id": "core/global",
      "path": ".../rules/00-global.md",
      "group": "core",
      "kind": "rule",
      "scope": "global",
      "paths": [],
      "on_demand": false,
      "priority": 0,
      "description": "全局行为规则"
    }
  ],
  "skills": [
    { "name": "battle-tips", "id": "unity-framework/battle-tips", "path": "...", "group": "unity-framework", "description": "..." }
  ],
  "agents": {
    "BattleDev": { "name": "BattleDev", "id": "unity-framework/BattleDev", "mode": "subagent", "system": "...", "group": "unity-framework" }
  },
  "commands": {
    "battle-build": { "name": "battle-build", "id": "unity-framework/battle-build", "template": "...", "group": "unity-framework" }
  },
  "mcp": {
    "capability:unity-framework_unity": { "type": "stdio", "command": "..." }
  },
  "flows": [
    {
      "id": "core/art-review",
      "flow_id": "art-review",
      "name": "美术评审",
      "group": "core",
      "path": ".../flows/art-review.flow.json",
      "description": "...",
      "tags": ["art"],
      "version": "",
      "requires": ["core"]
    }
  ],
  "warnings": [],
  "fingerprint": "sha256",
  "model_layers": [
    { "id": "fast", "label": "快速", "kind": "speed", "rank": 1 },
    { "id": "standard", "label": "标准", "kind": "balanced", "rank": 2 },
    { "id": "strong", "label": "深度", "kind": "reasoning", "rank": 3 },
    { "id": "vision", "label": "多模态", "kind": "multimodal", "rank": 4 }
  ],
  "model_default": "standard",
  "names": {
    "agents": { "unity-framework/BattleDev": "BattleDev" },
    "commands": { "unity-framework/battle-build": "capability-unity-framework-battle-build" },
    "skills": { "unity-framework/battle-tips": "capability-unity-framework-battle-tips" }
  }
}
```

| 字段 | 说明 |
|---|---|
| `schema_version` | 恒为 `2` |
| `active` | 计划是否生效；`mode=capabilities` 时始终为 `true` |
| `mode` | `project` 或 `capabilities` |
| `core` | 已解析的 Core 摘要；`project` 模式无 stack 时为 `null` |
| `groups` | 已解析的领域组摘要，按加载顺序 |
| `rules` | 规则列表，按注入顺序；带作用域与 `on_demand` |
| `skills` | 技能目录，按加载顺序；可带 `model`（层 id） |
| `agents` | 已合并 Agent；可带 `model`（层 id） |
| `commands` | 已合并命令；可带 `model`（层 id） |
| `mcp` | 已合并 MCP 配置，key 为 `capability:<group>_<server>` |
| `flows` | 能力组内的工作流 |
| `warnings` | 非致命问题 |
| `fingerprint` | 解析输入内容的 SHA-256 |
| `model_layers` | 平台模型层目录 |
| `model_default` | 平台默认层 id |
| `names` | 限定 id → 宿主名（命令、技能）或计划键（Agent） |

路径为绝对路径和正斜杠。

### 限定 id 与计划键

| 位置 | 格式 |
|---|---|
| 内容的 `id` | `<group>/<name>` |
| `agents` / `commands` 的键 | `<name>` |
| `skills` 的宿主名 | `capability-<group>-<name>` |
| 流程的 `id` | `<group>/<flow.id>` |

`rules` 的 `kind` 为 `rule` 或 `agents`（吸收的 `AGENTS.md`）。`scope` 为 `global` 或
`paths`。`on_demand: true` 的规则只进索引（`- <路径>: <description>`），不注入正文。

`agents.system` 与 `commands.template` 仍内联正文，因为宿主 `systemPrompt` 回调是同步的。
`system_path` / `template_path` 指向同一文件，供需要按需读取的实现使用。

`model` 可选，值必须是平台层 id（`fast` / `standard` / `strong` / `vision`），长度 ≤32。
未知或非法值写入 `warnings` 并省略该字段。层到 provider/model/reasoningEffort 的绑定属于
用户本机配置，由插件按 `model_layers` 解析。能力组不得写 provider、具体模型名、
temperature、permission 等宿主参数。

## 工作流校验

- 文件位置：组根 `flows/`，递归发现 `*.flow.json`，跳过点目录。
- `schemaVersion` 必须为 `2`，顶层 `flow` 必须为对象，`flow.id` 必填。
- `flow.id` 匹配 `^[a-z0-9][a-z0-9._-]*$`；非法文件告警并跳过。
- 同一限定 id 重复：保留首个，后续告警并跳过。
- `flow.requires` 原样透传，只用于展示与人工确认，不参与依赖解析。
- 解析器不校验节点契约；节点与边的完整校验由插件在运行前完成。

## 解析规则

加载顺序：

1. Core（`mode=capabilities` 时无条件；`project` 模式仅当 stack 存在）
2. `stack.groups` 数组顺序
3. 每个组的 `extends` 依赖优先，支持 `name@version`；环报错
4. 同名组只加载一次
5. 每组内部按 `rules/`、`agents/`、`commands/`、`skills/`、`flows/` 收集

内容校验：

| 类型 | 规则 |
|---|---|
| rules | 递归发现 `rules/**/*.md`；必须有 `name`、`description`；可选 `scope`（`global`/`paths`）、`paths`、`on_demand`、`priority`、`overrides` |
| agents | 递归发现 `agents/**/*.md`；必须有 `name`、`description`、`mode`，`mode` 只能是 `primary`、`subagent`、`all` |
| commands | 递归发现 `commands/**/*.md`；必须有 `name`、`description`，`agent` 可选 |
| skills | 每个含 `SKILL.md` 的目录一项；`name` 匹配目录名和 `[a-z0-9]+(-[a-z0-9]+)*`；`description` 1-1024 字符；禁止 `metadata` |
| flows | 递归发现 `flows/**/*.flow.json`；`schemaVersion=2`，`flow.id` 合法且唯一 |
| AGENTS.md | 组根自动吸收为 `kind=agents` 规则；项目子目录仅在 stack 的 `agents_md` 为 `nested` 时吸收 |
| MCP | 仅处理 `group.json` 的工具引用；`mcp.enabled=false` 跳过 |

## 合并与冲突

- rules：`global` 规则先于 `paths` 规则，同作用域按 `priority` 排序；`overrides` 压掉同组已收集的同名规则；`stack` 的 `disable` 按限定 id 或裸名剔除。
- skills：追加；宿主名重复保留后加载者并告警，`sync` 报错。
- agents、commands、mcp：同名后加载者覆盖。
- flows：同限定 id 重复时保留首个并告警；不存在跨组覆盖。
- 同一个限定 id 重复（同组同类同名）才算真重复：`resolve` 告警并保留后加载者，`sync` / `validate` 报错。
- 不注入宿主模型参数（provider、具体模型名、temperature、permission）；只透传可选的层 id。

## 失败策略

- 只有一种形状，没有版本协商；插件必须校验 `schema_version == 2`。
- 不兼容时插件只加载默认技能，不得阻断 Agent 启动。
- 插件调用失败不得阻断 Agent 启动；建议超时 5 秒，可通过
  `HNFLOW_RESOLVE_TIMEOUT_MS` 覆盖。
- CLI 必须已安装并在 `PATH` 中；自定义路径使用 `HNFLOW_CLI`。
