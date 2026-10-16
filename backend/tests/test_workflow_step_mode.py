"""Tests for §25 single-step debugging (`debug_step`).

Step mode is a *run-level* switch: every node suspends before it executes, and a
resume of a *step* task keeps stepping. Covered here: the predicate, the
compiler gate (including its interaction with a static node breakpoint), the end
to end advance-one-node-per-resume flow, and both resume paths re-deriving the
flag from the task row.
"""

from __future__ import annotations

import asyncio
from types import SimpleNamespace
from typing import Any
from unittest.mock import AsyncMock, MagicMock, patch

import pytest

from deerflow.workflow.breakpoint import (
    BREAKPOINT_SNAPSHOT_KIND,
    DEBUG_STEP_CONTEXT_KEY,
    STEP_SNAPSHOT_KIND,
    breakpoint_requested,
    run_breakpoint,
    step_mode_requested,
)
from deerflow.workflow.compiler import WorkflowRuntime, clear_compile_cache, compile_definition
from deerflow.workflow.executors import build_default_registry
from deerflow.workflow.schema import Edge, Node, NodeType, Port, PortType, WorkflowDefinition

try:  # langgraph is a hard dependency of the workflow package
    from langgraph.checkpoint.memory import InMemorySaver
    from langgraph.types import Command
except ImportError:  # pragma: no cover - dependency is present in CI
    raise


@pytest.fixture(autouse=True)
def _isolate_cache():
    clear_compile_cache()
    yield
    clear_compile_cache()


#: Smallest definition the resume paths can validate (they only need a body).
_MINIMAL_DEFINITION: dict[str, Any] = {
    "id": "wf-1",
    "name": "W",
    "version": "0.1.0",
    "nodes": [
        {"id": "start", "type": "flow:start", "inputs": [], "outputs": [], "params": {}},
        {"id": "end", "type": "flow:end", "inputs": [], "outputs": [], "params": {}},
    ],
    "edges": [],
}


class _FakeRepo:
    def __init__(self) -> None:
        self.rows: dict[tuple[str, str], dict[str, Any]] = {}
        self.create_calls: list[dict[str, Any]] = []

    async def create(self, **kwargs: Any) -> dict[str, Any]:
        row: dict[str, Any] = {"id": f"ht-{len(self.create_calls) + 1}", "status": "pending", **kwargs}
        self.create_calls.append(row)
        self.rows[(kwargs["workflow_run_id"], kwargs["node_id"])] = row
        return row

    async def find_by_run_and_node(self, *, run_id: str, node_id: str) -> dict[str, Any] | None:
        return self.rows.get((run_id, node_id))


def _work_node(node_id: str, **params: Any) -> Node:
    return Node(
        id=node_id,
        type=NodeType.DATA_ASSIGN,
        params=params,
        inputs=[Port(name="in", type=PortType.DATA)],
        outputs=[Port(name="out", type=PortType.DATA)],
    )


def _definition(*nodes: Node) -> WorkflowDefinition:
    chain = [_work_node("a", value="A"), _work_node("b", value="B")] if not nodes else list(nodes)
    all_nodes = [Node(id="start", type=NodeType.FLOW_START, inputs=[], outputs=[Port(name="input", type=PortType.DATA)]), *chain, Node(id="end", type=NodeType.FLOW_END, inputs=[Port(name="in", type=PortType.DATA)], outputs=[])]
    edges: list[Edge] = [Edge(source="start", source_port="input", target=chain[0].id, target_port="in")]
    for left, right in zip(chain, chain[1:], strict=False):
        edges.append(Edge(source=left.id, source_port="out", target=right.id, target_port="in"))
    edges.append(Edge(source=chain[-1].id, source_port="out", target="end", target_port="in"))
    return WorkflowDefinition(id="wf-step", name="Step WF", nodes=all_nodes, edges=edges)


def _graph(definition: WorkflowDefinition, *, seen: list[str], checkpointer: Any = None) -> Any:
    async def _executor(_runtime: Any, params: dict, _inputs: dict) -> dict:
        seen.append(str(params.get("value")))
        return {"out": params.get("value")}

    ctx = build_default_registry().build_context()
    ctx.executors[NodeType.DATA_ASSIGN] = _executor
    ctx.checkpointer = checkpointer or InMemorySaver()
    return compile_definition(definition, context=ctx)


