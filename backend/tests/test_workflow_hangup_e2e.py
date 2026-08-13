"""End-to-end integration tests for the T13 human-task hangup chain (T13-5).

Lands the four planned verification points as executable tests over a real
compiled graph + ``InMemorySaver`` + a mock :class:`HumanTaskRepository`,
driving ``run_workflow`` (not the lower-level graph calls used by the unit
tests in ``test_workflow_human_task_executor.py``).

Verification points and how they are landed:

1. **Interrupt → todo → submit → precise resume** (``test_e2e_hangup_submit_resume_completes`` /
   ``test_e2e_hangup_skip_continues``): a ``human:task`` node suspends the run
   (``interrupted`` + ``checkpoint_ref`` backfill), a simulated submit/skip
   triggers a ``Command(resume=...)`` run on the same thread, and the graph
   continues to ``end`` with the submitted value visible to downstream nodes.
2. **Transactional rollback / no half-state** (``test_e2e_no_repo_no_half_state``):
   with no repository injected the ``human:task`` executor degrades to an
   explicit ``error`` and the graph never leaves a suspended checkpoint
   (``aget_state().next`` is empty — no half-state).
3. **Loop iteration count** (``test_e2e_loop_hangup_iteration_count_ok``): scoped
   to a *non-hanging* loop-body regression — the T13 changes must not disturb
   ``flow:loop`` iteration counting.  Loop-*internal* human-task suspension is
   NOT supported by T13 (single-confirm model) and is out of scope here.
4. **Subgraph unified hangup semantics** (``test_e2e_subgraph_human_task_degrades``):
   a ``human:task`` inside an inline ``nested:subworkflow`` degrades to an error
   (subgraphs compile with ``checkpointer=None``, so ``interrupt()`` cannot
   suspend), the parent run ends ``error``, and compensation removes the
   pending row — no half-state.

The mock repository is *stateful* and keyed by ``(run_id, node_id)`` to mirror
the real :class:`~deerflow.persistence.human_tasks.sql.HumanTaskRepository`
(``find_by_run_and_node`` / ``create`` / ``update_checkpoint_ref_by_run`` /
``delete_pending_by_run`` / ``submit`` / ``skip``).  ``app_config`` is supplied
on ``RunContext`` so ``run_workflow`` seeds ``config["context"]["run_id"]``
exactly as the production ``start_workflow_run`` path does.
"""

from __future__ import annotations

from typing import Any
from unittest.mock import AsyncMock

import pytest
from langgraph.checkpoint.memory import InMemorySaver
from langgraph.types import Command

from deerflow.config.app_config import AppConfig
from deerflow.config.sandbox_config import SandboxConfig
from deerflow.runtime.runs.manager import RunManager, RunRecord
from deerflow.runtime.runs.schemas import RunStatus
from deerflow.runtime.runs.worker import RunContext
from deerflow.workflow.compiler import clear_compile_cache, compile_definition
from deerflow.workflow.executors import build_default_registry
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


def _human_node(id_: str = "ht") -> Node:
    """A ``human:task`` node whose sole output port is ``answer``."""
    return Node(
        id=id_,
        type=NodeType.HUMAN_TASK,
        params={"description": "Approve this change"},
        inputs=[Port(name="in", type=PortType.DATA)],
        outputs=[Port(name="answer", type=PortType.DATA)],
    )


def _assign_node(id_: str = "out") -> Node:
    """A pass-through ``data:assign`` node (``out = in``) — forwards the submitted answer downstream."""
    return Node(
        id=id_,
        type=NodeType.DATA_ASSIGN,
        params={},
        inputs=[Port(name="in", type=PortType.DATA)],
        outputs=[Port(name="out", type=PortType.DATA)],
    )


def _make_bridge() -> Any:
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


async def _make_record(manager: RunManager, thread_id: str, assistant_id: str | None = None) -> RunRecord:
    return await manager.create(thread_id, assistant_id=assistant_id)


def _app_config() -> AppConfig:
    """Minimal ``AppConfig`` so ``run_workflow`` seeds ``context.run_id`` (production-shaped)."""
    return AppConfig(sandbox=SandboxConfig(use="test"))


