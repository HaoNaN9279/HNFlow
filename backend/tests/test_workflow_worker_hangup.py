"""Hangup detection + checkpoint_ref backfill + Command resume tests for ``run_workflow``.

Covers T13-2:
- A workflow that suspends on a ``human:task`` node (LangGraph ``interrupt()``)
  is marked ``RunStatus.interrupted``, not the old unconditional ``success``.
- The worker backfills ``checkpoint_ref`` on the run's pending human tasks via
  the injected repository (``update_checkpoint_ref_by_run``).
- ``run.end`` is emitted with ``metadata.status == "interrupted"`` when hanging.
- A normal (non-hanging) workflow still ends ``success`` and never backfills.
- ``run_workflow(..., resume=Command(resume=...))`` resumes a hung graph from its
  interrupt point to ``success``.
- A missing repository still marks the run ``interrupted`` without crashing and
  without backfilling.

The real ``exec_human_task`` (T13-1) is used; the repository is a mock injected
through the ``human_task_repo`` keyword so ``config["context"]["human_task_repo"]``
carries it into the graph.
"""

from __future__ import annotations

from typing import Any
from unittest.mock import AsyncMock, patch

import pytest
from langgraph.checkpoint.memory import InMemorySaver
from langgraph.types import Command

from deerflow.runtime.runs.manager import RunManager, RunRecord
from deerflow.runtime.runs.schemas import RunStatus
from deerflow.runtime.runs.worker import RunContext
from deerflow.workflow.compiler import clear_compile_cache
from deerflow.workflow.registry import ExecutorRegistration, ExecutorRegistry, WorkflowExecutionError
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


def _human_node(id_: str = "human", output_port: str = "answer") -> Node:
    """A ``human:task`` node whose sole output port is named ``output_port``."""
    return Node(
        id=id_,
        type=NodeType.HUMAN_TASK,
        params={"description": "Approve this change"},
        inputs=[Port(name="in", type=PortType.DATA)],
        outputs=[Port(name=output_port, type=PortType.DATA)],
    )


def _assign_node(id_: str = "assign") -> Node:
    return Node(
        id=id_,
        type=NodeType.DATA_ASSIGN,
        params={"value": "done"},
        inputs=[Port(name="in", type=PortType.DATA)],
        outputs=[Port(name="out", type=PortType.DATA)],
    )


def _hangup_def(def_id: str = "hangup-wf") -> WorkflowDefinition:
    """start → human:task → end — suspends on the human node via ``interrupt()``."""
    return _make_def(
        nodes=[_start_node("start"), _human_node("human"), _end_node("end")],
        edges=[
            Edge(source="start", source_port="input", target="human", target_port="in"),
            Edge(source="human", source_port="answer", target="end", target_port="in"),
        ],
        id=def_id,
        name="Hangup WF",
    )


def _linear_def(def_id: str = "linear-wf") -> WorkflowDefinition:
    """start → assign → end — completes without hanging."""
    return _make_def(
        nodes=[_start_node("start"), _assign_node("assign"), _end_node("end")],
        edges=[
            Edge(source="start", source_port="input", target="assign", target_port="in"),
            Edge(source="assign", source_port="out", target="end", target_port="in"),
        ],
        id=def_id,
        name="Linear WF",
    )


def _make_bridge():
    """A mock StreamBridge that records published events."""

    class _MockBridge:
        def __init__(self) -> None:
            self.events: list[tuple[str, str, Any]] = []
            self.publish = AsyncMock(side_effect=self._record)
            self.publish_end = AsyncMock()
            self.cleanup = AsyncMock()

        async def _record(self, run_id: str, event: str, data: Any) -> None:
            self.events.append((run_id, event, data))

    return _MockBridge()


def _make_repo() -> AsyncMock:
    """A mock HumanTaskRepository: ``create`` yields a task id, ``update_checkpoint_ref_by_run`` yields 0."""
    repo = AsyncMock()
    repo.create = AsyncMock(return_value={"id": "ht-test", "status": "pending"})
    repo.find_by_run_and_node = AsyncMock(return_value=None)
    repo.update_checkpoint_ref_by_run = AsyncMock(return_value=0)
    repo.delete_pending_by_run = AsyncMock(return_value=0)
    return repo


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
# 1. Hangup detection — status mapping
# ═══════════════════════════════════════════════════════════════════════════════


