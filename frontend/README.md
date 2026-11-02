# HNFlow 前端

Next.js App Router 界面：工作流画布、项目工作台、全局执行监视、Lead Agent 对话、模型档案、能力组目录、定时任务与工具页。

开发约束与架构细节见 [AGENTS.md](AGENTS.md)。

## 技术栈

- Next.js 16（App Router）、React 19、TypeScript 5.8
- Tailwind CSS 4、Shadcn UI、MagicUI、React Bits、Vercel AI Elements
- LangGraph SDK、LangChain Core、TanStack Query
- 测试：Rstest（单元）、Playwright（E2E）

## 环境要求

- Node.js 22+
- pnpm 10.26.2+

## 安装与开发

```bash
pnpm install
cp .env.example .env
pnpm dev
```

打开 <http://localhost:3000>。标准开发栈从仓库根执行 `make dev`，前端经 nginx（2026）访问后端。

## 命令

| 命令 | 说明 |
| --- | --- |
| `pnpm dev` | Turbopack 开发服务器 |
| `pnpm build` | 生产构建 |
| `pnpm start` | 启动生产服务器 |
| `pnpm check` | ESLint + TypeScript 检查（提交前必跑） |
| `pnpm lint` / `lint:fix` | 仅 ESLint |
| `pnpm format` / `format:write` | Prettier 检查 / 修复 |
| `pnpm test` | Rstest 单元测试 |
| `pnpm test:e2e` | Playwright E2E（Chromium） |
| `pnpm typecheck` | `tsc --noEmit` |
| `pnpm perf:check` | 路由资源预算检查 |

首次 E2E 需安装浏览器：

```bash
pnpm exec playwright install chromium
```

## 环境变量

标准 `make dev` / Docker 流程无需设置，Nginx 代理 `/api/langgraph/*` 与 `/api/*`：

```text
NEXT_PUBLIC_BACKEND_BASE_URL=http://localhost:8001
NEXT_PUBLIC_LANGGRAPH_BASE_URL=http://localhost:8001/api
```

非 localhost 开发需把主机加入 `DEER_FLOW_DEV_ALLOWED_ORIGINS`（逗号分隔），否则 HMR/字体等 `/_next/*` 请求被 403。

## 主要路由

| 路由 | 页面 |
| --- | --- |
| `/` | 重定向到 `/workspace/workflows` |
| `/workspace/workflows` | 工作流目录 |
| `/workspace/workflows/[id]` | 工作流画布编辑器 |
| `/workspace/projects` | 项目列表 |
| `/workspace/projects/[project_id]/workbenches` | 项目工作台列表 |
| `/workspace/projects/[project_id]/workbenches/[workbench_id]` | 执行工作台 |
| `/workspace/capability-groups` | VibeStack 能力组只读目录 |
| `/workspace/model-profiles` | 模型档案 |
| `/workspace/scheduled-tasks` | 定时任务 |
| `/workspace/tools` | 工具目录 |
| `/[lang]/docs/...` | 应用内文档 |

Lead Agent 无独立路由，常驻于 Workspace 布局底部；右侧全局执行监视同样挂载在布局层。

## 测试

- 单元测试在 `tests/unit/`，镜像 `src/` 结构；纯逻辑用 node 环境，渲染/DOM 用 `*.dom.test.*`。
- E2E 在 `tests/e2e/`，通过 `page.route()` mock 后端。
- 提交前运行 `pnpm check`。
