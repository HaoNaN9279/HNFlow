# HNFlow 开发方案

> 本文件是 HNFlow 当前阶段的权威开发方案：描述系统现状、架构分层、核心机制、目标设计与后续规划。Web 服务 + 本地部署形态，后端 Python（FastAPI + LangGraph），前端 Next.js + React Flow。

## 一、整体定位与设计目标

### 1.1 核心定位

HNFlow（**H**uman-**N**ode **Flow**）是一套**图驱动的确定性工作流编排引擎**，面向软件开发者和 AI 工作流构建者，充当「流程管家」。

它以可视化 DAG 描述「AI 产出 → 人工审核 → 修改迭代」等可复现流程，把大模型从「自由对话」约束到「按图执行」的确定性轨道；同时保留对话入口，让 AI Agent 辅助生成、调度与监控工作流。确定性与自主性并存：**流程型任务走工作流图，自由任务走对话**。

### 1.2 部署形态

- Web 服务 + 本地部署（Docker Compose 或裸机），数据主权保留在本机，**不提供桌面端**。
- 默认回环绑定（`127.0.0.1:2026`），需要对外服务时显式设置 `BIND_HOST`。
- **双入口平权**：可视化画布（React Flow）与 AI 对话助手，控制同一运行生命周期，行为一致。

### 1.3 核心设计目标

1. **领域无关**：核心引擎不依赖任何游戏引擎或专业软件，领域特定能力通过能力包/技能插件化接入。
2. **人机协同**：人工操作是一等公民节点，支持审核、修改、跳过、打回重交等完整生命周期。
3. **两级扩展**：内置原子节点库 + 自定义能力（能力包 + 子工作流）。
4. **AI 辅助 + 可视化编排**：可视化编辑器拖拽编排 + AI Agent 自然语言辅助，两入口平权。
5. **嵌套复用**：子工作流嵌套 + 依赖快照，常用流程沉淀为可复用模板。
6. **能力按需加载**：能力包依赖在定义时声明、保存时静态校验、执行时懒加载。
7. **模型访问统一**：所有模型调用经 LLM 中间层，上层不直连厂商 SDK。
8. **工具供给统一**：所有工具能力经工具网关，MCP 是 provider 之一，不在其之上另造协议。
9. **可复现靠快照**：可复现由全量能力快照（lockfile）保证，而非靠版本号冻结。

## 二、技术栈

| 维度 | 技术选型 |
|---|---|
| **后端语言** | Python 3.12+（FastAPI Gateway + LangGraph 执行底座） |
| **执行引擎** | LangGraph `StateGraph`：checkpointer、interrupt、`Command(resume=)` 原生语义 |
| **前端** | Next.js 16 + React 19 + TypeScript，画布基于 React Flow |
| **图编辑** | React Flow（`frontend/src/components/workspace/workflows/`） |
| **能力抽象** | 能力包（功能组）：版本化技能（semver + 不可变版本目录）+ 契约（权限/评测/预算）+ custom agent 身份 |
| **LLM 访问** | LLM 中间层（统一模型访问层）：AI 节点与 lead agent 统一经此调用，中间层再适配各厂商 LLM |
| **工具供给** | 工具网关：统一描述符 + provider（builtin / skill / sandbox / mcp / acp） |
| **外部协议** | MCP（stdio / http / sse）+ Sandbox（本地 / Docker / provisioner） |
| **数据存储** | SQLite 或 Postgres（LangGraph checkpointer / Store / 应用表共享同库） |
| **包管理** | 后端 uv，前端 pnpm |

## 三、系统分层架构

八层，自上而下单向依赖；「定义层 + 编译层」、「模型访问层（LLM 中间层）」与「能力供给层（工具网关）」是 HNFlow 的核心新增，其余复用底层 harness。

