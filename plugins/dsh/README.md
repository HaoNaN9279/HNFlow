# dsh-hnflow

HNFlow 的统一 DSH 插件。一个包、一个会话模式：能力组、模型层、规则注入、工作流运行
与页面都在这里，不再需要第二个 `dsh-capability` 插件。

## 安装

```sh
dsh plugin --profile desktop add "<repo>/plugins/dsh"
```

升级插件后重启桌面应用：宿主侧（解析、初始化、路由）只在启动时加载，客户端半部会随页面热更新。

- DSH `>=0.2.1-0 <0.3.0`
- Python CLI：仓库内 `hnflow-stack`（`src/hnflow_stack`），插件通过它解析能力组
- 插件对每次调用都钉住仓库（`--repo <repo> --project <dir> <cmd>`，从工作区或插件包路径向上找
  `capability-groups`），不依赖宿主进程的 cwd；因此 `HNFlow repository not found` 不会出现
- 安装后在会话模式中选择 **HNFlow**；不存在单独的“能力组模式”

## 一个模式里有什么

| 面 | 行为 |
| --- | --- |
| 能力组 | 按项目 `.hnflow/stack.json` 解析，注入 rules、skills、commands、agents、MCP、模型层 |
| 能力组开关 | 工作区标题右键或 `…` 菜单里的「HNFlow 能力组…」：新窗口列出全部能力组，勾选启停，展开看组内内容，悬停 `◉` 预览全文 |
| 工作流 | 能力组的 `flows/*.flow.json`，与规则/技能同一条解析链 |
| 模型层 | 平台层 `fast` / `standard` / `strong` / `vision`，项目与全局绑定由 Python Core 读取；HNFlow 模式下接管输入框右下角的模型位 |
| 上下文预览 | 输入框左下角 `▤` 按钮，查看本次会话实际注入的人设、规则、技能、命令、Agent、MCP 与工作流（左下角只放 Agent 选择与预览） |
| 工作区 | 切到 HNFlow 时立刻按当前工作区初始化 `.hnflow/stack.json` 并解析一次，预览与模型层不必等首轮对话 |
| 运行 | 左栏流程/运行/收件箱，人工门禁与交付在收件箱 |

## 工作流属于能力组

- 组根流程：`capability-groups/<layer>/<name>/<version>/flows/<id>.flow.json`
- 对外的键：`<group>/<id>`
- 项目内新建：`hnflow_author create` 写 `<workspace>/.hnflow/groups/<group>/flows/<id>.flow.json`
- 组可用本组及 `extends` 依赖组的全部规则、技能、Agent、命令、工具与工作流

没有独立资产库，没有 `list_library` / `add_ref` / `pin` / `publish` / `rollback` /
`promote` / `import`，也没有独立的 revision 文件。`.hnflow/lock.json` 只记录能力组解析闭包，
不参与运行；每次运行会在 run 记录里冻结定义、内容哈希与模型路由。修改流程就是修改能力组
文件；是否共享由版本与仓库决定。

## 工具

`hnflow`：

`list_flows` · `describe_flow` · `run` · `status` · `list_runs` · `cancel` · `resume` ·
`inbox` · `artifact` · `triggers`

`hnflow_author`：

`schema` · `validate` · `create` · `draft` · `delete` · `rename`

Agent 不能裁决门禁或替人交付；也没有发布/回滚动作。

## 命令

`/hnflow list|runs|status <runId>|inbox|open`

`/capability-agent` 与 `/capability-layer` 只切换当前会话的 Agent 与模型层。
模型层的持久选择在设置页「模型层」，右下角模型位切换的也是当前会话的层。

## 数据布局

```text
<repo>/capability-groups/.../group.json
<repo>/capability-groups/.../flows/<id>.flow.json
<workspace>/.hnflow/stack.json                 激活的根能力组
<workspace>/.hnflow/groups/<name>/             项目本地能力组（无版本目录）
<workspace>/.hnflow/groups/<name>/flows/       项目本地工作流
<workspace>/.hnflow/triggers.json              触发器（由人维护）
$DSH_HOME/hnflow/runs                          运行状态（storage 不可用时的降级文件）
```

## 页面

左栏 `HNFlow` 三页签：流程、运行、收件箱。流程页只读展示所属能力组、依赖与
节点契约；收件箱处理门禁与人工交付；上下文清单从输入框左下角 `▤` 打开。
工作区窗口从工作区三点菜单打开，启停直接写该工作区的 `.hnflow/stack.json`。

## 测试

```sh
cd plugins/dsh
node test/run.mjs
```

Python 解析器测试：

```sh
python -m pytest tests -q
```

详细架构见 [`docs/architecture.md`](../../docs/architecture.md)，解析契约见
[`docs/resolve-api.md`](../../docs/resolve-api.md)。
