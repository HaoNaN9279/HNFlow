"""Tests for §25 rewind & re-run (``workflow/rewind.py`` + the rewind route).

The valuable behaviour is not "it runs again" but "it runs again **from the
right place** without repeating upstream work", so these pin the checkpoint
selection, and every way the request can be refused.
"""

from __future__ import annotations

import asyncio
from types import SimpleNamespace
from typing import Any
from unittest.mock import AsyncMock, MagicMock, patch

import pytest

from deerflow.workflow.compiler import clear_compile_cache, compile_definition
from deerflow.workflow.executors import build_default_registry
from deerflow.workflow.rewind import (
    RewindCandidate,
    RewindError,
    RewindPoint,
    locate_rewind_point,
    parse_rewind_candidate,
    plan_rewind,
)
from deerflow.workflow.schema import Edge, Node, NodeType, Port, PortType, WorkflowDefinition

try:
    from langgraph.checkpoint.memory import InMemorySaver
except ImportError:  # pragma: no cover
    raise


@pytest.fixture(autouse=True)
def _isolate_cache():
    clear_compile_cache()
    yield
    clear_compile_cache()


# ── 1. candidate reduction ───────────────────────────────────────────────────


def _snapshot(checkpoint_id: Any, next_ids: Any, step: Any = 5) -> SimpleNamespace:
    return SimpleNamespace(
        config={"configurable": {"thread_id": "t1", "checkpoint_id": checkpoint_id}},
        next=next_ids,
        metadata={"step": step},
    )


class TestParseCandidate:
    def test_reduces_a_langgraph_shaped_snapshot(self) -> None:
        candidate = parse_rewind_candidate(_snapshot("cp-1", ("a", "b"), 7))
        assert candidate == RewindCandidate(checkpoint_id="cp-1", next_node_ids=("a", "b"), step=7)

    def test_tolerates_missing_pieces(self) -> None:
        candidate = parse_rewind_candidate(_snapshot("cp-1", None, None))
        assert candidate == RewindCandidate(checkpoint_id="cp-1", next_node_ids=(), step=None)

    def test_filters_non_string_task_names(self) -> None:
        candidate = parse_rewind_candidate(_snapshot("cp-1", ("a", 7, None, "b")))
        assert candidate is not None
        assert candidate.next_node_ids == ("a", "b")

    def test_a_non_integer_step_is_not_a_step(self) -> None:
        candidate = parse_rewind_candidate(_snapshot("cp-1", ("a",), "5"))
        assert candidate is not None
        assert candidate.step is None

    def test_rejects_a_snapshot_without_an_addressable_checkpoint(self) -> None:
        # A checkpoint nobody can resume from must not become a candidate: the
        # plan would name an id that cannot be used.
        assert parse_rewind_candidate(_snapshot(None, ("a",))) is None
        assert parse_rewind_candidate(_snapshot("", ("a",))) is None
        assert parse_rewind_candidate(SimpleNamespace(config=None, next=("a",))) is None
        assert parse_rewind_candidate(object()) is None


# ── 2. planning ──────────────────────────────────────────────────────────────


class TestPlanRewind:
    def test_picks_the_newest_matching_checkpoint(self) -> None:
        # Newest first, as ``aget_state_history`` yields: the newest match is on
        # the run's current head lineage.
        candidates = [
            RewindCandidate("cp-new", ("b",), 4),
            RewindCandidate("cp-old", ("a", "b"), 2),
        ]
        assert plan_rewind(candidates, "a") == RewindPoint(checkpoint_id="cp-old", node_id="a", step=2)
        assert plan_rewind(candidates, "b") == RewindPoint(checkpoint_id="cp-new", node_id="b", step=4)

    def test_a_node_in_the_newest_checkpoint_wins(self) -> None:
        candidates = [
            RewindCandidate("cp-new", ("a",), 4),
            RewindCandidate("cp-old", ("a",), 2),
        ]
        assert plan_rewind(candidates, "a").checkpoint_id == "cp-new"

    def test_rejects_a_node_that_was_never_scheduled(self) -> None:
        candidates = [RewindCandidate("cp-1", ("a", "b"), 1)]
        with pytest.raises(RewindError, match="was never scheduled") as excinfo:
            plan_rewind(candidates, "c")
        # The failure lists what CAN be rewound to — an actionable dead end.
        assert "a" in str(excinfo.value)
        assert "b" in str(excinfo.value)

    def test_rejects_a_node_absent_from_a_history_with_no_tasks(self) -> None:
        with pytest.raises(RewindError, match="rewindable nodes: <none>"):
            plan_rewind([RewindCandidate("cp-1", (), 1)], "a")

    def test_rejects_the_graph_sentinels(self) -> None:
        for sentinel in ("flow:start", "flow:end"):
            with pytest.raises(RewindError, match="graph sentinel"):
                plan_rewind([RewindCandidate("cp-1", (sentinel,), 1)], sentinel)


# ── 3. locating a point in a real checkpoint history ─────────────────────────


