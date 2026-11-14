# DSH 升级回归清单

每次 DSH 升级（桌面版或 web profile）后按本清单回归。不要只看“插件加载成功”。

## 1. 静态与单元

```sh
cd plugins/dsh
node test/run.mjs
```

要求全部通过。重点：

- `flow/schema.js`：`type` 与 `oneOf` 不能同时出现；
- `flow/envelope.js`：节点信封是 object-rooted 的扁平对象；
- `runner.test.js`：`startActivation` 收到 `signal`，`maxDepth=1`；
- `service.test.js` / `human.test.js`：门禁、交付、过期、审计仍符合状态机。

Python 解析器：

```sh
python -m pytest tests -q
```

## 2. 原生契约探针

在隔离 `DSH_HOME` 起一个 web 实例：

```powershell
$env:DSH_HOME='<repo>/temp/dshhome'
$env:HNFLOW_TRACE='1'
dsh --profile ztest --no-open --port 3999
```

| 探针 | 通过标准 | 失败时的降级 |
| --- | --- | --- |
| `subagents.startActivation(spawn, delivery:'caller', outputSchema)` | 子 Agent 返回 `structured`，节点 done | `node-spawn-failed` |
| `agents.create` conductor | 页面启动的 run 由 conductor 跑通 | `host-unavailable` |
| storageDomain 跨进程读回 | 重启后 `/api/hnflow/state` 仍列出旧 run | 文件存储 + `storage-degraded` 告警 |
| `userQuestions.ask()` + POST fetch 路由 | 收件箱出现 `askedVia: card`，页面可裁决 | 卡片失败只记日志 |
| `ctx.get('capability')` + `agentOptions` | `apiVersion >= 3`；模型层解析出 provider/model | `capability-unavailable`；未绑定层 `model-layer-unbound` |
| client 槽位 | `sidebar.panellist` / `main` / `conversation.view` / `sidebarRightTabs` / `shell.overlay` / `conversation.input.left` 都注册 | 页面或页签空白 |
| `hnflow-pass` 行 | 触发器生效、过期推进、副作用重放 | 检查该行是否被禁用 |

## 3. 页面回归

1. 左栏 **HNFlow** 三页签可切换；流程树列出能力组流程。
2. 选流程：只读画布、所属能力组、`requires`、启动输入。
3. 输入 JSON → 运行 → 收件箱出现门禁 → 批准 → 运行页显示 `succeeded`。
4. 运行页：节点 token 用量、产物按钮、取消/继续。
5. 输入框左下角 `▤` 打开上下文预览，能看到 persona、rules、skills、commands、flows、mcp、agents。
6. 右下角模型位是「模型层」而不是原生模型选择；左下角只有 Agent 选择与 `▤`。
7. 新窗口切到 HNFlow：不报 `no usable Capability plan`，工作区自动补 `.hnflow/stack.json`。
8. 模型层选择器与 `/capability-layer` 生效；Agent 选择器与 `/capability-agent` 生效。
9. 浏览器 console 无 error、无 pageerror。

## 4. 常见契约变更

| 契约 | 症状 | 处理 |
| --- | --- | --- |
| `startActivation` 参数 | `node-spawn-failed` | 对照 `dsh-subagent` README 修 `lib/runner.js` |
| `signal` 必填 | spawn 立即失败 | 始终传 `AbortController.signal` |
| `maxDepth` | `subagent depth 1 exceeds maxDepth 0` | 保持 1 |
| structured output schema | `UNSUPPORTED_SCHEMA` | 修 `flow/envelope.js`、`flow/schema.js` |
| storage domain | 打不开/串 run | core 独占；失败走文件降级 |
| `hnflow-pass` | 触发器不触发 | 检查行是否被禁用/报错 |
