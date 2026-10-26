# HNFlow configuration examples

These files are **templates**, not live configuration. `make config` copies them
into the gitignored `hnflow-data/` directory only when the target does not exist.

| Path | Purpose |
|---|---|
| `../config.example.yaml` | Main application config (models, database, sandbox, tools). |
| `../extensions_config.example.json` | MCP servers and skill enablement. |
| `../.env.example` | Backend secrets and runtime environment variables. |
| `frontend.env.example` | Frontend SSR / Next.js environment variables. |
| `prompts/lead-agent.md` | Lead Agent identity and behavior prompt. |
| `model-profiles/default.yaml` | User model-profile example. |
| `workflows/hello.workflow.json` | Minimal valid workflow definition. |
| `workflows/verification.workflow.json` | Formal-verification workflow example. |

The live tree is:

```text
hnflow-data/
├── config.yaml
├── extensions_config.json
├── .env
├── frontend.env
├── prompts/lead-agent.md
├── capability-groups/   # external VibeStack link/clone
├── tools/               # external VibeStack link/clone
├── skills/
├── data/deerflow.db
└── users/{user_id}/threads/{thread_id}/
```

Capability groups and tool packages are managed in the external VibeStack repository and are not seeded by `make config`. `hnflow-data/` is ignored by Git. Workflow definitions and model profiles are
stored transactionally in `hnflow-data/data/deerflow.db`; the JSON/YAML files
here are examples you can import or copy from.