```
┌─────────────────────────────────────────────────────────────┐
│ 用户交互层（Next.js）                                          │
│   ├── 对话界面（chat UI + SSE）                                │
│   └── 工作流画布（React Flow，/workspace/workflows/[id]）      │
├─────────────────────────────────────────────────────────────┤
│ 工作流定义层（backend/packages/harness/deerflow/workflow/）    │
│   ├── schema.py       节点/边/端口类型定义（Pydantic v2）      │
│   ├── workflow_io.py  定义校验 + JSON 序列化/迁移              │
│   └── registry.py     节点执行器注册表（幂等标注）             │
├─────────────────────────────────────────────────────────────┤
│ 编译层                                                       │
│   └── compiler.py     WorkflowDefinition → LangGraph StateGraph│
│       节点→图节点；边→普通边/条件边；端口→state 字段           │
├─────────────────────────────────────────────────────────────┤
│ 执行引擎层                                                    │
│   ├── worker.py       编排 run / checkpointer / SSE 事件       │
│   ├── executors/      ai / data / flow / human / tool          │
│   ├── prompts.py      三层提示词组装（身份→能力→任务）          │
│   ├── human_task_state.py  HumanTask 状态机                    │
│   └── delegate.py     运行期委派（子工作流 agent）             │
├─────────────────────────────────────────────────────────────┤
│ 模型访问层（LLM 中间层）                                       │
│   ├── 统一模型接口     AI 节点 / lead agent 经此创建与调用模型   │
│   ├── 厂商适配器       OpenAI / Anthropic / DeepSeek / vLLM 等  │
│   └── 能力归一         思考 / 视觉 / 流式 / 工具调用 / 结构化    │
├─────────────────────────────────────────────────────────────┤
│ 能力供给层（工具网关）                                         │
│   ├── 统一描述符       工具 schema / 权限 / 版本 / 来源能力包    │
│   ├── 调用治理         权限裁决 / 路由 / 审计 / 幂等 / 预算      │
│   └── provider         builtin / skill / sandbox / mcp / acp    │
├─────────────────────────────────────────────────────────────┤
│ 能力包层                                                      │
│   ├── skills/         版本化技能 + 依赖解析 + 契约              │
│   ├── sandbox / subagents / extensions                        │
│   └── custom agents   agent_name → SOUL + 工具集               │
├─────────────────────────────────────────────────────────────┤
│ 基础设施层                                                    │
│   ├── persistence/    workflow_definitions / human_tasks 表    │
│   ├── runtime events  JSONL / DB 事件流（SSE 驱动）            │
│   └── user-scoped storage（定义按 user 隔离）                  │
└─────────────────────────────────────────────────────────────┘
```

**核心理念**：`WorkflowDefinition` 是纯 JSON（可序列化、可校验、可版本化），编译后变成 LangGraph `StateGraph`（可执行）。可序列化由定义层保证，可执行 / 断点 / 挂起 / 恢复全部继承 LangGraph 语义。

- **定义层与执行层解耦**：数据模型不引入 LangGraph 依赖。
- **不造新调度器**：流程控制全部转为 LangGraph 语义（条件边 = Route 函数）。
- **校验器是纯函数**：图结构无环（迭代 DFS）、单起点单终点、端口类型匹配、参数合法，供后端保存与前端画布实时校验共用同一套规则。
- **模型访问统一入口**：AI 节点与 lead agent 经 LLM 中间层调用模型（第八节）。
- **工具供给统一入口**：工具能力经工具网关获取与调用（第九节）。

## 四、核心概念与数据模型

### 4.1 核心实体

| 实体 | 说明 |
|---|---|
| **工作流（Workflow）** | 节点与连线组成的有向无环图，可独立执行、可嵌套调用；定义即 `WorkflowDefinition` 纯 JSON |
| **节点（Node）** | 最小执行单元，含输入/输出端口、参数、能力包声明、主身份绑定 |
| **端口（Port）** | 数据输入/输出接口，类型枚举 `data/file/bool/enum`，连线时校验兼容性 |
| **能力包（Capability Package）** | 按领域划分的能力声明与契约，AI 节点的工具与规则来源 |
| **人工任务（HumanTask）** | 挂起工作流等待人工处理的待办，状态机 `pending → submitted / skipped / reopened / expired` |
| **子工作流（Subworkflow）** | 引用另一 definition 的节点，支持编译期子图与运行期委派 |
| **lockfile（能力快照）** | 一次运行的全量能力快照：`guid@version` + 模型版本 + prompt/tool schema hash + MCP 版本 + 采样参数 |
| **checkpoint** | LangGraph 断点持久化，一个工作流实例 = 一个 thread_id |

