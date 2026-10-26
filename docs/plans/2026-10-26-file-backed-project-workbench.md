# 文件化项目工作台开发方案

状态：已完成
日期：2026-10-26
范围：Project + Workbench 文件化；不做旧数据迁移。

## 1. 目标

- 项目配置保存在项目目录 `.hnflow/project.json`。
- 工作台保存在项目目录 `.hnflow/workbenches/*.workbench.json`。
- 工作台与项目绑定，项目配置由项目文件拥有，不写入工作台。
- 新 API 和前端只使用文件化项目/工作台。
- 旧工作台公开 API、页面和旧数据在完成后删除。
- 现有 workflow 定义、运行、监控、人工任务继续工作。

## 2. 本期边界

- 文件是 Project / Workbench 的事实源。
- Workbench 文件成员继续引用现有 DB 中的 workflow `definition_id`；本期不文件化 workflow。
- DB 中保留一张 Workbench 镜像表，供运行监控和既有 workspace 工具读取；镜像由文件服务单向写入。
- 运行元数据保存 project snapshot 和 workbench snapshot，供本次运行及恢复使用。
- 不做旧工作台数据迁移；旧公开入口删除，旧数据清理。

## 3. 文件格式

```text
<project-root>/
  .hnflow/
    project.json
    workbenches/
      <workbench-id>.workbench.json
```

### project.json

```json
{
  "schema_version": 2,
  "project_id": "proj-...",
  "name": "example",
  "description": "",
  "default_environment": "local",
  "capability_groups": {
    "roots": [{"id": "project", "path": ".vibestack/capability-groups"}]
  },
  "roots": [{"id": "main", "path": ".", "mode": "rw"}],
  "mcp_allowlist": [],
  "secret_refs": [],
  "settings": {}
}
```

### workbench.json

```json
{
  "schema_version": 1,
  "project_id": "proj-...",
  "workbench_id": "wb-...",
  "name": "Daily",
  "description": "",
  "layout": {"version": 1, "cards": []},
  "settings": {},
  "members": [
    {"definition_id": "wf-...", "order_index": 0, "settings": {}}
  ],
  "revision": 1,
  "created_at": "...",
  "updated_at": "..."
}
```

约束：

- Workbench `settings` 只允许展示配置，禁止项目级字段。
- 文件写入使用同目录临时文件 + 原子替换。
- 文件路径必须位于项目根 `.hnflow` 内。
- 同一项目的工作台 ID 唯一；跨项目也使用全局唯一 ID。
- 外部修改由每次读取/写入时重新读取文件发现；不引入文件 watcher。

## 4. 数据模型

新增 `projects`：

- `id`
- `user_id`
- `name`
- `root_path`
- `manifest_hash`
- `created_at`
- `updated_at`
- 唯一约束：`(user_id, root_path)`

扩展 `workflow_workbenches`：

- `project_id` 可空；文件化工作台写入项目 ID，旧 DB-only 行为空。

旧数据清理：

- 新迁移删除 `project_id IS NULL` 的旧 workbench 和 members。
- 不迁移旧工作台。

## 5. 服务设计

### ProjectService

- `create(root_path, name)`：创建 `.hnflow`、project.json、workbenches 目录，并登记 DB。
- `open(root_path)`：读取并校验已有项目，登记/刷新 DB 索引。
- `list/get/close`：关闭只移除 DB 登记，不删除项目文件。
- 路径必须存在、可读、位于解析后的绝对路径内。
- 同一 project ID 不能绑定两个根目录。

### WorkbenchFileStore

- `list(project)`：读取 `.hnflow/workbenches/*.workbench.json`。
- `get(project, workbench_id)`：严格校验。
- `create/update/delete`：原子写文件、revision 递增。
- `add_member/remove_member`：写文件并重建 DB 镜像。
- 成员必须引用当前用户存在的 workflow definition。
- 读取时填充 `definition_name` / `definition_exists`。

### DB 镜像

- 文件写入成功后，同步 `workflow_workbenches` / members。
- 镜像失败不回滚文件；记录错误，下一次读取/写入可修复。
- 运行监控仍使用镜像读取 workbench name。
- 文件化工作台 ID 在镜像中带 `project_id`，workspace 服务修改这类行时拒绝，避免文件/DB 双写。