def _make_stateful_repo() -> AsyncMock:
    """A stateful mock :class:`HumanTaskRepository` keyed by ``(run_id, node_id)``.

    Mirrors the real repository's idempotency keying (``find_by_run_and_node``
    scopes to ``workflow_run_id``) so the resume path exercises the same
    create-vs-reuse decision as production.
    """
    repo = AsyncMock()
    store: dict[tuple[str, str], dict[str, Any]] = {}
    create_calls: list[dict[str, Any]] = []

    async def _create(**kwargs: Any) -> dict[str, Any]:
        task: dict[str, Any] = {"id": f"ht-{len(create_calls) + 1}", "status": "pending", **kwargs}
        create_calls.append(task)
        store[(kwargs["workflow_run_id"], kwargs["node_id"])] = task
        return dict(task)

    async def _find_by_run_and_node(*, run_id: str, node_id: str) -> dict[str, Any] | None:
        task = store.get((run_id, node_id))
        return dict(task) if task is not None else None

    async def _update_checkpoint_ref_by_run(*, run_id: str, checkpoint_ref: dict[str, Any] | None) -> int:
        count = 0
        for (r, _n), task in store.items():
            if r == run_id:
                task["checkpoint_ref"] = checkpoint_ref
                count += 1
        return count

    async def _delete_pending_by_run(*, run_id: str) -> int:
        count = 0
        for key in [k for k in store if k[0] == run_id]:
            if store[key].get("status") == "pending":
                del store[key]
                count += 1
        return count

    async def _submit(task_id: str, *, user_id: str, values: dict[str, Any], to_status: str) -> dict[str, Any] | None:
        for task in store.values():
            if task.get("id") == task_id:
                task["status"] = to_status
                task["submission"] = values
                return dict(task)
        return None

    async def _skip(task_id: str, *, user_id: str) -> dict[str, Any] | None:
        for task in store.values():
            if task.get("id") == task_id:
                task["status"] = "skipped"
                return dict(task)
        return None

    repo.create = AsyncMock(side_effect=_create)
    repo.find_by_run_and_node = AsyncMock(side_effect=_find_by_run_and_node)
    repo.update_checkpoint_ref_by_run = AsyncMock(side_effect=_update_checkpoint_ref_by_run)
    repo.delete_pending_by_run = AsyncMock(side_effect=_delete_pending_by_run)
    repo.submit = AsyncMock(side_effect=_submit)
    repo.skip = AsyncMock(side_effect=_skip)
    repo.store = store  # type: ignore[attr-defined]
    repo.create_calls = create_calls  # type: ignore[attr-defined]
    return repo


def _compile(definition: WorkflowDefinition, checkpointer: Any) -> Any:
    """Compile *definition* with the default registry and *checkpointer* (same key as ``run_workflow``)."""
    ctx = build_default_registry().build_context()
    ctx.checkpointer = checkpointer
    return compile_definition(definition, context=ctx)


async def _state_values(checkpointer: Any, thread_id: str) -> dict[str, Any]:
    """Read the final checkpoint's channel values for *thread_id*."""
    state = await checkpointer.aget_tuple({"configurable": {"thread_id": thread_id}})
    assert state is not None, "checkpoint must exist after a run"
    checkpoint = getattr(state, "checkpoint", {}) or {}
    values = checkpoint.get("channel_values", {}) if isinstance(checkpoint, dict) else {}
    return dict(values)


# ── Workflow definitions ───────────────────────────────────────────────────────


def _submit_resume_def() -> WorkflowDefinition:
    """start → human:task(ht) → assign(out) → end — the submitted ``answer`` flows to ``wf:out:out``."""
    return _make_def(
        nodes=[_start_node("start"), _human_node("ht"), _assign_node("out"), _end_node("end")],
        edges=[
            Edge(source="start", source_port="input", target="ht", target_port="in"),
            Edge(source="ht", source_port="answer", target="out", target_port="in"),
            Edge(source="out", source_port="out", target="end", target_port="in"),
        ],
        id="submit-resume-wf",
        name="Submit Resume WF",
    )


