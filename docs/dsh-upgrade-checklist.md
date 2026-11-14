# DSH 升级回归清单（dsh-hnflow 0.4.0）

本机 DSH 仍是 `0.2.x` 预览版，subagent / storage / slot / structured-output 契约都可能变。
每次升级 DSH（桌面版或 web profile）后按本清单回归，**不要**只看插件是否加载成功。

## 1. 静态与单元

```sh
node plugins/dsh/test/run.mjs
```

要求：全部通过。重点看：

- `flow/schema.js`：`type` 与 `oneOf` 不能同时出现（宿主 structured-output 校验器的新规则）；
- `flow/envelope.js`：信封必须是 object-rooted 的扁平对象（`status` + 可选字段），不能顶层 `oneOf`；
- `runner.test.js`：`startActivation` 必须收到 `signal`、`provider: 'spawn'`，`maxDepth` 为 1；
- `service.test.js` / `human.test.js`：门禁/交付/过期/审计仍符合状态机。

## 2. 原生契约探针（M0，5 项）

在隔离 DSH_HOME 起一个 web 实例（不要动桌面端真实会话）：

```powershell
$env:DSH_HOME='D:\workspace\HNFlow\temp\dshhome'
$env:HNFLOW_TRACE='1'
dsh --profile ztest --no-open --port 3999
```

| 探针 | 通过标准 | 失败时的降级 |
| --- | --- | --- |
| ① `subagents.startActivation(spawn, delivery:'caller', outputSchema)` | 子 Agent 返回 `structured`，节点 done | 节点 `node-spawn-failed`；页面直跑不可用 |
| ② `agents.create` conductor + 作为 parent | 页面启动的 run 用 conductor 跑通 | run 标 `host-unavailable`，需回会话启动 |
| ③ storageDomain 跨进程读回 | 重启后 `/api/hnflow/state` 仍列出旧 run，`storage: domain` | 降级文件存储并告警 `storage-degraded` |
| ④ 同一宿主 `userQuestions.ask()` + POST fetch 路由 | 收件箱待决项 `askedVia: card`，页面 POST 可裁决 | 卡片失败只记日志，收件箱仍可用 |
| ⑤ `ctx.get('vibestack')` + `agentOptions` | VibeStack `apiVersion >= 3`；`lockfile.models.<layer>` 有 provider/model，spawn trace 的路由一致 | 旧插件直接 `vibestack-unavailable`；未绑定层 `model-layer-unbound`、自定义层 `model-layer-custom`、写错层名 `model-layer-unknown`，都不回落 |

## 3. 页面/浏览器（Playwright，隔离实例）

启动后打开 URL（日志里的 token），用页面完成：

1. 侧栏 **HNFlow** → 三个页签可切换；工作区树列出引用流程；
2. 选流程：画布、版本历史、`发布新版本` 预览（校验 + diff）、`取消`；
3. `钉住` / `跟随最新` 生效；`回滚` 需要第二次点击确认；
4. 输入 `{"brief":"..."}` → 运行 → 收件箱出现门禁 → 批准 → 运行页签显示 `succeeded`；
5. 运行页签：节点 token 用量、产物按钮可展开 JSON、取消/继续按钮按状态出现，顶部有健康说明；
6. 收件箱：按阶段排序并显示一句话摘要；底部“自动化”面板显示触发器、副作用计数与上次扫描；
7. 在 `<workspace>/.hnflow/triggers.json` 写一条 cron 触发器，等一个 `passIntervalMs`：
   出现一条 `由触发器启动` 的运行，且同一分钟不重复；删掉文件后面板不再列出；
8. 浏览器 console 无 error、无 pageerror。

自测脚本在 `temp/ui-flow-verify.mjs`（仓库临时目录，不随插件发布）。

## 4. 宿主契约变更点

| 契约 | 插件依赖 | 变更症状 | 处理 |
| --- | --- | --- | --- |
| `subagents.startActivation` 参数 | `provider/label/delivery/signal/request{parent,cwd,agentPreset,outputSchema,maxDepth,prompt}` | `node-spawn-failed`，`subagent-unavailable` | 对照 `dsh-subagent` README 更新 `lib/runner.js` |
| `signal` 必填 | 不传会 `throwIfAborted` 报 undefined | spawn 立即失败 | 始终传 `AbortController.signal` |
| `maxDepth` 语义 | 节点是 depth 1；`0` 会拒绝节点自身 | `subagent depth 1 exceeds maxDepth 0` | 保持 1 |
| `structured_output` schema | object-rooted、禁止 `type`+`oneOf`、`const` 需要 `type` | `UNSUPPORTED_SCHEMA` | 改 `lib/flow/envelope.js` 与 `flow/schema.js` |
| `agents.create` + 默认模型 | conductor 无会话模型选择 | 子会话无事件、run 卡 running | 用 `agentDefaultModel` / VibeStack 默认层给 conductor `agentOptions` |
| storage domain | `runs` 域单实例、原子写 | 打不开/丢 run | 保持 core 独占；失败走文件降级 |
| `userQuestions.ask` | 只接受活跃 root（conductor 可） | 卡片不出现 | 收件箱是权威，卡片只是便利 |
| client 槽位 | `sidebar.panellist`/`main`/`conversation.view`/`sidebarRightTabs`/`shell.overlay` | 页面/页签空白 | 对照 `cordis_inspect_list` 的 Slots 清单 |
| `hnflow-pass` 行 | `role: pass` 与 `ctx.inject(['hnflow'])` | 触发器不触发、过期不推进、副作用不重放 | 检查该行是否被禁用/报错；`status().pass` 与页面“自动化”面板给出上次扫描 |
| 时钟源 | `setInterval` + `timer.unref()` | 测试进程挂住或 tick 不跑 | 保持 `unref`，首次 tick 用 `setTimeout(≤1s)` |
| command/executed | 客户端本地确认事件，无内置消费者 | 空白会话看不到命令结果 | 不改插件；用页面或先发一条消息 |

## 5. 升级后记录

在 `docs/dsh-plugin-plan-v2.md` 附录 E 追加一行：DSH 版本、探针结果、降级路径是否触发。
若某项契约变化导致降级，必须把降级写进 README 的“已知限制”，而不是静默吞掉。
