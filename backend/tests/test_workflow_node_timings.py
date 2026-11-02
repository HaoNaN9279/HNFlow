"""Tests for N14x node execution timing (per-node duration observability).

Covers the four links of the chain: the compiler's per-node measurement, the
reserved state channel, the worker's ``run.end`` aggregate, and
``get_workflow_run`` exposure.
"""

from __future__ import annotations

import asyncio
from types import SimpleNamespace
from typing import Any
from unittest.mock import AsyncMock

import pytest

from deerflow.runtime.events.store.memory import MemoryRunEventStore
from deerflow.runtime.runs.manager import RunManager
from deerflow.runtime.runs.schemas import RunStatus
from deerflow.runtime.runs.worker import RunContext
from deerflow.workflow.compiler import clear_compile_cache, compile_definition
from deerflow.workflow.dispatch import WORKFLOW_RUNTIME_CONTEXT_KEY, get_workflow_run
from deerflow.workflow.executors import build_default_registry
from deerflow.workflow.replay import (
    MODE_RECORD,
    MODE_REPLAY,
    REPLAY_CONTEXT_KEY,
    ReplayFixture,
    ReplaySession,
)
from deerflow.workflow.schema import Edge, Node, NodeType, Port, PortType, WorkflowDefinition
from deerflow.workflow.worker import _aggregate_final_node_durations, run_workflow

SLEEP_SECONDS = 0.05


@pytest.fixture(autouse=True)
def _isolate_cache():
    clear_compile_cache()
    yield
    clear_compile_cache()


def _definition() -> WorkflowDefinition:
    return WorkflowDefinition(
        id="wf-timing",
        name="Timing WF",
        nodes=[
            Node(id="start", type=NodeType.FLOW_START, inputs=[], outputs=[Port(name="input", type=PortType.DATA)]),
            Node(id="work", type=NodeType.DATA_ASSIGN, inputs=[Port(name="in", type=PortType.DATA)], outputs=[Port(name="out", type=PortType.DATA)]),
            Node(id="end", type=NodeType.FLOW_END, inputs=[Port(name="in", type=PortType.DATA)], outputs=[]),
        ],
        edges=[
            Edge(source="start", source_port="input", target="work", target_port="in"),
            Edge(source="work", source_port="out", target="end", target_port="in"),
        ],
    )


async def _slow_executor(_runtime: Any, _params: dict, _inputs: dict) -> dict:
    await asyncio.sleep(SLEEP_SECONDS)
    return {"out": "done"}


def _context_with_slow_executor():
    ctx = build_default_registry().build_context()
    ctx.executors[NodeType.DATA_ASSIGN] = _slow_executor
    return ctx


async def _run(definition: WorkflowDefinition, *, context: Any, session: ReplaySession | None = None) -> dict:
    graph = compile_definition(definition, context=context)
    run_context: dict[str, Any] = {"run_id": "r1"}
    if session is not None:
        run_context[REPLAY_CONTEXT_KEY] = session
    return await graph.ainvoke({"wf:start:input": "seed"}, {"configurable": {"thread_id": "t-timing"}, "context": run_context})


# ── 1. compiler measurement ───────────────────────────────────────────────────


class TestCompilerDurationChannel:
    @pytest.mark.asyncio
    async def test_every_executed_node_reports_a_duration(self) -> None:
        state = await _run(_definition(), context=_context_with_slow_executor())
        duration = state["wf:work:__duration_ms"]
        assert isinstance(duration, float)
        # Lower bound only: ``asyncio.sleep`` cannot return early, so this
        # proves the executor's work was measured.  No upper bound — a loaded
        # machine adding seconds of scheduling latency is not a failure.  The
        # threshold is defensively below the sleep because the Windows event
        # loop's timer granularity can fire marginally early.
        assert duration >= SLEEP_SECONDS * 1000 * 0.4

    @pytest.mark.asyncio
    async def test_declared_for_non_ai_nodes_too(self) -> None:
        # The channel is declared for every node type, so it persists whenever a
        # node writes it — not only for AI nodes.  (``flow:start``/``flow:end``
        # are graph sentinels with no node function, so they never write one.)
        graph = compile_definition(_definition(), context=build_default_registry().build_context())
        assert "wf:work:__duration_ms" in graph.channels

    @pytest.mark.asyncio
    async def test_a_fast_node_reports_a_small_but_present_duration(self) -> None:
        state = await _run(_definition(), context=build_default_registry().build_context())
        assert 0.0 <= state["wf:work:__duration_ms"] < 1000

    @pytest.mark.asyncio
    async def test_record_mode_records_the_duration_alongside_the_outputs(self) -> None:
        session = ReplaySession(mode=MODE_RECORD, fixture=ReplayFixture(run_id="r1"), redact=False)
        state = await _run(_definition(), context=_context_with_slow_executor(), session=session)
        assert state["wf:work:out"] == "done"
        assert session.fixture.entries

    @pytest.mark.asyncio
    async def test_replay_writes_no_duration_channel(self) -> None:
        # Record first, then replay the same node: a replayed node did no work,
        # so it must not claim an execution duration.
        recorder = ReplaySession(mode=MODE_RECORD, fixture=ReplayFixture(run_id="r1"), redact=False)
        await _run(_definition(), context=_context_with_slow_executor(), session=recorder)

        player = ReplaySession(mode=MODE_REPLAY, fixture=recorder.fixture)
        state = await _run(_definition(), context=build_default_registry().build_context(), session=player)
        assert state["wf:work:out"] == "done"
        assert "wf:work:__duration_ms" not in state


