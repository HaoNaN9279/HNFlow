"""Tests for §24.6a controlled dynamic handoff (``flow:handoff``).

A supervisor picks an expert at run time from a whitelist of nodes registered in
the definition, under a run budget.  The interesting failures are the *silent*
ones a switch would allow — an unlisted selection, a candidate that does not
exist, a drawn edge competing with the param routing — so most of these pin
fail-loud behaviour rather than the happy path.
"""

from __future__ import annotations

import asyncio
from typing import Any

import pytest

from deerflow.workflow.compiler import (
    CompileContext,
    WorkflowCompileError,
    WorkflowRuntime,
    clear_compile_cache,
    compile_definition,
)
from deerflow.workflow.executors import build_default_registry, exec_handoff
from deerflow.workflow.handoff import (
    DECISION_PORT,
    DEFAULT_MAX_HANDOFFS,
    HANDOFF_COUNT_CHANNEL,
    MAX_HANDOFFS_CEILING,
    TARGET_PORT,
    HandoffError,
    handoff_count_key,
    parse_handoff,
    resolve_handoff_target,
)
from deerflow.workflow.registry import WorkflowExecutionError
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


# ── 1. declaration parsing ───────────────────────────────────────────────────


def _params(**overrides: Any) -> dict[str, Any]:
    params: dict[str, Any] = {
        "candidates": [
            {"value": "blender", "node": "fix_blender"},
            {"value": "unity", "node": "fix_unity"},
        ]
    }
    params.update(overrides)
    return params


class TestParseHandoff:
    def test_parses_candidates_and_default_budget(self) -> None:
        spec = parse_handoff(_params())
        assert spec.values() == ("blender", "unity")
        assert spec.targets() == ("fix_blender", "fix_unity")
        assert spec.max_handoffs == DEFAULT_MAX_HANDOFFS

    def test_dedupes_targets_but_keeps_values(self) -> None:
        spec = parse_handoff(_params(candidates=[{"value": "a", "node": "x"}, {"value": "b", "node": "x"}]))
        assert spec.values() == ("a", "b")
        assert spec.targets() == ("x",)

    def test_rejects_a_missing_or_empty_candidate_list(self) -> None:
        with pytest.raises(HandoffError, match="non-empty 'candidates'"):
            parse_handoff({})
        with pytest.raises(HandoffError, match="non-empty 'candidates'"):
            parse_handoff({"candidates": []})
        with pytest.raises(HandoffError, match="non-empty 'candidates'"):
            parse_handoff({"candidates": "blender"})

    def test_rejects_malformed_entries(self) -> None:
        with pytest.raises(HandoffError, match="must be a mapping"):
            parse_handoff(_params(candidates=["blender"]))
        with pytest.raises(HandoffError, match="non-empty string 'value'"):
            parse_handoff(_params(candidates=[{"node": "x"}]))
        with pytest.raises(HandoffError, match="non-empty string 'node'"):
            parse_handoff(_params(candidates=[{"value": "a"}]))

    def test_rejects_duplicate_values(self) -> None:
        # A duplicate value would make the route order-dependent, which is
        # exactly the ambiguity a whitelist is supposed to remove.
        with pytest.raises(HandoffError, match="declared twice"):
            parse_handoff(_params(candidates=[{"value": "a", "node": "x"}, {"value": "a", "node": "y"}]))

    def test_budget_must_be_a_bounded_integer(self) -> None:
        assert parse_handoff(_params(max_handoffs=1)).max_handoffs == 1
        assert parse_handoff(_params(max_handoffs=MAX_HANDOFFS_CEILING)).max_handoffs == MAX_HANDOFFS_CEILING
        for bad in (0, -1, MAX_HANDOFFS_CEILING + 1):
            with pytest.raises(HandoffError, match="between 1 and"):
                parse_handoff(_params(max_handoffs=bad))
        for bad in ("8", 2.5, True, None):
            with pytest.raises(HandoffError, match="must be an integer"):
                parse_handoff(_params(max_handoffs=bad))


class TestResolveTarget:
    def test_maps_a_declared_value(self) -> None:
        spec = parse_handoff(_params())
        assert resolve_handoff_target(spec, "unity") == "fix_unity"

    def test_rejects_an_unregistered_selection(self) -> None:
        spec = parse_handoff(_params())
        with pytest.raises(HandoffError, match="not a registered expert") as excinfo:
            resolve_handoff_target(spec, "photoshop")
        # The failure names the allowed values so the model that picked can act.
        assert "'blender'" in str(excinfo.value)
        assert "'unity'" in str(excinfo.value)

    def test_rejects_a_missing_selection(self) -> None:
        spec = parse_handoff(_params())
        for empty in (None, "", 7):
            with pytest.raises(HandoffError, match="non-empty string selection"):
                resolve_handoff_target(spec, empty)


# ── 2. executor ──────────────────────────────────────────────────────────────


def _runtime(state: dict[str, Any] | None = None) -> WorkflowRuntime:
    return WorkflowRuntime(state=state or {})


