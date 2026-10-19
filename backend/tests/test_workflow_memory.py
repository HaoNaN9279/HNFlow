"""Tests for N14 §24.1 node-level memory (:mod:`deerflow.workflow.memory`)."""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any

import pytest

from deerflow.workflow.memory import (
    MEMORY_STORE_CONTEXT_KEY,
    InMemoryMemoryStore,
    MemoryPolicy,
    MemoryPolicyError,
    MemoryRecord,
    acollect_memory,
    awrite_memory,
    collect_memory,
    format_memory_block,
    output_text,
    parse_memory_policy,
    render_query,
)


class TestParseMemoryPolicy:
    def test_absent(self) -> None:
        assert parse_memory_policy({}) is None
        assert parse_memory_policy(None) is None

    def test_full(self) -> None:
        policy = parse_memory_policy({"memory": {"scopes": ["node", "long_term"], "query": "{{in}}", "inject_budget": 100, "write": True, "write_scope": "workflow"}})
        assert policy == MemoryPolicy(scopes=("node", "long_term"), query="{{in}}", inject_budget=100, write=True, write_scope="workflow")

    def test_defaults(self) -> None:
        policy = parse_memory_policy({"memory": {"scopes": ["node"]}})
        assert policy == MemoryPolicy(scopes=("node",), query=None, inject_budget=None, write=False, write_scope="node")

    @pytest.mark.parametrize(
        "bad",
        [
            "nope",
            {},
            {"scopes": []},
            {"scopes": ["bogus"]},
            {"scopes": ["node"], "nope": 1},
            {"scopes": ["node"], "query": 3},
            {"scopes": ["node"], "inject_budget": 0},
            {"scopes": ["node"], "inject_budget": True},
            {"scopes": ["node"], "write": "yes"},
            {"scopes": ["node"], "write_scope": "bogus"},
        ],
    )
    def test_bad(self, bad: Any) -> None:
        with pytest.raises(MemoryPolicyError):
            parse_memory_policy({"memory": bad})


class TestRenderQuery:
    def test_template(self) -> None:
        assert render_query("find {{topic}} now", {"topic": "cats"}) == "find cats now"

    def test_missing_key_empty(self) -> None:
        assert render_query("x {{missing}} y", {}) == "x  y"

    def test_no_template_uses_default(self) -> None:
        assert render_query(None, {}, default="fallback") == "fallback"
        assert render_query("", {}, default="fallback") == "fallback"


class TestFormatMemoryBlock:
    def test_empty(self) -> None:
        assert format_memory_block([]) == ""
        assert format_memory_block([MemoryRecord("node", "   ")]) == ""

    def test_renders(self) -> None:
        block = format_memory_block([MemoryRecord("node", "alpha"), MemoryRecord("long_term", "beta")])
        assert block.startswith("<memory>")
        assert "[node] alpha" in block
        assert "[long_term] beta" in block
        assert block.endswith("</memory>")

    def test_budget_stops_fill(self) -> None:
        records = [MemoryRecord("node", "a" * 10), MemoryRecord("node", "b" * 10)]
        block = format_memory_block(records, budget=5)
        assert "a" * 10 in block
        assert "b" * 10 not in block


class TestInMemoryStore:
    def test_put_search(self) -> None:
        store = InMemoryMemoryStore()
        store.put("node", "the quick brown fox")
        store.put("node", "lazy dog")
        assert [r.text for r in store.search("node", "quick")] == ["the quick brown fox"]
        assert len(store.search("node", "")) == 2

    def test_search_limit(self) -> None:
        store = InMemoryMemoryStore()
        for i in range(5):
            store.put("node", f"item {i}")
        assert len(store.search("node", "item", limit=2)) == 2

    def test_scope_isolation(self) -> None:
        store = InMemoryMemoryStore()
        store.put("node", "x")
        assert store.search("long_term", "") == []


class TestCollect:
    def test_collect_sync(self) -> None:
        store = InMemoryMemoryStore()
        store.put("node", "a")
        store.put("workflow", "b")
        policy = MemoryPolicy(scopes=("node", "workflow"))
        assert len(collect_memory(store, policy, query="")) == 2

    @pytest.mark.asyncio
    async def test_collect_async(self) -> None:
        class AsyncStore:
            async def search(self, scope: str, query: str, *, limit: int = 5) -> list[MemoryRecord]:
                return [MemoryRecord(scope, "async-hit")]

            async def put(self, scope: str, text: str, *, key: str | None = None) -> None:
                self.written = (scope, text, key)

        store = AsyncStore()
        records = await acollect_memory(store, MemoryPolicy(scopes=("node",)), query="q")
        assert records[0].text == "async-hit"
        await awrite_memory(store, scope="node", text="t", key="k")
        assert store.written == ("node", "t", "k")


