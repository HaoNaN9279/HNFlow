# 游戏开发能力组开发计划：`game-dev` 0.1.0

> 状态：计划草案，尚未创建组目录、技能或 `group.json`。
> 配套文档：[`game-dev-workflow-plan.md`](game-dev-workflow-plan.md)（HNFlow 流程）。
> 方法来源：`hnflow-forge` 的 `flow-capability` / `flow-review`，`group-forge` 的 `custom-group` / `custom-skill`。

## 0. 结论摘要

- 单个领域组 `game-dev@0.1.0`：**16 个技能 + 2 条规则 + 1 套 `references/`**，不建模块、不含 agent 与命令（留到 0.2.0）。
- 技能分三类：**契约**（文档系统、预览包、校验、落盘）、**手法**（各层起草）、**查询**（上下文包）。
- 组的职责是「怎么写」；节点顺序、门禁、交付验收仍写在流程定义里。
- 校验链：`hnflow-stack validate` → `hnflow-stack resolve --json --project <项目>` → `hnflow-stack sync` → 新会话生效。

## 1. 定位与边界

装：

- 文档系统契约：ID、层级、frontmatter、状态机、编号、单一事实源、`asset://` 引用。
- 预览包格式，以及「预览 → 确认 → 落盘」的操作纪律。
- 机械校验清单：可被 `agent` 节点逐条执行，并为每条结论给出证据。
- 各层起草手法：愿景、GDD 段落、系统、数据（Luban）、美术基线与技术管线、资源清单、废弃、上下文包。

不装：

- 流程定义、门禁、交付 schema（属于 HNFlow）。
- 工具/脚本/MCP。将来若需 `doc-lint` CLI，放仓库根部 `tools/`，由 `group.json` 的 `tools` 引用，不在组内实现。
- 权限表达、preset、provider、具体模型名。
- 任何本地绝对路径：一律相对项目根或使用占位符。

## 2. 目录结构

```text
capability-groups/domain/game-dev/0.1.0/
  group.json
  rules/
    00-doc-system.md        # 常驻：文档系统与写入纪律
    10-preview-write.md     # 按路径：docs/**、assets/**
  skills/                   # 每个技能一个目录，含 SKILL.md
    doc-system/  doc-lint/  doc-apply/  preview-packet/
    requirement-intake/  change-plan/  impact-scan/
    vision-brief/  gdd-sections/  system-model/
    data-model/  art-baseline/  art-tech/
    asset-manifest/  deprecation-plan/  context-pack/
  references/
    doc-types.md        # 11 个设计类型 + 7 个美术类型的层级/目录/骨架
    id-rules.md         # doc id、asset id、R-/F-/AC-/CHK- 编号规则
    status-machine.md   # 状态流转；AI 允许写的状态
    checklists.md       # lint 检查项分组与证据格式
    review-criteria.md  # 各流程 judge 的判据来源
    flow-map.md         # 流程 × 技能 × 节点矩阵
    templates/          # vision / system / data-schema / art-baseline / asset-manifest-entry
```

## 3. `group.json` 草案

```json
{
  "guid": "<32 位小写十六进制，实现时生成并校验全仓唯一>",
  "name": "game-dev",
  "version": "0.1.0",
  "description": "游戏开发文档系统与流程技法：文档契约、预览包、机械校验、落盘纪律，以及愿景/GDD/系统/数据/美术/资产/废弃/上下文的起草手法。",
  "permissions": ["fs", "exec"],
  "tools": []
}
```

- `permissions`：`fs` 读写文档；`exec` 只跑 `git status` / `git diff` 这类只读命令，不含网络。
- 不写 `extends`：`group-forge` 与 `hnflow-forge` 是「制作流程/能力组」的组，`game-dev` 是「写游戏文档」的组，二者不构成依赖。
- `tools` 暂空；将来 `doc-lint` CLI 由这里引用。

## 4. 规则

### 4.1 `rules/00-doc-system.md`（常驻，priority 100）

frontmatter：`name: doc-system`、`description`、`always: true`。

内容：文档 ID 语法；`docs/<layer>/` 目录约定；必填 frontmatter；状态机（AI 只能建议 `idea`/`draft`/`review`）；单一事实源；`asset://` 引用；AI 不解码图片与视频，只登记元数据；写入前必须先有预览与人的确认；不提交 Git、不碰 `.hnflow/`、不改资产库。