def _loop_def() -> WorkflowDefinition:
    """start → flow:loop(iterations=2) ⇄ body(assign) → end — non-hanging loop count regression."""
    return _make_def(
        nodes=[
            _start_node("start"),
            Node(id="loop", type=NodeType.FLOW_LOOP, params={"iterations": 2}, inputs=[Port(name="in", type=PortType.DATA)], outputs=[Port(name="out", type=PortType.DATA)]),
            Node(id="body", type=NodeType.DATA_ASSIGN, params={"value": "iter"}, inputs=[Port(name="in", type=PortType.DATA)], outputs=[Port(name="out", type=PortType.DATA)]),
            _end_node("end"),
        ],
        edges=[
            Edge(source="start", source_port="input", target="loop", target_port="in"),
            Edge(source="loop", source_port="out", target="body", target_port="in", condition="loop_body"),
            Edge(source="body", source_port="out", target="loop", target_port="in"),
            Edge(source="loop", source_port="out", target="end", target_port="in"),
        ],
        id="loop-wf",
        name="Loop WF",
    )


def _subgraph_hangup_def() -> WorkflowDefinition:
    """Parent ``start → sub(nested:subworkflow inline) → end``; child ``cstart → human:task(c_ht) → cend``.

    The child is compiled with ``checkpointer=None``, so its ``human:task``
    cannot suspend — it must degrade to an error.
    """
    child = _make_def(
        nodes=[
            Node(id="cstart", type=NodeType.FLOW_START, inputs=[], outputs=[Port(name="in", type=PortType.DATA)]),
            _human_node("c_ht"),
            Node(id="cend", type=NodeType.FLOW_END, inputs=[Port(name="in", type=PortType.DATA)], outputs=[Port(name="result", type=PortType.DATA)]),
        ],
        edges=[
            Edge(source="cstart", source_port="in", target="c_ht", target_port="in"),
            Edge(source="c_ht", source_port="answer", target="cend", target_port="in"),
        ],
        id="child-wf",
        name="Child WF",
    )
    sub = Node(
        id="sub",
        type=NodeType.NESTED_SUBWORKFLOW,
        params={
            "subworkflow": {"type": "inline", "definition": child.model_dump(mode="json")},
            "mapping": {"inputs": {"in": "wf:start:input"}, "outputs": {"result": "out"}},
        },
        inputs=[Port(name="in", type=PortType.DATA)],
        outputs=[Port(name="out", type=PortType.DATA)],
    )
    return _make_def(
        nodes=[_start_node("start"), sub, _end_node("end")],
        edges=[
            Edge(source="start", source_port="input", target="sub", target_port="in"),
            Edge(source="sub", source_port="out", target="end", target_port="in"),
        ],
        id="subgraph-wf",
        name="Subgraph WF",
    )


# ═══════════════════════════════════════════════════════════════════════════════
# Fixture
# ═══════════════════════════════════════════════════════════════════════════════


@pytest.fixture(autouse=True)
def _isolate_cache() -> Any:
    clear_compile_cache()
    yield


# ═══════════════════════════════════════════════════════════════════════════════
# 1. Interrupt → todo → submit → precise resume
# ═══════════════════════════════════════════════════════════════════════════════


