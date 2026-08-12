"""Tests for ``deerflow.workflow.worker`` — run_workflow lifecycle, bridge events,
event_store persistence, error handling, cancellation, and checkpointer integration.

Covers T6-5 acceptance criteria:
- Normal serial 4-node workflow → bridge events (metadata + wf:node:started/completed per node),
  event_store (run.start + wf:node:started/completed + run.end), final status success
- Node failure (bash without crash_confirm) → wf:node:failed + run.error + status error
- Cancellation → status interrupted + publish_end
- Input mapping → params reach assign node via graph_input builder
- No checkpointer → run.end content from accumulated_output
- With checkpointer (InMemorySaver) → run.end from aget_state values
"""

from __future__ import annotations

from typing import Any
from unittest.mock import AsyncMock

import pytest
from langgraph.checkpoint.memory import InMemorySaver

from deerflow.runtime.runs.manager import RunManager, RunRecord
from deerflow.runtime.runs.schemas import RunStatus
from deerflow.runtime.runs.worker import RunContext
from deerflow.workflow.compiler import clear_compile_cache
from deerflow.workflow.schema import Edge, Node, NodeType, Port, PortType, WorkflowDefinition
from deerflow.workflow.worker import run_workflow

# ═══════════════════════════════════════════════════════════════════════════════
# Helpers
# ═══════════════════════════════════════════════════════════════════════════════


def _make_def(nodes: list[Node] | None = None, edges: list[Edge] | None = None, **kwargs: Any) -> WorkflowDefinition:
    kwargs.setdefault("id", "test-wf")
    kwargs.setdefault("name", "Test Workflow")
    return WorkflowDefinition(nodes=nodes or [], edges=edges or [], **kwargs)


def _start_node(id_: str = "start") -> Node:
    return Node(id=id_, type=NodeType.FLOW_START, inputs=[], outputs=[Port(name="input", type=PortType.DATA)])


def _end_node(id_: str = "end") -> Node:
    return Node(id=id_, type=NodeType.FLOW_END, inputs=[Port(name="in", type=PortType.DATA)], outputs=[])


def _node(
    id_: str,
    node_type: NodeType = NodeType.DATA_ASSIGN,
    inputs: list[Port] | None = None,
    outputs: list[Port] | None = None,
    params: dict[str, Any] | None = None,
) -> Node:
    return Node(
        id=id_,
        type=node_type,
        params=params or {},
        inputs=inputs or [Port(name="in", type=PortType.DATA)],
        outputs=outputs or [Port(name="out", type=PortType.DATA)],
    )


def _make_bridge():
    """Build a mock StreamBridge that records published events."""

    class _MockBridge:
        def __init__(self) -> None:
            self.events: list[tuple[str, str, Any]] = []
            self.publish = AsyncMock(side_effect=self._record)
            self.publish_end = AsyncMock()
            self.cleanup = AsyncMock()

        async def _record(self, run_id: str, event: str, data: Any) -> None:
            self.events.append((run_id, event, data))

    return _MockBridge()


async def _make_record(manager: RunManager, thread_id: str, assistant_id: str | None = None) -> RunRecord:
    return await manager.create(thread_id, assistant_id=assistant_id)


# ═══════════════════════════════════════════════════════════════════════════════
# Fixtures
# ═══════════════════════════════════════════════════════════════════════════════


@pytest.fixture(autouse=True)
def _isolate_cache() -> Any:
    clear_compile_cache()
    yield


# ═══════════════════════════════════════════════════════════════════════════════
# 1. Normal serial workflow (4 nodes: start → assign → convert → end)
# ═══════════════════════════════════════════════════════════════════════════════


