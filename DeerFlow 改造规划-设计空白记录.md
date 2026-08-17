# DeerFlow 改造规划 — 设计空白记录

> 记录审阅《DeerFlow 改造规划.md》时发现的设计空白、建议与修改方案。仅记录，不修改规划正文。

## 背景（已确认的相邻结论）

- 改造后 lead agent 双角色：对话侧保留（工作流生成/调度/监护），工作流 AI 节点是「lead_agent 同款工厂产出的受限执行体」，非完整 lead agent 会话。
- 功能组 = 现有 Skill 目录 + 不可变版本层（`v<semver>/`）+ 身份文件（`agent.md`）+ GUID 元数据（`group.json`）+ 节点执行函数。
- T8 依赖机制：声明 `guid@versionRange` → catalog 静态校验 → 装配层加命名空间前缀 → 工作流保存时递归收集 `resolvedGroups` 快照。

## 空白 1（核心）：AI 节点 × 功能组 × agent 关系未定义

**问题**：一个 AI 节点声明多个功能组（每功能组含 `agent.md` 身份）时，如何决定当前任务使用哪个 agent？

**现状缺口**：
- T1 `Node` 模型只有 `capabilityGroups[]`，无主/次区分，也无 `agent_name` 绑定字段。
- T8 只解决依赖解析（存在性/版本/环），未解决多身份竞争。
- 若多组 `agent.md` 并集拼进一个 system prompt，会产生人格冲突。

**文档约束**（推导依据）：
- AI 节点 ≠ 自由 ReAct loop：LLM 只决策「调哪个工具、按模板产出什么」。
- 现有 custom agent 机制：一次 run 只有一个 `agent_name`（单一身份）。
- 多 agent 动态路由违反上述约束，文档未支持。

## 建议机制：静态绑定主身份 + 能力并集

```
① 节点定义时静态绑定主身份
   params: { agent_name: "发布专家" } 或 primaryGroup: <guid>
   → 一个节点 = 一个主 agent（走 custom agent 路由）

② 其余功能组降级为能力供给
   工具集 = 主 agent 工具 + 全部关联组 allowed-tools 并集
   能力层（rules/工具描述）全部并入 prompt
   身份层只有一份：主 agent 的 agent.md/SOUL

③ 任务层指令驱动「当前任务做什么」（模板/委托两档）

④ LLM 唯一决策：从受限工具集里选工具。不选 agent、不自由路由。
```

**「多 agent」语义区分**：

| 语义 | 机制 | 决定者 |
|---|---|---|
| 多功能组 = 多身份 | 节点声明主身份，其余做能力并集 | 工作流作者（画布绑定） |
| 多个 custom agent | 节点 `params.agent_name` 静态绑定一个 | 工作流作者（画布绑定） |
| 多 agent 动态路由 | 不支持——拆成多 AI 节点 + 条件边，或委托模式委派 | 显式画进图，不隐式路由 |

## 空白 2：AI 节点会话连续性未定义

**问题**：AI 节点执行后，能否在「该节点的会话」接着上下文继续给出新提示词继续执行？规划默认不支持——节点执行是一次性语义（模板拼 prompt → 执行 → 写端口），无节点级会话模型。

**底层原料已具备**：

| 能力 | 位置 |
|---|---|
| 对话级持久化 | LangGraph checkpointer + thread_id（lead agent 现成） |
| 节点级命名空间 | T6：子图/并行分支用不同 `recursion` 命名空间防串扰 |
| 受限 agent 工厂 | `create_deerflow_agent`，节点执行体本身是 LangGraph 子图，可挂 checkpointer |
| 挂起恢复链路 | T13：HumanTask → `Command(resume=...)` |

**建议**：节点会话模式 `reset / continue` 两档：
- **reset（现状，默认）**：模板 + 端口输入全量重跑，消息历史清空。适用确定性模板任务。
- **continue（新增）**：append 新提示词到节点会话消息历史 → resume 该节点 checkpoint → 继续跑 → 结果写端口。适用迭代式任务。
- 会话 key = `(run_id, node_id)`，映射 checkpointer 独立 `checkpoint_ns`。
- 恢复入口：画布节点「继续会话」（T15/T16）、lead agent 工具 `continue_node(run_id, node_id, prompt)`（T18）、HumanTask 答复回灌。
- 约束检查：continue 不违反「AI 节点 ≠ 自由 ReAct」——仍限功能组工具，只是多轮受限对话；会话长度用 SummarizationMiddleware 或轮数上限控制。

