"""Tests for §25 node breakpoints (`deerflow.workflow.breakpoint`).

Two levels, mirroring the approval suite:

1. **Unit** — the resume protocol, the request predicate, and the task-creation
   path with ``interrupt`` stubbed (so the create/reuse logic and the stored
   ``output_spec`` can be asserted directly).
2. **End-to-end** — a real compiled graph over ``InMemorySaver``: the node
   really suspends *before* running, ``Command(resume=...)`` really resumes it,
   and the ``{"__skip": True}`` sentinel really skips it.
"""

from __future__ import annotations

import asyncio
from typing import Any

import pytest
from langgraph.checkpoint.memory import InMemorySaver
from langgraph.types import Command

from deerflow.workflow.breakpoint import (
    BREAKPOINT_SNAPSHOT_KIND,
    BreakpointDecision,
    breakpoint_requested,
    run_breakpoint,
)
from deerflow.workflow.compiler import WorkflowCompileError, clear_compile_cache, compile_definition
from deerflow.workflow.executors import build_default_registry
from deerflow.workflow.registry import WorkflowExecutionError
from deerflow.workflow.schema import Edge, Node, NodeType, Port, PortType, WorkflowDefinition

# ── doubles ───────────────────────────────────────────────────────────────────


class _FakeRepo:
    """In-memory HumanTask repository double with a real create → find round-trip."""

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


@pytest.fixture(autouse=True)
def _isolate_cache():
    clear_compile_cache()
    yield
    clear_compile_cache()


def _runtime(context: dict[str, Any] | None = None) -> Any:
    from deerflow.workflow.compiler import WorkflowRuntime

    return WorkflowRuntime(state={}, context=context or {})


def _start_node() -> Node:
    return Node(id="start", type=NodeType.FLOW_START, inputs=[], outputs=[Port(name="input", type=PortType.DATA)])


def _end_node() -> Node:
    return Node(id="end", type=NodeType.FLOW_END, inputs=[Port(name="in", type=PortType.DATA)], outputs=[])


def _work_node(**params: Any) -> Node:
    return Node(
        id="w1",
        type=NodeType.DATA_ASSIGN,
        params=params,
        inputs=[Port(name="in", type=PortType.DATA)],
        outputs=[Port(name="out", type=PortType.DATA)],
    )


def _definition(node: Node) -> WorkflowDefinition:
    return WorkflowDefinition(
        id="breakpoint-wf",
        name="Breakpoint Workflow",
        nodes=[_start_node(), node, _end_node()],
        edges=[
            Edge(source="start", source_port="input", target=node.id, target_port="in"),
            Edge(source=node.id, source_port="out", target="end", target_port="in"),
        ],
    )


def _build_graph(node: Node, checkpointer: Any) -> Any:
    ctx = build_default_registry().build_context()
    ctx.checkpointer = checkpointer
    return compile_definition(_definition(node), context=ctx)


def _config(thread_id: str, repo: _FakeRepo, *, user_id: str = "user-1", run_id: str = "run-1") -> dict[str, Any]:
    return {
        "configurable": {"thread_id": thread_id},
        "context": {"human_task_repo": repo, "user_id": user_id, "run_id": run_id},
    }


# ── 1. predicate + resume protocol ────────────────────────────────────────────


class TestRequestPredicate:
    def test_only_explicit_true_requests(self) -> None:
        assert breakpoint_requested({"breakpoint": True}) is True
        assert breakpoint_requested({"breakpoint": False}) is False
        assert breakpoint_requested({"breakpoint": "true"}) is False
        assert breakpoint_requested({}) is False


class TestDecisionFromResume:
    def test_skip_sentinel_skips(self) -> None:
        assert BreakpointDecision.from_resume({"__skip": True}, task_id="ht-1").skipped is True

    @pytest.mark.parametrize("payload", [None, {}, {"submission": {"a": 1}}, "done", {"__skip": False}])
    def test_everything_else_continues(self, payload: Any) -> None:
        # A breakpoint is not a decision: anything that is not the shared skip
        # sentinel means "let the node run".
        assert BreakpointDecision.from_resume(payload).skipped is False


# ── 2. task creation (interrupt stubbed) ──────────────────────────────────────