### 4.2 `rules/10-preview-write.md`（`paths: ["docs/**", "assets/**"]`，priority 90）

只写预览里列出的路径；写入前校验 `baseHash`；保留人工字段（`owner`、人工 `TODO`、手写备注）；不重排无关段落；不新建预览外的目录。

两条规则必须能被「没装 HNFlow 的普通会话」直接遵守，这是能力组独立于流程的底线。

## 5. 技能矩阵

| 技能 | 类型 | 输入 | 输出 | 消费节点 | 阶段 |
| --- | --- | --- | --- | --- | --- |
| `doc-system` | 契约 | 项目现状、目标文档 | ID/路径/frontmatter/状态判定 | 全部 | M1 |
| `doc-lint` | 契约 | 预览文件或目标文档 | `ok` + `errors[{path,rule,message}]` + 证据 | `lint`、`audit` | M1 |
| `doc-apply` | 契约 | 预览包 + 裁决 | 落盘清单、`applied[]` | `apply` | M1 |
| `preview-packet` | 契约 | 变更集 | 预览文件 + `summary`（≤800 字）+ `files[]` | `draft` | M1 |
| `requirement-intake` | 手法 | 需求文本、现有文档 | 概念简报 + `gaps[]` | `intake` | M2 |
| `vision-brief` | 手法 | 概念简报 | L0 愿景/支柱/范围 | `draft` | M2 |
| `gdd-sections` | 手法 | 需求 + 现有 GDD | L1/L2/L3 段落补丁 | `draft` | M2 |
| `system-model` | 手法 | 系统需求 | L1 系统文档（状态机/公式/依赖） | `draft` | M2 |
| `change-plan` | 手法 | 需求 + 扫描结果 | 变更集（含影响与构建提示） | `draft` | M3 |
| `impact-scan` | 手法 | `git diff` / `git status` | 变更路径、悬空引用、孤儿资源 | `scan` | M3 |
| `data-model` | 手法 | 系统文档 | L5 schema + Luban 表定义 | `draft` | M4 |
| `art-baseline` | 手法 | 风格约束 | A0/A1 基线文档 | `draft` | M4 |
| `art-tech` | 手法 | 基线 + 引擎约束 | A2/A3 技术、管线、导入检查表 | `draft` | M4 |
| `asset-manifest` | 手法 | 资产路径清单 | A4 manifest 条目 + 引用修正 | `draft` | M5 |
| `deprecation-plan` | 手法 | 废弃目标 | 废弃计划 + 迁移建议 | `draft` | M5 |
| `context-pack` | 查询 | 问题 + 目标范围 | 上下文包路径 + 引用清单 | `context` | M5 |

## 6. 契约技能的四条硬要求

- **`doc-system`** 是唯一「写到哪、叫什么、frontmatter 填什么、状态填什么」的查询入口。ID 语法 `{type}.{scope}.{slug}`，文件名 `{id}.md`；覆盖 L0–L8、A0–A4 层级目录、必填 10 字段、状态机、`source_of_truth`、`asset://`、`related`/`assets` 写法。输出「目标路径 + frontmatter 草案 + 为什么是这个 type/layer」，不复制 references 正文。
- **`doc-lint`** 把可确定性检查的项固定成清单，确保每次给出同一套证据。检查项分七组：路径与命名；frontmatter 必填字段与枚举；doc id / asset id 全项目唯一；`asset://`、`{{doc}}` 引用可解；`R-*`/`F-*`/`AC-*`/`CHK-*` 编号连续且被引用；同一事实不在两处给出不同值；人工内容未被覆盖。输出 `{ ok, errors[{path,line,rule,message}], warnings[], checked[] }`，没有 `path` 的结论不算证据。
- **`doc-apply`** 是不可越界的执行器：只写 `preview.files[]`，逐文件比对 `baseHash`，不一致立即停并报 `preview-drift`；不 `git add/commit`；不碰 `.hnflow/` 与资产库；结束输出 `applied[]` 与 `paths[]`。遇到 `modified` 时理由即指令，先改预览再落盘，并在 `applied[].note` 里逐条对应。
- **`preview-packet`** 让预览成为可读、可比、可裁决的对象：逐文件给出 `path`、`action`、`baseHash`、unified diff（每文件 ≤200 行）、受影响文档/节点、构建影响（是否触及 Luban 表），末尾列待确认问题；摘要 ≤800 字符，供门禁卡片展示；预览文件写 `.game-dev/previews/`，不进 `docs/`。

