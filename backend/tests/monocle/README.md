# Monocle 行为测试

基于 trace 的 agent 行为测试：Monocle 记录每次运行的 agent/tool 调用、token、耗时，测试用 [Monocle Test Tools](https://github.com/monocle2ai/monocle) 对 trace 断言。

## 分层

- **离线示例**（`test_assertion_api_example`）：从文件加载已录制 trace，展示完整断言 API。无需密钥与网络，验证 trace 格式与 asserter 接线。
- **两个 live 测试**：端到端驱动 agent，对真实 trace 断言路由、工具选择、token 成本。默认跳过，需 `MONOCLE_LIVE_TESTS=1`。

## 目录

- `test_deerflow.py` —— 离线示例 + 两个 live 测试
- `conftest.py` —— `run_agent` fixture（仅 live）
- `_helpers.py` —— 路径与 `run_deerflow()`
- `traces/` —— 离线示例加载的录制 trace
- `requirements.txt` —— 独立依赖

## 运行

`monocle_test_tools` 依赖较重的 ML 栈（torch、transformers 等），不进入后端默认依赖；未安装时整套测试 `pytest.importorskip` 跳过。

```bash
pip install -r backend/tests/monocle/requirements.txt
pytest backend/tests/monocle/                       # 离线
MONOCLE_LIVE_TESTS=1 pytest backend/tests/monocle/  # 含 live
```

使用 uv 时：

```bash
cd backend
uv pip install -r tests/monocle/requirements.txt
uv run pytest tests/monocle/
MONOCLE_LIVE_TESTS=1 uv run pytest tests/monocle/
```

## 录制新 trace

1. 在 Monocle 下运行 agent，trace 默认写入 `.monocle/`。
2. 离线用例：把 trace 放进 `traces/`，用 `with_trace_source("file", trace_path=...)` 加载。
3. 行为用例：通过 `run_agent` 驱动，再用 `validator.test_workflow(...)` 断言。
4. 断言 API：`called_agent`、`called_tool`、`contains_input`、`contains_any_output`、`under_token_limit`、`under_duration`。

离线断言绑定 trace 与 `monocle_apptrace` 的 span 形状；提示词、工具或模型变化后需重新录制。

内容质量评测未接入：当前 `monocle_test_tools` 的本地 evaluator 不能与文件 trace 组合，声明式 `eval` 会被静默忽略，fluent `check_eval()` 与本地 evaluator 签名不兼容。
