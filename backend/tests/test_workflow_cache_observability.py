"""Workflow cache/token observability tests (W1C).

Covers the exposure path for AI-node sub-agent token usage — specifically the
prompt-cache ``cache_read_tokens`` consumed by cache-aware pricing:

1. ``exec_llm_agent`` aggregates ``SubagentResult.token_usage_records`` onto a
   reserved ``__workflow_token_usage`` result key (absent when no records).
2. The compiler lifts that key onto a declared state channel
   ``wf:<node>:__token_usage`` for AI nodes only.
3. The workflow worker aggregates per-node channels into an additive
   ``token_usage`` key on the opaque ``run.end`` content.
4. ``get_workflow_run`` surfaces the persisted ``token_usage`` as an optional
   additive summary field without changing any existing key.

Existing contract tests (``test_workflow_ai_node.py``,
``test_workflow_runtime_tools.py``, ``test_workflow_dispatch.py``) must keep
passing: the reserved key only appears when usage records exist.
"""

from __future__ import annotations

from types import SimpleNamespace
from typing import Any
from unittest.mock import AsyncMock

import pytest
from langgraph.checkpoint.memory import InMemorySaver

from deerflow.runtime.events.store.memory import MemoryRunEventStore
from deerflow.runtime.runs.manager import RunManager
from deerflow.runtime.runs.schemas import RunStatus
from deerflow.runtime.runs.worker import RunContext
from deerflow.workflow.compiler import (
    CompileContext,
    WorkflowRuntime,
    clear_compile_cache,
    compile_definition,
)
from deerflow.workflow.dispatch import WORKFLOW_RUNTIME_CONTEXT_KEY, get_workflow_run
from deerflow.workflow.executors import exec_llm_agent
from deerflow.workflow.schema import Edge, Node, NodeType, Port, PortType, WorkflowDefinition
from deerflow.workflow.worker import _aggregate_final_token_usage, run_workflow

# ═══════════════════════════════════════════════════════════════════════════════
# Helpers
# ═══════════════════════════════════════════════════════════════════════════════


def _make_def(nodes: list[Node], edges: list[Edge], **kwargs: Any) -> WorkflowDefinition:
    kwargs.setdefault("id", "test-wf")
    kwargs.setdefault("name", "Test Workflow")
    return WorkflowDefinition(nodes=nodes, edges=edges, **kwargs)


def _start_node(id_: str = "start") -> Node:
    return Node(id=id_, type=NodeType.FLOW_START, inputs=[], outputs=[Port(name="input", type=PortType.DATA)])


def _end_node(id_: str = "end") -> Node:
    return Node(id=id_, type=NodeType.FLOW_END, inputs=[Port(name="in", type=PortType.DATA)], outputs=[])


def _ai_node(id_: str = "ai_step") -> Node:
    return Node(
        id=id_,
        type=NodeType.AI_LLM_AGENT,
        params={},
        inputs=[
            Port(name="in", type=PortType.DATA),
            Port(name="template_prompt", type=PortType.DATA),
        ],
        outputs=[Port(name="out", type=PortType.DATA)],
    )


def _usage_records() -> list[dict[str, int | str | None]]:
    return [
        {"input_tokens": 100, "output_tokens": 50, "total_tokens": 150, "cache_read_tokens": 20},
        {"input_tokens": 200, "output_tokens": 100, "total_tokens": 300, "cache_read_tokens": 10},
    ]


def _completed_result(text: str = "AI done", records: list[dict[str, int | str | None]] | None = None) -> SimpleNamespace:
    return SimpleNamespace(
        status=SimpleNamespace(value="completed"),
        result=text,
        error=None,
        token_usage_records=records,
    )


class _FakeSubagentExecutor:
    """Drop-in ``SubagentExecutor`` replacement scripted with a fixed result.

    Patching targets the *class* (``exec_llm_agent`` instantiates
    ``SubagentExecutor(**kwargs)``), so the scripted result lives on the class.
    """

    result: Any = None

    def __init__(self, **kwargs: Any) -> None:
        self.kwargs = kwargs

    async def _aexecute(self, task: str, result_holder: Any = None) -> Any:
        return type(self).result