## 7. 起草与查询技能要点

- `requirement-intake`：一句话需求 → 可开工简报（`concept`/`audience`/`constraints[]`/`existingDocs[]`/`gaps[]`）。先读现有文档再写，`gaps` 只写「需人提供」的项，不编数据与美术结论。
- `vision-brief`：产出 L0 愿景，不是文案。一句话愿景 + 3–5 条支柱（每条写「玩家可感知的表现」）+ 范围做/不做 + 开放问题。支柱必须能被 L1 系统文档验证。
- `gdd-sections`：维护 GDD 段落，保持 8 节骨架与编号；只改涉及段落；新事实只进 `source_of_truth` 一处；`R-*`/`AC-*` 连续；L1 不写程序方案。
- `system-model`：把玩法描述落成可实现的系统契约。状态机给 Mermaid 源码，公式给符号表与边界条件，依赖双向可解，不写引擎 API 细节（属 L6）。
- `change-plan`：需求 → 最小变更集。输出 `files[{path,action,baseHash,patchNote}]`、`impact[]`、`buildImpact`、`risk[]`；不顺手重构无关段落；删除类改动必须列出引用者。
- `impact-scan`：手改后的对账。读 `git status --porcelain` 与 `git diff --name-only`，反查 `depends_on`/`asset://`，输出 `changedPaths[]`、`untracked[]`、`staleRefs[]`、`orphanAssets[]`；只读，修复交回 `draft`。
- `data-model`：字段类型/枚举/范围/默认值；表名与 `data_schema` 一致；数值只来自人（request 交付），技能内不写死。
- `art-baseline`：A0 视觉基线 + A1 体量（角色/场景/VFX/UI/动画的数量与规格），只写可验收的规格，不描述画面细节。
- `art-tech`：A2 技术方案（分辨率/材质/骨骼/特效预算）、A3 管线（导出命名、导入检查表），输出 `CHK-*` 清单。
- `asset-manifest`：条目字段 `id/role/path/owner/status`；只校验存在性、命名、路径、扩展名、重复、孤儿、引用，不解码内容。
- `deprecation-plan`：废弃理由、影响面、迁移建议、状态改 `deprecated` 的前置条件。
- `context-pack`：按问题裁剪上下文（相关文档 + 关键段落 + 引用链），输出包路径与引用清单；只读。

## 8. 流程 × 技能矩阵

| 流程 | `intake` | `draft` | `lint` | `review` | `apply` | `audit` | 其它 |
| --- | --- | --- | --- | --- | --- | --- | --- |
| `game-vision` | requirement-intake | vision-brief + preview-packet | doc-lint | 流程内 judge | doc-apply | doc-lint | — |
| `game-gdd` | requirement-intake | gdd-sections + system-model + preview-packet | doc-lint | 流程内 judge | doc-apply | doc-lint | — |
| `game-change` | requirement-intake | change-plan + preview-packet | doc-lint | 流程内 judge | doc-apply | doc-lint | `scan`: impact-scan |
| `game-data` | requirement-intake | data-model + preview-packet | doc-lint | 流程内 judge | doc-apply | doc-lint | `ask`/`accept`：流程内契约 |
| `game-art` | requirement-intake | art-baseline/art-tech + preview-packet | doc-lint | 流程内 judge | doc-apply | doc-lint | `ask`/`accept` |
| `game-asset` | requirement-intake | asset-manifest + preview-packet | doc-lint | 流程内 judge | doc-apply | doc-lint | — |
| `game-deprecate` | requirement-intake | deprecation-plan + preview-packet | doc-lint | 流程内 judge | doc-apply | doc-lint | `impact`: impact-scan |
| `game-context` | — | context-pack | — | — | — | — | 单节点 |

`review` 的判据写在流程定义里（judge 节点的 `criteria`），不依赖技能加载，避免「judge 拿不到能力组」的风险。

## 9. 激活与校验

