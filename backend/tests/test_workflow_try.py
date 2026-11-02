"""Tests for the N12 ``flow:try`` container node (try / catch / finally).

``flow:try`` protects a sub-workflow body (``params.subworkflow``, inline or
template — the same machinery ``nested:subworkflow`` uses).  A body failure is
surfaced on ``error`` / ``error_message`` / ``error_type`` output ports instead
of aborting the run, so a downstream ``flow:if`` can route to a catch branch.
``params.finally_subworkflow`` runs in a ``finally`` block; ``on_error="fail"``
restores the abort-the-run behavior.
"""

from __future__ import annotations

from typing import Any

import pytest
from langgraph.errors import GraphInterrupt, GraphRecursionError

from deerflow.workflow.compiler import (
    WorkflowCompileError,
    _control_flow_should_propagate,
    clear_compile_cache,
    compile_definition,
)
from deerflow.workflow.executors import WorkflowExecutionError, build_default_registry
from deerflow.workflow.schema import (
    Edge,
    Node,
    NodeType,
    Port,
    PortType,
    WorkflowDefinition,
)

# ═══════════════════════════════════════════════════════════════════════════════
# Helpers
# ═══════════════════════════════════════════════════════════════════════════════


def _body_definition(work_type: str = "data:assign") -> dict[str, Any]:
    """An inline sub-workflow: start → work → end, end exposes ``result``."""
    return {
        "id": "body",
        "name": "Protected Body",
        "nodes": [
            {"id": "bstart", "type": "flow:start", "inputs": [], "outputs": [{"name": "seed", "type": "data"}]},
            {"id": "bwork", "type": work_type, "inputs": [{"name": "in", "type": "data"}], "outputs": [{"name": "out", "type": "data"}]},
            {"id": "bend", "type": "flow:end", "inputs": [{"name": "in", "type": "data"}], "outputs": [{"name": "result", "type": "data"}]},
        ],
        "edges": [
            {"source": "bstart", "source_port": "seed", "target": "bwork", "target_port": "in"},
            {"source": "bwork", "source_port": "out", "target": "bend", "target_port": "in"},
        ],
    }


def _finally_definition() -> dict[str, Any]:
    """An inline finally block whose work node is a ``data:convert`` marker."""
    return {
        "id": "fin",
        "name": "Finally",
        "nodes": [
            {"id": "fstart", "type": "flow:start", "inputs": [], "outputs": [{"name": "seed", "type": "data"}]},
            {"id": "fwork", "type": "data:convert", "inputs": [{"name": "in", "type": "data"}], "outputs": [{"name": "out", "type": "data"}]},
            {"id": "fend", "type": "flow:end", "inputs": [{"name": "in", "type": "data"}], "outputs": []},
        ],
        "edges": [
            {"source": "fstart", "source_port": "seed", "target": "fwork", "target_port": "in"},
            {"source": "fwork", "source_port": "out", "target": "fend", "target_port": "in"},
        ],
    }


def _try_node(*, params: dict[str, Any] | None = None) -> Node:
    merged: dict[str, Any] = {
        "subworkflow": {"type": "inline", "definition": _body_definition()},
        "mapping": {"inputs": {"seed": "in"}, "outputs": {"result": "out"}},
    }
    merged.update(params or {})
    return Node(
        id="try",
        type=NodeType.FLOW_TRY,
        params=merged,
        inputs=[Port(name="in", type=PortType.DATA)],
        outputs=[
            Port(name="out", type=PortType.DATA),
            Port(name="error", type=PortType.BOOL),
            Port(name="error_message", type=PortType.DATA),
            Port(name="error_type", type=PortType.DATA),
        ],
    )


def _start() -> Node:
    return Node(id="start", type=NodeType.FLOW_START, inputs=[], outputs=[Port(name="input", type=PortType.DATA)])


def _end() -> Node:
    return Node(id="end", type=NodeType.FLOW_END, inputs=[Port(name="in", type=PortType.DATA)], outputs=[])


def _simple_edges() -> list[Edge]:
    return [
        Edge(source="start", source_port="input", target="try", target_port="in"),
        Edge(source="try", source_port="out", target="end", target_port="in"),
    ]


def _parent_def(nodes: list[Node], edges: list[Edge]) -> WorkflowDefinition:
    return WorkflowDefinition(id="test-wf", name="Test Workflow", nodes=nodes, edges=edges)


@pytest.fixture(autouse=True)
def _isolate_cache() -> Any:
    clear_compile_cache()
    yield


def _context(body_exec: Any) -> Any:
    ctx = build_default_registry().build_context()
    ctx.executors[NodeType.DATA_ASSIGN] = body_exec
    return ctx


# ═══════════════════════════════════════════════════════════════════════════════
# Exception classification (pure)
# ═══════════════════════════════════════════════════════════════════════════════


class TestControlFlowPropagation:
    def test_graph_interrupt_always_propagates(self) -> None:
        assert _control_flow_should_propagate(GraphInterrupt(()), catch_recursion=True) is True

    def test_recursion_propagates_by_default(self) -> None:
        assert _control_flow_should_propagate(GraphRecursionError("limit"), catch_recursion=False) is True

    def test_recursion_catchable_when_opted_in(self) -> None:
        assert _control_flow_should_propagate(GraphRecursionError("limit"), catch_recursion=True) is False

    def test_ordinary_exception_is_catchable(self) -> None:
        assert _control_flow_should_propagate(ValueError("boom"), catch_recursion=False) is False


# ═══════════════════════════════════════════════════════════════════════════════
# Behaviour
# ═══════════════════════════════════════════════════════════════════════════════