def _config(thread_id: str, repo: _FakeRepo, *, debug_step: bool) -> dict[str, Any]:
    context: dict[str, Any] = {"human_task_repo": repo, "user_id": "u", "run_id": "r"}
    if debug_step:
        context[DEBUG_STEP_CONTEXT_KEY] = True
    return {"configurable": {"thread_id": thread_id}, "context": context}


# ── 1. predicate ──────────────────────────────────────────────────────────────


class TestStepModePredicate:
    def test_only_explicit_true(self) -> None:
        assert step_mode_requested({DEBUG_STEP_CONTEXT_KEY: True}) is True
        assert step_mode_requested({DEBUG_STEP_CONTEXT_KEY: "true"}) is False
        assert step_mode_requested({DEBUG_STEP_CONTEXT_KEY: 1}) is False
        assert step_mode_requested({}) is False

    def test_non_mapping_context_is_false(self) -> None:
        assert step_mode_requested(None) is False
        assert step_mode_requested("debug_step") is False


class TestRunBreakpointKind:
    def test_step_kind_is_recorded_on_the_task(self, monkeypatch: pytest.MonkeyPatch) -> None:
        repo = _FakeRepo()
        monkeypatch.setattr("deerflow.workflow.breakpoint.interrupt", lambda payload: {})

        asyncio.run(run_breakpoint(WorkflowRuntime(state={}, context={"human_task_repo": repo, "run_id": "r"}), node_id="a", node_type="data:assign", kind=STEP_SNAPSHOT_KIND))

        row = repo.create_calls[0]
        assert row["kind"] == STEP_SNAPSHOT_KIND
        assert row["inputs_snapshot"]["kind"] == STEP_SNAPSHOT_KIND
        assert row["description"].startswith(f"[{STEP_SNAPSHOT_KIND}] ")

    def test_default_kind_is_the_node_breakpoint(self, monkeypatch: pytest.MonkeyPatch) -> None:
        repo = _FakeRepo()
        monkeypatch.setattr("deerflow.workflow.breakpoint.interrupt", lambda payload: {})
        asyncio.run(run_breakpoint(WorkflowRuntime(state={}, context={"human_task_repo": repo, "run_id": "r"}), node_id="a", node_type="data:assign"))
        assert repo.create_calls[0]["kind"] == BREAKPOINT_SNAPSHOT_KIND


# ── 2. end to end: one node per resume ────────────────────────────────────────


class TestStepModeEndToEnd:
    def test_each_node_suspends_and_advances_on_resume(self) -> None:
        seen: list[str] = []
        repo = _FakeRepo()
        graph = _graph(_definition(), seen=seen)
        config = _config("t-step", repo, debug_step=True)

        async def _run() -> Any:
            await graph.ainvoke({"wf:start:input": "go"}, config)
            assert seen == []  # nothing ran yet
            first = await graph.aget_state(config)
            assert first.next  # suspended before node 'a'

            await graph.ainvoke(Command(resume={"acknowledge": True}), config)
            assert seen == ["A"]  # exactly one node advanced
            second = await graph.aget_state(config)
            assert second.next  # suspended before node 'b'

            await graph.ainvoke(Command(resume={"acknowledge": True}), config)
            final = await graph.aget_state(config)
            return final

        final = asyncio.run(_run())

        assert seen == ["A", "B"]
        assert final.next == ()
        assert final.values.get("wf:b:out") == "B"
        # One step task per node visit, all marked as step tasks.
        assert [row["kind"] for row in repo.create_calls] == [STEP_SNAPSHOT_KIND, STEP_SNAPSHOT_KIND]

    def test_skipping_a_step_leaves_its_outputs_unset_and_keeps_stepping(self) -> None:
        seen: list[str] = []
        repo = _FakeRepo()
        graph = _graph(_definition(), seen=seen)
        config = _config("t-step-skip", repo, debug_step=True)

        async def _run() -> Any:
            await graph.ainvoke({"wf:start:input": "go"}, config)
            await graph.ainvoke(Command(resume={"__skip": True}), config)
            assert seen == []  # 'a' skipped
            await graph.ainvoke(Command(resume={"acknowledge": True}), config)
            return await graph.aget_state(config)

        final = asyncio.run(_run())

        assert seen == ["B"]  # 'b' still stepped and ran
        assert final.next == ()
        assert final.values.get("wf:a:out") is None
        assert final.values.get("wf:b:out") == "B"

    def test_step_mode_off_is_unchanged(self) -> None:
        seen: list[str] = []
        repo = _FakeRepo()
        graph = _graph(_definition(), seen=seen)
        config = _config("t-nostep", repo, debug_step=False)

        final = asyncio.run(graph.ainvoke({"wf:start:input": "go"}, config))

        assert seen == ["A", "B"]
        assert final["wf:b:out"] == "B"
        assert repo.create_calls == []

    def test_a_node_with_its_own_breakpoint_pauses_once_under_step_mode(self) -> None:
        # Step mode already paused the node; a second pause (its own breakpoint)
        # would need a second resume for the same visit.
        seen: list[str] = []
        repo = _FakeRepo()
        definition = _definition(_work_node("a", value="A", breakpoint=True), _work_node("b", value="B"))
        graph = _graph(definition, seen=seen)
        config = _config("t-both", repo, debug_step=True)

        async def _run() -> Any:
            await graph.ainvoke({"wf:start:input": "go"}, config)
            await graph.ainvoke(Command(resume={"acknowledge": True}), config)  # 'a' runs
            assert seen == ["A"]
            await graph.ainvoke(Command(resume={"acknowledge": True}), config)  # 'b' runs
            return await graph.aget_state(config)

        final = asyncio.run(_run())

        assert seen == ["A", "B"]
        assert final.next == ()
        # Both pauses are the step kind, and neither node minted two tasks.
        assert [row["kind"] for row in repo.create_calls] == [STEP_SNAPSHOT_KIND, STEP_SNAPSHOT_KIND]