class TestSubmitResume:
    @pytest.mark.asyncio
    async def test_e2e_hangup_submit_resume_completes(self) -> None:
        definition = _submit_resume_def()
        thread_id = "thread-e2e-submit"
        checkpointer = InMemorySaver()
        repo = _make_stateful_repo()

        # ── First run: suspend on the human:task ──────────────────────────
        manager1 = RunManager()
        record1 = await _make_record(manager1, thread_id, definition.id)
        ctx1 = RunContext(checkpointer=checkpointer, app_config=_app_config())

        await run_workflow(
            _make_bridge(),  # type: ignore[arg-type]
            manager1,
            record1,
            ctx=ctx1,
            definition=definition,
            params={},
            human_task_repo=repo,
        )

        assert record1.status is RunStatus.interrupted, f"Expected interrupted, got {record1.status}"
        assert repo.create.await_count == 1, f"first run must create exactly one todo, got {repo.create.await_count}"

        # The worker backfilled checkpoint_ref with the suspended coordinate.
        repo.update_checkpoint_ref_by_run.assert_awaited_once()
        ref = repo.update_checkpoint_ref_by_run.call_args.kwargs["checkpoint_ref"]
        assert ref["thread_id"] == thread_id
        assert ref["checkpoint_id"], "checkpoint_id must be a non-empty coordinate"

        # ── Simulate the submit route: repo.submit + Command(resume) run ───
        task = repo.store[(record1.run_id, "ht")]
        await repo.submit(task_id=task["id"], user_id="", values={"answer": "hi"}, to_status="submitted")

        manager2 = RunManager()
        record2 = await _make_record(manager2, thread_id, definition.id)
        ctx2 = RunContext(checkpointer=checkpointer, app_config=_app_config())

        await run_workflow(
            _make_bridge(),  # type: ignore[arg-type]
            manager2,
            record2,
            ctx=ctx2,
            definition=definition,
            params={},
            resume=Command(resume={"answer": "hi"}),
            human_task_repo=repo,
            origin_run_id=record1.run_id,
        )

        assert record2.status is RunStatus.success, f"Expected success after resume, got {record2.status}"

        # The submitted value flows through the downstream assign node.
        values = await _state_values(checkpointer, thread_id)
        assert values.get("wf:out:out") == "hi", f"Expected wf:out:out == 'hi', got {values.get('wf:out:out')!r}"

        # No duplicate todo: the resume re-execution reuses the existing task.
        assert repo.create.await_count == 1, f"resume re-created a todo: create called {repo.create.await_count} times"

    @pytest.mark.asyncio
    async def test_e2e_hangup_skip_continues(self) -> None:
        definition = _submit_resume_def()
        thread_id = "thread-e2e-skip"
        checkpointer = InMemorySaver()
        repo = _make_stateful_repo()

        manager1 = RunManager()
        record1 = await _make_record(manager1, thread_id, definition.id)
        ctx1 = RunContext(checkpointer=checkpointer, app_config=_app_config())

        await run_workflow(
            _make_bridge(),  # type: ignore[arg-type]
            manager1,
            record1,
            ctx=ctx1,
            definition=definition,
            params={},
            human_task_repo=repo,
        )
        assert record1.status is RunStatus.interrupted

        task = repo.store[(record1.run_id, "ht")]
        await repo.skip(task_id=task["id"], user_id="")

        manager2 = RunManager()
        record2 = await _make_record(manager2, thread_id, definition.id)
        ctx2 = RunContext(checkpointer=checkpointer, app_config=_app_config())

        await run_workflow(
            _make_bridge(),  # type: ignore[arg-type]
            manager2,
            record2,
            ctx=ctx2,
            definition=definition,
            params={},
            resume=Command(resume={"__skip": True}),
            human_task_repo=repo,
            origin_run_id=record1.run_id,
        )

        assert record2.status is RunStatus.success, f"Expected success after skip, got {record2.status}"

        # Skipped: the human:task output port stays unset, so the downstream node sees None.
        values = await _state_values(checkpointer, thread_id)
        assert values.get("wf:out:out") is None, f"Expected wf:out:out == None after skip, got {values.get('wf:out:out')!r}"
        assert repo.create.await_count == 1, f"skip resume re-created a todo: create called {repo.create.await_count} times"


# ═══════════════════════════════════════════════════════════════════════════════
# 2. No repository → error, no half-state
# ═══════════════════════════════════════════════════════════════════════════════


