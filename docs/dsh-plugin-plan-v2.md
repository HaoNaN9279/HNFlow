# HNFlow 统一开发方案（v3）

## 1. 目标

把旧版独立仓库并入 HNFlow，形成一套仓库、一个 DSH 插件、一个会话模式：

- 能力组是内容边界，工作流是能力组的一种内容；
- 能力组通过 `extends` 声明依赖，激活时自动得到依赖闭包；
- 工作流可以使用本组及依赖组的全部内容；
- 插件只保留 `hnflow` 预设，把旧版的上下文预览、模型层选择、Agent 投影、
  规则注入与 MCP 一并迁入；
- 不兼容旧格式：旧资产库、revision、publish、旧配置只做一次性迁移，
  运行时不读取。

## 2. 目标结构

```text
capability-groups/
  core/<version>/{group.json,rules,agents,commands,skills,flows,modules}
  domain/<name>/<version>/{group.json,...,flows,modules}
tools/<name>/<version>/
src/hnflow_stack/          Python 解析器、CLI、preview
plugins/dsh/               唯一插件 dsh-hnflow
  capability/              能力组注入实现
  lib/flow/                流程定义、校验、运行
  client.js                页面 + 上下文 + Agent + 模型层
tests/
docs/
```

## 3. 能力组依赖

- `extends` 存组名，允许 `name@version`。
- `stack.json` 只存激活的根组，不写依赖。
- 解析时递归依赖，依赖先加载、按组名去重；环报错。
- 停用仍被依赖的组报错。
- lockfile 记录闭包与内容摘要，不记录 revision。

## 4. 工作流

```json
{
  "schemaVersion": 2,
  "flow": { "id": "art-review", "name": "美术评审", "requires": ["hnflow-forge"] },
  "input": { "type": "object", "properties": { "brief": { "type": "string" } } },
  "nodes": [],
  "edges": []
}
```

- 位置：组根 `flows/` 或模块 `flows/`。
- 解析键：`<group>/<id>` / `<group>/<alias>/<id>`。
- 模块流程与组根流程走同一条解析链。
- 运行开始时快照定义；运行中的流程不被文件修改影响。
- 新建/修改只写项目组的 `flows/`；没有 publish、revision、pin、rollback。

## 5. 单插件

`cordis.patch.yml` 只保留四行：`hnflow-core`、`hnflow-pass`、`hnflow-ui`、
`preset-hnflow`。`preset-hnflow` 内不再挂第二个插件。

| 迁移项 | 落点 |
| --- | --- |
| 能力组解析与注入 | `plugins/dsh/capability/` |
| 规则注入 | `agent/pre-step` + systemPrompt |
| 技能/命令/Agent/MCP | capability preset 注册 |
| 模型层选择 | `settings.section` + `conversation.input.model` |
| 上下文预览 | 输入框左下角 `▤` 按钮 |
| 流程/运行/收件箱 | 原 HNFlow 页面 |
| 模型管理命令 | `/capability-layer`、`/capability-agent` |

## 6. 迁移

1. 复制旧版仓库的能力组、工具、Python 包、测试与文档；
2. Python 包与 CLI 改用 `hnflow_stack` / `hnflow-stack`；
3. 项目配置改用 `.hnflow`，全局配置改用 `~/.config/hnflow-stack`；
4. 插件内服务键、路由、命令、配置前缀改为 `capability`；
5. 删除旧资产库、revision、publish/rollback、`import` 与旧测试；
6. 文档合并重写，不再描述“两个插件/两个模式”。

一次性迁移脚本不随插件发布；旧内容迁移后，旧目录可以删除。

## 7. 验收

- `cd plugins/dsh && node test/run.mjs` 全通过；
- `python -m pytest tests -q` 全通过；
- `hnflow-stack resolve --json --mode capabilities` 在示例项目输出依赖闭包与 `flows`；
- 页面三页签可用，模型层与 Agent 切换生效，上下文预览列出能力组内容；
- `hnflow_author create` 写项目组 `flows/`，`run` 能从能力组启动；
- 运行时代码与用户文档不再出现旧插件名、旧 asset/revision 公共入口。
