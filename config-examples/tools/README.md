# Tool package examples

Custom tools are a first-class layer. Capability groups reference tool ids; they
do not own tool definitions.

```text
hnflow-data/tools/<name>/<version>/tool.json
```

`tool.json`:

```json
{
  "schema_version": 1,
  "guid": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
  "name": "query-sales",
  "version": "0.1.0",
  "description": "Query sales data",
  "provider": "python",
  "entrypoint": "tool.py:build_tool",
  "permissions": ["fs"],
  "idempotent": true
}
```

- `guid`: 32 lowercase hex characters.
- `name`: package slug.
- `provider`: `python`, `mcp`, `builtin`, `sandbox`, or `app`.
- `python`: `entrypoint` is `<file>:<attribute>`; the attribute must be a
  `BaseTool` or a zero-argument factory returning one.
- `mcp`: `server` and `tool` are required.
- `builtin` / `sandbox`: `tool` is required.
- `app`: `app` (or `tool`) is required.
- `permissions`: subset of `fs`, `net`, `exec`, `secrets`.

Tool packages execute inside the Gateway process. Treat `hnflow-data/tools/` as
trusted local code; do not expose an arbitrary upload endpoint for it.