class TestFlowTry:
    @pytest.mark.asyncio
    async def test_body_success_writes_out_and_error_false(self) -> None:
        graph = compile_definition(_parent_def([_start(), _try_node(), _end()], _simple_edges()), context=_context(lambda _rt, _p, i: {"out": i.get("in")}))
        state = await graph.ainvoke({"wf:start:input": "hello"})

        assert state.get("wf:try:out") == "hello"
        assert state.get("wf:try:error") is False

    @pytest.mark.asyncio
    async def test_body_failure_is_caught_not_fatal(self) -> None:
        def _boom(_rt: Any, _p: dict, _i: dict) -> dict[str, Any]:
            raise WorkflowExecutionError("node 'bwork': kaboom")

        graph = compile_definition(_parent_def([_start(), _try_node(), _end()], _simple_edges()), context=_context(_boom))
        state = await graph.ainvoke({"wf:start:input": "hello"})

        assert state.get("wf:try:error") is True
        assert state.get("wf:try:error_type") == "WorkflowExecutionError"
        assert "kaboom" in str(state.get("wf:try:error_message"))
        assert state.get("wf:try:out") is None

    @pytest.mark.asyncio
    async def test_on_error_fail_reraises(self) -> None:
        def _boom(_rt: Any, _p: dict, _i: dict) -> dict[str, Any]:
            raise WorkflowExecutionError("node 'bwork': kaboom")

        graph = compile_definition(_parent_def([_start(), _try_node(params={"on_error": "fail"}), _end()], _simple_edges()), context=_context(_boom))

        with pytest.raises(WorkflowExecutionError):
            await graph.ainvoke({"wf:start:input": "hello"})

    @pytest.mark.asyncio
    async def test_graph_interrupt_is_not_turned_into_a_caught_failure(self) -> None:
        """A human-in-the-loop suspension inside the body must escape the catch.

        LangGraph itself consumes a raised ``GraphInterrupt`` as a suspension
        (so the outer ``ainvoke`` returns rather than raising), which makes the
        observable contract here: the try must NOT convert it into a caught
        failure (``error`` stays unset).  The pure classification is pinned by
        :class:`TestControlFlowPropagation`.
        """

        def _suspend(_rt: Any, _p: dict, _i: dict) -> dict[str, Any]:
            raise GraphInterrupt(())

        graph = compile_definition(_parent_def([_start(), _try_node(), _end()], _simple_edges()), context=_context(_suspend))
        state = await graph.ainvoke({"wf:start:input": "hello"})

        assert state.get("wf:try:error") is not True
        assert state.get("wf:try:error_type") is None

    @pytest.mark.asyncio
    async def test_recursion_error_propagates_by_default(self) -> None:
        def _recursion(_rt: Any, _p: dict, _i: dict) -> dict[str, Any]:
            raise GraphRecursionError("recursion limit")

        graph = compile_definition(_parent_def([_start(), _try_node(), _end()], _simple_edges()), context=_context(_recursion))
        with pytest.raises(GraphRecursionError):
            await graph.ainvoke({"wf:start:input": "hello"})

    @pytest.mark.asyncio
    async def test_recursion_error_caught_when_opted_in(self) -> None:
        def _recursion(_rt: Any, _p: dict, _i: dict) -> dict[str, Any]:
            raise GraphRecursionError("recursion limit")

        graph = compile_definition(_parent_def([_start(), _try_node(params={"catch_recursion": True}), _end()], _simple_edges()), context=_context(_recursion))
        state = await graph.ainvoke({"wf:start:input": "hello"})
        assert state.get("wf:try:error") is True

    @pytest.mark.asyncio
    async def test_finally_runs_on_success_and_failure(self) -> None:
        ran: list[str] = []

        def _finally_marker(_rt: Any, _p: dict, _i: dict) -> dict[str, Any]:
            ran.append("finally")
            return {}

        def _body_ok(_rt: Any, _p: dict, _i: dict) -> dict[str, Any]:
            return {"out": _i.get("in")}

        def _body_fail(_rt: Any, _p: dict, _i: dict) -> dict[str, Any]:
            raise WorkflowExecutionError("boom")

        def _build(body_exec: Any) -> Any:
            ctx = build_default_registry().build_context()
            ctx.executors[NodeType.DATA_ASSIGN] = body_exec
            ctx.executors[NodeType.DATA_CONVERT] = _finally_marker
            return ctx

        nodes = [_start(), _try_node(params={"finally_subworkflow": {"type": "inline", "definition": _finally_definition()}}), _end()]

        graph_ok = compile_definition(_parent_def(nodes, _simple_edges()), context=_build(_body_ok))
        await graph_ok.ainvoke({"wf:start:input": "x"})
        assert ran == ["finally"]

        ran.clear()
        clear_compile_cache()
        graph_fail = compile_definition(_parent_def(nodes, _simple_edges()), context=_build(_body_fail))
        state = await graph_fail.ainvoke({"wf:start:input": "x"})
        assert ran == ["finally"]
        assert state.get("wf:try:error") is True

    @pytest.mark.asyncio
    async def test_missing_body_spec_is_compile_error(self) -> None:
        node = Node(id="try", type=NodeType.FLOW_TRY, params={}, inputs=[Port(name="in", type=PortType.DATA)], outputs=[Port(name="error", type=PortType.BOOL)])
        edges = [
            Edge(source="start", source_port="input", target="try", target_port="in"),
            Edge(source="try", source_port="error", target="end", target_port="in"),
        ]
        with pytest.raises(WorkflowCompileError):
            compile_definition(_parent_def([_start(), node, _end()], edges), context=build_default_registry().build_context())