class TestRunBreakpoint:
    def test_creates_a_task_that_needs_no_decision(self, monkeypatch: pytest.MonkeyPatch) -> None:
        repo = _FakeRepo()
        monkeypatch.setattr("deerflow.workflow.breakpoint.interrupt", lambda payload: {})

        decision = asyncio.run(run_breakpoint(_runtime({"human_task_repo": repo, "user_id": "u", "run_id": "r"}), node_id="w1", node_type="data:assign"))

        assert decision.skipped is False
        assert decision.task_id == "ht-1"
        kwargs = repo.create_calls[0]
        assert kwargs["node_id"] == "w1"
        assert kwargs["user_id"] == "u"
        assert kwargs["workflow_run_id"] == "r"
        assert kwargs["kind"] == BREAKPOINT_SNAPSHOT_KIND
        assert kwargs["inputs_snapshot"] == {"kind": BREAKPOINT_SNAPSHOT_KIND, "node_id": "w1", "node_type": "data:assign"}
        # One required acknowledgement port: LangGraph treats a falsy resume
        # payload as "not resumed", so an empty submission would wedge the run.
        assert kwargs["output_spec"]["ports"][0]["name"] == "acknowledge"
        assert kwargs["validation_rules"] == {"enum": {"acknowledge": {"enum": [True]}}}
        assert kwargs["checkpoint_ref"] is None
        assert kwargs["description"].startswith("[breakpoint] ")

    def test_reuses_an_existing_task_on_resume(self, monkeypatch: pytest.MonkeyPatch) -> None:
        repo = _FakeRepo()
        repo.rows[("r", "w1")] = {"id": "ht-existing", "inputs_snapshot": {"kind": BREAKPOINT_SNAPSHOT_KIND}}
        monkeypatch.setattr("deerflow.workflow.breakpoint.interrupt", lambda payload: {})

        decision = asyncio.run(run_breakpoint(_runtime({"human_task_repo": repo, "run_id": "r"}), node_id="w1", node_type="data:assign"))

        assert decision.task_id == "ht-existing"
        assert repo.create_calls == []

    def test_missing_repository_fails_loud(self) -> None:
        with pytest.raises(WorkflowExecutionError, match="human_task_repo"):
            asyncio.run(run_breakpoint(_runtime({}), node_id="w1", node_type="data:assign"))

    def test_the_task_spec_accepts_the_acknowledgement_and_nothing_else(self) -> None:
        from deerflow.workflow.breakpoint import BREAKPOINT_OUTPUT_SPEC, BREAKPOINT_VALIDATION_RULES
        from deerflow.workflow.human_task_state import validate_human_task_submission

        assert validate_human_task_submission({"acknowledge": True}, BREAKPOINT_OUTPUT_SPEC, BREAKPOINT_VALIDATION_RULES) == []
        assert validate_human_task_submission({"acknowledge": False}, BREAKPOINT_OUTPUT_SPEC, BREAKPOINT_VALIDATION_RULES)
        assert validate_human_task_submission({}, BREAKPOINT_OUTPUT_SPEC, BREAKPOINT_VALIDATION_RULES)


# ── 3. compile-time validation ────────────────────────────────────────────────


class TestBreakpointValidation:
    def test_non_boolean_is_rejected(self) -> None:
        with pytest.raises(WorkflowCompileError, match="breakpoint must be a boolean"):
            compile_definition(_definition(_work_node(breakpoint="true")), context=build_default_registry().build_context())

    @pytest.mark.parametrize("node_id", ["start", "end"])
    def test_rejected_on_graph_sentinels(self, node_id: str) -> None:
        node = _start_node() if node_id == "start" else _end_node()
        node = node.model_copy(update={"params": {"breakpoint": True}})
        definition = _definition(_work_node())
        definition = definition.model_copy(update={"nodes": [node if n.id == node_id else n for n in definition.nodes]})
        with pytest.raises(WorkflowCompileError, match="never executes"):
            compile_definition(definition, context=build_default_registry().build_context())

    def test_false_is_allowed_everywhere(self) -> None:
        compile_definition(_definition(_work_node(breakpoint=False)), context=build_default_registry().build_context())

    def test_a_real_breakpoint_compiles(self) -> None:
        graph = _build_graph(_work_node(breakpoint=True, value="done"), InMemorySaver())
        assert graph is not None


# ── 4. end-to-end suspend / resume ────────────────────────────────────────────


class TestBreakpointEndToEnd:
    def test_suspends_before_the_node_then_resumes_into_it(self) -> None:
        calls: list[str] = []

        def _executor(_runtime: Any, _params: dict, _inputs: dict) -> dict:
            calls.append("executed")
            return {"out": "done"}

        ctx = build_default_registry().build_context()
        ctx.executors[NodeType.DATA_ASSIGN] = _executor
        ctx.checkpointer = InMemorySaver()
        graph = compile_definition(_definition(_work_node(breakpoint=True)), context=ctx)

        repo = _FakeRepo()
        config = _config("t-bp", repo)

        async def _run() -> Any:
            first = await graph.ainvoke({"wf:start:input": "go"}, config)
            # The node must not have run while suspended.
            assert calls == []
            state = await graph.aget_state(config)
            assert state.next  # suspended, not finished
            await graph.ainvoke(Command(resume={"acknowledge": True}), config)
            return first, await graph.aget_state(config)

        _first, final = asyncio.run(_run())

        assert calls == ["executed"]
        assert final.next == ()
        assert final.values.get("wf:w1:out") == "done"
        # The queued task survives the resume as a normal HumanTask row.
        assert repo.create_calls[0]["kind"] == BREAKPOINT_SNAPSHOT_KIND

    def test_skip_sentinel_skips_the_node(self) -> None:
        calls: list[str] = []

        def _executor(_runtime: Any, _params: dict, _inputs: dict) -> dict:
            calls.append("executed")
            return {"out": "done"}

        ctx = build_default_registry().build_context()
        ctx.executors[NodeType.DATA_ASSIGN] = _executor
        ctx.checkpointer = InMemorySaver()
        graph = compile_definition(_definition(_work_node(breakpoint=True)), context=ctx)

        repo = _FakeRepo()
        config = _config("t-bp-skip", repo)

        async def _run() -> Any:
            await graph.ainvoke({"wf:start:input": "go"}, config)
            await graph.ainvoke(Command(resume={"__skip": True}), config)
            return await graph.aget_state(config)

        final = asyncio.run(_run())

        assert calls == []
        assert final.next == ()
        assert final.values.get("wf:w1:out") is None

    def test_no_breakpoint_leaves_execution_unchanged(self) -> None:
        ctx = build_default_registry().build_context()
        ctx.checkpointer = InMemorySaver()
        graph = compile_definition(_definition(_work_node(value="plain")), context=ctx)
        repo = _FakeRepo()
        config = _config("t-no-bp", repo)

        final = asyncio.run(graph.ainvoke({"wf:start:input": "go"}, config))

        assert final["wf:w1:out"] == "plain"
        assert repo.create_calls == []
