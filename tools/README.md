# Tool packages

Custom tools are a first-class layer. Capability groups reference tool ids; they
do not own tool definitions.

```text
tools/<name>/<version>/tool.json
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

Tool packages are public-only. User-scoped Python tool packages are intentionally
rejected because they would execute user code inside the Gateway process.

Capability group `group.json` references tools:

```json
{
  "tools": [
    "builtin:read_file",
    "mcp:github:search_repositories",
    "tool:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa@v0.1.0"
  ],
  "tool_permissions": {
    "mcp:github:search_repositories": ["net"]
  }
}
```

Canonical ids:

```text
tool:<guid>@v<version>
mcp:<server>:<tool>
builtin:<name>
sandbox:<name>
app:<name>
```

MCP server transport, credentials, and enablement remain in
`extensions_config.json`; capability groups only reference discovered tools.
