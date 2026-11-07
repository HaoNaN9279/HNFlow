# dsh-hnflow

HNFlow 约束式流程在 DeepSeek Harness 里的模式插件。设计与边界见
[`docs/dsh-plugin-plan-v2.md`](../../docs/dsh-plugin-plan-v2.md)。

核心区别：流程不是"用户画图、AI 照着走"的执行脚本，而是**约束层**——节点声明角色与产物契约，
边声明消费条件，人通过门禁与交付进入流程，验收由独立 judge / verify 完成，不由生成者自报。

- 编排权在插件自己的状态机里（`ctx.hnflow`），节点执行交给 DSH `subagents`；
- 流程状态进 DSH storage domain（不可用时降级为文件，并显式告警）；
- 发布是人的动作：`/hnflow publish` 或页面按钮；Agent 只有 `draft`；
- 页面/会话/右栏读同一个 service，不读文件、不跑命令、不写会话事件。

## 依赖

| 项 | 要求 |
| --- | --- |
| DSH | `>=0.2.1-0 <0.3.0`（`engines.dsh`） |
| VibeStack | `dsh-vibestack` ≥ 0.3.0 / `apiVersion >= 2`（**强依赖**：能力组 + 模型层） |
| 模型层 | 节点 `model` 引用 VibeStack 层 id；缺层即失败，不回落 |

没有 VibeStack 时插件进入 `degraded`：可以列流程、看运行，但**发布与启动一律拒绝**。

## 安装（自用，不上架）

```sh
dsh plugin --profile desktop add "D:/workspace/HNFlow/plugins/dsh"
dsh --profile desktop --dump-config | grep -A2 'dsh-hnflow'
```

装好后会话模式里出现 **HNFlow**（`preset-hnflow`）。VibeStack 模式不变。

## 三行装配

| 行 | 角色 | 注册内容 |
| --- | --- | --- |
| `hnflow-core` | `role: core` | `ctx.hnflow`、`/api/hnflow/*` 路由、存储与调度 |
| `preset-hnflow` → `hnflow` | `role: preset` | `hnflow` / `hnflow_author` 工具、`/hnflow`、`hnflow-flows` 技能、流程索引 |
| `hnflow-ui` | `host: false` | 浏览器 bundle：侧栏页面、会话页签、右栏收件箱、右下角通知 |

## 页面与命令

- 左侧 HNFlow 图标：**流程**（树 + 只读画布 + 发布/启动）/ **运行**（节点时间线）/ **收件箱**（门禁与交付）。
- 会话页签只显示本会话启动的运行；右栏是同一份收件箱；右下角首次出现待决项时提示一次。
- `/hnflow list|runs|status|inbox|publish|pin|import|open`；发布需要 `publish <流程> confirm` 二次确认。
- 模型面：`hnflow`（list_flows / describe_flow / run / status / cancel / resume / inbox）与
  `hnflow_author`（schema / validate / draft，**没有 publish**）。

## 配置

```yaml
- id: hnflow-core
  name: dsh-hnflow
  config:
    role: core
    libraryRoot: D:/data/hnflow-library   # 空 = $DSH_HOME/hnflow/library
    presetAllowlist: [hnflow, standard]    # 节点可引用的 preset
    maxParallel: 3                         # 同时推进的节点数（不超过宿主 maxActiveSubagents=8）
```

其它字段：`workspaceDir`（默认 `.hnflow`）、`stateDir`（降级文件存储根）、`maxAttempts`、
`nodeTimeoutMs`、`maxIndexEntries`、`storage`（`false` 强制文件存储）。

## 数据布局

```text
$DSH_HOME/hnflow/library/<name>.flow.json        资产（asset + definition）
$DSH_HOME/hnflow/library/.hnflow-revisions/<id>/rN.json   不可变快照 + lockfile
<workspace>/.hnflow/flows.json                   引用（默认钉住 revision）
<workspace>/.hnflow/overrides/<flowId>.flow.json 工作区草稿
$DSH_HOME/hnflow/state/runs/<runId>.json         仅 storage domain 不可用时的降级
```

运行记录本身进 storage domain（域 `hnflow`，一张 `runs` 表，一条 run 一个文档——
domain 没有跨表事务，一次推进必须原子）。

## 示例

```sh
# 把示例导入工作区并跑一次（先确保 hnflow 模式下有 VibeStack 模型层）
/hnflow import 冒烟流程 /path/to/examples/smoke.flow.json
/hnflow publish 冒烟流程 confirm
```

`examples/art-review.flow.json` 演示 `request` + `verify` + 独立 judge。

### 已预置的两条测试流程（本机）

| 引用（alias） | 位置 | 做什么 |
| --- | --- | --- |
| `smoke-general` | 通用资产库 `library/test/general-smoke.flow.json` | `agent` 写摘要与要点 → `gate` 人工确认；验证启动、信封、门禁、终态 |
| `project-delivery` | 通用库 `library/test/project-delivery.flow.json` + **本工作区覆盖** `.hnflow/overrides/fl-demo-project-delivery.flow.json` | 人工交付 `{files, notes}` → `verify` schema 验收 → `agent` 变更清单；验证投递、CAS、覆盖优先 |

使用：

```text
/hnflow list
```

- `smoke-general`：页面「流程」选中 → 输入 `{"brief":"随便写一段测试说明"}` → 运行 → 收件箱批准。
- `project-delivery`：运行后在收件箱提交 `{"files":["a.txt"],"notes":"测试交付"}`；它带工作区覆盖，列表里显示「草稿」，运行记录标「草稿覆盖」，child 简报里能看到“（本项目覆盖）”。

两条流程都不写 `model`，直接用会话当前模型，不需要先在 VibeStack 里定义模型层。


## 测试

```sh
node test/run.mjs
```

纯函数层（schema/envelope/调度/CAS/发布）与编排层（fake runner/store）分别覆盖；
端到端仍需在桌面版里手测一次（M0 探针结论见方案 §13）。
