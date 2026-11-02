"""Tests for ``flow:loop`` output-port semantics in the compiled graph.

The frontend catalog declares ``iteration`` / ``out`` as the loop node's
output ports.  ``compiler._loop_node_fn`` must write both every round:

- ``wf:<loop_id>:iteration`` — the current round (count + 1), incrementing
  1, 2, 3, ... and readable by downstream nodes;
- ``wf:<loop_id>:out`` — pass-through of the loop's ``in`` input-port value
  resolved via the incoming-edge key map (upstream state key).  Missing
  upstream (producer never ran) yields ``None``, matching ``_make_node_fn``.
"""

from __future__ import annotations

from typing import Any

import pytest

from deerflow.workflow.compiler import clear_compile_cache, compile_definition
from deerflow.workflow.executors import build_default_registry
from deerflow.workflow.schema import (
    Edge,
    Node,
    NodeType,
    Port,
    PortType,
    WorkflowDefinition,
)

# ═══════════════════════════════════════════════════════════════════════════════
# Helpers (mirror test_workflow_executors.py)
# ═══════════════════════════════════════════════════════════════════════════════


def _make_def(nodes: list[Node] | None = None, edges: list[Edge] | None = None, **kwargs: Any) -> WorkflowDefinition:
    kwargs.setdefault("id", "test-wf")
    kwargs.setdefault("name", "Test Workflow")
    return WorkflowDefinition(nodes=nodes or [], edges=edges or [], **kwargs)


def _start_node(id_: str = "start") -> Node:
    return Node(id=id_, type=NodeType.FLOW_START, inputs=[], outputs=[Port(name="input", type=PortType.DATA)])


def _end_node(id_: str = "end") -> Node:
    return Node(id=id_, type=NodeType.FLOW_END, inputs=[Port(name="in", type=PortType.DATA)], outputs=[])


def _loop_node(id_: str = "loop", iterations: int = 3) -> Node:
    return Node(
        id=id_,
        type=NodeType.FLOW_LOOP,
        params={"iterations": iterations},
        inputs=[Port(name="in", type=PortType.DATA)],
        outputs=[Port(name="iteration", type=PortType.DATA), Port(name="out", type=PortType.DATA)],
    )


def _loop_node_agg(id_: str = "loop", iterations: int = 3, *, with_results: bool = True, with_last: bool = True) -> Node:
    outputs = [Port(name="iteration", type=PortType.DATA), Port(name="out", type=PortType.DATA)]
    if with_results:
        outputs.append(Port(name="results", type=PortType.ARRAY))
    if with_last:
        outputs.append(Port(name="last", type=PortType.DATA))
    return Node(
        id=id_,
        type=NodeType.FLOW_LOOP,
        params={"iterations": iterations},
        inputs=[Port(name="in", type=PortType.DATA)],
        outputs=outputs,
    )


def _data_node(id_: str) -> Node:
    return Node(id=id_, type=NodeType.DATA_ASSIGN, inputs=[Port(name="in", type=PortType.DATA)], outputs=[Port(name="out", type=PortType.DATA)])


def _no_output_exec(_rt: Any, _p: dict, _i: dict) -> dict[str, Any]:
    """Executor that produces no output port — upstream stays unset."""
    return {}


async def _run(graph: Any, initial: dict[str, Any]) -> dict[str, Any]:
    return await graph.ainvoke(initial)


@pytest.fixture(autouse=True)
def _isolate_cache() -> Any:
    clear_compile_cache()
    yield


def _make_context() -> Any:
    ctx = build_default_registry().build_context()
    return ctx


# ═══════════════════════════════════════════════════════════════════════════════
# Loop output-port semantics
# ═══════════════════════════════════════════════════════════════════════════════


