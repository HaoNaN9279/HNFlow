# 能力组与工具包外置化

日期：2026-10-26
状态：已实现

## 目标

- HNFlow 不再内置能力组与工具包内容。
- 全局能力组/工具默认路径保持：
  - `hnflow-data/capability-groups`
  - `hnflow-data/tools`
- 用户通过 clone 或符号链接把 VibeStack 仓库接入上述路径。
- 项目能力组默认位于 `<project>/.vibestack/capability-groups/`，不放进 `.hnflow/`。
- HNFlow 只负责发现、解析、校验、运行期快照，不管理外部仓库生命周期。

## 外部仓库

本地路径：`D:/workspace/work/VibeStack`

```text
VibeStack/
├── README.md
├── capability-groups/<name>/<version>/group.json
└── tools/<name>/<version>/tool.json
```

- `capability-groups` 与 `tools` 是同级目录。
- 能力组通过 `group.json.tools` 引用工具 ID。
- `guid` 跨版本稳定，已发布版本目录不可修改。

## HNFlow 项目配置

`.hnflow/project.json` 新增：

```json
{
  "schema_version": 2,
  "capability_groups": {
    "roots": [
      { "id": "project", "path": ".vibestack/capability-groups" }
    ]
  }
}
```

规则：

- 路径相对项目根目录。
- 禁止绝对路径、`..` 逃逸、`.hnflow` 内部路径。
- 允许符号链接/Junction，链接目标可以在项目外。
- 项目能力组根缺失时只报告不可用，不自动创建。

## 解析规则

- 作用域优先级：项目 > 用户 > 全局。
- 同名能力组按作用域覆盖；同一作用域同名不同 GUID 直接报错。
- GUID 查找跨作用域；同一 GUID 同版本内容冲突直接报错。
- 运行开始时记录能力组根、组版本与内容 hash；运行中内容变化时 fail-loud。

## 删除的旧内容

- `config-examples/capability-groups/`
- `config-examples/tools/`
- `scripts/configure.py` 的能力组/工具播种逻辑
- 项目清单 `capability_profile` 字段
- `workspace-manager` 中对 `workbench_manage` 的引用
- 旧能力组/工具示例测试

## HNFlow 代码落点

- `deerflow/capability_groups/discovery.py`：多作用域根、优先级、冲突检测、内容 hash、运行快照校验。
- `deerflow/capability_groups/runtime.py`：规则/技能加载接收项目根。
- `deerflow/projects/schema.py`：`.vibestack/capability-groups` 默认根与路径校验。
- `deerflow/projects/service.py`：项目根解析、状态、清单热更新。
- `deerflow/workflow/tool_gateway.py`、`executors/ai.py`：项目作用域工具解析。
- `deerflow/workflow/prompt_preview.py`：项目作用域 prompt 预览。
- `deerflow/persistence/workflow_definitions/service.py`：lockfile 与能力组快照。
- `app/gateway/routers/capability_groups.py`：`project_id` 查询。
- `app/gateway/routers/workflow_routes.py`、`workflow_run_routes.py`、`project_routes.py`：项目作用域保存/预览/运行。
- `config/paths.py`：能力组/工具目录改为可选外部仓库根。
- `portability/select.py`：HNFlow 备份排除外部能力组/工具。
- 前端：项目能力组来源、项目作用域 hooks、prompt preview 与保存参数。

## 验收结果

- 全局能力组/工具通过 Junction 从 VibeStack 发现：
  - `capability-groups` -> `D:/workspace/work/VibeStack/capability-groups`
  - `tools` -> `D:/workspace/work/VibeStack/tools`
  - `make doctor`：5 个能力组、1 个工具包。
- `make config` 不创建、不覆盖能力组/工具。
- 项目能力组仅在该项目上下文中可见。
- 项目同名组覆盖全局组。
- 工作流保存、预览、运行携带项目能力组作用域。
- 运行快照在组内容变化时拒绝继续。
- 后端：`11352 passed, 136 skipped`；`test_extension_task_lifecycle` 的既有计时测试偶发失败一次，单独重跑通过。
- 前端：`pnpm check` 通过，`pnpm test` 1157 passed。
- E2E：`tests/e2e/workbench.spec.ts` 通过。
- VibeStack 提交：
  - `3c242c7 feat: move HNFlow capability groups and tools into VibeStack`
  - `87160ad docs: align workspace capability group with project-managed workbenches`
- HNFlow 提交：`3059bae feat(capabilities): externalize capability groups and tools`