class TestExecHandoff:
    def test_resolves_the_target_and_forwards_the_message(self) -> None:
        outputs = exec_handoff(
            _runtime(),
            _params(node_id="route"),
            {DECISION_PORT: "unity", "task": "fix the light", "context": ["asset://host/a.fbx"]},
        )
        assert outputs[TARGET_PORT] == "fix_unity"
        # Every declared input except the selection rides along: that is how a
        # handoff carries its structured message (task / constraints / context).
        assert outputs["task"] == "fix the light"
        assert outputs["context"] == ["asset://host/a.fbx"]
        assert outputs[HANDOFF_COUNT_CHANNEL] == 1

    def test_counts_handoffs_across_visits(self) -> None:
        params = _params(node_id="route")
        first = exec_handoff(_runtime(), params, {DECISION_PORT: "blender"})
        state = {handoff_count_key("route"): first[HANDOFF_COUNT_CHANNEL]}
        second = exec_handoff(_runtime(state), params, {DECISION_PORT: "blender"})
        assert second[HANDOFF_COUNT_CHANNEL] == 2

    def test_fails_once_the_budget_is_exhausted(self) -> None:
        params = _params(node_id="route", max_handoffs=2)
        state = {handoff_count_key("route"): 2}
        with pytest.raises(WorkflowExecutionError, match="handoff budget exhausted") as excinfo:
            exec_handoff(_runtime(state), params, {DECISION_PORT: "blender"})
        # The message names the knob to change, not just the symptom.
        assert "max_handoffs" in str(excinfo.value)

    def test_an_unregistered_selection_is_an_execution_error(self) -> None:
        with pytest.raises(HandoffError, match="not a registered expert"):
            exec_handoff(_runtime(), _params(node_id="route"), {DECISION_PORT: "maya"})

    def test_requires_the_compiler_injected_node_id(self) -> None:
        # Refuse rather than run with an unenforceable budget: no node id means
        # no counter, and a silently unbounded handoff is worse than a failure.
        with pytest.raises(WorkflowExecutionError, match="requires a 'node_id'"):
            exec_handoff(_runtime(), _params(), {DECISION_PORT: "blender"})

    def test_ignores_a_corrupt_counter_value(self) -> None:
        params = _params(node_id="route", max_handoffs=3)
        outputs = exec_handoff(_runtime({handoff_count_key("route"): "many"}), params, {DECISION_PORT: "blender"})
        assert outputs[HANDOFF_COUNT_CHANNEL] == 1


# ── 3. definition shapes ─────────────────────────────────────────────────────


def _handoff_node(node_id: str = "route", **params: Any) -> Node:
    return Node(
        id=node_id,
        type=NodeType.FLOW_HANDOFF,
        params=_params(node_id=node_id, **params),
        inputs=[Port(name=DECISION_PORT, type=PortType.DATA), Port(name="task", type=PortType.DATA)],
        outputs=[Port(name=TARGET_PORT, type=PortType.DATA), Port(name="task", type=PortType.DATA)],
    )


def _expert(node_id: str) -> Node:
    return Node(
        id=node_id,
        type=NodeType.DATA_ASSIGN,
        params={"value": node_id},
        inputs=[Port(name="in", type=PortType.DATA)],
        outputs=[Port(name="out", type=PortType.DATA)],
    )


def _definition(*, handoff: Node | None = None, edges: list[Edge] | None = None) -> WorkflowDefinition:
    route = handoff or _handoff_node()
    nodes = [
        Node(id="start", type=NodeType.FLOW_START, inputs=[], outputs=[Port(name="out", type=PortType.DATA)]),
        route,
        _expert("fix_blender"),
        _expert("fix_unity"),
        Node(id="end", type=NodeType.FLOW_END, inputs=[Port(name="in", type=PortType.DATA)], outputs=[]),
    ]
    default_edges = [
        Edge(source="start", source_port="out", target=route.id, target_port=DECISION_PORT),
        Edge(source="fix_blender", source_port="out", target="end", target_port="in"),
        Edge(source="fix_unity", source_port="out", target="end", target_port="in"),
    ]
    return WorkflowDefinition(id="wf-handoff", name="Handoff", nodes=nodes, edges=edges if edges is not None else default_edges)


def _context(**executors: Any) -> CompileContext:
    ctx = build_default_registry().build_context()
    ctx.checkpointer = InMemorySaver()
    ctx.executors.update(executors)
    return ctx


def _compile(def_: WorkflowDefinition, ctx: CompileContext | None = None) -> Any:
    return compile_definition(def_, context=ctx or _context())


