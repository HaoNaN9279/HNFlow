# AGENTS.md —— 前端

本文件是前端模块的唯一开发指引。产品概览见根 [README.md](../README.md)，后端契约见 [backend/AGENTS.md](../backend/AGENTS.md)。

## 1. 概览

Next.js 16 App Router + React 19 + TypeScript。前端是**有状态工作台**：工作流画布、项目工作台、常驻 Lead Agent、右侧执行监视共享同一 Workspace 布局与 LangGraph 流。

核心依赖：

- `@langchain/langgraph-sdk`（流式与线程）
- `@langchain/core`
- `@tanstack/react-query`（服务端状态）
- Shadcn UI / MagicUI / React Bits / Vercel AI Elements（注册表生成）

## 2. 命令

| 命令 | 用途 |
| --- | --- |
| `pnpm dev` | Turbopack 开发（3000） |
| `pnpm build` / `start` | 生产构建 / 启动 |
| `pnpm check` | ESLint + `tsc --noEmit`（提交前） |
| `pnpm lint` / `lint:fix` | ESLint |
| `pnpm format` / `format:write` | Prettier |
| `pnpm test` | Rstest 单元测试 |
| `pnpm test:e2e` | Playwright E2E |
| `pnpm typecheck` | 类型检查 |
| `pnpm perf:check` | 路由资源预算 |

E2E 由 Playwright 管理 `next build && next start`，不要手工起服务。

## 3. 源码结构

```text
src/
├── app/                 # App Router 路由与 route handlers
├── components/
│   ├── ui/              # Shadcn（生成，勿手改）
│   ├── ai-elements/     # Vercel AI Elements（生成，勿手改）
│   ├── workspace/       # 工作台、工作流、监视、设置、Lead Agent
│   ├── docs/            # MDX 文档渲染
│   └── landing/         # 静态官网
├── core/                # 业务逻辑
├── hooks/               # 共享 hooks
├── lib/                 # cn() 等工具
├── content/             # 应用内 MDX（en/zh）
├── styles/              # Tailwind v4 与主题变量
└── typings/             # 全局类型
```

`core/` 主要域：

- `threads/`、`messages/`、`api/` —— 会话、流、LangGraph 客户端
- `workflows/` —— 画布模型、校验、节点 schema、folder tree、editor session、human tasks
- `projects/`、`model-profiles/`、`capability-groups/`、`scheduled-tasks/`、`tools/`
- `tasks/`、`todos/`、`skills/`、`mcp/`、`memory/`、`settings/`
- `workspace-changes/`、`workspace-resources/` —— 运行变更与撤销
- `auth/` —— 单用户静态身份
- `i18n/`、`notification/`、`voice-input/`

## 4. 数据流

1. 输入经 `core/threads/hooks.ts` → LangGraph SDK 流式接口。
2. 主线程流使用 SDK `throttle: true`，同一 macrotask 内合并更新；不要替换为数字延迟。
3. `useThreadHistory` 从 `GET /api/threads/{id}/messages/page` 加载分页历史，并按 thread-global `seq` 叠加 checkpoint/live 副本。
4. Stop 立即失效当前线程、历史、token、侧栏缓存，并安排一次补取，等待后端标题/状态收尾。
5. TanStack Query 管服务端状态；localStorage 存 UI 设置；sessionStorage 存 composer 草稿与工作流草稿。
6. 组件订阅线程状态并渲染。

### 流与 SSE

- `core/api/stream-mode.ts` 只允许 `values`、`messages-tuple`、`updates`、`debug`、`tasks`、`checkpoints`、`custom`；`streamResumable` 在 HTTP 前剥离。
- `core/api/api-client.ts` 包装初始/加入流：收到无 id 的 `gap` 控制帧时清空重连元数据、触发 `stream_replay_gap`、重载持久历史并从保留尾部重连（最多 5 次）。
- 不要把 gap 当正常结束，也不要取消仍在运行的后端 run。

### 消息渲染

- assistant 文本与 tool_calls 可共存；工具回合中的可见文本属于 `assistant:processing`。
- 推理应显示在答案文本上方；流式与落定两个组件必须一致。
- 运行级展示（耗时、workspace change）只锚定该 run 最后一个 assistant 气泡，不要挂到每条消息。
- Human input 协议：v1 `free_text` / `choice_with_other`，v2 `form`；未知版本降级为纯文本。

### Composer

- `/goal`、`/compact` 是内建命令，不走 skill 激活。
- `/` 只在输入开头触发 skill 列表；选中后仍可在 chip 旁输入 `/` 替换 skill。
- 草稿按 user + agent + 会话作用域存 sessionStorage；新会话使用稳定作用域 `"new"`。
- 单用户部署无登录页，`AuthProvider` 暴露静态默认用户。

## 5. 交互归属