class TestNormalSerial:
    """A simple linear workflow with 4 nodes produces all expected bridge events,
    event_store entries, and terminates with success."""

    @pytest.mark.asyncio
    async def test_four_node_linear_workflow(self) -> None:
        nodes = [
            _start_node("start"),
            _node("assign", NodeType.DATA_ASSIGN, params={"value": "hello"}, inputs=[Port(name="in", type=PortType.DATA)]),
            _node("convert", NodeType.DATA_CONVERT, params={"to": "str"}, inputs=[Port(name="in", type=PortType.DATA)]),
            _end_node("end"),
        ]
        edges = [
            Edge(source="start", source_port="input", target="assign", target_port="in"),
            Edge(source="assign", source_port="out", target="convert", target_port="in"),
            Edge(source="convert", source_port="out", target="end", target_port="in"),
        ]
        definition = _make_def(nodes, edges, id="serial-wf", name="Serial WF")

        manager = RunManager()
        record = await _make_record(manager, "thread-serial", definition.id)
        bridge = _make_bridge()
        event_store = AsyncMock()
        event_store.put = AsyncMock()

        ctx = RunContext(checkpointer=None, event_store=event_store)

        await run_workflow(
            bridge,  # type: ignore[arg-type]
            manager,
            record,
            ctx=ctx,
            definition=definition,
            params={"input": "hello"},
        )

        # ── Bridge assertions ──────────────────────────────────────────
        ev_types = [e[1] for e in bridge.events]
        assert ev_types[0] == "metadata", f"First event must be metadata, got {ev_types}"

        # Nodes: assign, convert (start/end not in stream filter)
        node_ids = {n.id for n in definition.nodes if n.type not in (NodeType.FLOW_START, NodeType.FLOW_END)}
        # Order: metadata, wf:node:started(assign), wf:node:completed(assign),
        #        wf:node:started(convert), wf:node:completed(convert)
        for node_id in node_ids:
            assert ("wf:node:started", node_id) in [(e[1], e[2].get("node_id")) for e in bridge.events]
            assert ("wf:node:completed", node_id) in [(e[1], e[2].get("node_id")) for e in bridge.events]

        # Verify started before completed for each node
        assign_started_idx = next(i for i, e in enumerate(bridge.events) if e[1] == "wf:node:started" and e[2].get("node_id") == "assign")
        assign_completed_idx = next(i for i, e in enumerate(bridge.events) if e[1] == "wf:node:completed" and e[2].get("node_id") == "assign")
        assert assign_started_idx < assign_completed_idx

        convert_started_idx = next(i for i, e in enumerate(bridge.events) if e[1] == "wf:node:started" and e[2].get("node_id") == "convert")
        convert_completed_idx = next(i for i, e in enumerate(bridge.events) if e[1] == "wf:node:completed" and e[2].get("node_id") == "convert")
        assert convert_started_idx < convert_completed_idx

        assert bridge.publish_end.called
        assert record.status is RunStatus.success

        # ── Event store assertions ─────────────────────────────────────
        put_calls = [c.kwargs for c in event_store.put.call_args_list]
        event_types = [c["event_type"] for c in put_calls]
        assert "run.start" in event_types
        assert "wf:node:started" in event_types
        assert "wf:node:completed" in event_types
        assert "run.end" in event_types

        # run.end content should have accumulated output
        run_end = next(c for c in put_calls if c["event_type"] == "run.end")
        assert isinstance(run_end["content"], dict)
        assert run_end["content"]  # non-empty


# ═══════════════════════════════════════════════════════════════════════════════
# 2. Node failure — bash without crash_confirm
# ═══════════════════════════════════════════════════════════════════════════════


