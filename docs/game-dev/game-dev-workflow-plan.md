# 游戏开发 HNFlow 工作流开发计划（v0.1）

> 状态：计划草案，未经人确认；本文件不包含任何已创建/已发布的流程定义。
> 配套文档：[`game-dev-capability-plan.md`](game-dev-capability-plan.md)（能力组 `game-dev`）。
> 源需求：《游戏开发文档流程》——单人开发 + AI + Skill 驱动 + Git 唯一历史 + 预览后落盘。

## 0. 结论摘要

- 用 **8 条流程**覆盖源文档的 W0–W9。P0 三条（`game-vision`、`game-gdd`、`game-change`）打通「生成 → 独立评审 → 预览 → 人裁决 → 落盘 → 复核」闭环，其余按 P1/P2 递进。
- 所有写流程共用一个 **10 节点骨架**：`intake → draft → lint → review → packet → gate → go → apply → audit`，失败走 `close` 收尾、`report` 汇聚为唯一终点。
- 源文档硬约束③（AI 写入前必须预览确认）由 `gate` 承担；硬约束①④⑤⑥ 不进流程（分别是能力组规则、Git 提交、触发器、美术元数据边界）。
- 流程**不提交 Git、不碰 `.hnflow/`、不写 `triggers.json`**；发布、门禁裁决、人工交付全部留给人。
- 先用**项目草稿**迭代，稳定后再移入仓库能力组随版本发布；是否发布由人决定。

## 1. 目标与非目标

目标：

1. 把「AI 起草设计/美术文档」变成可校验、可中断恢复、可问责的运行，而不是一次对话。
2. 把源文档的「预览 + 确认后才落盘」落成 HNFlow 的 `agent` 产物 + `gate` 快照。
3. 把「只有人才能提供的东西」（数值手感、真实美术资产、废弃承诺）落成 `request` + `verify`，不写进 instruction。
4. 每个节点一个可验收产物，产物以**路径 + 摘要**传递，正文留在磁盘。

非目标：

- 不做 Doc System 后端、索引服务、构建钩子（源文档的 `.doc-system` 不在本计划内）。
- 不做 HTML 预览界面，也不写 diff 渲染器；预览就是文档 + `git diff`。
- 不替代人做设计裁决，不自动提交，不自动发布。
- 不改 `plugins/dsh`：只用现有六种节点原语（见 §3 R1）。

## 2. 源文档语义 → HNFlow 落点

| 源文档理念 / 硬约束 | HNFlow 落点 | 说明 |
| --- | --- | --- |
| AI 写入前必须生成预览并由人确认 | `draft`（写预览文件）→ `packet` → `gate` → `apply` | 预览包是 gate 的直接上游产物，快照里可追溯 |
| 门禁只做「允许/拒绝/带修改批准」 | `gate` 三分支 `approved`/`rejected`/`modified` | `modified` 的理由即修改指令，交给 `apply` |
| 独立验收（AI 不给自己打分） | `judge`（preset `standard`），与全部 `agent`（preset `hnflow`）不同 | 评审意见进 gate 快照，供人参阅 |
| 人作为能力节点 | `request`（交付契约 + `whyHuman`）+ `verify`（schema/judge） | 数值基线、真实资产、归属确认 |
| 不做 Doc System UI，只用 Agent/Skill | 流程里不出现 UI/工具调用；文档契约进能力组规则 | instruction 只说「用哪个技能、交什么」 |
| 文档可手改、不锁、不阻断 | 无文件锁；手改后由 `game-change` 的 `scan` 重新对账 | 不设「必须走流程」的阻力 |
| Git 是唯一跟踪 | `audit` 只读 `git status`/`git diff`，**不提交** | 提交由人做，流程只交证据 |
| Luban 由文件变化自动构建 | 不进流程；`draft` 只在预览里提示「构建影响」 | 触发器或项目钩子由人写 |
| 美术只登记元数据与引用 | `game-art`/`game-asset` 只产出 manifest 与 `asset://` 校验 | AI 不解码图片视频内容 |
| 状态不阻断、AI 只能建议 `idea/draft/review` | 能力组规则约束 frontmatter；流程不改状态为 `approved` | 状态由人推进 |
| W8 只读查询 | `game-context` 单节点流程，不写文件 | 产物是上下文包路径 |

## 3. 插件事实与设计约束