- `components/workspace/workflow-monitor/global-workflow-monitor.tsx`：右侧常驻执行监视，挂载于布局层。轮询 `/api/workflow-monitor/runs` 与 `/api/human-tasks?status=pending`；只展示执行状态，启动/单步/取消仍由工作台负责；可处理审核、人工任务、单步暂停。
- `components/workspace/lead-agent/`：底部常驻 Lead Agent，挂载于布局层；持有活动 thread，折叠不卸载流；`SkillMenu` 通过 `context.active_skills` 传 skill；`ResourceUndoControl` 调用 `/api/threads/{id}/resource-changes` 与 `/undo`。
- `components/workspace/projects/project-list.tsx`：项目打开/创建/关闭。
- `components/workspace/workbenches/workbench-board.tsx`：项目工作台执行面；启动 `/api/projects/{id}/workbenches/{wid}/runs`，强制 `on_disconnect="continue"`。
- `components/workspace/workflows/workflow-node.tsx`：节点卡片内联编辑，无属性面板；固定参数表单来自 `core/workflows/canvas/node-property-schema.ts`；尺寸/标签写 `metadata.canvas.*`。
- `components/workspace/workflows/workflow-node-form.tsx`：AI 节点表单，包含 agent、model profile、`template_prompt`、`continue_prompt`、Schema 端口。
- `components/workspace/workflows/workflow-canvas.tsx`：双击空白打开节点目录；右键复制/剪切/粘贴；同一输入端口只允许一条入边，`flow:end`/`flow:loop` 例外。
- `components/workspace/workflows/workflow-toolbar.tsx`：只负责保存/返回，无 Run/Stop/Step；有未保存改动时拦截导航。
- `components/workspace/workflows/workflow-list.tsx`：任意层级文件夹树；列表不显示运行状态。
- `core/workflows/editor-session.ts`：按标签页保存最后位置与脏草稿；保存/丢弃时清理。
- `app/workspace/model-profiles/page.tsx` + `components/workspace/model-profiles/`：模型档案 CRUD；节点只存稳定 profile id。
- `app/workspace/capability-groups/page.tsx`：只读 VibeStack 目录；Core 固定，项目内显示 active/inactive；保存工作流会 upsert 到 `.vibestack/stack.json`。
- `core/workflows/human-tasks.ts`：人工任务协议；单步暂停用 `{acknowledge: true}` 恢复（空 payload 会被 LangGraph 视为未恢复）。
- `components/workspace/messages/message-list.tsx`：human input 卡片的待答/最新/已回答门控。

## 6. 工作流编辑器约束

- 定义是纯 JSON；画布只编辑定义、节点尺寸与标签。
- `data:schema` 使用行式 AI Result Schema 编辑器；`core/workflows/canvas/ai-schema.ts` 负责规范化/校验。
- `workflow-ai-prompt-composition.tsx` 通过 `POST /prompt-preview` 预览三层提示词来源。
- 子工作流通过 URL 编码的面包屑进入；共享模板（全局保存）或 `save_mode: "local"` 内联快照。
- 目录移动使用 `folder_id`；删除文件夹不级联删除工作流。
- AI 节点只通过 `params.model_profile` 选模型；输入/输出 Schema 必须来自同一 `data:schema`。

## 7. 代码风格

- 导入顺序：builtin → external → internal → parent → sibling，组内字母序，组间空行；类型用 `import { type Foo }`。
- 未使用变量前缀 `_`。
- 条件类名用 `cn()`（`@/lib/utils`）。
- 路径别名 `@/*` → `src/*`。
- `components/ui/` 与 `components/ai-elements/` 由注册表生成，不要手改。
- Server Components 为默认；仅交互组件加 `"use client"`。
- 根 `app/layout.tsx` 不得读 cookie 或引入聊天专用 KaTeX/Streamdown 样式。

## 8. 测试

- 单元测试 `tests/unit/` 镜像 `src/`；纯逻辑用 node 环境，DOM/渲染用 `*.dom.test.*`（happy-dom，成本约 3 倍）。
- E2E `tests/e2e/` 用 Playwright + `page.route()` mock 后端；真实后端用例在 `tests/e2e-real-backend/`。
- 路由资源预算由 `pnpm perf:check` 检查，超预算优先拆分包，不要随手调高阈值。
- 提交前运行 `pnpm check`；功能与修复必须带测试。

## 9. 环境

- 标准流程无需设置后端 URL，Nginx 代理 `/api/langgraph/*` 与 `/api/*`。
- 非 localhost 开发需配置 `DEER_FLOW_DEV_ALLOWED_ORIGINS`，否则 `/_next/*`、字体、HMR 被 403。
- 环境变量由 `src/env.js` 用 `@t3-oss/env-nextjs` + Zod 校验；可用 `SKIP_ENV_VALIDATION=1` 跳过。

变更架构、命令或约定时同步更新本文件。
