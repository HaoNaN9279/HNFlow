# 边界案例库

五个案例示范“流程 / 能力组 / 项目文件 / 输入”的切分。结论可复用，细节按需改。末尾附“误拆速查”。

---

## 案例 1：美术概念到接入（人交付型）

**需求**：给一句 brief，产出 3 个概念方向；人做精修稿；独立验收后接入项目。

| 内容 | 归属 | 理由 |
| --- | --- | --- |
| 3 个概念方向 | 流程 `agent` 节点 | 需要模型产出，且被下游消费 |
| 精修稿 | 流程 `request` 节点 | 真实手感 + 线下工具，模型不可替代 |
| 精修稿是否合格 | 流程 `verify`（`checks: ["schema","judge"]`，judge 用不同 preset） | 机械校验 + 独立判断，不由生产者自评 |
| 风格关键词、命名规范 | 能力组 `rules` | 跨流程复用 |
| 概念产出的提问模板 | 能力组 `skills` | 手法复用 |
| 项目接入规范 | 项目文件 | 换项目就变 |

流程清单：`concept(agent) → craft(request) → accept(verify) → integrate(agent)`，边分别为 `status:done`、`status:done`、`artifact.accepted:true`。
关键判据：把“精修”写成 agent 节点会一直产不出合格物；把“验收”交给 concept 节点就是自评。

---

## 案例 2：数据清洗流水线（工具型）

**需求**：每周对一批 CSV 清洗、打标、汇总，异常样本要人确认。

| 内容 | 归属 | 理由 |
| --- | --- | --- |
| 清洗脚本、字段映射、打标规则 | 工具包 + 能力组技能 | 确定性步骤，不该由模型自由发挥 |
| 清洗规则变更审批 | 流程 `gate` | 人做决定（过/不过/改） |
| 异常样本判定 | 流程 `request`（deliverable = 样本 id 列表 + 处置意见） | 需要人的现实判断 |
| 汇总报告是否可用 | 流程 `verify`（schema + judge） | 可检查项自动化，独立性由 judge 保证 |
| 周报字段定义 | 项目文件 | 仅本项目 |
| 本次数据文件路径 | `flow.input` | 每次运行不同 |

流程清单：`approve-rules(gate) → clean(agent，调用工具) → triage(request) → verify(verify) → report(agent) → gate 收尾`。
关键判据：脚本执行不是流程节点；流程只保留“要契约、要人、要验收”的环节。gate 在中间时三分支必须齐全，拒绝分支汇到终点 `merge`。

---

## 案例 3：代码重构（自动 + 独立审查）

**需求**：按重构目标改一处代码，独立审后由人决定是否合并。

| 内容 | 归属 | 理由 |
| --- | --- | --- |
| 改动本身 | 流程 `agent` 节点（output = 变更文件清单 + 自测结果） | 需要模型写代码 |
| 是否通过审查 | 流程 `verify`（judge 另用 preset，criteria 写清“行为等价、无越界改动”） | 生产者不能当验收者 |
| 是否合并/发布 | 流程 `gate` + **人执行**合并/发布 | 仓库动作由人完成，HNFlow 没有 publish |
| 编码规范、测试约定 | 项目文件或能力组 `rules` | 跨项目通用才进能力组 |
| 目标仓库、分支、重构范围 | `flow.input` | 每次不同 |

流程清单：`plan(agent) → patch(agent) → review(verify) → approve(gate，无出边即终点)`。
关键判据：`review` 报 `reject` 时靠 `onReject` 让 patch 重试，或走“修订”节点向前，**不能画回边**（`cycle-unsupported`）。

---

## 案例 4：内容本地化（人给术语，机器做量）

**需求**：把产品文案翻成多语言，术语表由人定，机翻产出后要独立抽检，抽检不过回退重译。

| 内容 | 归属 | 理由 |
| --- | --- | --- |
| 术语表与禁用表达 | 流程 `request`（`deliverable` = 词条数组） | 只有人能拍板术语，模型自造术语会污染全局 |
| 翻译本身 | 流程 `agent`（`output` = `{locale, segments[], glossaryHits[]}`） | 需要模型，产物被下游消费 |
| 抽检是否合格 | 流程 `verify`（`checks: ["schema","judge"]`，judge 换 preset，criteria 写“术语一致、语气一致、无漏译”） | 生产者不能自评；抽检标准要可写 |
| 不合格重译 | 节点 `onReject.kind: "return"` | 重做不画回边 |
| 语言风格指南、术语写法 | 能力组 `skills` + `rules` | 跨项目复用 |
| 目标语言清单、发布渠道 | `flow.input` | 每次运行不同 |
| 本项目的品牌词表 | 项目文件（或能力组，若多项目共用） | 换项目会变 |