### 4.2 数据模型（`workflow/schema.py`）

- `Port`：`{name, type: PortType, required, description}`。
- `Node`：`{id, type: NodeType, inputs: Port[], outputs: Port[], params, capability_groups[], agent_name}`。`agent_name` 是 AI 节点的主身份绑定（`None` = 默认 lead 身份）。
- `Edge`：`{source, source_port, target, target_port, condition?}`。
- `WorkflowDefinition`：`{id, name, version, nodes, edges, metadata}`。
- `WorkflowMetadata`：`{resolved_groups, lockfile, created_at, updated_at, pending_review_nodes}`。

约束：
- `id` 校验为稳定标识（`^[A-Za-z0-9_-]{1,64}$`），禁止路径字符（落盘安全依赖此约束）。
- `Port.type` 用枚举，禁止字符串自由值。
- 模型 `extra="forbid"`，禁止宽松 dict。

### 4.3 端口数据流

节点间仅通过端口传数据，端口经 state 字段流转，字段命名 `wf:<node_id>:<port>`，由 compiler 绑定；节点执行函数与 state 解耦。同名端口因带 node_id 前缀而互不覆盖，reducer 语义默认「覆盖」。

## 五、能力包（功能组）体系

能力包是 AI 能力的抽象单元，是「一组按领域划分的能力」的一等公民。

> 5.1–5.4 为现状；5.5–5.12 为能力包体系的目标设计（落地路线见第十八节）。

### 5.1 三层职责拆分（目标）

| 层 | 内容 | 性质 |
|---|---|---|
| **声明层** | 工具 schema、规则、依赖、权限、示例、评测 | 版本化、可复现 |
| **执行层** | 工具装配 / 检索 / 权限裁决（经工具网关） | 运行时、动态 |
| **身份层** | custom agent（`agent_name` 绑定 config + SOUL） | 独立，一节点 = 身份 × N 能力包 |

- **身份与能力解耦**：能力包不含身份；节点用 `agent_name` 绑定身份，`capability_groups` 供给能力，避免人格冲突。

### 5.2 组成与实现映射

| 能力维度 | 实现 |
|---|---|
| 工具/技能 | 版本化技能（`skills/`），`allowed-tools` 声明可用工具 |
| 规则 | 技能正文 + rules 并入提示词能力层 |
| 身份 | custom agent（`agent_name` 绑定 config + SOUL），一节点一主身份 |
| MCP | 经工具网关接入；能力包以 `mcp:{server}@range` 声明依赖（现状为全局配置） |

### 5.3 版本化存储

- **GUID 不变性**：安装时生成 GUID，改名/移动写入 aliases，引用永远有效；路径仅用于展示与语义理解。
- **语义版本 + 不可变版本目录**：布局 `<root>/{public,custom}/<name>/v<semver>/SKILL.md`，已发布版本目录只读，修改 = 创建新版本；写路径走原子替换。
- **旧布局迁移**：无版本目录的旧技能迁移到 `v0.1.0`（`scripts/migrate_skills_versioned.py`）。
- **当前版本选择**：未指定版本时取版本列表最高者。

### 5.4 依赖解析

- frontmatter 声明 `dependencies: [{guid, versionRange}]`；MCP 依赖声明为 `mcp:{server}@range`。
- 保存工作流时递归收集节点能力包依赖，固化为 `resolved_groups`（`guid@v<version>` 集合）落盘。
- 静态校验存在性、版本范围，并做跨实体循环检测。
- **统一依赖图**（`dependency_graph.py`）：聚合「工作流→子工作流、能力包→能力包、能力包→MCP」三类引用，全局 DFS 循环检测，输出完整循环路径。

### 5.5 能力包契约（目标）

每个能力包声明并在导入/升级时校验：

- `permissions`：`fs` / `net` / `exec` / `secrets` 最小权限，运行时由工具网关裁决。
- `evals`：示例任务 + 期望断言；导入/升级/CI 时执行，不通过则拒绝或降级。
- `tool_schema_version` + 结构化 changelog + 行为兼容标记（语义版本之外再标行为兼容性）。
- `context_budget`：工具描述 token 预算。
- `required-secrets`：请求级密钥声明。