| 事实 | 对设计的影响 |
| --- | --- |
| 六种原语：`agent`/`judge`/`merge`/`gate`/`request`/`verify`；本宿主未注册额外 kind | 不能用脚本节点；机械校验只能由 `agent` 按清单执行（R1） |
| 单起点 + 单终点、无环 | 驳回不能回边；`modified` 只能向前走（`apply` 按理由修正），重做靠再开一次 run |
| `gate` 有出边时必须三分支齐全 | 每条写流程都要有 `close`（rejected）分支 |
| `gate` 快照 = 直接上游的 output；卡片 detail 截断 4000 字符 | `gate` 前必须有 `packet` 汇合节点；摘要 ≤800 字符，完整预览写文件 |
| instruction 支持 `{{input.x}}`、`{{nodes.<id>.output.x}}`；上游产物注入截断 8000 字符 | 契约只传路径、摘要与结构化小对象，不传文档正文 |
| `judge` preset 不得与任一祖先 `agent` 相同 | 全部 `agent` 用 `hnflow`，全部 `judge` 用 `standard` |
| `verify` 只能 `against` `request`，`checks` ⊂ `[schema, judge]` | 交付物验收走 `verify`，文档校验走 `agent` + `judge` |
| `merge` 跳过 skipped 源；有 skipped 源未 done 则失败；多源浅合并；`map` 可指定 `from.id.path` | 分支汇聚用 `merge`；`map` 从三个上游取字段组装快照 |
| `request` 需 `deliverable` + `whyHuman`；`onReject` 支持 `return/fallback/arbitrate/fail` | 人交付不合格可退回重交（`return`） |
| 没有 `triggers` 写入口；`publish`/裁决/交付无工具入口 | 自动化与发布由人做，交付报告如实说明 |

固定取舍：

- `preset`：`agent` = `hnflow`，`judge` = `standard`（必须不同，否则 `judge-same-as-producer`）。
- `model`：P0 不写，用宿主默认路由；P1 起在 `hnflow` 上试 `model: "strong"`，以 `hnflow-stack models` 的实际层为准（写了不存在的层报 `model-layer-unknown`）。
- 预览包：`<workspace>/.game-dev/previews/<flow>-<yyyymmdd-hhmm>.md`（临时目录，需人加进 `.gitignore`）。
- 落盘纪律：`apply` 只写 `preview.files[]`；先校验 `baseHash`，与当前文件不一致即失败，防止「预览后被人手改」造成的静默覆盖。
- 一切产物路径为**工作区相对路径**，便于人直接打开。

## 4. 边界划分

| 放哪 | 内容 | 例 |
| --- | --- | --- |
| HNFlow 流程 | 何时、谁、拿什么、交什么、谁验收；节点契约、门禁、驳回语义 | `game-vision` 的 10 个节点与边 |
| 能力组 `game-dev` | 文档契约、检查清单、起草手法、落盘纪律、模板 | `doc-system`、`gdd-sections` 技能 |
| 项目文件 | 文档本身、`assets/`、`project.yaml`、`.hnflow/triggers.json`、`.gitignore` | `docs/L1_system/*.md` |
| run input | 本次需求、模式、路径范围 | `input.requirement`、`input.mode` |
| 模型层 | 路由（只写层 id） | `strong`（P1 起可选） |

拆分细则：

- **进流程**：节点顺序、产物契约、门禁理由、分支、预算、deadline。
- **进能力组**：ID/frontmatter/状态机/编号/单一事实源清单、预览包写法、lint 检查项、落盘纪律、各层起草手法、美术元数据规则。
- **进项目文件**：真实文档、资源、`triggers.json`、构建钩子、`.gitignore`。
- **进输入**：需求文本、模式（`apply`/`scan`）、目标路径、项目名。

## 5. 流程清单

| 流程 id | 名称 | 覆盖 | 阶段 | 门禁 | request |
| --- | --- | --- | --- | --- | --- |
| `game-vision` | 愿景与支柱孵化 | W1 | P0 | 1（愿景与支柱） | — |
| `game-gdd` | GDD 段落与系统文档维护 | W2 + L1/L2/L3 | P0 | 1（设计取舍） | — |
| `game-change` | 需求变更与手改对账 | W0 + W7 | P0 | 1（落盘前预览） | — |
| `game-data` | 系统与数据建模（Luban） | W3 | P1 | 2（字段、数值） | 1（数值基线） |
| `game-art` | 美术基线与技术管线 | W4 + W5 | P1 | 1（审计资产可用性） | 1（风格约束 + 资产路径） |
| `game-asset` | 资源组织与引用校验 | W6 | P2 | 1（归属与命名） | — |
| `game-deprecate` | 废弃与发布收尾 | W9 | P2 | 1（废弃承诺） | — |
| `game-context` | 只读上下文包 | W8 | P2 | 0 | — |