def _definition(*node_ids: str) -> WorkflowDefinition:
    chain = [
        Node(
            id=node_id,
            type=NodeType.DATA_ASSIGN,
            params={"value": node_id},
            inputs=[Port(name="in", type=PortType.DATA)],
            outputs=[Port(name="out", type=PortType.DATA)],
        )
        for node_id in node_ids
    ]
    nodes = [
        Node(id="start", type=NodeType.FLOW_START, inputs=[], outputs=[Port(name="out", type=PortType.DATA)]),
        *chain,
        Node(id="end", type=NodeType.FLOW_END, inputs=[Port(name="in", type=PortType.DATA)], outputs=[]),
    ]
    edges = [Edge(source="start", source_port="out", target=chain[0].id, target_port="in")]
    for left, right in zip(chain, chain[1:], strict=False):
        edges.append(Edge(source=left.id, source_port="out", target=right.id, target_port="in"))
    edges.append(Edge(source=chain[-1].id, source_port="out", target="end", target_port="in"))
    return WorkflowDefinition(id="wf-rewind", name="Rewind", nodes=nodes, edges=edges)


class TestLocate:
    def _ran_graph(self, *, fail_at: str | None = None) -> tuple[Any, list[str]]:
        """Run start→a→b→end, optionally failing at one node."""
        seen: list[str] = []

        async def _assign(_runtime: Any, params: dict, _inputs: dict) -> dict:
            node_id = str(params.get("value"))
            seen.append(node_id)
            if node_id == fail_at:
                raise RuntimeError(f"boom at {node_id}")
            return {"out": node_id}

        ctx = build_default_registry().build_context()
        ctx.executors[NodeType.DATA_ASSIGN] = _assign
        ctx.checkpointer = InMemorySaver()
        graph = compile_definition(_definition("a", "b", "c"), context=ctx)
        config = {"configurable": {"thread_id": "t-rewind"}}
        try:
            asyncio.run(graph.ainvoke({}, config))
        except RuntimeError:
            pass
        return ctx.checkpointer, seen

    def test_locates_the_checkpoint_that_scheduled_the_node(self) -> None:
        checkpointer, seen = self._ran_graph()

        point = asyncio.run(locate_rewind_point(_definition("a", "b", "c"), checkpointer, "t-rewind", "b"))

        assert point.node_id == "b"
        assert point.checkpoint_id

    def test_stops_naming_the_failing_node(self) -> None:
        checkpointer, seen = self._ran_graph(fail_at="b")

        # 'b' failed, but it WAS scheduled, so it is rewindable — that is exactly
        # the recovery case (fix the cause, re-run from here).
        point = asyncio.run(locate_rewind_point(_definition("a", "b", "c"), checkpointer, "t-rewind", "b"))
        assert point.node_id == "b"

    def test_refuses_a_node_that_never_ran(self) -> None:
        checkpointer, _seen = self._ran_graph(fail_at="b")

        with pytest.raises(RewindError, match="was never scheduled"):
            asyncio.run(locate_rewind_point(_definition("a", "b", "c"), checkpointer, "t-rewind", "c"))

    def test_an_unknown_thread_has_nothing_to_rewind(self) -> None:
        checkpointer, _seen = self._ran_graph()
        with pytest.raises(RewindError):
            asyncio.run(locate_rewind_point(_definition("a", "b", "c"), checkpointer, "t-nope", "a"))

    def test_resuming_the_located_checkpoint_reruns_only_from_there(self) -> None:
        """The mechanism the worker uses, proven end to end.

        This is the whole value of a rewind: 'a' (which may have had a side
        effect) must NOT run again, while 'b' and everything after it must.
        """
        seen: list[str] = []

        async def _assign(_runtime: Any, params: dict, _inputs: dict) -> dict:
            seen.append(str(params.get("value")))
            return {"out": params.get("value")}

        ctx = build_default_registry().build_context()
        ctx.executors[NodeType.DATA_ASSIGN] = _assign
        ctx.checkpointer = InMemorySaver()
        definition = _definition("a", "b", "c")
        graph = compile_definition(definition, context=ctx)
        config = {"configurable": {"thread_id": "t-rerun"}}

        asyncio.run(graph.ainvoke({}, config))
        assert seen == ["a", "b", "c"]

        point = asyncio.run(locate_rewind_point(definition, ctx.checkpointer, "t-rerun", "b"))
        resumed = asyncio.run(graph.ainvoke(None, {"configurable": {"thread_id": "t-rerun", "checkpoint_id": point.checkpoint_id}}))

        assert seen == ["a", "b", "c", "b", "c"]
        assert resumed["wf:c:out"] == "c"


# ── 4. route ─────────────────────────────────────────────────────────────────


def _route_module():
    from app.gateway.routers import workflow_run_routes

    return workflow_run_routes


def _request(*, status: Any, kwargs: dict[str, Any] | None = None, checkpointer: Any = "cp") -> SimpleNamespace:
    run_mgr = MagicMock()
    record = SimpleNamespace(
        run_id="run-1",
        thread_id="wf-run-abc",
        status=status,
        kwargs=kwargs if kwargs is not None else {"params": {"in": "x"}, "definition_id": "wf-1"},
    )
    run_mgr.get = AsyncMock(return_value=record)
    return SimpleNamespace(
        app=SimpleNamespace(state=SimpleNamespace(run_manager=run_mgr)),
        state=SimpleNamespace(),
        app_state_holder=None,
        _record=record,
    )