def _patch_subagent_executor(monkeypatch: pytest.MonkeyPatch, fake_cls: type, result: Any) -> None:
    import deerflow.subagents as subagents_pkg

    fake_cls.result = result
    monkeypatch.setattr(subagents_pkg, "SubagentExecutor", fake_cls)


# ═══════════════════════════════════════════════════════════════════════════════
# Fixtures
# ═══════════════════════════════════════════════════════════════════════════════


@pytest.fixture(autouse=True)
def _isolate_cache() -> Any:
    clear_compile_cache()
    yield


# ═══════════════════════════════════════════════════════════════════════════════
# 1. exec_llm_agent aggregation
# ═══════════════════════════════════════════════════════════════════════════════


class TestExecLlmAgentTokenUsage:
    @pytest.mark.asyncio
    async def test_aggregates_cache_read_tokens_from_records(self, monkeypatch: pytest.MonkeyPatch) -> None:
        _patch_subagent_executor(monkeypatch, _FakeSubagentExecutor, _completed_result(records=_usage_records()))

        result = await exec_llm_agent(WorkflowRuntime(), {}, {"in": "x", "template_prompt": "do {{in}}"})

        assert result["out"]["content"] == "AI done"
        usage = result["__workflow_token_usage"]
        assert usage["input_tokens"] == 300
        assert usage["output_tokens"] == 150
        assert usage["total_tokens"] == 450
        assert usage["cache_read_tokens"] == 30

    @pytest.mark.asyncio
    async def test_omits_reserved_key_when_no_records(self, monkeypatch: pytest.MonkeyPatch) -> None:
        # A result without ``token_usage_records`` keeps the exact pre-feature
        # output shape — pins test_workflow_ai_node.py's ``{"out": ...}``.
        _patch_subagent_executor(
            monkeypatch,
            _FakeSubagentExecutor,
            SimpleNamespace(status=SimpleNamespace(value="completed"), result="ok", error=None),
        )

        result = await exec_llm_agent(WorkflowRuntime(), {}, {"in": "x", "template_prompt": "do {{in}}"})

        assert result["out"]["content"] == "ok"
        assert result["__workflow_prompt"]

    @pytest.mark.asyncio
    async def test_sparse_cache_read_aggregates_to_zero(self, monkeypatch: pytest.MonkeyPatch) -> None:
        # The collector's ``cache_read_tokens`` key is sparse (absent when no
        # prompt-cache hit was reported); the aggregate always carries it as 0.
        _patch_subagent_executor(
            monkeypatch,
            _FakeSubagentExecutor,
            _completed_result(records=[{"input_tokens": 5, "output_tokens": 3, "total_tokens": 8}]),
        )

        result = await exec_llm_agent(WorkflowRuntime(), {}, {"in": "x", "template_prompt": "do {{in}}"})

        usage = result["__workflow_token_usage"]
        assert usage["cache_read_tokens"] == 0
        assert usage["total_tokens"] == 8


# ═══════════════════════════════════════════════════════════════════════════════
# 2. Compiler state-channel lifting
# ═══════════════════════════════════════════════════════════════════════════════