# ── 3. resume paths keep stepping ─────────────────────────────────────────────


class TestResumeKeepsStepping:
    def test_app_resume_reads_the_step_kind_from_the_task_row(self) -> None:
        from app.gateway.routers import human_task_routes

        for snapshot_kind, expected in ((STEP_SNAPSHOT_KIND, True), (BREAKPOINT_SNAPSHOT_KIND, False), (None, False)):
            task = {
                "id": "ht-1",
                "checkpoint_ref": {"thread_id": "t1"},
                "workflow_run_id": "r1",
                "inputs_snapshot": None if snapshot_kind is None else {"kind": snapshot_kind},
            }
            run_mgr = MagicMock()
            run_mgr.get = AsyncMock(return_value=SimpleNamespace(kwargs={"definition_id": "wf-1"}))
            repo = MagicMock()
            repo.get = AsyncMock(return_value={"definition": _MINIMAL_DEFINITION})
            request = SimpleNamespace(app=SimpleNamespace(state=SimpleNamespace(run_manager=run_mgr, workflow_definition_repo=repo)))

            with patch.object(human_task_routes, "start_workflow_run", new=AsyncMock()) as mock_start:
                asyncio.run(human_task_routes._resume_workflow(task, {"acknowledge": True}, request, task_id="ht-1", user_id="u"))

            assert mock_start.await_args.kwargs["debug_step"] is expected

    def test_harness_resume_reads_the_step_kind_from_the_task_row(self) -> None:
        from deerflow.workflow import dispatch

        for snapshot_kind, expected in ((STEP_SNAPSHOT_KIND, True), (BREAKPOINT_SNAPSHOT_KIND, False)):
            task = {
                "id": "ht-1",
                "checkpoint_ref": {"thread_id": "t1"},
                "workflow_run_id": "r1",
                "inputs_snapshot": {"kind": snapshot_kind},
            }
            run_mgr = MagicMock()
            run_mgr.get = AsyncMock(return_value=SimpleNamespace(kwargs={"definition_id": "wf-1"}))
            bundle = {"run_manager": run_mgr}
            runtime = SimpleNamespace(context={dispatch.WORKFLOW_RUNTIME_CONTEXT_KEY: bundle})

            deps = {
                "get_workflow_definition": AsyncMock(return_value={"definition": _MINIMAL_DEFINITION}),
                "WorkflowDefinition": WorkflowDefinition,
            }

            with (
                patch.object(dispatch, "_deps", return_value=deps),
                patch.object(dispatch, "start_workflow_run", new=AsyncMock()) as mock_start,
            ):
                asyncio.run(dispatch.resume_workflow_run(task, runtime=runtime))

            assert mock_start.await_args.kwargs["debug_step"] is expected


# ── 4. interaction with the static breakpoint helper ──────────────────────────


def test_breakpoint_predicate_is_unchanged_by_step_mode() -> None:
    # The node-level flag stays node-level: step mode is per run and must not
    # leak into a definition's params.
    assert breakpoint_requested({"breakpoint": True}) is True
    assert breakpoint_requested({"debug_step": True}) is False