**落地状态（2026-08-14，计划 `.opencode/jobs/20260814_181109_ai-node-session-loop/`）**：已落地。`executors/ai.py` `exec_llm_agent` 双模式：`continue_prompt` 非空 → continue（checkpointer + `checkpoint_thread_id=f"{origin_thread_id}:wfai:{node_id}"`，跨 run 经 context 注入 `ai_origin_thread_id`），否则 template（reset，执行前清空旧会话）；`checkpointer=None`（memory backend）显式降级 reset。对话侧 `continue_node` 工具 + REST `POST /{definition_id}/runs/{run_id}/continue` + 画布运行面板 continue 表单。测试 `tests/test_workflow_ai_continue.py` / `test_workflow_continue_tool.py` / `test_workflow_run_continue_route.py`。

## 空白 3：Loop 节点语义与端口未定义

**文档明示**仅：T5「loop 用固定迭代数（简单版）」，T9「深层循环持久化用 LangGraph 递归或 checkpointer 语义补」。

**两层语义**：
- **简单版（T5 占位）**：loop 内部 `for i in range(n)` 顺序调用循环体执行器，固定次数，断点仅整节点粒度。
- **正宗版（T4+T9 最终形态）**：compiler 把 loop + 循环体展开为 LangGraph 子图，循环 = 条件边（Route 函数判断 continue/exit）+ checkpointer 记录每轮迭代状态。遵循 T4「不造新调度器，全部转 LangGraph 语义」。

**端口连接规范**（推导建议，T1 落地需补定义）：

| 端口 | 方向 | 说明 |
|---|---|---|
| `items` | 输入（可选） | 遍历模式：待遍历集合 |
| `iterations` | 输入（可选） | 次数模式：固定迭代数 |
| `break_condition` | 输入（可选） | 外部终止条件 |
| `on_result` | 输入 | 循环体末节点回报本轮输出 |
| `item` | 输出 | 当前轮数据 → 循环体首节点 |
| `results` | 输出 | 聚合结果（每轮输出列表） |
| `last` | 输出 | 最后一轮输出 |

循环体接线：上游 → `loop.in`；`loop.item` → 循环体首；循环体末 → `loop.on_result`；`loop.results/last` → 下游。迭代直至条件变体：循环体末 → if 条件边自环回环，loop 退化为深度限制器。

**落地状态（2026-08-14，同计划）**：简单版端口已落地。`compiler._loop_node_fn` 补写 `wf:<loop_id>:iteration`（镜像轮次计数）+ `wf:<loop_id>:out`（`in` 入口值透传，`state.get(in_state_key)`），与前端 catalog 声明一致；迭代计数仍走 `wf:<loop_id>:__count`。正宗版（子图展开 + 条件边 + `results`/`last` 聚合）留后续。测试 `tests/test_workflow_loop_ports.py`。

## 修改方案：AI 节点双端口 + 人审打回重改（综合空白 2/3）

**AI 节点双输入端口**（双端口即模式开关，无需 `params.session_mode`）：
- `template_prompt`（text/data）：有值 → **reset 模式**——create_agent 全量执行（模板拼 system，输入作任务层）。
- `continue_prompt`（text/data）：有值（且 template 空）→ **continue 模式**——append 到该节点现有会话，resume checkpoint 继续执行。
- 执行器优先级：`continue_prompt` 有值 → continue；否则 → template。两端口同值歧义在模型层定死。

**目标场景**：AI 产出 → 人工审核 → 按建议同会话继续修改，直到通过或达上限。

```
start → 任务描述 → AI.template_prompt（初轮 reset）
                      ↓
                   AI 节点 ──→ draft 端口
                      ↓
                human_task 审核 → feedback 端口
                      ↓
                 if 通过?
                    ├─ 通过 → notify → end
                    └─ 不通过 → loop（迭代计数 + 深度上限）
                          loop.item（本轮 feedback）→ AI.continue_prompt
                          → AI 节点（continue）→ human_task → if ...（自环）
```

**关键机制**：

| # | 机制 | 说明 |
|---|---|---|
| 1 | 双端口优先级 | continue 有值 → continue；否则 → template |
| 2 | 会话 key 稳定 | key = `(run_id, node_id)`，checkpoint_ns 固定，loop 自环中同节点实例天然满足 |
| 3 | 命名空间解耦 | loop 迭代计数存 loop 命名空间；AI 节点会话只按 node_id 存，否则 continue 丢历史 |
| 4 | loop.item 通道 | 每轮向循环体传本轮新数据（审核意见逐轮不同） |
| 5 | 结果覆盖 | draft 端口每轮覆盖（T4 reducer 默认覆盖），下游永远审最新稿 |
| 6 | 会话长度控制 | SummarizationMiddleware 或轮数上限；loop iterations 即硬上限，防无限打回 |
| 7 | feedback 格式化 | append 前包一层（"用户要求修改：..."），区分新指令与历史对话 |

**结论**：原料齐全（节点会话 + loop 迭代 + human_task + T13 恢复），无新增系统组件；落地唯一要钉死的是机制 2/3 命名空间策略。

