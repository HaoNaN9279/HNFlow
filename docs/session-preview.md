# 会话内容预览

回答一个问题：**这个工作目录、这个 Agent，会话里到底加载了什么？**

两个入口共用同一份决策逻辑：

- `hnflow-stack preview`：命令行列出内容、状态、字节数与摘要。
- DSH 插件的 `▤` 按钮：输入框左下角、Agent 选择器旁，弹窗列出同一份清单，悬停看全文。

清单不只包含能力组：宿主自己注入的工作区指令（`AGENTS.md` / `CLAUDE.md` 链）也在其中。

## 1. 顺序即真实加载顺序

```text
agents-md → persona → skills → commands → flows → mcp → rules → rules-skipped → agents
```

- `agents-md`：宿主工作区指令链，会话首条消息注入。
- `persona`：当前人设正文。
- `skills` / `commands` / `flows`：能力组内容目录。
- `mcp`：为当前 Agent 挂载的 MCP 服务。
- `rules`：最后追加的规则消息；内部按 `injected → indexed → omitted`。
- `rules-skipped`：当前目录不匹配 `paths`、不会加载的规则。
- `agents`：人设候选，仅界面可见，不进上下文。

`rules` 段与注入共用 `plan_rules`，预算、索引行与截断标记和真实注入一致。

## 2. 状态符号

| 符号 | 状态 | 含义 |
| --- | --- | --- |
| `+` | injected | 已并入规则消息 |
| `~` | indexed | `on_demand: true`，只贡献一行「路径 + 描述」索引 |
| `!` | omitted | 超预算或正文为空，未注入 |
| `-` | skipped | 当前目录不匹配作用域 |
| `*` | active | 技能 / 命令 / 流程 / MCP / 人设已生效 |

## 3. CLI

```bash
hnflow-stack preview [--agent <name>] [--cwd <dir>] [--mode project|capabilities]
                  [--max-rules-bytes <n>] [--json] [--with-text] [--text-bytes <n>]
```

| 参数 | 说明 |
| --- | --- |
| `--agent` | 人设名；缺省取第一个非 subagent |
| `--cwd` | 项目相对路径，缺省项目根 |
| `--project` | 项目根，缺省当前目录 |
| `--mode` | `project` 或 `capabilities`（Core 无条件加载） |
| `--max-rules-bytes` | 规则预算，默认 65536 |
| `--json` | 输出结构化字段 |
| `--with-text` | 内联正文，配合 `--text-bytes` 截断 |

JSON 条目带 `id`、`name`、`kind`、`status`、`summary`、`path`、`host_name`、`owner`；
`kind` 为 `rule`、`skill`、`command`、`flow`、`mcp`、`agent` 之一。

## 4. 插件路由

- `GET /api/capability/prepare?sessionId=<id>&cwd=<dir>`：切到 HNFlow 时由客户端调用，
  给当前工作区补 `.hnflow/stack.json` 并解析一次计划。
- `GET /api/capability/inventory?sessionId=<id>&agent=<name>&cwd=<dir>`：清单。
- `GET /api/capability/inventory/text?sessionId=<id>&kind=<kind>&id=<id>&cwd=<dir>`：单条正文，按 `text-bytes` 截断。
- `GET /api/capability/models` 与 `GET /api/capability/roster?sessionId=<id>&cwd=<dir>`：模型层目录与 Agent 候选。

`cwd` 是客户端报告的工作区提示，只在宿主还不知道会话目录（新窗口尚未落盘）时使用。
页面只读；预览不改变注入，也不写会话。