### 5.6 可复现性：全量能力快照（lockfile，目标）

- 锁的不只是 `guid@version`，还含：**模型 id/版本、prompt hash、工具 schema hash、MCP server 版本、采样参数**。
- 运行时恢复以 lockfile 为准 → 版本**可自动升级**（含安全补丁），lockfile 仍保证回放确定。
- 用 lockfile 取代「靠版本号冻结」的虚假确定性：模型权重、MCP 远程行为、采样参数都会漂移，只锁能力包版本锁不住行为。

### 5.7 工具命名与消歧（目标）

- 默认保留**语义工具名**；冲突用「工具描述消歧 + 模型可见别名 → 执行层映射真实工具」。
- 统一 MCP 与 skill 的命名机制，取消机械双轨前缀。
- GUID 只留存储/执行层，**不注入 LLM 上下文**（对 LLM 无意义，浪费 token）。

### 5.8 组合机制（目标）

- 提供 `extends` / `overlay` / `peerDependencies` + profile（能力组合预设），抑制细粒度依赖爆炸。

### 5.9 缓存友好纪律（目标）

- 能力集在**会话/run 开始冻结**，system 前缀稳定；运行期只做检索排序，不增删前缀内容。
- 工具集排序确定化（拓扑 + 名称），保证 prompt cache 前缀稳定。

### 5.10 冲突处理（目标）

- 放弃 natural-language 规则的静态互斥判定（不可行——NL 规则无法静态判互斥）。
- 改为规则分层（身份 / 能力 / 任务）+ 显式优先级 + 拼装时模型消解确认 + 同激活组可观测。

### 5.11 版本生命周期（目标）

- patch 可自动升级（可关），minor/major 手动；lockfile 固定回放；`securityAdvisory` 强制升级。

### 5.12 可观测与评测闭环（目标）

- 每能力包记录 per-group 指标：工具调用成功率、token、延迟、拒绝率，驱动能力改进。

## 六、节点体系

节点按类型分六类，`id` 后为 `NodeType` 枚举值。

### 6.1 流程控制（flow）

| 节点 | 说明 |
|---|---|
| `flow:start` | 工作流入口，无输入触发一次 |
| `flow:end` | 终止节点，收集最终结果 |
| `flow:if` | 条件分支，按真值路由 true/false 端口 |
| `flow:switch` | 多分支，按 `params.cases` 匹配点亮分支端口 |
| `flow:loop` | 循环，输出 `iteration`/`out`（简单版） |
| `flow:parallel` | 并行 fan-out/fan-in 透传（LangGraph 原生多出边并行） |
| `flow:wait` | 延时，按 `params.duration` 秒睡眠后透传 |

### 6.2 数据操作（data）

`data:assign`（赋值/透传）、`data:convert`（类型转换）、`data:file`（沙箱文件读写）、`data:json`（stringify/parse）、`data:regex`（正则匹配/替换）。

### 6.3 工具调用（tool）

`tool:bash`（沙箱命令，**必须走 sandbox**）、`tool:http`（HTTP 请求）、`tool:notify`（用户通知）、`tool:log`（日志透传）。

### 6.4 AI（ai）

`ai:llm_agent`——三层提示词 + 受限执行体，见第七节；模型调用经第八节 LLM 中间层，工具经第九节工具网关。

### 6.5 人工（human）

`human:task`——挂起并生成 HumanTask，见第十节。

### 6.6 嵌套（nested）

`nested:subworkflow`——编译期子图或运行期委派，见第十一节。

## 七、AI 节点

### 7.1 三层提示词

AI 节点提示词运行时按**身份 → 能力 → 任务**三层拼装（`workflow/prompts.py`，纯函数）：

```
身份层：agent_name 对应 custom agent 的 SOUL（None → 默认 lead 身份）
能力层：关联能力包的 rules / 工具描述 / allowed-tools 并集
任务层：节点 instruction 模板（画布上写，每节点一份），支持 {{port}} 插值
```

- 一个 AI 节点 = 一个主身份 + 若干能力供给包（能力并集），避免人格冲突。
- 任务层模板必填，留空保存校验报错。
- **AI 节点 ≠ 自由 ReAct loop**：节点内只能调用关联能力包声明的工具，LLM 只决策「调用哪个工具、按模板产出什么」。