**落地状态（2026-08-14，同计划）**：双端口已落地。执行器单点判定优先级（`continue_prompt` 有值 → continue；否则 → template）——机制 1；会话 key = `checkpoint_thread_id=f"{origin_thread_id}:wfai:{node_id}"`——机制 2/3（loop 计数走 loop 命名空间 `wf:<loop_id>:__count`，AI 会话只按 node_id 存）。机制 4（loop.item 通道）随 loop 端口 `out` 透传实现；机制 5（draft 覆盖）沿用 T4 reducer 默认覆盖；机制 6（loop iterations 硬上限）既有。画布/表单双端口接线已落地（见空白 2 落地状态）。

## 方案：缓存感知的节点执行顺序规划

**动机**：主流模型缓存（Anthropic prompt caching / OpenAI automatic / DeepSeek context）= 相同 token 前缀的重复请求命中。单节点单次执行吃不到，收益集中在：同一 run 多节点共享功能组（N 节点共享 system 前缀，N-1 次命中）、loop/continue 多轮、跨 run 重跑（TTL 窗口内）。缓存命中主体是 **system 前缀**（功能组身份+能力+工具描述），任务层不影响。

**合理性边界**：
- 只重排**无依赖节点**（同一拓扑层）——DAG 数据依赖是硬约束，跨层节点物理上无法集中。
- 聚焦**缓存 TTL 窗口内**的相邻执行（Anthropic 5min/1h、OpenAI ~10min），不是全局最优排序。
- 前置条件：多节点共享功能组 + system 拼装确定性 + **共享块前置**（主身份/核心工具在 system 最前，辅助组在后，共享前缀才长）。

**注意点**：
1. 别为缓存牺牲并行——parallel 分支保持并行；串行链上相邻执行。
2. 反直觉：parallel 内节点同时发起，缓存尚未建立 → 可能全 miss；串行相邻反而第 2 次起全命中。
3. 静态规划 ≠ 实际路径（if/switch 条件分支）——**运行时局部贪心**（执行完选下一步时，优先共享功能组的可并行节点）比全局静态规划可靠。
4. 断点续跑需从当前 checkpoint **重新规划**，不能 run 开始时定死。
5. 高并发下收益打折（provider 缓存全局，其他 run 请求会 evict）。
6. **先量后做**：记录 `cache_read_input_tokens`/`cache_creation_input_tokens`，benchmark 对比后再定是否投入。

**推荐形态**（T6 worker 前可插拔「执行规划器」，默认简单策略，正确性不受影响）：
```
① 编译期：拓扑排序，层内按功能组聚类贪心排序（无依赖节点相邻化）
② 运行时：执行完节点，从候选可执行节点优先选与上一步共享功能组的
③ 恢复时：断点续跑后从当前 checkpoint 重新执行 ①
④ 观测：cache token 指标进 RunJournal，对比开关前后
```

**不做**：跨依赖层重排、全局最优求解、为缓存牺牲并行度。优先级排在 T4-T6 执行引擎之后、benchmark 验证收益后。

**落地状态（2026-08-14，同计划）**：观测先行已落地，规划器未做（收益未验证，遵循「先量后做」）。`exec_llm_agent` 聚合 `SubagentResult.token_usage_records`（含稀疏 `cache_read_tokens`）到保留结果键，编译器声明 `wf:<node_id>:__token_usage` 通道，worker `_aggregate_final_token_usage` 折叠进 `run.end.content["token_usage"]`（无用量节点 absent 保持 absent），`get_workflow_run` 暴露可选 `token_usage` 字段——不破坏 T18 既有契约。测试 `tests/test_workflow_cache_observability.py`。执行规划器（拓扑层内聚类 + 运行时局部贪心）待 benchmark 后另行立项。

## 建议落地位置

- **T1/T4**：`Node` 模型补——`agent_name`/`primaryGroup` + `auxiliaryGroups[]`（空白 1）；双输入端口 `template_prompt`/`continue_prompt`（修改方案）；loop 专属端口（空白 3）。模型层一次性补，别拖到 T8 后。
- **T6/T13**：节点会话机制（checkpoint_ns 持久化 + continue 执行）并进执行接线与挂起恢复链路。
- **T14/T15**：画布节点表单暴露主身份选择 + 辅助组勾选 + 双端口接线。
- **T18**：lead agent 工具 `continue_node(run_id, node_id, prompt)`。
- **T6 后（优化层）**：缓存感知执行规划器——拓扑层内聚类 + 运行时局部贪心 + 恢复重规划，先加 cache token 观测，benchmark 验证后启用。
- 后续：复杂任务分诊走画布条件边显式路由，不放开节点内自由路由。