class TestCompileValidation:
    def test_compiles_a_valid_handoff(self) -> None:
        graph = _compile(_definition())
        assert graph is not None

    def test_rejects_an_unknown_candidate_node(self) -> None:
        node = _handoff_node(candidates=[{"value": "blender", "node": "ghost"}])
        with pytest.raises(WorkflowCompileError, match="targets unknown node 'ghost'"):
            _compile(_definition(handoff=node))

    def test_rejects_self_and_sentinel_targets(self) -> None:
        with pytest.raises(WorkflowCompileError, match="targets the handoff itself"):
            _compile(_definition(handoff=_handoff_node(candidates=[{"value": "a", "node": "route"}])))
        with pytest.raises(WorkflowCompileError, match="gate completion with a separate 'flow:if'"):
            _compile(_definition(handoff=_handoff_node(candidates=[{"value": "a", "node": "end"}])))

    def test_rejects_a_bad_declaration(self) -> None:
        node = _handoff_node(candidates=[])
        with pytest.raises(WorkflowCompileError, match="non-empty 'candidates'"):
            _compile(_definition(handoff=node))

    def test_requires_the_decision_input_and_target_output(self) -> None:
        no_decision = Node(
            id="route",
            type=NodeType.FLOW_HANDOFF,
            params=_params(),
            inputs=[Port(name="task", type=PortType.DATA)],
            outputs=[Port(name=TARGET_PORT, type=PortType.DATA)],
        )
        # The start edge feeds the surviving port, so the *generic* edge
        # validation passes and the handoff's own contract is what rejects it.
        wired = _definition(handoff=no_decision)
        for edge in wired.edges:
            if edge.target == "route":
                edge.target_port = "task"
        with pytest.raises(WorkflowCompileError, match="input port named 'decision'"):
            _compile(wired)

        no_target = Node(
            id="route",
            type=NodeType.FLOW_HANDOFF,
            params=_params(),
            inputs=[Port(name=DECISION_PORT, type=PortType.DATA)],
            outputs=[Port(name="task", type=PortType.DATA)],
        )
        with pytest.raises(WorkflowCompileError, match="output port named 'target'"):
            _compile(_definition(handoff=no_target))

    def test_rejects_edges_from_the_handoff(self) -> None:
        # Params are the single source of routing truth; a drawn edge would be a
        # second, conflicting route.
        edges = [
            Edge(source="start", source_port="out", target="route", target_port=DECISION_PORT),
            Edge(source="route", source_port=TARGET_PORT, target="fix_unity", target_port="in"),
            Edge(source="fix_unity", source_port="out", target="end", target_port="in"),
        ]
        with pytest.raises(WorkflowCompileError, match="must be removed"):
            _compile(_definition(edges=edges))

    def test_handoff_params_are_rejected_on_other_node_types(self) -> None:
        def_ = _definition()
        for node in def_.nodes:
            if node.id == "fix_unity":
                node.params = {"value": "x", "max_handoffs": 3}
        with pytest.raises(WorkflowCompileError, match="only supported on 'flow:handoff'"):
            _compile(def_)


# ── 4. end-to-end routing ────────────────────────────────────────────────────


def _routing_definition(decision: str = "unity", **params: Any) -> WorkflowDefinition:
    """A start → assign(decision) → handoff → expert → end graph."""
    decider = Node(
        id="decide",
        type=NodeType.DATA_ASSIGN,
        params={"value": decision},
        inputs=[Port(name="in", type=PortType.DATA)],
        outputs=[Port(name="out", type=PortType.DATA), Port(name="task", type=PortType.DATA)],
    )
    route = _handoff_node(**params)
    nodes = [
        Node(id="start", type=NodeType.FLOW_START, inputs=[], outputs=[Port(name="out", type=PortType.DATA)]),
        decider,
        route,
        _expert("fix_blender"),
        _expert("fix_unity"),
        Node(id="end", type=NodeType.FLOW_END, inputs=[Port(name="in", type=PortType.DATA)], outputs=[]),
    ]
    edges = [
        Edge(source="start", source_port="out", target="decide", target_port="in"),
        Edge(source="decide", source_port="out", target="route", target_port=DECISION_PORT),
        Edge(source="decide", source_port="task", target="route", target_port="task"),
        Edge(source="fix_blender", source_port="out", target="end", target_port="in"),
        Edge(source="fix_unity", source_port="out", target="end", target_port="in"),
    ]
    return WorkflowDefinition(id="wf-handoff-run", name="Handoff run", nodes=nodes, edges=edges)


class TestEndToEnd:
    def test_routes_to_the_selected_expert_only(self) -> None:
        seen: list[str] = []

        async def _assign(_runtime: Any, params: dict, inputs: dict) -> dict:
            seen.append(str(params.get("value")))
            return {"out": params.get("value"), "task": f"task:{params.get('value')}"}

        graph = _compile(_routing_definition("unity"), _context(**{NodeType.DATA_ASSIGN: _assign}))
        final = asyncio.run(graph.ainvoke({}, {"configurable": {"thread_id": "t-route"}}))

        assert seen == ["unity", "fix_unity"]
        assert final["wf:route:target"] == "fix_unity"
        assert final["wf:route:__handoffs"] == 1

    def test_an_unregistered_selection_fails_the_run(self) -> None:
        async def _assign(_runtime: Any, params: dict, inputs: dict) -> dict:
            return {"out": params.get("value"), "task": "t"}

        graph = _compile(_routing_definition("maya"), _context(**{NodeType.DATA_ASSIGN: _assign}))
        with pytest.raises(HandoffError, match="not a registered expert"):
            asyncio.run(graph.ainvoke({}, {"configurable": {"thread_id": "t-bad"}}))