## 6. API

新增：

```text
GET    /api/projects
POST   /api/projects
POST   /api/projects/open
GET    /api/projects/{project_id}
DELETE /api/projects/{project_id}

GET    /api/projects/{project_id}/workbenches
POST   /api/projects/{project_id}/workbenches
GET    /api/projects/{project_id}/workbenches/{workbench_id}
PUT    /api/projects/{project_id}/workbenches/{workbench_id}
DELETE /api/projects/{project_id}/workbenches/{workbench_id}
POST   /api/projects/{project_id}/workbenches/{workbench_id}/members
DELETE /api/projects/{project_id}/workbenches/{workbench_id}/members/{definition_id}
POST   /api/projects/{project_id}/workbenches/{workbench_id}/runs
```

删除：

```text
/api/workbenches/*
```

运行：

- `start_workflow_run` metadata 增加：
  - `project_id`
  - `project`（manifest snapshot）
  - `workbench_id`
  - `workbench`（workbench snapshot）
- runtime context 暴露 `project` / `workbench`，供后续节点使用。
- 人类任务恢复保留原始 metadata。

## 7. 前端

- 新增 `/workspace/projects` 项目列表/打开项目。
- 新增 `/workspace/projects/[project_id]/workbenches` 工作台列表。
- 新增 `/workspace/projects/[project_id]/workbenches/[workbench_id]` 工作台看板。
- 工作台 API hooks 改为 project-scoped。
- 删除旧 `/workspace/workbenches` 页面与旧 hooks。
- 导航增加 Projects，移除旧 Workbenches 入口。

## 8. 删除旧内容

完成后删除：

- `backend/app/gateway/routers/workbench_routes.py`
- `backend/tests/test_workbench_routes.py`
- 旧 `/api/workbenches` 前端 API 与页面
- 旧 workbench 导航入口
- 旧 DB-only workbench 数据（迁移清理）

保留：

- `workflow_workbenches` 表作为文件工作台的内部镜像，供监控/workspace 读取。
- `workflow_monitor_routes` 的既有运行聚合。

## 9. 测试

后端：

- project 创建/打开/重复根/重复 ID。
- 文件写入原子性与路径校验。
- workbench CRUD、revision 冲突、成员增删。
- 文件与 DB 镜像一致。
- workbench 运行携带 project snapshot，恢复保留 metadata。
- 旧公开 workbench 路由不存在。
- 旧数据清理由迁移测试或直接服务测试覆盖。

前端：

- 项目列表/打开。
- project-scoped workbench 列表/看板。
- `pnpm check`。
- 更新相关 unit/E2E 路由。

## 10. 验收

- 新项目只通过项目目录文件管理。
- 工作台文件在 `.hnflow/workbenches` 下可读、可提交 Git。
- 项目配置不写入工作台文件。
- 旧 `/api/workbenches` 与旧页面不可用。
- 现有 workflow/run/monitor 测试通过。
- 后端离线测试、前端 check/test 通过。
- 提交完成。

## 11. 进度

- [x] 方案文档与状态跟踪
- [x] Project 文件模型与 DB 索引
- [x] Workbench 文件服务与 DB 镜像
- [x] API 与运行时项目上下文
- [x] 前端项目/工作台
- [x] 删除旧内容
- [x] 测试
- [x] 文档与提交

## 12. 完成记录

- 后端：`deerflow.projects` 文件服务、项目注册表、0026 迁移、项目 API、运行时 project/workbench 上下文。
- 旧内容：删除 `/api/workbenches` 路由、旧前端页面、旧工作台路由测试；迁移清理 `project_id IS NULL` 的旧工作台及其成员。
- 保留：`workflow_workbenches` 作为文件工作台的 SQL 镜像，供 monitor/workspace 读取；Lead Agent 的 workbench 写工具不再暴露。
- 测试：后端 `11350 passed, 136 skipped`；前端 `pnpm check`、`pnpm test`（1157 passed）；`workbench.spec.ts` E2E 通过。
- 提交：`24f9e52 feat(projects): add file-backed projects and workbenches`。