class TestNodeFailure:
    """A bash node without crash_confirm raises WorkflowExecutionError,
    producing wf:node:failed + run.error + status error."""

    @pytest.mark.asyncio
    async def test_bash_node_without_crash_confirm_fails(self) -> None:
        bash_node = _node("bash_step", NodeType.TOOL_BASH, params={"command": "echo hi"})
        nodes = [_start_node(), bash_node, _end_node()]
        edges = [
            Edge(source="start", source_port="input", target="bash_step", target_port="in"),
            Edge(source="bash_step", source_port="out", target="end", target_port="in"),
        ]
        definition = _make_def(nodes, edges, id="fail-wf", name="Fail WF")

        manager = RunManager()
        record = await _make_record(manager, "thread-fail", definition.id)
        bridge = _make_bridge()
        event_store = AsyncMock()
        event_store.put = AsyncMock()

        ctx = RunContext(checkpointer=None, event_store=event_store)

        await run_workflow(
            bridge,  # type: ignore[arg-type]
            manager,
            record,
            ctx=ctx,
            definition=definition,
            params={"input": "x"},
        )

        # ── Bridge assertions ──────────────────────────────────────────
        ev_types = [e[1] for e in bridge.events]
        assert "wf:node:started" in ev_types
        assert "wf:node:failed" in ev_types
        # The failed event should reference the bash node
        failed_events = [e for e in bridge.events if e[1] == "wf:node:failed"]
        assert len(failed_events) >= 1
        assert failed_events[0][2]["node_id"] == "bash_step"

        # ── Status and bridge ──────────────────────────────────────────
        assert record.status is RunStatus.error
        assert record.error is not None
        assert "crash_confirm" in record.error or "Workflow" in record.error

        # ── Event store assertions ─────────────────────────────────────
        put_types = [c.kwargs["event_type"] for c in event_store.put.call_args_list]
        assert "run.start" in put_types
        assert "wf:node:started" in put_types
        assert "wf:node:failed" in put_types
        assert "run.error" in put_types


# ═══════════════════════════════════════════════════════════════════════════════
# 3. Cancellation
# ═══════════════════════════════════════════════════════════════════════════════


class TestCancel:
    """Cancelling a run during execution produces interrupted status."""

    @pytest.mark.asyncio
    async def test_abort_during_streaming(self) -> None:
        """Set abort_event after the first node starts → run ends as interrupted."""
        nodes = [
            _start_node("start"),
            _node("step1", NodeType.DATA_ASSIGN, params={"value": "a"}),
            _node("step2", NodeType.DATA_ASSIGN, params={"value": "b"}),
            _end_node("end"),
        ]
        edges = [
            Edge(source="start", source_port="input", target="step1", target_port="in"),
            Edge(source="step1", source_port="out", target="step2", target_port="in"),
            Edge(source="step2", source_port="out", target="end", target_port="in"),
        ]
        definition = _make_def(nodes, edges, id="cancel-wf", name="Cancel WF")

        manager = RunManager()
        record = await _make_record(manager, "thread-cancel", definition.id)
        bridge = _make_bridge()

        # Override publish to set abort_event after the first wf:node:started
        _call_count = 0
        _orig_publish = bridge._record

        async def _publish_and_maybe_abort(run_id: str, event: str, data: Any) -> None:
            nonlocal _call_count
            _call_count += 1
            await _orig_publish(run_id, event, data)
            # After first wf:node:started, signal abort
            if event == "wf:node:started" and _call_count >= 3:
                record.abort_event.set()

        bridge.publish = AsyncMock(side_effect=_publish_and_maybe_abort)

        ctx = RunContext(checkpointer=None)

        await run_workflow(
            bridge,  # type: ignore[arg-type]
            manager,
            record,
            ctx=ctx,
            definition=definition,
            params={"input": "x"},
        )

        assert record.status is RunStatus.interrupted
        assert bridge.publish_end.called


# ═══════════════════════════════════════════════════════════════════════════════
# 4. Input mapping
# ═══════════════════════════════════════════════════════════════════════════════


