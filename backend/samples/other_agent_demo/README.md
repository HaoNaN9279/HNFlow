# DeerMem 可移植性示例（接入其他 agent）

`backends/deermem/` 是自包含的 memory 后端，只有 **一处** `from deerflow` 导入：`deer_mem.py` 中的 `MemoryManager` ABC。其余均为包内相对导入，因此可以整体搬到其他 agent。

## 三步接入

1. **内置契约**：把 `agents/memory/manager.py` 中的 `MemoryManager` ABC、`get_memory_manager()` 与 `_scan_backends()` 复制到目标 agent；直接实例化 `DeerMem` 时只需要最小 ABC。
2. **复制后端**：把 `backends/deermem/` 放入目标 `backends/`，只改 `deer_mem.py` 的一行：

   ```python
   # from
   from deerflow.agents.memory.manager import MemoryManager
   # to
   from <your_agent>.memory.manager import MemoryManager
   ```

3. **配置**：提供 `deermem_manager.yaml`，调用 `get_memory_manager()` 或直接 `DeerMem(backend_config=...)`。

DeerMem 可在零 `backend_config` 下运行（默认存储 `$DEERMEM_DATA_DIR` 或 `~/.deermem/`，未配置模型时只支持非 LLM 操作）。

## 验证

`tests/test_deermem_self_contained.py::test_portability_vendor_to_other_agent` 把后端复制到临时包、改指向内置契约、完成 `import_memory → get_context` 往返，运行时零 DeerFlow 依赖。

## 配置示例

`deermem_manager.yaml`：

```yaml
manager_class: deermem
backend_config:
  storage_path: ~/.myagent/memory
  model:
    provider: openai
    model: gpt-4o-mini
    api_key: ${OPENAI_API_KEY}
    base_url: https://api.openai.com/v1
  debounce_seconds: 30
  max_facts: 100
```

`callbacks` / `should_keep_hidden_message` 由宿主 `from_config` 注入，不能来自 YAML。