## 6. 统一骨架

```
主链：intake → draft → lint → review → packet → gate → go → apply → audit → report
分支：gate(approved|modified) → go；gate(rejected) → close → report
```

| id | 类型 | 职责 | output 要点 |
| --- | --- | --- | --- |
| `intake` | agent | 读项目现状，把 input 结构化；只读，不发问 | `concept`/`summary`、`gaps[]`、`existingDocs[]` |
| `draft` | agent | 产出变更集与预览文件（唯一允许写预览的节点） | `previewPath`、`summary`（≤800）、`files[{path,action,baseHash}]` |
| `lint` | agent | 按 `doc-lint` 清单机械校验预览内容 | `ok`、`errors[{path,rule,message}]`、`checked[]`、`previewPath` |
| `review` | judge | 独立语义评审：读 `lint` 回传的 `previewPath` 文件（判据写在流程定义里） | `verdict`/`reasons`/`conditions` |
| `packet` | merge | 组装 gate 快照：预览 + 校验 + 评审 | `previewPath`/`summary`/`files`/`lintOk`/`lintErrors`/`verdict`/`reasons` |
| `gate` | gate | 人看预览后裁决；`rejected` 必须写理由 | `decision`/`reason` |
| `go` | merge | 合并 packet 与 gate 结论，供 apply 消费 | `previewPath`/`files`/`decision`/`reason` |
| `apply` | agent | 按 decision 落盘；`modified` 先按理由修正 | `applied[]`、`paths[]`、`modified` |
| `audit` | agent | 落盘后复核：重跑 lint + 只读 `git status` | `consistent`、`residual[]`、`checked[]` |
| `close` | merge | rejected 收尾（常用 `outcome:"rejected"`） | `outcome` |
| `report` | merge | 唯一终点，汇总结论 | `flow`、可选 `applied`/`residual` |

边：

```
intake→draft status:done      draft→lint status:done
lint→review status:done       review→packet status:done
packet→gate always            gate→go gate:approved / gate→go gate:modified
gate→close gate:rejected      go→apply status:done
apply→audit status:done       audit→report status:done
close→report status:done
```

`packet.from = [draft, lint, review]`，`go.from = [packet, gate]`，`close.from = [gate]`，`report.from = [audit, close]`；`packet`/`go`/`report` 用 `map` 取字段，靠 merge 跳过 skipped 源兼容互斥分支。

`judge` 只拿**直接上游**的产物（截断 8000 字符），所以 `lint` 必须回传 `previewPath`；`review` 的 instruction 写明「读取上游产物中的 `previewPath` 文件再评审」，不靠模板拼接文档正文。`gate` 同理，靠 `packet` 汇合快照，而不是让 gate 读文件。

`review` 放在 `lint` 之后是有意的：先机械校验、再语义评审，评审能看到清单结论；两者都不阻断，最终由 `gate` 裁决。

## 7. P0 流程详设

### 7.1 `game-vision`（W1）

- input：`{ idea: string }`（required），可选 `audience`、`refs[]`。
- 额外节点：无（走通用 10 节点）。
- `draft` 产物：`docs/L0_vision/vision.<scope>.md`，含一句话愿景、3–5 条支柱、范围（做/不做）、开放问题。
- `review` 判据：支柱能被后续系统文档验证；范围不含实现细节；不编造数值与美术结论；术语与现有文档一致；单一事实源（不复制既有段落）。
- gate 理由：**愿景与支柱是创作意图，AI 只能起草**；人批准的是「这款游戏要带来什么体验」，不是文字质量。
- 失败处理：`intake` 必填缺失 → 节点失败；`draft` 无写权限或目录不存在 → 失败并保留诊断；`apply` 发现 `baseHash` 漂移 → 失败，要求重跑。

### 7.2 `game-gdd`（W2 + L1/L2/L3）

- input：`{ requirement: string, scope?: string }`。
- `draft` 产物：按 `{type}.{scope}.{slug}` 生成或更新 `core_loop`、`system`、`ux_3c`、`content` 段落；只改涉及段落，保留人工字段（`owner`、人工 `TODO`）。
- `review` 判据：8 节骨架齐全；`R-*`/`F-*`/`AC-*` 编号连续且被正文引用；系统 `depends_on` 双向可解；与既有 `source_of_truth` 不冲突；L1 不写实现细节。
- gate 理由：**设计取舍与设计基线只能由人定**；门禁同时是「这段文字是否代表当前设计」的签署。
- 失败处理：同 `game-vision`；另外 `lint` 发现 frontmatter 缺字段时，gate 快照必须含错误清单，避免带病落盘。