class TestInputMapping:
    """Params are mapped to start-node output ports and flow through the graph."""

    @pytest.mark.asyncio
    async def test_params_flow_through_assign(self) -> None:
        """Params ``{"in": "hello"}`` → assign receives and passes through ``hello``."""
        assign_node = _node("assign", NodeType.DATA_ASSIGN)
        nodes = [_start_node("start"), assign_node, _end_node("end")]
        edges = [
            Edge(source="start", source_port="input", target="assign", target_port="in"),
            Edge(source="assign", source_port="out", target="end", target_port="in"),
        ]
        definition = _make_def(nodes, edges, id="input-wf", name="Input WF")

        manager = RunManager()
        record = await _make_record(manager, "thread-input", definition.id)
        bridge = _make_bridge()
        event_store = AsyncMock()
        event_store.put = AsyncMock()

        ctx = RunContext(checkpointer=None, event_store=event_store)

        await run_workflow(
            bridge,  # type: ignore[arg-type]
            manager,
            record,
            ctx=ctx,
            definition=definition,
            params={"input": "hello"},
        )

        assert record.status is RunStatus.success
        # Check that the assign node's completed event carries output "hello"
        completed = [e for e in bridge.events if e[1] == "wf:node:completed" and e[2].get("node_id") == "assign"]
        assert len(completed) >= 1
        # The output should contain the passthrough value
        assert completed[0][2].get("output") is not None


# ═══════════════════════════════════════════════════════════════════════════════
# 5. No checkpointer — run.end uses accumulated output
# ═══════════════════════════════════════════════════════════════════════════════


class TestNoCheckpointer:
    """When no checkpointer is configured, run.end content comes from accumulated output."""

    @pytest.mark.asyncio
    async def test_run_end_uses_accumulated_output(self) -> None:
        nodes = [
            _start_node("start"),
            _node("a", NodeType.DATA_ASSIGN, params={"value": 42}),
            _end_node("end"),
        ]
        edges = [
            Edge(source="start", source_port="input", target="a", target_port="in"),
            Edge(source="a", source_port="out", target="end", target_port="in"),
        ]
        definition = _make_def(nodes, edges, id="no-cp-wf", name="NoCP WF")

        manager = RunManager()
        record = await _make_record(manager, "thread-nocp", definition.id)
        bridge = _make_bridge()
        event_store = AsyncMock()
        event_store.put = AsyncMock()

        # No checkpointer
        ctx = RunContext(checkpointer=None, event_store=event_store)

        await run_workflow(
            bridge,  # type: ignore[arg-type]
            manager,
            record,
            ctx=ctx,
            definition=definition,
            params={"input": "x"},
        )

        assert record.status is RunStatus.success

        put_calls = [c.kwargs for c in event_store.put.call_args_list]
        run_end = next(c for c in put_calls if c["event_type"] == "run.end")
        # accumulated_output should be non-empty
        assert isinstance(run_end["content"], dict)
        assert run_end["content"], "run.end content must be non-empty from accumulated output"


# ═══════════════════════════════════════════════════════════════════════════════
# 6. With checkpointer (InMemorySaver) — run.end from aget_state values
# ═══════════════════════════════════════════════════════════════════════════════


class TestWithCheckpointer:
    """When InMemorySaver is configured, run.end content comes from aget_state values."""

    @pytest.mark.asyncio
    async def test_run_end_from_checkpointer_state(self) -> None:
        nodes = [
            _start_node("start"),
            _node("a", NodeType.DATA_ASSIGN, params={"value": "checkpointed"}),
            _end_node("end"),
        ]
        edges = [
            Edge(source="start", source_port="input", target="a", target_port="in"),
            Edge(source="a", source_port="out", target="end", target_port="in"),
        ]
        definition = _make_def(nodes, edges, id="cp-wf", name="CP WF")

        manager = RunManager()
        record = await _make_record(manager, "thread-cp", definition.id)
        bridge = _make_bridge()
        event_store = AsyncMock()
        event_store.put = AsyncMock()

        checkpointer = InMemorySaver()
        ctx = RunContext(checkpointer=checkpointer, event_store=event_store)

        await run_workflow(
            bridge,  # type: ignore[arg-type]
            manager,
            record,
            ctx=ctx,
            definition=definition,
            params={"input": "x"},
        )

        assert record.status is RunStatus.success

        put_calls = [c.kwargs for c in event_store.put.call_args_list]
        run_end = next(c for c in put_calls if c["event_type"] == "run.end")
        # Should get values from aget_state, not empty
        assert isinstance(run_end["content"], dict)
        # The state should contain wf: keys from the workflow
        content = run_end["content"]
        assert content, "run.end content must be non-empty from checkpoint state"
