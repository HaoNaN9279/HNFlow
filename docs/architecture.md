# HNFlow 架构

## 1. 定位

HNFlow 用一个仓库同时管理：

- **能力组**：规则、技能、Agent、命令、MCP、工具与工作流的内容边界；
- **工作流**：能力组的一种内容，由 HNFlow 插件编排、DSH subagent 执行；
- **解析器**：Python `hnflow-stack`，唯一的加载、依赖、排序、校验与注入计划来源；
- **DSH 插件**：`dsh-hnflow`，唯一会话模式，负责注入、模型层、页面与运行。

项目只写 `.hnflow/stack.json`。能力组内容不复制进项目，也不复制进 Agent 配置目录。

## 2. 分层

```text
Layer (core / domain / project)
  └── Group (版本边界, group.json)
        └── 内容目录 rules/ agents/ commands/ skills/ flows/
```

- **Core**：常驻规则、基础 Agent/命令/技能，仓库内 `capability-groups/core/<version>/`。
- **领域组**：`capability-groups/domain/<name>/<version>/`，显式激活。
- **项目组**：`<project>/.hnflow/groups/<name>/`，无版本目录；同名覆盖仓库组，天然承载
  未发布的项目内工作流。
- 组内不再有子模块层：需要「只对某些目录生效」的内容用规则的 `scope: paths`，
  需要「正文长、按需查阅」的内容用规则的 `on_demand: true`。

## 3. 依赖

`group.json` 的 `extends` 是能力组依赖：

```json
{ "name": "hnflow-forge", "version": "0.1.0", "extends": ["group-forge"] }
```

- 依赖先于依赖者加载，按组名去重；同一依赖可写 `name@version`。
- 激活只把**根组**写进 `.hnflow/stack.json`，不展开依赖。
- 解析时递归依赖闭包；`extends` 环是硬错误。
- 停用一个仍被其他活跃组依赖的组会被拒绝。
- 依赖组的内容对依赖者完全可见：规则、技能、Agent、命令、MCP、工具与工作流。
- 组内工作流可以使用本组及依赖闭包内的全部内容；解析器不校验节点 instruction 里引用的
  技能是否存在，未命中的内容不会被注入。

## 4. 工作流作为能力组内容

```text
capability-groups/domain/hnflow-forge/0.1.0/flows/art-review.flow.json
<project>/.hnflow/groups/local/flows/my-flow.flow.json
```

- 流程键：`<group>/<flow.id>`。
- `flow.id` 必填，匹配 `^[a-z0-9][a-z0-9._-]*$`；同一键重复时保留首个并产生 warning。
- 流程定义 `schemaVersion: 2`，顶层 `flow`、`input`、`nodes`、`edges`。
- `flow.requires` 是给人看的依赖说明，不参与解析。
- 解析结果 `flows[]` 含 `id/flow_id/name/group/path/description/tags/version/requires`。

工作流没有独立资产库、revision、publish 或 rollback。能力组同步会在 `.hnflow/lock.json`
记录解析闭包，但运行不依赖它；一次运行在开始时把定义快照写进 run，之后文件修改不影响
已启动的运行。

## 5. 解析与注入

```sh
hnflow-stack --repo <repo> --project <project> resolve --json --mode capabilities
```

`--repo` / `--project` 是全局参数，必须放在子命令前。插件每次都显式钉住仓库
（从工作区向上找 `capability-groups`，找不到再用插件自身包路径；成功找到后 `--repo` 一定会带），
因为 CLI 在缺省时回退到自己的进程 cwd，而宿主进程的 cwd 不是 HNFlow 仓库，
会直接报 `HNFlow repository not found`。

固定顺序：

1. 定位仓库与 Core；
2. 读 `.hnflow/stack.json`；
3. Core → `stack.groups` → 每组递归 `extends`；
4. 按组名去重；
5. 按组顺序收集 rules / skills / agents / commands / mcp / flows；
7. 计算限定 id 与宿主名；
8. 输出注入计划与 `fingerprint`。

限定 id：`<group>/<name>`。
DSH 宿主名：`capability-<group>-<name>`。

合并规则：

- rules 追加，`global` 规则先于 `paths` 规则，按 `priority` 排序，`overrides` 压掉同名早期规则；
  `on_demand: true` 的规则只注入 `- <路径>: <description>` 摘要行，正文由 Agent 按需读取；
- skills 追加，同名宿主名保留后者并告警；
- agents / commands / mcp 同名后加载覆盖；
- 同限定 id 重复才是真冲突：`resolve` 告警，`sync` / `validate` 报错。

失败策略：插件只接受 `schema_version == 2`；解析失败不阻断启动，只加载默认能力并告警。

## 6. 插件装配

`plugins/dsh` 是单包 ESM，`cordis.patch.yml` 插入四行：

| 行 | 作用 |
| --- | --- |
| `hnflow-core` | `ctx.hnflow`、`ctx.capability`、Fetch 路由、`/hnflow` 命令 |
| `hnflow-pass` | 2 秒时钟：过期推进、副作用重放、触发器、停滞续推 |
| `hnflow-ui` | 页面：流程/运行/收件箱，输入框内上下文预览 |
| `preset-hnflow` | 唯一 preset：工具、技能、流程索引、规则注入、模型层、Agent 投影、MCP |

`preset-hnflow` 同时承担能力组注入职责：解析 → 规则消息 → skills
provider → commands → agents 投影 → MCP → 模型层应用。客户端同一 bundle 注册页面、
上下文预览、Agent 选择器与模型层选择。

客户端 bundle 只调用一次 `window.__ModuleLoader__.load`，且 `id` 必须等于包名
（`dsh-hnflow`）：Cordis Loader 按包名导入模块，其它 id 只被登记、永远不会被实例化。
`dsh.client` 需要 `immediately: true`，否则页面启动时没人导入这个模块。两条 Loader 行
（`hnflow-ui` 与 preset 内的 `hnflow`）共用这一个工厂，各自带挂载守卫。

输入框的两个位置各有归属，不按服务端 selector 分支：左下角只放 Agent 选择器与 `▤` 预览，
模型层永远接管右下角的模型位（`conversation.input.model`，`priority -1`）。
切换模式时客户端立刻请求 `GET /api/capability/prepare?sessionId=&cwd=`：宿主按会话
工作区补写 `.hnflow/stack.json` 并解析一次计划，预览与模型层读同一份热计划，不必等首轮对话。

## 7. 边界

- **HNFlow 拥有**：工作流定义与运行、门禁/交付、页面、能力组解析入口。
- **能力组拥有**：可复用知识、规则、人设、命令、技能、工具引用与工作流。
- **项目拥有**：`.hnflow/stack.json`、`.hnflow/groups/`、`.hnflow/triggers.json`。
- **人拥有**：激活/停用组、门禁裁决、人工交付。没有 publish/rollback 动作。
- Agent 只能创建/修改草稿、运行流程、查看运行与收件箱。
