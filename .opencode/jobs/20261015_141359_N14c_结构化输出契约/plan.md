# N14-切片C 结构化输出契约（§24.4）— 执行计划

> 来源：《HNFlow 开发方案》§24.4（line 673-690）「AI 节点输出 schema + 校验 + 修复，与端口类型强绑定」：`params.output_schema`；校验失败进入**有界修复循环（≤N 次，带错误信息重试）**；仍失败则节点失败或转人工；schema 字段映射到输出端口、端口类型与字段类型一致（data/file/bool/enum + number/array/record）；记录校验失败率与修复次数。
> 目标仓库：`D:\workspace\work\HNFlow_deerflow-rebase`，分支 `deerflow-rebase`，起点 `fafaa1d`。
> 状态：**已完成（Option A，D1–D8 按建议；D7 的组合校验改为运行期）**。提交见 boulder.json `commit`。

---

## 一、现状（已核对代码）

- `ai:llm_agent`（`executors/ai.py`）把子代理的**自由文本**直接写 `out` 端口；端口类型（`PortType`）只是图上的静态契约，**不约束模型实际输出**——图上「确定性」在 AI 边界断裂（方案原文问题）。
- 输出端口 `out`（data）是前端目录默认；节点可额外声明输出端口。
- `_make_node_fn` 只把 executor 返回的、**已声明**的输出端口写进 state。
- repo **无** `jsonschema` 依赖，有 `pydantic`；现有代码**无**任何 structured-output 用法。
- 已有 reserved 通道先例：`__token_usage` / `__stop_reason`（AI 节点），`__shared_writes`（共享写）。

---

## 二、Option A（推荐）：`ai:llm_agent` 的 `params.output_schema`

### A1. schema 形态（依赖零新增）
```jsonc
"output_schema": {
  "fields": { "<field>": "data|number|array|record|bool|enum" },
  "required": ["<field>", ...],        // 可选；缺省 = 全部 required
  "enum_values": { "<field>": [...] }, // 可选，仅 enum 字段
  "max_repairs": 1                       // 可选；有界修复次数（0..5）
}
```
- 采用**字段→`PortType` 映射**（而非完整 JSON Schema/Pydantic 模型）：与「端口类型一致」天然对齐、**零新依赖**（不需要 `jsonschema`）。完整 JSON Schema 支持列后续。

### A2. 执行与修复循环（`exec_llm_agent`，仅 template 模式）
1. 在任务提示里追加「按 schema 输出**单个 JSON 对象**」的指令（含字段名/类型/required）。
2. 跑子代理 → 取 `out` 文本 → **剥代码围栏** → `json.loads`。
3. **校验**：必填字段在、类型匹配（`data`=任意、`number`=int/float 非 bool、`array`=list、`record`=dict、`bool`=bool、`enum`=值在 `enum_values`）。
4. 失败 → 把**校验错误**追加进提示，**有界重试**（≤ `max_repairs`，默认 1）。仍失败 → 节点**失败**（`WorkflowExecutionError`，含最后一次错误；「转人工」列后续）。
5. 成功 → 返回 `{"out": <原始文本>, "<field>": <value>, ...}`，由 `_make_node_fn` 按**已声明的输出端口**写入。
- 继续模式（continue）与 `output_schema` 组合：**MVP 不支持**（继续模式以会话续写为主），提供即编译期报错。

### A3. 端口绑定 / 编译期校验
- 每个 schema 字段**必须**在节点 `outputs` 里声明同名端口，且**端口类型 == 字段类型**；否则 `WorkflowCompileError`（把「确定性断裂」前移到编译期）。
- 节点仍保留 `out`（原始文本，向后兼容）。

### A4. 可观测
- reserved 通道 `wf:<node_id>:__schema_repairs`（int，实际修复次数）；0 也写（有 schema 即写），供 `run.end`/`get_workflow_run` 观测失败率与修复次数。
- 失败的 schema 名/错误只进 `WorkflowExecutionError` 信息，不进通道。

### A5. 兼容 / 迁移
- 纯新增参数与可选通道；未声明 `output_schema` 的节点行为字节不变。
- **无 schema 迁移、无新表、无新配置段、无新依赖**。

### A6. 前端
- AI 节点默认输出端口仍为 `out`；schema 字段由作者**加端口**（画布支持自定义端口）。本切片前端**零改动**（表单不渲染 `output_schema`，与 `autonomy`/`merge` 一致）。

### A7. 测试（TDD）
- 合法 JSON（裸 / 带代码围栏 / 前后有散文）→ 字段写端口、`__schema_repairs=0`。
- 首次非法、重试后合法 → `__schema_repairs=1`、字段正确。
- 始终非法 → 节点失败（`WorkflowExecutionError`，信息含最后错误）。
- 必填缺失 / 类型不符（number 收到 str、array 收到 dict…）/ enum 越界 → 各自失败。
- 编译期：字段无对应端口 / 端口类型不符 / `max_repairs` 越界 / 与 continue 模式组合 → 报错。
- 回归：AI 节点既有测试、全量离线 A/B 对拍。

### A8. 风险
- 低—中：全部在 `executors/ai.py` + compiler 校验 + 一个 reserved 通道；不碰执行主路径。
- **模型不一定吐合法 JSON**——修复循环 + 明确失败即为此设计；`data` 类型宽松兜底。

---

## 三、Option B：§24.6a 有界评审回环（备选）

- producer↔critic 迭代上限 + 评审结论注入下一轮 + 评审身份。
- 观察：多可由现成原语表达（`flow:loop` 正宗版 `results`/`last` + 回边喂回 critic 结论 + `data:shared` 黑板）→ **新能力增量较小**；列后续。

---

## 四、待确认决策

- **D1**：范围 = **Option A（§24.4 结构化输出，推荐）** / Option B（评审回环） / 两者。
- **D2**：schema 形态 = **字段→PortType 映射**（零新依赖），完整 JSON Schema/Pydantic 列后续 —— 确认。
- **D3**：类型集合 = `data|number|array|record|bool|enum`（`file` 列后续）—— 确认。
- **D4**：修复循环默认 `max_repairs=1`（可配 0..5），耗尽即**节点失败**（转人工列后续）—— 确认。
- **D5**：端口绑定 = 字段必须在 `outputs` 声明且**类型一致**，否则编译期报错；保留 `out` —— 确认。
- **D6**：可观测 reserved 通道 `wf:<node>:__schema_repairs` —— 确认。
- **D7**：仅 template 模式支持；与 continue 组合 → 编译期报错 —— 确认。
- **D8**：无迁移/无新表/无新配置/无新依赖；前端零改动 —— 确认。

---

## 五、验收标准
- 合法结构化输出写正确端口；非法输出经有界修复或明确失败；`__schema_repairs` 可观测；端口类型与数据一致（编译期 + 运行期双重）；未声明 `output_schema` 的节点行为不变。
- 全量离线回归失败集合逐条一致；ruff + 前端 `pnpm test`/`pnpm check` 绿。
- 文档同步：`AGENTS.md`（AI 节点/结构化输出）、`HNFlow 开发规划.md` N14/M5 状态。