class TestOutputText:
    def test_str_out(self) -> None:
        assert output_text({"out": "hello"}) == "hello"

    def test_non_str_out(self) -> None:
        assert output_text({"out": {"a": 1}}) == '{"a": 1}'

    def test_none_out(self) -> None:
        assert output_text({"something": 1}) == '{"something": 1}'


# ── executor integration ─────────────────────────────────────────────────────


@dataclass
class _Status:
    value: str = "completed"


class _Result:
    status = _Status()
    result = "node-output"
    token_usage_records: list[Any] | None = None
    stop_reason: str | None = None


@pytest.fixture
def fake_executor(monkeypatch: pytest.MonkeyPatch) -> Any:
    captured: dict[str, Any] = {}

    class FakeExecutor:
        def __init__(self, **kwargs: Any) -> None:
            captured["kwargs"] = kwargs

        async def _aexecute(self, task: str, result_holder: Any = None) -> Any:
            captured["task"] = task
            return _Result()

    import deerflow.subagents as subagents_pkg

    monkeypatch.setattr(subagents_pkg, "SubagentExecutor", FakeExecutor)
    monkeypatch.setattr("deerflow.workflow.executors.ai._resolve_node_tools", lambda *a, **k: [])
    monkeypatch.setattr("deerflow.workflow.prompts.load_agent_soul", lambda *a, **k: None)
    yield captured


def _runtime(store: Any) -> Any:
    from deerflow.workflow.compiler import WorkflowRuntime

    return WorkflowRuntime(context={"user_id": "u1", "thread_id": "t", MEMORY_STORE_CONTEXT_KEY: store})


class TestExecutorMemory:
    @pytest.mark.asyncio
    async def test_reads_and_injects(self, fake_executor: dict[str, Any]) -> None:
        from deerflow.workflow.executors.ai import exec_llm_agent

        store = InMemoryMemoryStore()
        store.put("long_term", "the user prefers dark mode")
        await exec_llm_agent(
            _runtime(store),
            {"instruction": "hi", "node_id": "n", "memory": {"scopes": ["long_term"], "query": "prefers"}},
            {},
        )
        system_prompt = fake_executor["kwargs"]["config"].system_prompt
        assert "<memory>" in system_prompt
        assert "dark mode" in system_prompt

    @pytest.mark.asyncio
    async def test_writes_output(self, fake_executor: dict[str, Any]) -> None:
        from deerflow.workflow.executors.ai import exec_llm_agent

        store = InMemoryMemoryStore()
        await exec_llm_agent(
            _runtime(store),
            {"instruction": "hi", "node_id": "n", "memory": {"scopes": ["node"], "write": True, "write_scope": "workflow"}},
            {},
        )
        assert [r.text for r in store.search("workflow", "")] == ["node-output"]

    @pytest.mark.asyncio
    async def test_no_store_no_injection(self, fake_executor: dict[str, Any]) -> None:
        from deerflow.workflow.executors.ai import exec_llm_agent

        await exec_llm_agent(_runtime(None), {"instruction": "hi", "node_id": "n", "memory": {"scopes": ["node"]}}, {})
        assert "<memory>" not in fake_executor["task"]

    @pytest.mark.asyncio
    async def test_continue_rejects_memory(self, fake_executor: dict[str, Any]) -> None:
        from deerflow.workflow.executors.ai import exec_llm_agent
        from deerflow.workflow.registry import WorkflowExecutionError

        with pytest.raises(WorkflowExecutionError, match="memory is not supported"):
            await exec_llm_agent(
                _runtime(InMemoryMemoryStore()),
                {"instruction": "hi", "node_id": "n", "memory": {"scopes": ["node"]}},
                {"continue_prompt": "more"},
            )

    @pytest.mark.asyncio
    async def test_bad_memory_fails(self, fake_executor: dict[str, Any]) -> None:
        from deerflow.workflow.executors.ai import exec_llm_agent
        from deerflow.workflow.registry import WorkflowExecutionError

        with pytest.raises(WorkflowExecutionError, match="invalid memory"):
            await exec_llm_agent(_runtime(InMemoryMemoryStore()), {"instruction": "hi", "node_id": "n", "memory": {"scopes": ["bad"]}}, {})