### 7.3 `game-change`（W0 + W7）

- input：`{ requirement: string, mode: "apply" | "scan" }`（required，enum）。
- 额外节点 `scan`（在 `intake` 之后）：只读 `git diff`/`git status` 与最近提交，产出 `changedPaths[]`、`untracked[]`、`staleRefs[]`、`orphanAssets[]`；`mode=scan` 时只做对账，不产生文档改动。
- `draft` 产物：变更集（每文件 `action` + 补丁 + 影响：`depends_on` 反查、构建影响提示），预览文件含逐文件 diff。
- `review` 判据：改动范围与需求一致；未触碰无关文档；被引用的 ID 全部存在；变更后仍单一事实源；不删人工内容。
- gate 理由：**硬约束③**——任何 AI 写入前，人必须看到「改什么、为什么、影响谁、构建是否受影响」。
- `mode=scan` 语义：`apply` 只更新索引与引用修正类文件；无改动时 `applied=[]` 且 `audit.consistent=true`，流程正常成功。

## 8. P1 / P2 概要

- `game-data`（W3）：`intake → ask(request 数值基线) → accept(verify) → seed(merge) → draft → lint → review → packet → gate → go → apply → audit → close → report`。`ask` 交付 `{ baseline, rationale, source }`，`whyHuman = "手感与难度曲线需要真实试玩判断"`，`onReject: return`；`accept` 用 `checks: ["schema","judge"]`，`onInconclusive: "gate"`。数值门禁与字段/枚举门禁分离：先确认数值，再确认结构。`draft` 产物为 `docs/L5_data/*.md` + Luban 表定义（表结构、字段类型、范围、默认值）。
- `game-art`（W4 + W5）：`intake → ask(风格约束 + 真实资产路径) → accept(verify) → draft → lint → review → packet → gate → go → apply → audit → close → report`。`ask` 交付 `{ styleKeywords[], refAssets[{path,role}], constraints[] }`，`whyHuman = "AI 不解码图片与视频，风格与资产可用性只能由人给"`；`accept` 用 `checks: ["schema"]` + judge 校验路径存在与角色一致。`draft` 产物为 `A0_art_baseline`、`A2_art_tech`、`A3_art_pipeline` 文档与 `A4` manifest 条目（只登记元数据与引用）。
- `game-asset`（W6）：`draft` 产出 manifest 条目与 `asset://` 引用修正；`lint` 查命名/路径/扩展名/重复/孤儿/悬空引用（只读文件系统，不解码内容）。gate 理由：**资源归属与命名是现实资产的承诺**，AI 只能对齐文本。
- `game-deprecate`（W9）：`intake → impact`（反查引用与 liveops 承诺）`→ draft`（废弃计划 + 迁移建议）`→ lint → review → packet → gate`（**废弃是对玩家与团队的承诺**）`→ apply`（改为 `deprecated` 需人批准）`→ audit → report`。
- `game-context`（W8）：单节点 `context`（agent，只读）→ 终点。输出 `{ packPath, summary, citations[] }`，不写项目文件（包写临时目录）。

## 9. 触发与自动化边界

- 手动：`hnflow run <flow> <input.json>`，这是日常入口。
- 自动（可选，由人配）：`.hnflow/triggers.json` 用 `source: "file"` 监听 `docs/**`、`assets/**`，只新开 `game-change` 的 `scan` 模式；或用 `run-completed` 让 `game-gdd` 接在 `game-change` 之后（链式最多 5 层）。
- 前提：插件 `hnflow-pass` 行启用（默认 2 秒一次）；触发器只新开 run，不接管授权、不跳 `gate`/`request`。
- 本计划**不创建、也不修改** `triggers.json`。

## 10. 验收标准

静态：

1. 每条流程 `hnflow_author validate` 返回 `ok: true`，无 `contract-unsatisfiable`/`input-unbound`/`gate-branches-incomplete`/`judge-same-as-producer`。
2. 每条流程 `gate` 三分支齐全，`report` 是唯一终点，无环。
3. `packet` 摘要 ≤800 字符，保证 gate 卡片 4000 字符内可读。

运行（样例项目 `temp/game-fixture/`，需在独立工作区打开会话）：

