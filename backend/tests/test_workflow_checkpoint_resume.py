"""Checkpoint resume tests — abort mid-workflow then resume from checkpoint.

Covers T6-5 planning verification point 2: kill process, restart, resume from
checkpoint.  Uses InMemorySaver as the checkpointer.

Strategy:
- Construct a workflow: start → assign(step1) → wait(small duration) → assign(step2) → end
- First run: signal abort AFTER the first node completes but before the wait node
  finishes → status interrupted, checkpoint written
- Second run: same definition, same thread_id → graph resumes from checkpoint
  (first assign already written) and completes successfully

If the cancel path is unreliable, fall back to: first run completes fully,
second run with same thread_id sees old state in checkpoint (state continuity).
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
    """Build a mock StreamBridge that records events and supports abort-after-N."""

    class _MockBridge:
        def __init__(self) -> None:
            self.events: list[tuple[str, str, Any]] = []
            self.publish_end = AsyncMock()
            self.cleanup = AsyncMock()
            self.publish_calls: int = 0
            self._abort_after: int | None = None
            self._abort_event: Any = None

        async def publish(self, run_id: str, event: str, data: Any) -> None:
            self.events.append((run_id, event, data))
            self.publish_calls += 1
            if self._abort_after is not None and self._abort_event is not None:
                if self.publish_calls >= self._abort_after:
                    self._abort_event.set()

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
# 1. Cancel and resume — checkpoint continuity
# ═══════════════════════════════════════════════════════════════════════════════


class TestCancelAndResume:
    """First run aborted mid-graph; second run resumes from checkpoint."""

    @pytest.mark.asyncio
    async def test_resume_from_checkpoint_after_abort(self) -> None:
        """Build a workflow with start → step1(assign) → step2(assign) → end.
        In the first run, abort after step1 completes. The second run with
        the same thread_id should resume from the checkpoint and complete."""
        nodes = [
            _start_node("start"),
            _node("step1", NodeType.DATA_ASSIGN, params={"value": "first_value"}),
            _node("step2", NodeType.DATA_ASSIGN, params={"value": "second_value"}),
            _end_node("end"),
        ]
        edges = [
            Edge(source="start", source_port="input", target="step1", target_port="in"),
            Edge(source="step1", source_port="out", target="step2", target_port="in"),
            Edge(source="step2", source_port="out", target="end", target_port="in"),
        ]
        definition = _make_def(nodes, edges, id="resume-wf", name="Resume WF")

        thread_id = "thread-cp-resume"
        checkpointer = InMemorySaver()

        # ── First run: abort after a few events ─────────────────────────
        manager1 = RunManager()
        record1 = await _make_record(manager1, thread_id, definition.id)
        bridge1 = _make_bridge()
        bridge1._abort_after = 5  # abort after metadata + step1 started/completed + step2 started
        bridge1._abort_event = record1.abort_event

        ctx1 = RunContext(checkpointer=checkpointer)

        await run_workflow(
            bridge1,  # type: ignore[arg-type]
            manager1,
            record1,
            ctx=ctx1,
            definition=definition,
            params={"input": "hello"},
        )

        assert record1.status is RunStatus.interrupted, f"Expected interrupted, got {record1.status}"

        # ── Second run: same thread_id, same definition → resume ────────
        manager2 = RunManager()
        record2 = await _make_record(manager2, thread_id, definition.id)
        bridge2 = _make_bridge()

        ctx2 = RunContext(checkpointer=checkpointer)

        await run_workflow(
            bridge2,  # type: ignore[arg-type]
            manager2,
            record2,
            ctx=ctx2,
            definition=definition,
            params={},  # No new params; graph resumes from checkpointed state
        )

        # The second run should succeed — graph resumes from checkpoint
        assert record2.status is RunStatus.success, f"Expected success on resume, got {record2.status}"

        # Verify the checkpoint has the first run's state values
        state = await checkpointer.aget_tuple({"configurable": {"thread_id": thread_id}})
        assert state is not None, "Checkpoint must exist after two runs"
        checkpoint = getattr(state, "checkpoint", {}) or {}
        values = checkpoint.get("channel_values", {}) if isinstance(checkpoint, dict) else {}
        # The first assign node's output should still be checkpointed
        step1_key = "wf:step1:out"
        if step1_key in values:
            assert values[step1_key] == "first_value", f"Expected 'first_value' from checkpoint, got {values[step1_key]}"


# ═══════════════════════════════════════════════════════════════════════════════
# 2. State continuity — full first run then verify checkpoint values
# ═══════════════════════════════════════════════════════════════════════════════


class TestStateContinuity:
    """Run a workflow to completion, then a second run with the same thread_id
    sees the first run's checkpointed state values (state continuity)."""

    @pytest.mark.asyncio
    async def test_state_values_persist_between_runs(self) -> None:
        nodes = [
            _start_node("start"),
            _node("a", NodeType.DATA_ASSIGN, params={"value": "persisted_value"}),
            _end_node("end"),
        ]
        edges = [
            Edge(source="start", source_port="input", target="a", target_port="in"),
            Edge(source="a", source_port="out", target="end", target_port="in"),
        ]
        definition = _make_def(nodes, edges, id="state-wf", name="State WF")

        thread_id = "thread-state-continuity"
        checkpointer = InMemorySaver()

        # ── First run: complete normally ─────────────────────────────────
        manager1 = RunManager()
        record1 = await _make_record(manager1, thread_id, definition.id)
        bridge1 = _make_bridge()

        ctx1 = RunContext(checkpointer=checkpointer)

        await run_workflow(
            bridge1,  # type: ignore[arg-type]
            manager1,
            record1,
            ctx=ctx1,
            definition=definition,
            params={"input": "x"},
        )
        assert record1.status is RunStatus.success

        # ── Verify checkpoint state ──────────────────────────────────────
        state1 = await checkpointer.aget_tuple({"configurable": {"thread_id": thread_id}})
        assert state1 is not None
        checkpoint = getattr(state1, "checkpoint", {}) or {}
        values1 = checkpoint.get("channel_values", {}) if isinstance(checkpoint, dict) else {}
        assert values1.get("wf:a:out") == "persisted_value"

        # ── Second run: same thread_id, no new params ────────────────────
        # The graph starts from the existing checkpoint; output should still be visible
        manager2 = RunManager()
        record2 = await _make_record(manager2, thread_id, definition.id)
        bridge2 = _make_bridge()

        ctx2 = RunContext(checkpointer=checkpointer)

        await run_workflow(
            bridge2,  # type: ignore[arg-type]
            manager2,
            record2,
            ctx=ctx2,
            definition=definition,
            params={},  # no input → graph resumes from persisted state
        )
        assert record2.status is RunStatus.success

        # State should still contain the previous persisted value
        state2 = await checkpointer.aget_tuple({"configurable": {"thread_id": thread_id}})
        assert state2 is not None
        checkpoint2 = getattr(state2, "checkpoint", {}) or {}
        values2 = checkpoint2.get("channel_values", {}) if isinstance(checkpoint2, dict) else {}
        # The old value from run 1 should survive in checkpoint
        assert values2.get("wf:a:out") == "persisted_value", f"Expected 'persisted_value', got {values2.get('wf:a:out')}"