### 7.2 双端口会话模式

| 输入端口 | 有值行为 |
|---|---|
| `template_prompt` | **reset 模式（默认）**：模板 + 端口输入全量重跑，历史清空，适合确定性模板任务 |
| `continue_prompt` | **continue 模式**：新提示词 append 到该节点既有会话，resume checkpoint 继续，适合迭代任务 |

- 优先级定死：`continue_prompt` 有值 → continue；否则 → template。
- 会话 key 稳定：`checkpoint_thread_id = {origin_thread_id}:wfai:{node_id}`，跨 run 经 context 注入 `ai_origin_thread_id` 定位旧会话。
- continue 仍限关联能力包工具，loop 迭代次数即硬上限。

### 7.3 执行体

- 复用受限 SubagentExecutor 执行（非自由 lead 会话）。
- 工具集 = 主 agent 工具 + 全部关联能力包 allowed-tools 并集，经工具网关（第九节）装配。
- 模型调用统一经 LLM 中间层（第八节），不直连厂商 SDK。
- 非幂等：`idempotent=False`，重试需人工确认。

### 7.4 Token 与缓存观测

- 节点 `token_usage`（含稀疏 `cache_read_tokens`）经保留通道由 worker 聚合进 `run.end.content["token_usage"]`。
- 无用量节点保持 absent，绝不补零；`get_workflow_run` 暴露可选 `token_usage`。

## 八、LLM 中间层（模型访问层）

**定位**：所有模型访问的统一入口。AI 节点与对话侧 lead agent **不直接引用任何厂商 SDK**，一律引用 LLM 中间层；中间层再向下具体引用各厂商 LLM。换厂商、加新模型、改协议只动中间层，上层节点与 agent 零改动。

**引用关系**：

```
AI 节点执行体 ─┐
              ├─→ LLM 中间层 ─→ 厂商适配器 ─→ OpenAI / Anthropic / DeepSeek /
lead agent  ──┘                              Google / vLLM / OpenAI 兼容端点 …
```

**职责**：

- **统一模型接口**：模型的创建与调用（invoke / stream）走同一接口，上层不感知厂商差异。
- **厂商适配**：向下对接各厂商 SDK/HTTP，封装鉴权、base_url、协议差异与请求/响应字段映射。
- **能力归一**：思考模式（thinking/reasoning）、视觉（vision）、流式、工具调用（tool calling）、结构化输出统一抽象，各厂商按能力声明映射。
- **模型选择与路由**：按模型名解析到具体厂商与实例；支持运行时切换、按 run/节点选择模型。
- **可靠性**：统一错误归一、超时与重试、限流与配额。
- **可观测**：统一 token 用量与缓存命中计量，供 run 聚合与成本统计。

**边界**：中间层只负责「模型访问」。提示词组装（三层）、工具装配、agent 循环属于上层，不下沉到中间层。

**扩展方式**：新增厂商 = 在中间层加一个适配器并注册，上层无需改动。

## 九、工具网关（能力供给层）

**定位**：所有工具能力的统一供给与治理入口。AI 节点、lead agent 及能力包一律经工具网关获取与调用工具，**不直接引用某个工具来源**。**MCP 是网关下的一个 provider**，不在 MCP 之上另造一层协议。

**与 LLM 中间层的区别**：

- LLM 中间层抹平厂商差异——「调模型」是同构原语，差异几乎全是管道，可在 invoke/stream 后完全隐藏。
- 工具网关归一**描述符**与**调用治理**，但**不隐藏执行语义差异**：本地 builtin / 远程 MCP / 沙箱命令 / skill 脚本 / ACP 的执行位置、权限、副作用本就不同，网关只**分类治理**，不抹平异构。

**结构**：

```
上层（AI 节点 / lead agent agent loop）
        │  统一描述符 + 调用信封
        ▼
   工具网关（注册表 + 治理：权限 / 路由 / 审计 / 幂等 / 版本 / 预算）
        │  分派执行（异构）
        ├── builtin（本地）
        ├── skill-script（能力包自带执行体）
        ├── sandbox（命令 / 文件，强制隔离）
        ├── mcp（stdio / http / sse）   ← provider 之一
        └── acp
```