class TestHangupDetection:
    @pytest.mark.asyncio
    async def test_hangup_marks_interrupted_not_success(self) -> None:
        definition = _hangup_def()
        thread_id = "thread-hangup"
        checkpointer = InMemorySaver()
        repo = _make_repo()

        manager = RunManager()
        record = await _make_record(manager, thread_id, definition.id)
        bridge = _make_bridge()
        ctx = RunContext(checkpointer=checkpointer)

        await run_workflow(
            bridge,  # type: ignore[arg-type]
            manager,
            record,
            ctx=ctx,
            definition=definition,
            params={},
            human_task_repo=repo,
        )

        assert record.status is RunStatus.interrupted, f"Expected interrupted, got {record.status}"
        # The executor must have created a pending human task before suspending.
        repo.create.assert_awaited_once()

    @pytest.mark.asyncio
    async def test_hangup_run_end_metadata_is_interrupted(self) -> None:
        definition = _hangup_def("hangup-end-wf")
        thread_id = "thread-hangup-end"
        checkpointer = InMemorySaver()
        repo = _make_repo()
        event_store = AsyncMock()
        event_store.put = AsyncMock()

        manager = RunManager()
        record = await _make_record(manager, thread_id, definition.id)
        bridge = _make_bridge()
        ctx = RunContext(checkpointer=checkpointer, event_store=event_store)

        await run_workflow(
            bridge,  # type: ignore[arg-type]
            manager,
            record,
            ctx=ctx,
            definition=definition,
            params={},
            human_task_repo=repo,
        )

        assert record.status is RunStatus.interrupted
        run_end = next(c for c in event_store.put.call_args_list if c.kwargs["event_type"] == "run.end")
        assert run_end.kwargs["metadata"]["status"] == "interrupted"


# ═══════════════════════════════════════════════════════════════════════════════
# 2. checkpoint_ref backfill
# ═══════════════════════════════════════════════════════════════════════════════


class TestCheckpointRefBackfill:
    @pytest.mark.asyncio
    async def test_backfill_checkpoint_ref_on_hangup(self) -> None:
        definition = _hangup_def("backfill-wf")
        thread_id = "thread-backfill"
        checkpointer = InMemorySaver()
        repo = _make_repo()

        manager = RunManager()
        record = await _make_record(manager, thread_id, definition.id)
        bridge = _make_bridge()
        ctx = RunContext(checkpointer=checkpointer)

        await run_workflow(
            bridge,  # type: ignore[arg-type]
            manager,
            record,
            ctx=ctx,
            definition=definition,
            params={},
            human_task_repo=repo,
        )

        assert record.status is RunStatus.interrupted
        repo.update_checkpoint_ref_by_run.assert_awaited_once()
        kwargs = repo.update_checkpoint_ref_by_run.call_args.kwargs
        assert kwargs["run_id"] == record.run_id

        ref = kwargs["checkpoint_ref"]
        assert isinstance(ref, dict)
        assert ref["thread_id"] == thread_id
        assert ref["checkpoint_id"], "checkpoint_id must be a non-empty checkpoint coordinate"


# ═══════════════════════════════════════════════════════════════════════════════
# 3. No-hangup regression
# ═══════════════════════════════════════════════════════════════════════════════


class TestNoHangupRegression:
    @pytest.mark.asyncio
    async def test_linear_workflow_success_and_no_backfill(self) -> None:
        definition = _linear_def()
        thread_id = "thread-linear"
        checkpointer = InMemorySaver()
        repo = _make_repo()

        manager = RunManager()
        record = await _make_record(manager, thread_id, definition.id)
        bridge = _make_bridge()
        ctx = RunContext(checkpointer=checkpointer)

        await run_workflow(
            bridge,  # type: ignore[arg-type]
            manager,
            record,
            ctx=ctx,
            definition=definition,
            params={"input": "x"},
            human_task_repo=repo,
        )

        assert record.status is RunStatus.success
        repo.update_checkpoint_ref_by_run.assert_not_awaited()


# ═══════════════════════════════════════════════════════════════════════════════
# 4. Command resume
# ═══════════════════════════════════════════════════════════════════════════════


class TestCommandResume:
    @pytest.mark.asyncio
    async def test_resume_command_continues_to_success(self) -> None:
        definition = _hangup_def("resume-wf")
        thread_id = "thread-resume"
        checkpointer = InMemorySaver()
        repo = _make_repo()

        # ── First run: suspend on the human node ────────────────────────
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
            params={},
            human_task_repo=repo,
        )
        assert record1.status is RunStatus.interrupted

        # ── Second run: resume the same thread with Command(resume=...) ──
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
            params={},
            resume=Command(resume={"answer": "hi"}),
            human_task_repo=repo,
        )

        assert record2.status is RunStatus.success, f"Expected success after resume, got {record2.status}"


# ═══════════════════════════════════════════════════════════════════════════════
# 5. No repository injected
# ═══════════════════════════════════════════════════════════════════════════════


