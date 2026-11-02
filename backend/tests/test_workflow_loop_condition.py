"""Tests for the C5 data-driven loop exit (``flow:loop`` ``params.continue_on``).

``continue_on`` names a source-port on one of the loop's incoming edges; the
loop reads ``wf:<source>:<port>`` and exits early when that value is falsy.
The check only applies from round 2 on, an *absent* key means "keep looping",
and ``iterations`` stays a hard ceiling regardless — so a signal the body has
not produced yet, or a ``continue_on`` naming no edge, cannot cut a loop short.
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


def _make_def(nodes: list[Node], edges: list[Edge]) -> WorkflowDefinition:
    return WorkflowDefinition(id="test-wf", name="Test Workflow", nodes=nodes, edges=edges)


def _start_node() -> Node:
    return Node(id="start", type=NodeType.FLOW_START, inputs=[], outputs=[Port(name="input", type=PortType.DATA)])


def _end_node() -> Node:
    return Node(id="end", type=NodeType.FLOW_END, inputs=[Port(name="in", type=PortType.DATA)], outputs=[])


def _loop_node(iterations: int, continue_on: str) -> Node:
    return Node(
        id="loop",
        type=NodeType.FLOW_LOOP,
        params={"iterations": iterations, "continue_on": continue_on},
        inputs=[Port(name="in", type=PortType.DATA)],
        outputs=[
            Port(name="iteration", type=PortType.DATA),
            Port(name="out", type=PortType.DATA),
            Port(name="results", type=PortType.ARRAY),
            Port(name="last", type=PortType.DATA),
        ],
    )


def _body_node(*, extra_ports: tuple[str, ...] = ()) -> Node:
    outputs = [Port(name="out", type=PortType.DATA)]
    outputs.extend(Port(name=p, type=PortType.DATA) for p in extra_ports)
    return Node(id="body", type=NodeType.DATA_ASSIGN, inputs=[Port(name="in", type=PortType.DATA)], outputs=outputs)


@pytest.fixture(autouse=True)
def _isolate_cache() -> Any:
    clear_compile_cache()
    yield


async def _run_loop(*, iterations: int, continue_on: str, body_exec: Any, extra_ports: tuple[str, ...] = (), back_port: str = "out") -> dict[str, Any]:
    ctx = build_default_registry().build_context()
    ctx.executors[NodeType.DATA_ASSIGN] = body_exec
    nodes = [_start_node(), _loop_node(iterations, continue_on), _body_node(extra_ports=extra_ports), _end_node()]
    edges = [
        Edge(source="start", source_port="input", target="loop", target_port="in"),
        Edge(source="loop", source_port="out", target="body", target_port="in", condition="loop_body"),
        Edge(source="body", source_port=back_port, target="loop", target_port="in"),
        Edge(source="loop", source_port="out", target="end", target_port="in"),
    ]
    graph = compile_definition(_make_def(nodes, edges), context=ctx)
    return await graph.ainvoke({"wf:start:input": "seed"})


class TestLoopContinueOn:
    @pytest.mark.asyncio
    async def test_exits_when_body_signal_becomes_falsy(self) -> None:
        runs: list[Any] = []

        def _body(rt: Any, _p: dict, _i: dict) -> dict[str, Any]:
            it = rt.state.get("wf:loop:iteration")
            runs.append(it)
            return {"out": 1 if it < 3 else 0}

        # iterations=10 is a ceiling the falsy signal beats at round 4.
        state = await _run_loop(iterations=10, continue_on="out", body_exec=_body)

        assert runs == [1, 2, 3]
        assert state.get("wf:loop:iteration") == 4
        assert state.get("wf:loop:results") == [1, 1, 0]
        assert state.get("wf:loop:last") == 0

    @pytest.mark.asyncio
    async def test_iterations_is_still_a_hard_ceiling(self) -> None:
        runs: list[Any] = []

        def _body(rt: Any, _p: dict, _i: dict) -> dict[str, Any]:
            runs.append(rt.state.get("wf:loop:iteration"))
            return {"out": 1}  # always truthy — must stop at the ceiling

        state = await _run_loop(iterations=2, continue_on="out", body_exec=_body)

        assert runs == [1, 2]
        assert state.get("wf:loop:iteration") == 3

    @pytest.mark.asyncio
    async def test_continue_on_naming_no_edge_is_count_only(self) -> None:
        runs: list[Any] = []

        def _body(rt: Any, _p: dict, _i: dict) -> dict[str, Any]:
            runs.append(rt.state.get("wf:loop:iteration"))
            return {"out": 1}

        state = await _run_loop(iterations=2, continue_on="does-not-exist", body_exec=_body)

        assert runs == [1, 2]
        assert state.get("wf:loop:iteration") == 3

    @pytest.mark.asyncio
    async def test_absent_signal_keeps_looping(self) -> None:
        """``continue_on`` targets a real back-edge port the body never writes —
        the absent key must not stop the loop before the ceiling."""
        runs: list[Any] = []

        def _body(rt: Any, _p: dict, _i: dict) -> dict[str, Any]:
            runs.append(rt.state.get("wf:loop:iteration"))
            return {"out": 1}  # never writes the ``signal`` port

        state = await _run_loop(iterations=2, continue_on="signal", body_exec=_body, extra_ports=("signal",), back_port="signal")

        assert runs == [1, 2]
        assert state.get("wf:loop:iteration") == 3