```sh
# 1) 组静态校验（在 HNFlow 仓库根）
hnflow-stack validate
hnflow-stack list --tree

# 2) 项目内激活：只改 .hnflow/stack.json 的 groups，不复制内容
hnflow-stack resolve --json --project <游戏项目根>
hnflow-stack sync
hnflow-stack status
```

- 激活后**新会话**生效：规则注入与技能目录按会话构建。
- HNFlow 模式会话里，节点 instruction 用宿主名引用技能（`capability-game-dev-doc-lint` 等）；首次运行须确认 agent 能看到这些技能（见 R4）。
- HNFlow 仓库自身不激活此组：它的 `docs/` 是插件文档，不是游戏文档。

## 10. 验收标准

1. `hnflow-stack validate` 无错；`hnflow-stack resolve --json` 能看到 16 个技能与 2 条规则。
2. 每个 `SKILL.md` 的 `name` 与目录名一致且匹配 `^[a-z0-9]+(-[a-z0-9]+)*$`，有 `description`，正文含「输入/步骤/输出/边界」。
3. 全组无绝对路径、无 provider 或具体模型名、无内联工具。
4. `references/` 六份文件齐备，`flow-map.md` 与流程矩阵一致。
5. `doc-lint` 的检查项能被一条节点 instruction 完整触发；`doc-apply` 的越界规则可被 `audit` 复核。
6. 用 `game-vision` 做一次样例运行：技能被实际引用，输出符合契约；技能缺失时能降级并报告。

## 11. 里程碑

| 阶段 | 内容 | 验收 |
| --- | --- | --- |
| M1 | `group.json` + 2 规则 + 4 契约技能 | §10 第 1–3 条 |
| M2 | +4 手法技能（intake/vision/gdd/system） | 技能被 `game-vision` 引用并跑通 |
| M3 | +2 手法技能（change-plan/impact-scan） | `game-change` 的 `scan` 有真实 diff 证据 |
| M4 | +3 手法技能（data/art-baseline/art-tech） | `game-data`/`game-art` 的 request 契约可用 |
| M5 | +3 技能（asset/deprecate/context）与 references 全套 | §10 第 4–6 条 + `flow-review` 8 项 |

版本策略：0.1.0 发布后不再改动，0.2.0 再加 `agents/`（游戏设计执笔人设）与 `commands/`（`/gd-check`、`/gd-context`）；模块（`modules/design`、`modules/art`）等出现真实项目路径需求时再拆。

## 12. 假设与风险

假设：

- B1 组名 `game-dev`、版本 `0.1.0`；`guid` 实现时生成并校验全仓唯一。
- B2 技能用中文正文、英文 `name`；不建模块，不含 agent/command。
- B3 `references/` 是技能的共同底座；技能正文只写「步骤 + 输出」，细节指向 references。
- B4 技能不写死数值、美术结论与引擎版本。

风险：

- **R1 技能过多**：16 个技能若都写满，注入成本高。缓解：技能正文 ≤20 行，细节进 references，按需读取。
- **R2 与源文档漂移**：摘录可能失真。缓解：`references/doc-types.md` 只搬类型/目录/骨架，语义以源文档为准，实现时逐条对照。
- **R3 无人消费的契约**：`doc-system` 与流程 instruction 不一致时节点会自由发挥。缓解：矩阵 + 样例运行双向校验。
- **R4 judge 或子 agent 拿不到技能**：缓解见 §8，判据仍写在流程内。
- **R5 规则污染 HNFlow 仓库**：`00-doc-system` 常驻会作用于插件开发会话。缓解：只在游戏项目激活；`10-preview-write` 限定 `docs/**`、`assets/**`。
- **R6 无 lint CLI**：清单靠模型执行。缓解同流程计划 R1；将来把 `doc-lint` 做成 `tools/` 包由 `group.json` 引用（需单独决策）。

## 13. 待确认

1. 组名与粒度：单个 `game-dev` + 16 技能，还是拆成 `game-design` / `game-art` 两组？
2. `references` 粒度：6 个合并文件，还是按层拆成更多小文件（读取更省、维护更碎）？
3. 是否 0.1.0 就加 `agents/game-designer.md`（交互式人设）与 `/gd-check` 命令，还是留到 0.2.0？