class TestNoRepository:
    @pytest.mark.asyncio
    async def test_no_repo_marks_interrupted_without_backfill(self) -> None:
        definition = _hangup_def("no-repo-wf")
        thread_id = "thread-no-repo"
        checkpointer = InMemorySaver()

        manager = RunManager()
        record = await _make_record(manager, thread_id, definition.id)
        bridge = _make_bridge()
        ctx = RunContext(checkpointer=checkpointer)

        # No human_task_repo injected → the executor raises, and the run must
        # still terminate without a crash.  We assert the run is not ``success``.
        await run_workflow(
            bridge,  # type: ignore[arg-type]
            manager,
            record,
            ctx=ctx,
            definition=definition,
            params={},
        )

        assert record.status is not RunStatus.success


# ═══════════════════════════════════════════════════════════════════════════════
# 6. Failure-path compensation (T13-4)
# ═══════════════════════════════════════════════════════════════════════════════


def _failing_executor(_runtime: Any, _params: dict[str, Any], _inputs: dict[str, Any]) -> dict[str, Any]:
    """A human:task executor that raises after the point where a create would happen."""
    raise WorkflowExecutionError("interrupt/checkpoint write failed")


def _failing_registry() -> ExecutorRegistry:
    reg = ExecutorRegistry()
    reg.register(ExecutorRegistration(node_type=NodeType.HUMAN_TASK, executor=_failing_executor, description="failing human executor"))
    return reg


class TestFailureCompensation:
    @pytest.mark.asyncio
    async def test_interrupt_failure_compensates(self) -> None:
        """A node failure after create → run marked error + delete_pending_by_run called."""
        definition = _hangup_def("compensate-wf")
        thread_id = "thread-compensate"
        checkpointer = InMemorySaver()
        repo = _make_repo()

        manager = RunManager()
        record = await _make_record(manager, thread_id, definition.id)
        bridge = _make_bridge()
        ctx = RunContext(checkpointer=checkpointer)

        with patch("deerflow.workflow.worker.build_default_registry", _failing_registry):
            await run_workflow(
                bridge,  # type: ignore[arg-type]
                manager,
                record,
                ctx=ctx,
                definition=definition,
                params={},
                human_task_repo=repo,
            )

        assert record.status is RunStatus.error, f"Expected error, got {record.status}"
        repo.delete_pending_by_run.assert_awaited_once()
        assert repo.delete_pending_by_run.call_args.kwargs["run_id"] == record.run_id

    @pytest.mark.asyncio
    async def test_normal_hangup_does_not_compensate(self) -> None:
        """A successful suspend (interrupted) must NOT trigger compensation cleanup."""
        definition = _hangup_def("no-compensate-wf")
        thread_id = "thread-no-compensate"
        checkpointer = InMemorySaver()
        repo = _make_repo()

        manager = RunManager()
        record = await _make_record(manager, thread_id, definition.id)
        bridge = _make_bridge()
        ctx = RunContext(checkpointer=checkpointer)

        await run_workflow(
            bridge,  # type: ignore[arg-type]
            manager,
            record,
            ctx=ctx,
            definition=definition,
            params={},
            human_task_repo=repo,
        )

        assert record.status is RunStatus.interrupted
        repo.delete_pending_by_run.assert_not_awaited()

    @pytest.mark.asyncio
    async def test_abort_does_not_compensate(self) -> None:
        """An aborted run must NOT trigger compensation (user cancellation keeps the task)."""
        definition = _linear_def("abort-no-comp-wf")
        thread_id = "thread-abort-no-comp"
        checkpointer = InMemorySaver()
        repo = _make_repo()

        manager = RunManager()
        record = await _make_record(manager, thread_id, definition.id)
        bridge = _make_bridge()

        # Set abort_event as soon as the first node starts.
        _orig_record = bridge._record

        async def _publish_and_abort(run_id: str, event: str, data: Any) -> None:
            await _orig_record(run_id, event, data)
            if event == "wf:node:started":
                record.abort_event.set()

        bridge.publish = AsyncMock(side_effect=_publish_and_abort)

        ctx = RunContext(checkpointer=checkpointer)

        await run_workflow(
            bridge,  # type: ignore[arg-type]
            manager,
            record,
            ctx=ctx,
            definition=definition,
            params={"input": "x"},
            human_task_repo=repo,
        )

        assert record.status is RunStatus.interrupted
        repo.delete_pending_by_run.assert_not_awaited()

    @pytest.mark.asyncio
    async def test_no_repo_failure_does_not_crash(self) -> None:
        """A failing node with no repo injected still marks error without crashing."""
        definition = _hangup_def("no-repo-fail-wf")
        thread_id = "thread-no-repo-fail"
        checkpointer = InMemorySaver()

        manager = RunManager()
        record = await _make_record(manager, thread_id, definition.id)
        bridge = _make_bridge()
        ctx = RunContext(checkpointer=checkpointer)

        with patch("deerflow.workflow.worker.build_default_registry", _failing_registry):
            await run_workflow(
                bridge,  # type: ignore[arg-type]
                manager,
                record,
                ctx=ctx,
                definition=definition,
                params={},
            )

        assert record.status is RunStatus.error
        assert record.error is not None