class TestLoopPortOutputs:
    """``flow:loop`` writes ``iteration`` / ``out`` output ports."""

    @pytest.mark.asyncio
    async def test_iteration_increments_per_round(self) -> None:
        """Body node observes iteration 1, 2, 3 across three rounds; terminal
        state carries the final round (4 when the exit edge fires)."""
        seen_iterations: list[int] = []

        def _body_exec(_rt: Any, _p: dict, _i: dict) -> dict[str, Any]:
            seen_iterations.append(_rt.state.get("wf:loop:iteration"))
            return {"out": _i.get("in")}

        nodes = [
            _start_node(),
            _loop_node("loop", iterations=3),
            _data_node("body"),
            _end_node(),
        ]
        edges = [
            Edge(source="start", source_port="input", target="loop", target_port="in"),
            Edge(source="loop", source_port="out", target="body", target_port="in", condition="loop_body"),
            Edge(source="body", source_port="out", target="loop", target_port="in"),
            Edge(source="loop", source_port="out", target="end", target_port="in"),
        ]
        ctx = _make_context()
        ctx.executors[NodeType.DATA_ASSIGN] = _body_exec
        graph = compile_definition(_make_def(nodes, edges), context=ctx)
        state = await _run(graph, {"wf:start:input": "looping"})

        assert seen_iterations == [1, 2, 3]
        # Terminal state: last loop fn execution wrote iteration 4 (count 4).
        assert state.get("wf:loop:iteration") == 4
        assert state.get("wf:loop:__count") == 4

    @pytest.mark.asyncio
    async def test_out_passthrough_upstream_in_value(self) -> None:
        """``out`` carries the upstream ``in`` value into and out of the loop."""
        seen_in: list[Any] = []

        def _body_exec(_rt: Any, _p: dict, _i: dict) -> dict[str, Any]:
            seen_in.append(_i.get("in"))
            return {"out": len(seen_in)}

        nodes = [
            _start_node(),
            _loop_node("loop", iterations=3),
            _data_node("body"),
            _end_node(),
        ]
        edges = [
            Edge(source="start", source_port="input", target="loop", target_port="in"),
            Edge(source="loop", source_port="out", target="body", target_port="in", condition="loop_body"),
            # Back-edge: body's output feeds loop's ``in`` (dataflow ring) —
            # the last matching in-edge wins the input key map.
            Edge(source="body", source_port="out", target="loop", target_port="in"),
            Edge(source="loop", source_port="out", target="end", target_port="in"),
        ]
        ctx = _make_context()
        ctx.executors[NodeType.DATA_ASSIGN] = _body_exec
        graph = compile_definition(_make_def(nodes, edges), context=ctx)
        state = await _run(graph, {"wf:start:input": "looping"})

        # Round 1 has no body output yet (None); rounds 2-3 carry the previous
        # body output back through loop.out.
        assert seen_in == [None, 1, 2]
        # Terminal state: loop.out pass-throughs the last body output.
        assert state.get("wf:loop:out") == 3
        assert state.get("wf:loop:iteration") == 4

    @pytest.mark.asyncio
    async def test_out_passthrough_single_round_from_start(self) -> None:
        """A non-looping graph: ``out`` mirrors the upstream ``in`` value and
        ``iteration`` equals the single round (1)."""
        nodes = [
            _start_node(),
            _loop_node("loop", iterations=1),
            _end_node(),
        ]
        edges = [
            Edge(source="start", source_port="input", target="loop", target_port="in"),
            Edge(source="loop", source_port="out", target="end", target_port="in"),
        ]
        graph = compile_definition(_make_def(nodes, edges), context=_make_context())
        state = await _run(graph, {"wf:start:input": "seed-value"})

        assert state.get("wf:loop:out") == "seed-value"
        assert state.get("wf:loop:iteration") == 1
        assert state.get("wf:loop:__count") == 1

    @pytest.mark.asyncio
    async def test_results_accumulate_in_iteration_order(self) -> None:
        """C5: ``results`` collects each round's body output in order; ``last``
        is the newest entry."""

        def _body_exec(_rt: Any, _p: dict, _i: dict) -> dict[str, Any]:
            it = _rt.state.get("wf:loop:iteration")
            return {"out": f"v{it}"}

        nodes = [
            _start_node(),
            _loop_node_agg("loop", iterations=3),
            _data_node("body"),
            _end_node(),
        ]
        edges = [
            Edge(source="start", source_port="input", target="loop", target_port="in"),
            Edge(source="loop", source_port="out", target="body", target_port="in", condition="loop_body"),
            Edge(source="body", source_port="out", target="loop", target_port="in"),
            Edge(source="loop", source_port="out", target="end", target_port="in"),
        ]
        ctx = _make_context()
        ctx.executors[NodeType.DATA_ASSIGN] = _body_exec
        graph = compile_definition(_make_def(nodes, edges), context=ctx)
        state = await _run(graph, {"wf:start:input": "seed"})

        assert state.get("wf:loop:results") == ["v1", "v2", "v3"]
        assert state.get("wf:loop:last") == "v3"
        assert state.get("wf:loop:iteration") == 4

    @pytest.mark.asyncio
    async def test_results_empty_when_zero_iterations(self) -> None:
        """``iterations=0`` → no body run → ``results=[]``, ``last=None``."""
        nodes = [_start_node(), _loop_node_agg("loop", iterations=0), _end_node()]
        edges = [
            Edge(source="start", source_port="input", target="loop", target_port="in"),
            Edge(source="loop", source_port="out", target="end", target_port="in"),
        ]
        graph = compile_definition(_make_def(nodes, edges), context=_make_context())
        state = await _run(graph, {"wf:start:input": "seed"})

        assert state.get("wf:loop:results") == []
        assert state.get("wf:loop:last") is None

    @pytest.mark.asyncio
    async def test_last_only_port_still_accumulates(self) -> None:
        """A node declaring only ``last`` still sees the full history — the
        accumulation rides the reserved ``__results`` channel."""

        def _body_exec(_rt: Any, _p: dict, _i: dict) -> dict[str, Any]:
            return {"out": _rt.state.get("wf:loop:iteration")}

        nodes = [
            _start_node(),
            _loop_node_agg("loop", iterations=3, with_results=False, with_last=True),
            _data_node("body"),
            _end_node(),
        ]
        edges = [
            Edge(source="start", source_port="input", target="loop", target_port="in"),
            Edge(source="loop", source_port="out", target="body", target_port="in", condition="loop_body"),
            Edge(source="body", source_port="out", target="loop", target_port="in"),
            Edge(source="loop", source_port="out", target="end", target_port="in"),
        ]
        ctx = _make_context()
        ctx.executors[NodeType.DATA_ASSIGN] = _body_exec
        graph = compile_definition(_make_def(nodes, edges), context=ctx)
        state = await _run(graph, {"wf:start:input": "seed"})

        assert state.get("wf:loop:last") == 3
        assert state.get("wf:loop:__results") == [1, 2, 3]

    @pytest.mark.asyncio
    async def test_legacy_loop_writes_no_aggregation_channels(self) -> None:
        """A loop declaring only ``iteration``/``out`` (pre-C5) writes neither
        ``results`` nor the reserved accumulator."""
        nodes = [_start_node(), _loop_node("loop", iterations=2), _end_node()]
        edges = [
            Edge(source="start", source_port="input", target="loop", target_port="in"),
            Edge(source="loop", source_port="out", target="end", target_port="in"),
        ]
        graph = compile_definition(_make_def(nodes, edges), context=_make_context())
        state = await _run(graph, {"wf:start:input": "seed"})

        assert state.get("wf:loop:results") is None
        assert state.get("wf:loop:last") is None
        assert state.get("wf:loop:__results") is None

    @pytest.mark.asyncio
    async def test_out_none_when_upstream_produced_nothing(self) -> None:
        """Upstream node that never writes its output port → ``out`` is None
        (no error), while ``iteration`` is still written."""
        nodes = [
            _start_node(),
            _data_node("pre"),
            _loop_node("loop", iterations=1),
            _end_node(),
        ]
        edges = [
            Edge(source="start", source_port="input", target="pre", target_port="in"),
            Edge(source="pre", source_port="out", target="loop", target_port="in"),
            Edge(source="loop", source_port="out", target="end", target_port="in"),
        ]
        ctx = _make_context()
        ctx.executors[NodeType.DATA_ASSIGN] = _no_output_exec
        graph = compile_definition(_make_def(nodes, edges), context=ctx)
        state = await _run(graph, {"wf:start:input": "seed-value"})

        assert state.get("wf:loop:out") is None
        assert state.get("wf:loop:iteration") == 1