流程清单：`glossary(request) → translate(agent) → spotcheck(verify) → publish(agent) → approve(gate，无出边即终点)`。
关键判据：术语表不是 `agent` 的 instruction，是**人的交付**；抽检不是人肉逐条比对，`schema` 管结构、`judge` 管质量。

---

## 案例 5：周期性运营报表（定时 + 人工复核）

**需求**：每周从数据源取数、按固定口径汇总、生成周报；数字异常时人先确认口径再发布。

| 内容 | 归属 | 理由 |
| --- | --- | --- |
| 取数与聚合 | 工具包（`tools/`）或能力组技能 | 确定性计算，模型不参与 |
| 口径与指标定义 | 流程 `merge` 的 `set`（常量） | 版本化在流程里，改口径 = 改定义，可评审 |
| 异常口径确认 | 流程 `gate`（approved / rejected / modified 三分支齐全） | 只做一个决定 |
| 周报正文 | 流程 `agent`（`output` = `{title, highlights[], numbers{}, risks[]}`） | 需要模型组织语言 |
| 数字是否与源一致 | 流程 `verify`（`checks: ["schema"]` + 关键字段断言） | 机械校验优先，别让 judge 做算术 |
| 发布到渠道 | 流程 `gate` 收尾；实际发布由人 | 对外发布是人的授权 |
| 指标定义文档、口径变更记录 | 项目文件 | 仅本团队成立 |
| 本周日期范围、数据源路径 | `flow.input`（`required: ["week"]`） | 每次不同 |
| 每周一定时启动 | 项目 `.hnflow/triggers.json`（`source: "cron"`, `cron: "0 2 * * 1"`，人写） | 触发时机不是流程内容；改时间不该动流程定义 |

流程清单：`collect(agent 调工具) → normalize(merge 常量口径) → sanity(gate) → write(agent) → check(verify) → publish-approve(gate 终点)`。
关键判据：**数字由脚本算，模型只写文字**；口径用 `merge.set` 冻结，不用 instruction 描述；定时靠人写触发器，流程本身不写“每周”。

---

## 误拆速查

| 症状 | 拆错了什么 | 改法 |
| --- | --- | --- |
| 流程里有 5 个以上 `agent` 节点，每个都“顺手做点别的” | 一个节点干多件事 | 一节点一产物，或把手法移进能力组技能 |
| `instruction` 超过 200 字，还在描述步骤 | 知识写进了流程 | 抽成 `skills/`，instruction 只留“技能名 + 本次参数 + 契约” |
| `gate` 之后没有 rejected 去处 | 忘了三分支 | 拒绝分支汇到终点 `merge`，或改成 `request` 让人重交 |
| 想把“失败重试”画成环 | 违反无环 | 用 `onReject`（插件内重试）或“修订”节点向前 |
| 校验全过但结果不能用 | 少了 `verify`/`judge`，或能力组未激活 | 加独立验收；在 `description` 写 `requires:` 并在交付说明提示激活 |
| 门禁卡住几天没人处理 | `deadline` / `onExpire` 没写，或该用 `request` 却用了 `gate` | 补期限与过期策略；有交付物的用 `request` |
| 同一段规范在两三条流程里重复 | 该进能力组 `rules` | 提到组里，流程里只引用 |
| “每周一自动跑”写进 instruction | 触发时机写进了流程 | 人写 `.hnflow/triggers.json`；流程只描述一次运行内部 |

## 提炼：三条线

1. **确定性步骤**（脚本、格式转换、常量组装）→ 工具/技能或 `merge`，不要塞给 `agent`。
2. **必须人给的东西** → `request`（有交付物）或 `gate`（只做决定），不进 instruction。
3. **判定合格** → `verify` + 独立 `judge`；只有“要不要继续”这种价值判断才交 `gate`。

依赖前提要显式：案例 2 的工具包、案例 4 的语言风格技能、案例 5 的取数工具，都写进 `flow.description` 的 `requires:` 和交付说明。