class TestCompilerTokenUsageChannel:
    @pytest.mark.asyncio
    async def test_ai_node_lifts_reserved_key_to_state_channel(self) -> None:
        per_node = {"input_tokens": 10, "output_tokens": 5, "total_tokens": 15, "cache_read_tokens": 2}

        def fake_executor(_rt: Any, params: dict[str, Any], _inputs: dict[str, Any]) -> dict[str, Any]:
            return {"out": "done", "__workflow_token_usage": per_node}

        nodes = [_start_node(), _ai_node("ai_step"), _end_node()]
        edges = [
            Edge(source="start", source_port="input", target="ai_step", target_port="in"),
            Edge(source="start", source_port="input", target="ai_step", target_port="template_prompt"),
            Edge(source="ai_step", source_port="out", target="end", target_port="in"),
        ]
        def_ = _make_def(nodes, edges)
        ctx = CompileContext(executors={NodeType.AI_LLM_AGENT: fake_executor})
        graph = compile_definition(def_, context=ctx)

        state = await graph.ainvoke({"wf:start:input": "x"})

        assert state.get("wf:ai_step:out") == "done"
        assert state.get("wf:ai_step:__token_usage") == per_node

    @pytest.mark.asyncio
    async def test_non_ai_node_reserved_key_is_not_lifted(self) -> None:
        # A non-AI executor may return the reserved key; the compiler must not
        # create the observability channel for it (only ai:llm_agent).
        def fake_executor(_rt: Any, params: dict[str, Any], _inputs: dict[str, Any]) -> dict[str, Any]:
            return {"out": "done", "__workflow_token_usage": {"cache_read_tokens": 99}}

        assign = Node(
            id="a",
            type=NodeType.DATA_ASSIGN,
            params={"value": "x"},
            inputs=[Port(name="in", type=PortType.DATA)],
            outputs=[Port(name="out", type=PortType.DATA)],
        )
        nodes = [_start_node(), assign, _end_node()]
        edges = [
            Edge(source="start", source_port="input", target="a", target_port="in"),
            Edge(source="a", source_port="out", target="end", target_port="in"),
        ]
        def_ = _make_def(nodes, edges)
        ctx = CompileContext(executors={NodeType.DATA_ASSIGN: fake_executor})
        graph = compile_definition(def_, context=ctx)

        state = await graph.ainvoke({"wf:start:input": "x"})

        assert state.get("wf:a:out") == "done"
        assert "wf:a:__token_usage" not in state


# ═══════════════════════════════════════════════════════════════════════════════
# 3. Worker run.end aggregation
# ═══════════════════════════════════════════════════════════════════════════════


def _make_bridge() -> Any:
    class _MockBridge:
        def __init__(self) -> None:
            self.events: list[tuple[str, str, Any]] = []
            self.publish = AsyncMock(side_effect=self._record)
            self.publish_end = AsyncMock()
            self.cleanup = AsyncMock()

        async def _record(self, run_id: str, event: str, data: Any) -> None:
            self.events.append((run_id, event, data))

    return _MockBridge()


class TestWorkerRunEndTokenUsage:
    @pytest.mark.asyncio
    async def test_run_end_content_carries_token_usage_aggregate(self, monkeypatch: pytest.MonkeyPatch) -> None:
        _patch_subagent_executor(monkeypatch, _FakeSubagentExecutor, _completed_result(records=_usage_records()))

        nodes = [_start_node("start"), _ai_node("ai_step"), _end_node("end")]
        edges = [
            Edge(source="start", source_port="input", target="ai_step", target_port="in"),
            Edge(source="start", source_port="input", target="ai_step", target_port="template_prompt"),
            Edge(source="ai_step", source_port="out", target="end", target_port="in"),
        ]
        definition = _make_def(nodes, edges, id="ai-wf", name="AI WF")

        manager = RunManager()
        record = await manager.create("thread-ai", assistant_id=definition.id)
        bridge = _make_bridge()
        event_store = MemoryRunEventStore()
        ctx = RunContext(checkpointer=None, event_store=event_store)

        await run_workflow(bridge, manager, record, ctx=ctx, definition=definition, params={"input": "x"})

        assert record.status is RunStatus.success

        events = await event_store.list_events("thread-ai", record.run_id, event_types=["run.end"])
        assert len(events) == 1
        content = events[0]["content"]

        # Existing per-node output key is preserved untouched.
        assert content.get("wf:ai_step:out")["content"] == "AI done"

        # Additive aggregate key.
        token_usage = content["token_usage"]
        assert token_usage["input_tokens"] == 300
        assert token_usage["output_tokens"] == 150
        assert token_usage["total_tokens"] == 450
        assert token_usage["cache_read_tokens"] == 30
        assert token_usage["nodes"] == {"ai_step": {"input_tokens": 300, "output_tokens": 150, "total_tokens": 450, "cache_read_tokens": 30}}

    def test_aggregate_helper_returns_none_without_channels(self) -> None:
        assert _aggregate_final_token_usage({"wf:a:out": "x"}) is None
        assert _aggregate_final_token_usage({}) is None