**职责**：

- **统一描述符（唯一真相源）**：`id / 语义名 / 别名 / JSON schema / provider / version / 权限 / 幂等 / 副作用级别 / 来源能力包 / context 预算`。供依赖解析、lockfile、命名消歧、权限裁决、缓存稳定共用。
- **统一调用信封**：权限裁决 → provider 路由 → 结果/错误归一 → 审计与成本归因 → 幂等 / crash-confirm。
- **provider 分派**：执行留给 provider；网关只做分类治理。
- **MCP 收编**：MCP 的 `tools/list` 输出摄入为描述符，MCP server 版本成为 provider 元数据；能力包经 `mcp:{server}@range` 声明依赖（第五节）。

**边界与反面清单**：

- 不在 MCP 之上再造协议（避免双轨命名空间前缀）。
- 不假装工具可互换：`bash` 不能透明换成远程 MCP 工具（副作用 / 沙箱不同）。
- 不重造 LangChain 的工具绑定；保持薄（描述符 + 信封），不引入重型运行时。
- 不是执行引擎：LLM 层是一次调用，工具网关是「发现 + 多 provider + 策略」。

**收益**：描述符成为唯一来源后，工具 schema 前缀稳定（服务 prompt cache），能力包可统一声明工具与 MCP 依赖，E 项（MCP 入包）才有结构落点。

## 十、人工节点与统一挂起

### 10.1 HumanTask 生命周期

- 工作流执行到人工节点 → 挂起 `WaitingForHuman`，生成持久化待办。
- 待办含任务描述、上游输入快照、`output_spec`、`validation_rules`。
- 状态机（`workflow/human_task_state.py`，纯函数 + 转移表）：
  `pending → submitted / skipped / reopened / expired`。
- 用户提交后按 `output_spec` + `validation_rules` 校验（格式/必填/命名），通过则流程继续；失败回 `reopened` 打回重交。
- 支持跳过（`{"__skip": True}`）。

### 10.2 统一挂起（AI 中断 = 人工节点）

- AI 节点内部 LangGraph `interrupt()` 统一转化为 HumanTask 待办，外层封装层无需感知内部类型。
- **主键绑定**：以 HumanTask ID 为持久化主键，记录 checkpoint 引用。
- **恢复链路**：提交/跳过 → 按记录定位 checkpoint → `Command(resume=...)` 恢复对应节点，传入用户提交值。
- 恢复失败时任务回 `pending`，不丢用户输入。
- 状态与命令复用 LangGraph/现有 run 生命周期，不引入新执行循环。

## 十一、子工作流与嵌套

### 11.1 两种模式

| 模式 | 实现 | 特点 |
|---|---|---|
| **编译期子图** | definition 引用另一 definition，compiler 内联展开为嵌套 `StateGraph` | 自动获得子图 checkpointer / 错误传播 |
| **运行期委派** | 节点执行 = 增强版 task_tool，委派子工作流 agent 执行 | 子代理 `checkpointer=True`，递归按需放开 |

### 11.2 隔离与边界

- 子图 state 与父图 state 分离，仅通过端口映射通信。
- **写时复制边界**：跨子图边界做浅复制（`_copy_on_write`），不 deepcopy，保持大值嵌套共享。
- 编译前做嵌套深度限制（默认 ≤10 层）与全局依赖图循环检测，报完整引用链。

## 十二、执行引擎

### 12.1 编译与执行

- `compiler.py`：`compile_definition(def, context) → CompiledStateGraph`；节点→图节点、边→普通边/条件边；编译产物按 definition 哈希缓存，变更自动失效。
- `worker.py`：接收 definition id + 输入参数 → 编译 → `graph.astream(..., stream_mode=["updates","custom"])` 执行。

### 12.2 run 生命周期与事件

- 复用 run 生命周期：RunRecord、checkpointer、run events（JSONL/DB）、SSE 节点级事件 `wf:node:started|completed|failed`。
- 一个工作流实例 = 一个 thread_id；子图/并行分支用不同命名空间隔离状态。
- 取消/超时复用现有取消机制。