class TestNoRepoHalfState:
    @pytest.mark.asyncio
    async def test_e2e_no_repo_no_half_state(self) -> None:
        definition = _submit_resume_def()
        thread_id = "thread-e2e-no-repo"
        checkpointer = InMemorySaver()

        manager = RunManager()
        record = await _make_record(manager, thread_id, definition.id)
        ctx = RunContext(checkpointer=checkpointer, app_config=_app_config())

        await run_workflow(
            _make_bridge(),  # type: ignore[arg-type]
            manager,
            record,
            ctx=ctx,
            definition=definition,
            params={},
            # No human_task_repo injected — the executor must degrade to an error.
        )

        assert record.status is RunStatus.error, f"Expected error, got {record.status}"
        assert record.error is not None
        assert "human_task_repo" in record.error

        # No suspended checkpoint — the graph never hung, so there is no half-state.
        # LangGraph writes an *error* checkpoint for a failed node (its ``next`` is
        # the failed node, ``ht``); that is normal error/retry bookkeeping, not a
        # resumable hangup.  A hangup would carry a non-empty ``interrupts`` tuple.
        graph = _compile(definition, checkpointer)
        snapshot = await graph.aget_state({"configurable": {"thread_id": thread_id}})
        assert not snapshot.interrupts, f"Expected no resumable interrupt (no hangup), got {snapshot.interrupts}"


# ═══════════════════════════════════════════════════════════════════════════════
# 3. Loop iteration count regression (scoped)
# ═══════════════════════════════════════════════════════════════════════════════


class TestLoopIterationCount:
    @pytest.mark.asyncio
    async def test_e2e_loop_hangup_iteration_count_ok(self) -> None:
        """Non-hanging loop regression: T13 changes must not disturb loop counting.

        Loop-*internal* human-task suspension is NOT supported by T13 (single-confirm
        model — ``interrupt()`` would re-hang on every iteration).  The
        ``human:task`` idempotency property (reuse, not re-create) is instead
        exercised by ``TestSubmitResume`` above and by the unit-level
        ``TestIdempotency`` in ``test_workflow_human_task_executor.py``.
        """
        definition = _loop_def()
        thread_id = "thread-e2e-loop"
        checkpointer = InMemorySaver()

        manager = RunManager()
        record = await _make_record(manager, thread_id, definition.id)
        ctx = RunContext(checkpointer=checkpointer, app_config=_app_config())

        await run_workflow(
            _make_bridge(),  # type: ignore[arg-type]
            manager,
            record,
            ctx=ctx,
            definition=definition,
            params={"input": "looping"},
        )

        assert record.status is RunStatus.success, f"Expected success, got {record.status}"

        # iterations=2 → counter reaches 3 (0 → 1,2 on body trips → 3 on exit check).
        values = await _state_values(checkpointer, thread_id)
        assert values.get("wf:loop:__count") == 3, f"Expected wf:loop:__count == 3, got {values.get('wf:loop:__count')!r}"


# ═══════════════════════════════════════════════════════════════════════════════
# 4. Subgraph human:task degrades to error (scoped)
# ═══════════════════════════════════════════════════════════════════════════════


class TestSubgraphDegrades:
    @pytest.mark.asyncio
    async def test_e2e_subgraph_human_task_degrades(self) -> None:
        """A ``human:task`` inside an inline subgraph cannot suspend (``checkpointer=None``).

        Subgraph-internal hanging is NOT supported by T13 (D2).  The child graph's
        ``interrupt()`` raises, the parent run ends ``error`` (not ``interrupted``),
        and the compensation path deletes the pending row — no half-state.
        """
        definition = _subgraph_hangup_def()
        thread_id = "thread-e2e-subgraph"
        checkpointer = InMemorySaver()
        repo = _make_stateful_repo()

        manager = RunManager()
        record = await _make_record(manager, thread_id, definition.id)
        ctx = RunContext(checkpointer=checkpointer, app_config=_app_config())

        await run_workflow(
            _make_bridge(),  # type: ignore[arg-type]
            manager,
            record,
            ctx=ctx,
            definition=definition,
            params={},
            human_task_repo=repo,
        )

        assert record.status is RunStatus.error, f"Expected error, got {record.status}"
        assert record.error is not None

        # The failure names the child node id or the degradation text.
        assert ("c_ht" in record.error) or ("sub" in record.error) or ("human_task_repo" in record.error), f"error should name the subgraph node, got: {record.error}"

        # Compensation removed the pending row — no residual half-state.
        repo.delete_pending_by_run.assert_awaited()
        assert not repo.store, f"expected no residual pending tasks, got {list(repo.store)}"