# ═══════════════════════════════════════════════════════════════════════════════
# 4. get_workflow_run exposure
# ═══════════════════════════════════════════════════════════════════════════════


def _make_runtime(bundle: dict) -> Any:
    from langchain.tools import ToolRuntime

    return ToolRuntime(
        state={},
        context={WORKFLOW_RUNTIME_CONTEXT_KEY: bundle},
        config={"configurable": {"thread_id": "thread-1"}},
        stream_writer=lambda _: None,
        tool_call_id="call-1",
        store=None,
        tools=[],
    )


class TestGetWorkflowRunTokenUsage:
    @pytest.mark.asyncio
    async def test_exposes_token_usage_from_run_end(self) -> None:
        run_mgr = RunManager()
        event_store = MemoryRunEventStore()
        run_ctx = RunContext(checkpointer=InMemorySaver(), event_store=event_store)
        runtime = _make_runtime({"run_manager": run_mgr, "run_ctx": run_ctx})
        record = await run_mgr.create_or_reject(
            "thread-1",
            "wf-test-def",
            kwargs={"params": {}, "definition_id": "wf-test-def"},
        )
        token_usage = {
            "input_tokens": 10,
            "output_tokens": 5,
            "total_tokens": 15,
            "cache_read_tokens": 3,
            "nodes": {"ai_step": {"input_tokens": 10, "output_tokens": 5, "total_tokens": 15, "cache_read_tokens": 3}},
        }
        await event_store.put(
            thread_id="thread-1",
            run_id=record.run_id,
            event_type="run.end",
            category="outputs",
            content={"token_usage": token_usage, "wf:ai_step:out": "AI done"},
            metadata={"status": "success"},
        )

        summary = await get_workflow_run(record.run_id, runtime=runtime)

        assert summary["run_id"] == record.run_id
        assert summary["status"] == "pending"
        assert summary["token_usage"] == token_usage
        assert summary["token_usage"]["cache_read_tokens"] == 3

    @pytest.mark.asyncio
    async def test_omits_token_usage_without_run_end(self) -> None:
        # Mirrors test_workflow_dispatch.py::test_returns_summary: a bundle
        # without a run context / event store yields the exact legacy shape.
        run_mgr = RunManager()
        runtime = _make_runtime({"run_manager": run_mgr})
        record = await run_mgr.create_or_reject(
            "thread-1",
            "wf-test-def",
            kwargs={"params": {}, "definition_id": "wf-test-def"},
        )

        summary = await get_workflow_run(record.run_id, runtime=runtime)

        assert summary == {
            "run_id": record.run_id,
            "thread_id": "thread-1",
            "status": "pending",
            "error": None,
            "created_at": record.created_at,
        }
        assert "token_usage" not in summary

    @pytest.mark.asyncio
    async def test_omits_token_usage_when_run_end_has_no_aggregate(self) -> None:
        # A run.end persisted by an older worker (no token_usage key) must not
        # fabricate one; all existing summary keys stay intact.
        run_mgr = RunManager()
        event_store = MemoryRunEventStore()
        run_ctx = RunContext(checkpointer=InMemorySaver(), event_store=event_store)
        runtime = _make_runtime({"run_manager": run_mgr, "run_ctx": run_ctx})
        record = await run_mgr.create_or_reject(
            "thread-1",
            "wf-test-def",
            kwargs={"params": {}, "definition_id": "wf-test-def"},
        )
        await event_store.put(
            thread_id="thread-1",
            run_id=record.run_id,
            event_type="run.end",
            category="outputs",
            content={"wf:ai_step:out": "AI done"},
            metadata={"status": "success"},
        )

        summary = await get_workflow_run(record.run_id, runtime=runtime)

        assert summary["status"] == "pending"
        assert "token_usage" not in summary
        assert summary["thread_id"] == "thread-1"