### 12.3 断点续跑

- LangGraph checkpointer（sqlite/postgres）覆盖整图（含子图）。
- 每步执行状态持久化，进程崩溃后重启可从断点恢复。
- 挂起（人工待办）状态同样持久化，重启后仍在待办列表。

### 12.4 幂等与确认

- 每个节点显式标注 `idempotent`（`registry.py`）。
- 非幂等节点（`tool:bash` / `tool:http`）标注 `requires_confirmation`，留 crashConfirm 钩子，失败不自动重试，转人工确认。

## 十三、外部工具连接与沙箱

### 13.1 MCP

- 支持的传输：stdio / http / sse；OAuth；session pool；`tool_search` 懒加载；路由提示。
- MCP 经工具网关（第九节）作为 provider 接入；被收编为统一描述符后，能力包可经 `mcp:{server}@range` 声明依赖。

### 13.2 Sandbox

- 多模式：本地 / Docker / provisioner(K8s)。
- `tool:bash` 等命令类节点强制走沙箱执行（`Sandbox.execute_command`），**禁止直连宿主 shell**。
- 文件读写同受沙箱文件系统约束。

### 13.3 工具节点

`tool:bash`/`tool:http`/`tool:notify`/`tool:log` 为内置原子工具节点；AI 节点的工具调用经工具网关走其受限执行体。

## 十四、对话侧调度

lead agent 自身经 LLM 中间层（第八节）调用模型、经工具网关（第九节）装配工具，不直连厂商 SDK 或工具来源；其内置工作流工具与画布走**同一套 API**（双入口一致性，无旁路）：

| 工具 | 作用 |
|---|---|
| `generate_workflow(prompt)` | 自然语言 → WorkflowDefinition，过校验器（失败自动修正重试 ≤2 次）后保存；危险节点默认带「待审核」标记 |
| `edit_workflow(definition_id, instruction)` | 读现有定义 + 指令完整重生成，更新同一 definition_id |
| `run_workflow(definition_id, params, wait)` | 启动运行；`wait=True` 轮询至终态并聚合节点进度，`wait=False` 后台执行 |
| `get_workflow_run(run_id)` | 反复查询运行进度（含可选 token_usage） |
| `continue_node(run_id, node_id, prompt)` | 对 AI 节点会话追加提示词继续执行 |
| `list_human_tasks` / `submit_human_task` / `skip_human_task` | 查询待办、提交（校验后触发 resume）、跳过 |
| `pause_workflow` / `resume_workflow` / `cancel_workflow` | 运行控制（包装 run API） |

约束：生成结果必须通过图结构校验才可保存（「Agent 只能调用已注册能力」的强制边界）；异常修复的自动重试仅限幂等节点，非幂等节点失败转人工确认。对话侧工具经 Gateway 运行单例与画布共用同一 run 生命周期，失败时聚合 `wf:node:*` 事件给出修复信息。

## 十五、数据存储与隔离

- 统一 `database` 配置选择 SQLite 或 Postgres：LangGraph checkpointer / Store / 应用表共享同库。
- 应用表：`workflow_definitions`（id/user_id/name/schema_version/definition/metadata/resolved_at/lockfile）、`human_tasks`（id/run_id/node_id/status/描述/输入快照/输出规范/校验规则/checkpoint 引用/user_id）。
- **原子写入**：临时文件 → fsync → 原子替换。
- **用户隔离**：`user_id` 作用域存储，多用户同名工作流互不可见；无鉴权模式 fallback `default`。
- 产品形态为本地部署，协作通过导入导出 + Git 实现。

## 十六、安全

- **默认 loopback 绑定**：compose 入口默认 `127.0.0.1:2026`，不暴露公网。
- **沙箱隔离**：命令类节点强制走 Sandbox，禁止直连宿主 shell；文件写入受沙箱约束。
- **危险节点待审核**：AI 生成的 `tool:bash` / `tool:http` 默认写入 `pending_review_nodes` 元数据；`run_workflow` 启动时 pre-flight 拦截待审核节点，执行器的 `crash_confirm` 门是最终强制边界。
- **非幂等人工确认**：涉及覆盖、提交、删除、发布等操作不自动重试，转人工确认。
- **能力包最小权限**：能力包声明 `permissions`（fs/net/exec/secrets），运行时由工具网关裁决（目标设计）。
- **依赖静态校验**：能力包依赖存在性、版本范围、循环引用在保存时静态拦截。
- **生成必校验**：任何 AI 生成的工作流必须过图结构校验才可保存。

