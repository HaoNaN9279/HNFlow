# HNFlow 配置模板

这些文件是**模板**，不是运行配置。`make config` 只把缺失项复制到 gitignored 的 `hnflow-data/`。

| 路径 | 用途 |
| --- | --- |
| `../config.example.yaml` | 主配置（模型、数据库、沙箱、工具） |
| `../extensions_config.example.json` | MCP 服务器与 skill 启停 |
| `../.env.example` | 后端密钥与运行时环境变量 |
| `frontend.env.example` | 前端 SSR / Next.js 环境变量 |
| `prompts/lead-agent.md` | Lead Agent 身份与行为提示词 |
| `model-profiles/default.yaml` | 模型档案示例 |
| `workflows/hello.workflow.json` | 最小工作流定义 |
| `workflows/verification.workflow.json` | 形式化验证工作流示例 |

运行时目录：

```text
hnflow-data/
├── config.yaml / extensions_config.json / .env / frontend.env
├── prompts/lead-agent.md
├── skills/
├── data/deerflow.db
└── users/{user_id}/threads/{thread_id}/...
```

能力组与工具包由外部 VibeStack 仓库提供（`vibestack.repository`），不会播种到 `hnflow-data/`。工作流定义、规约与模型档案保存在 `hnflow-data/data/deerflow.db`；这里的 JSON/YAML 仅作导入/复制示例。

迁移旧布局用 `make data-migrate`（`DRY=1` 预览），只复制不删除。