4. `game-vision` 跑到 gate：快照含 `previewPath`/`summary`/`lintOk`/`verdict`。
5. `approve`：只新增预览列出的文件；`git status` 仅这些路径；无 commit、无 `.hnflow/` 改动。
6. `modify`（理由含具体修改点）：`apply` 落盘体现该修改，快照 reason 可追溯。
7. `reject`：零文件写入，`report` 输出 `outcome: "rejected"`。
8. `game-change` 的 `scan` 能列出 `git diff` 与未跟踪文件；`mode=scan` 无改动时正常成功。
9. `game-data` 的 request 出现在收件箱，交付后 `verify` 生效，不合格可退回重交。
10. `status` 能看到按节点的 token 归因；gate 等待 72 小时后有过期提醒。

## 11. 里程碑

| 阶段 | 产物 | 验收 | 依赖 |
| --- | --- | --- | --- |
| M0 计划确认 | 本文档 + 能力组计划 | 人确认 §13 三项决策 | — |
| M1 能力组骨架 | `game-dev@0.1.0` + 4 个契约技能 | `hnflow-stack validate` 通过，`resolve` 可见 | 能力组计划 §9 |
| M2 愿景闭环 | `game-vision` 定义 + 样例 run | §10 第 1–3、4–7 条 | M1 |
| M3 设计闭环 | `game-gdd`、`game-change` | §10 第 1–3、5–8 条 | M2 |
| M4 数据与美术 | `game-data`、`game-art` | §10 第 9 条 | M3 |
| M5 收尾 | `game-asset`/`deprecate`/`context` + 移入仓库能力组 + 评审报告 | `flow-review` 13+8+6 清单 | M4 |

每阶段结束跑 `cd plugins/dsh && node test/run.mjs`（不改插件，作为回归确认），并更新本文档的「实际状态」。

## 12. 假设与风险

假设：

- A1 项目根 = DSH 工作区根；目录结构按源文档（`docs/<layer>/`、`assets/{domain}/{entity}/{kind}/`）。
- A2 开发期用项目草稿迭代，M5 移入仓库能力组随版本发布；发布仍由人做。
- A3 预览目录 `.game-dev/previews/`，需人加进 `.gitignore`（流程不改 `.gitignore`）。
- A4 `agent` 一律 `hnflow`，`judge` 一律 `standard`，两者都能被 `validate` 解析。
- A5 P0 不写 `model`，P1 再试层 id。
- A6 流程不提交 Git、不写 `triggers.json`、不发布。
- A7 能力组技能宿主名 `capability-game-dev-<skill>`。
- A8 文档中文，id 与文件名为英文小写。
- A9 样例项目另建，不拿 HNFlow 仓库自身当游戏项目。

风险：

- **R1 无确定性校验节点**：`lint` 由模型执行，可能漏检。缓解：清单固定 + 每条错误给 `path:line` 证据 + `audit` 复跑；根治需注册 `doc-lint` kind（改插件，另立决策）。
- **R2 gate 快照 4000 字符**：大 diff 读不全。缓解：摘要 + `previewPath`，人在编辑器看完整预览。
- **R3 预览与落盘漂移**：人可能在 gate 等待期间手改文件。缓解：`files[].baseHash` + `apply` 先校验，不一致即失败。
- **R4 子 agent 未加载能力组技能**：指令里的技能名可能不存在。缓解：M1 先实测；instruction 写明「技能不可用则按本节点契约执行并报告缺失」，并在 `audit` 里暴露。
- **R5 分支汇聚语义**：`report` 依赖 merge 跳过 skipped 源。缓解：M2 实测 reject 分支，不通过就改成每分支独立终点 + 双流程。
- **R6 仓库能力组迭代慢**：发布后修改需人操作。缓解：M5 才移入。
- **R7 preset/model 未解析**：可能出现 `preset-unknown`/`model-layer-unknown`。缓解：M1 先用空流程验证 preset。
- **R8 样例运行需切工作区**：`run` 使用会话 cwd。缓解：在样例项目开独立会话，或运行前切目录。

## 13. 待确认

1. 流程载体：P0–M4 用项目草稿、M5 移入仓库能力组——是否接受？
2. 预览落盘位置：`.game-dev/previews/`（不留痕）还是 `docs/.preview/`（可追溯但进 Git）？
3. `judge` 定位：P0 只作建议、由 gate 裁决；P1 是否要求评审必须 accept 才进 gate，并加一次自动返修（需要新节点与 merge 改造）？
