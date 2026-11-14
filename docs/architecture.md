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
        ├── 组根内容 rules/ agents/ commands/ skills/ flows/
        └── Module (modules/<path>/, module.json)
              └── 同名内容目录，局部覆盖与激活
```

- **Core**：常驻规则、基础 Agent/命令/技能，仓库内 `capability-groups/core/<version>/`。
- **领域组**：`capability-groups/domain/<name>/<version>/`，显式激活。
- **项目组**：`<project>/.hnflow/groups/<name>/`，无版本目录；同名覆盖仓库组，天然承载
  未发布的项目内工作流。
- **模块**：随组版本发布，不跨组；路径深度 ≤3，同组 `alias` 唯一。

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

模块依赖是另一层：`module.json` 的 `depends` 只引用同组模块，自动补全并拓扑排序。

## 4. 工作流作为能力组内容

```text
capability-groups/domain/hnflow-forge/0.1.0/flows/art-review.flow.json
<project>/.hnflow/groups/local/flows/my-flow.flow.json
```

- 组根流程键：`<group>/<flow.id>`。
- 模块流程键：`<group>/<module alias>/<flow.id>`。
- `flow.id` 必填，匹配 `^[a-z0-9][a-z0-9._-]*$`；同一键重复时保留首个并产生 warning。
- 流程定义 `schemaVersion: 2`，顶层 `flow`、`input`、`nodes`、`edges`。
- `flow.requires` 是给人看的依赖说明，不参与解析。
- 解析结果 `flows[]` 含 `id/flow_id/name/group/module/path/description/tags/version/requires`。

工作流没有独立资产库、revision、publish 或 rollback。能力组同步会在 `.hnflow/lock.json`
记录解析闭包，但运行不依赖它；一次运行在开始时把定义快照写进 run，之后文件修改不影响
已启动的运行。

## 5. 解析与注入

```sh
hnflow-stack resolve --json --mode capabilities --project <project>
```

固定顺序：

1. 定位仓库与 Core；
2. 读 `.hnflow/stack.json`；
3. Core → `stack.groups` → 每组递归 `extends`；
4. 按组名去重；
5. 计算每组模块激活集，按 `depends` 拓扑与路径字典序；
6. 收集 rules / skills / agents / commands / mcp / flows；
7. 计算限定 id 与宿主名；
8. 输出注入计划与 `fingerprint`。

限定 id：组根 `<group>/<name>`，模块 `<group>/<alias>/<name>`。
DSH 宿主名：`capability-<group>[-<alias>]-<name>`。

合并规则：

- rules 追加，按 `priority` 排序，`overrides` 压掉同名早期规则；
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

## 7. 边界

- **HNFlow 拥有**：工作流定义与运行、门禁/交付、页面、能力组解析入口。
- **能力组拥有**：可复用知识、规则、人设、命令、技能、工具引用与工作流。
- **项目拥有**：`.hnflow/stack.json`、`.hnflow/groups/`、`.hnflow/triggers.json`。
- **人拥有**：激活/停用组、门禁裁决、人工交付。没有 publish/rollback 动作。
- Agent 只能创建/修改草稿、运行流程、查看运行与收件箱。