class TestRewindRoute:
    def _call(self, request: SimpleNamespace, node_id: str = "b") -> Any:
        module = _route_module()
        body = module.WorkflowRunRewindRequest(node_id=node_id)
        return module.rewind_workflow_run("wf-1", "run-1", body, request)  # type: ignore[arg-type]

    def test_rejects_a_live_run(self) -> None:
        from deerflow.runtime.runs.schemas import RunStatus

        module = _route_module()
        request = _request(status=RunStatus.running)
        with (
            patch.object(module, "get_optional_user_from_request", new=AsyncMock(return_value=SimpleNamespace(id="default"))),
            patch.object(module, "get_run_manager", return_value=request.app.state.run_manager),
            patch.object(module, "_require_run_owner", new=AsyncMock(return_value=request._record)),
        ):
            with pytest.raises(Exception) as excinfo:
                asyncio.run(self._call(request))
        assert getattr(excinfo.value, "status_code", None) == 409
        assert "not finished" in str(excinfo.value.detail)

    def test_refuses_without_a_checkpointer(self) -> None:
        from deerflow.runtime.runs.schemas import RunStatus

        module = _route_module()
        request = _request(status=RunStatus.success)
        with (
            patch.object(module, "get_optional_user_from_request", new=AsyncMock(return_value=SimpleNamespace(id="default"))),
            patch.object(module, "get_run_manager", return_value=request.app.state.run_manager),
            patch.object(module, "_require_run_owner", new=AsyncMock(return_value=request._record)),
            patch.object(module, "get_run_context", return_value=SimpleNamespace(checkpointer=None)),
        ):
            with pytest.raises(Exception) as excinfo:
                asyncio.run(self._call(request))
        assert getattr(excinfo.value, "status_code", None) == 503

    def test_maps_an_unrewindable_node_to_422(self) -> None:
        from deerflow.runtime.runs.schemas import RunStatus

        module = _route_module()
        request = _request(status=RunStatus.error)
        with (
            patch.object(module, "get_optional_user_from_request", new=AsyncMock(return_value=SimpleNamespace(id="default"))),
            patch.object(module, "get_run_manager", return_value=request.app.state.run_manager),
            patch.object(module, "_require_run_owner", new=AsyncMock(return_value=request._record)),
            patch.object(module, "get_run_context", return_value=SimpleNamespace(checkpointer=MagicMock())),
            patch.object(module, "_resolve_definition", new=AsyncMock(return_value=({}, _definition("a", "b")))),
            patch(
                "deerflow.workflow.rewind.locate_rewind_point",
                new=AsyncMock(side_effect=RewindError("node 'zzz' was never scheduled in this run's checkpoint history; rewindable nodes: a, b")),
            ),
        ):
            with pytest.raises(Exception) as excinfo:
                asyncio.run(self._call(request, node_id="zzz"))
        assert getattr(excinfo.value, "status_code", None) == 422
        assert "never scheduled" in str(excinfo.value.detail)

    def test_admits_a_run_on_the_same_thread_at_the_located_checkpoint(self) -> None:
        from deerflow.runtime.runs.schemas import RunStatus

        module = _route_module()
        request = _request(status=RunStatus.success)
        definition = _definition("a", "b")
        record = SimpleNamespace(run_id="run-2", thread_id="wf-run-abc", status="pending")
        start = AsyncMock(return_value=record)
        with (
            patch.object(module, "get_optional_user_from_request", new=AsyncMock(return_value=SimpleNamespace(id="default"))),
            patch.object(module, "get_run_manager", return_value=request.app.state.run_manager),
            patch.object(module, "_require_run_owner", new=AsyncMock(return_value=request._record)),
            patch.object(module, "get_run_context", return_value=SimpleNamespace(checkpointer=MagicMock())),
            patch.object(module, "_resolve_definition", new=AsyncMock(return_value=({}, definition))),
            patch.object(module, "_build_workflow_template_resolver", new=AsyncMock(return_value=None)),
            patch.object(module, "get_app_config", return_value=SimpleNamespace(subagents=SimpleNamespace(max_delegation_depth=3))),
            patch(
                "deerflow.workflow.rewind.locate_rewind_point",
                new=AsyncMock(return_value=RewindPoint(checkpoint_id="cp-42", node_id="b", step=2)),
            ),
            patch.object(module, "start_workflow_run", new=start),
            patch.object(module, "_record_to_response", return_value="response"),
        ):
            result = asyncio.run(self._call(request))

        assert result == "response"
        kwargs = start.await_args.kwargs
        assert kwargs["checkpoint_id"] == "cp-42"
        # Same thread: the rewind continues this run's state instead of starting over.
        assert kwargs["thread_id"] == "wf-run-abc"
        assert kwargs["params"] == {"in": "x"}
        assert kwargs["metadata"]["rewind_from_run_id"] == "run-1"
        assert kwargs["metadata"]["rewind_node_id"] == "b"
