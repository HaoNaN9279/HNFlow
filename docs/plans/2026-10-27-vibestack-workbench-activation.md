# VibeStack 项目激活与工作台同步

日期：2026-10-27
状态：已实现

## 目标

- HNFlow 直接读取用户配置的 VibeStack checkout，不再依赖 `hnflow-data/capability-groups` / `tools` 链接。
- 项目激活配置统一为 `<project>/.vibestack/stack.json`。
- Core 固定加载。
- 节点未选择能力组时只使用 Core；节点可以选择 VibeStack 仓库中的任意组。
- 工作台添加工作流、保存成员工作流时，将所需组增量写入项目 stack。
- 项目配置修改只影响需要变更的组，不删除其他无关能力组。
- 删除工作台不修改项目 stack。
- 能力组面板只读列出仓库中的所有组和版本。

## VibeStack 约定

```text
<repo>/
├── capability-groups/<name>/<version>/group.json
└── tools/<name>/<version>/tool.json
```

`stack.json`：

```json
{
  "schema_version": 1,
  "core": { "name": "core", "version": "0.1.0" },
  "agents": [],
  "groups": [{ "name": "data-forge", "version": "1.0.0" }]
}
```

加载顺序：Core → `groups` 顺序 → `extends` 依赖；按 GUID 去重。

## 仓库解析

优先级：

1. `config.yaml -> vibestack.repository`
2. `VIBESTACK_HOME`
3. `VIBESTACK_REPO`
4. `~/.config/vibestack/config.json -> repository`

Core：

1. 项目 stack 的 `core`
2. HNFlow `vibestack.core`
3. VibeStack 全局 `core`
4. `core@0.1.0`

## 项目激活语义

- 项目 stack 是工作台工作流选择的**增量投影**。
- 工作台创建时如果 stack 缺失，自动创建 Core-only stack。
- 添加工作流成员或保存工作流时，只 upsert 该工作流实际选择的组。
- 已存在的无关组保持原样。
- 同名组版本冲突 fail-loud。
- 删除工作台不回写 stack。
- 节点未选择组时只加载 Core。
- 运行开始时读取当前 stack；运行快照记录实际加载的 `guid@version` 与内容 hash。

## 代码落点

- `deerflow/config/vibestack_config.py`：仓库与 Core 配置。
- `deerflow/capability_groups/vibestack.py`：仓库发现、stack 读写、增量 upsert、组闭包、快照校验。
- `deerflow/projects/capability_activation.py`：从 workflow definition 收集组并增量激活。
- `deerflow/projects/service.py`：工作台创建初始化 Core、成员添加激活组、stack 状态；删除工作台不写 stack。
- `app/gateway/project_context.py`：运行 metadata 注入 VibeStack 仓库、stack 与组快照。
- `app/gateway/routers/capability_groups.py`：只读全量目录、所有版本、active/inactive。
- `app/gateway/routers/workflow_routes.py`：项目工作流保存前增量激活。
- `deerflow/workflow/executors/ai.py`、`runtime_context.py`、`tool_gateway.py`、`prompt_preview.py`：Core + 节点选择组。
- `deerflow/persistence/workflow_definitions/service.py`：lockfile 记录实际组快照。
- 前端能力组面板与节点选择器：全量只读、Core/active/inactive 标记、选择未激活组后保存同步。

## 验证

- 后端全量：`11353 passed, 136 skipped`。
  - `test_extension_task_lifecycle.py::test_budget_exhaustion_mid_hook_logs_a_warning_not_a_traceback` 出现既有计时 flaky，单独重跑通过。
- 后端 `ruff check .`、`ruff format --check .` 通过。
- 前端 `pnpm check`、`pnpm format`、`pnpm test`（1157 passed）通过。
- E2E `tests/e2e/workbench.spec.ts` 通过。
- `make doctor`：VibeStack Core、15 个能力组、10 个工具包。