# ── 2. worker aggregate helper ────────────────────────────────────────────────


class TestAggregateFinalNodeDurations:
    def test_collects_nodes_totals_and_slowest(self) -> None:
        timings = _aggregate_final_node_durations(
            {
                "wf:a:__duration_ms": 10.5,
                "wf:b:__duration_ms": 250,
                "wf:a:out": "x",
                "other": 1,
            }
        )
        assert timings is not None
        assert timings["nodes"] == {"a": 10.5, "b": 250.0}
        assert timings["total_ms"] == 260.5
        assert timings["slowest_node"] == "b"

    def test_slowest_ties_break_on_node_id(self) -> None:
        timings = _aggregate_final_node_durations({"wf:b:__duration_ms": 5, "wf:a:__duration_ms": 5})
        assert timings is not None
        assert timings["slowest_node"] == "a"

    def test_non_numeric_values_are_skipped(self) -> None:
        timings = _aggregate_final_node_durations({"wf:a:__duration_ms": "nope", "wf:b:__duration_ms": 4})
        assert timings is not None
        assert timings["nodes"] == {"b": 4.0}

    def test_returns_none_without_duration_channels(self) -> None:
        assert _aggregate_final_node_durations({"wf:a:out": "x"}) is None
        assert _aggregate_final_node_durations({}) is None


# ── 3. worker run.end integration ─────────────────────────────────────────────


class _Bridge:
    def __init__(self) -> None:
        self.publish = AsyncMock()
        self.publish_end = AsyncMock()
        self.cleanup = AsyncMock()


class TestWorkerRunEndNodeTimings:
    @pytest.mark.asyncio
    async def test_run_end_carries_node_timings(self) -> None:
        definition = _definition()
        manager = RunManager()
        record = await manager.create("thread-timing", assistant_id=definition.id)
        event_store = MemoryRunEventStore()
        ctx = RunContext(checkpointer=None, event_store=event_store)

        await run_workflow(_Bridge(), manager, record, ctx=ctx, definition=definition, params={"input": "x"})

        assert record.status is RunStatus.success
        events = await event_store.list_events("thread-timing", record.run_id, event_types=["run.end"])
        assert len(events) == 1
        content = events[0]["content"]
        timings = content["node_timings"]
        assert set(timings["nodes"]) == {"work"}
        assert timings["slowest_node"] in timings["nodes"]
        assert timings["total_ms"] >= 0
        # Existing per-node output key is untouched (run params enter ``start``).
        assert content.get("wf:work:out") == "x"


# ── 4. get_workflow_run exposure ──────────────────────────────────────────────


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


class TestGetWorkflowRunNodeTimings:
    @pytest.mark.asyncio
    async def test_summary_carries_node_timings(self) -> None:
        definition = _definition()
        manager = RunManager()
        record = await manager.create("thread-timing2", assistant_id=definition.id)
        event_store = MemoryRunEventStore()
        ctx = RunContext(checkpointer=None, event_store=event_store)

        await run_workflow(_Bridge(), manager, record, ctx=ctx, definition=definition, params={"input": "x"})
        await manager.set_status(record.run_id, RunStatus.success)

        runtime = _make_runtime({"run_manager": manager, "run_ctx": ctx})
        summary = await get_workflow_run(record.run_id, runtime=runtime)
        assert summary is not None
        assert set(summary["node_timings"]["nodes"]) == {"work"}

    @pytest.mark.asyncio
    async def test_summary_without_an_event_store_omits_the_key(self) -> None:
        manager = RunManager()
        record = await manager.create("thread-timing3", assistant_id="wf-timing")
        runtime = _make_runtime({"run_manager": manager, "run_ctx": SimpleNamespace()})
        summary = await get_workflow_run(record.run_id, runtime=runtime)
        assert summary is not None
        assert "node_timings" not in summary
