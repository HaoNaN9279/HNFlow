# Memory 后端

`agents/memory/backends/` 下每个子目录是一个可插拔后端，切换只需改 `config.yaml` 的 `memory.manager_class`。

| 后端 | 说明 |
| --- | --- |
| `deermem/` | 默认：结构化事实 + JSON/Markdown 存储 |
| `noop/` | 空实现，新增后端的模板 |
| `openviking/` | 远程 `langchain-openviking`，单用户 middleware 模式 |
| `honcho/` | 远程 Honcho HTTP，服务端构建用户画像 |
| `mem0/` | 远程 mem0 API，去重/抽取/存储在服务端 |

## 切换

```yaml
memory:
  manager_class: deermem   # 或 noop / openviking / honcho / mem0
  backend_config: { ... }
```

`MemoryManager` 是进程级单例，修改后需重启。

## 后端契约

- **Tier 1（必须）**：`add`、`get_context`。
- **Tier 2（有默认）**：`add_nowait`、`search`、`get_memory`、`clear_memory`、`import_memory`、`export_memory`、`delete_memory`、`shutdown_flush`。
- **Tier 3（可选 hook）**：`warm`、`reload_memory`、`create_fact`、`delete_fact`、`update_fact`、`on_pre_compress`、`on_turn_start`。
- 新增后端至少实现 `from_config` + `add` + `get_context`；参考 `noop/`。
- `get_memory` / `export_memory` 等返回 DeerMem 形状（`version/lastUpdated/user/history/facts[]`），否则前端会丢数据或崩溃。
- 网络后端应实现 `a*` 异步方法或在内部 offload；mem0 默认要求 HTTPS，本地 HTTP 需显式 `allow_insecure_http: true`。

## 隔离与配置

- 存储按用户隔离：`users/{user_id}/memory.json`，事实在 `users/{user_id}/agents/{agent_name}/facts/`。
- 后端只能通过 ABC 方法参数与 `backend_config` 访问宿主；除 ABC 导入外不要导入 `deerflow` 内部模块，保持可移植。
- 外部依赖必须写入 `packages/harness/pyproject.toml`，否则 `uv sync` 会清除。

新增后端详见 `noop/noop_manager.py` 顶部 docstring。