## 十七、关键设计原则

1. **领域无关**：核心引擎不绑定任何领域，能力通过能力包插件化接入。
2. **定义/执行解耦**：`WorkflowDefinition` 纯 JSON 可序列化；执行全部交 LangGraph 语义。
3. **不造新调度器**：流程控制转为条件边/普通边，出错行为沿用 LangGraph 默认。
4. **模型访问统一**：AI 节点与 lead agent 经 LLM 中间层调用模型，禁止上层直连厂商 SDK，换厂商只动中间层。
5. **工具供给统一**：所有工具能力经工具网关；MCP 是 provider 之一，不在其之上另造协议；网关只治理、不抹平执行异构。
6. **可复现靠快照**：可复现由全量能力快照（lockfile：模型/prompt/tool schema/MCP 版本/采样参数）保证，而非版本号冻结。
7. **能力包契约化**：能力包以契约（权限 / 评测 / schema 版本 / 预算）分发，导入/升级即校验。
8. **身份唯一**：一个 AI 节点一个主身份，能力可并集，禁止隐式多身份路由。
9. **GUID 不变性**：能力包 GUID 创建后终身不变，路径仅用于展示与语义理解。
10. **版本不可变**：每个版本目录是只读快照，修改即创建新版本。
11. **节点锁定版本**：依赖固定 `guid@version`，lockfile 负责回放确定。
12. **按需加载**：能力包内容执行到对应节点时懒加载，实例生命周期内缓存复用；能力集在会话/run 开始冻结以保证缓存前缀稳定。
13. **人工一等公民**：人工节点与 AI 中断统一为 HumanTask，对外层透明。
14. **状态强持久化**：每步落盘，异常退出无损恢复。
15. **运行时只读**：工作流执行时画布禁止编辑结构，防止两侧状态不一致。
16. **原子写入**：所有文件写入采用临时文件 + 原子替换。
17. **能力边界透明**：Agent 通过能力包命名理解能力边界，生成必校验。
18. **防递归**：嵌套前做循环引用检测，设最大嵌套深度（默认 10 层）。

## 十八、后续规划

以下为当前设计尚未覆盖、按需排期的开发方向：

- **能力包体系落地**：按第五节目标设计分步落地——能力包契约（权限 / 评测 / schema 版本 / 预算）、全量能力快照 lockfile、工具命名消歧、组合机制（extends/overlay）、缓存纪律、冲突处理与 per-group 可观测。
- **工具网关落地**：按第九节实现统一描述符 + 调用信封 + provider 分派，将 MCP 收编为 provider，打通能力包 `mcp:{server}@range` 依赖。
- **容错编排**：Try-Catch / Finally 节点，子图异常捕获走 catch 分支；失败降级与失败回调。当前流程控制仅 if/switch/loop/parallel/wait。
- **并发治理**：并行分支上下文隔离与可配置合并规则（后者覆盖/数组合并/冲突报错）、共享变量机制；外部软件实例级互斥的资源锁管理器（可重入锁 + 跨进程文件锁 + 统一加锁顺序）。
- **工具节点化**：MCP 工具直接调用节点（`mcpTool`），当前 MCP 仅经工具网关/AI 节点工具集可用。
- **调试能力**：节点断点、单步、回退重跑；当前仅有事后调试面板（日志/变量/节点状态）。
- **Loop 正宗版**：子图展开 + 条件边 + `results`/`last` 聚合输出（当前为简单版：`iteration` 轮次计数 + `out` 透传）。
- **成本与缓存优化**：缓存感知执行顺序规划器（观测已落地，规划器待 benchmark 后立项）；AI 节点级动态工具裁剪（子集选择 / 动态检索 / Token 预算联动）。
- **复杂任务分诊**：由画布条件边显式路由承载，不放开节点内自由路由。
- **执行数据分析**：节点耗时统计、瓶颈识别、Token 预算告警 UI。
