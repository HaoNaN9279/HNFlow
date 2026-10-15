"""Tests for N13 concurrency governance.

Two independent additions to the workflow engine:

- **Fan-in merge** (``params.merge``): a node input port fed by several parallel
  branches no longer silently keeps only the last edge — the author picks
  ``overwrite`` (default) / ``array`` / ``error``.
- **Node-level resource lock** (``params.resource_lock``): a node's whole
  execution holds a cross-process N8 lock, serializing access to a shared host
  resource.
"""

from __future__ import annotations

import asyncio
from typing import Any

import pytest

from deerflow.locks.file_lock import reset_file_locks_for_tests, resource_lock
from deerflow.workflow.compiler import (
    WorkflowCompileError,
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


def _start() -> Node:
    return Node(id="start", type=NodeType.FLOW_START, inputs=[], outputs=[Port(name="input", type=PortType.DATA)])


def _end() -> Node:
    return Node(id="end", type=NodeType.FLOW_END, inputs=[Port(name="in", type=PortType.DATA)], outputs=[])


def _data_node(id_: str, type_: NodeType, *, params: dict[str, Any] | None = None, outputs: list[Port] | None = None) -> Node:
    return Node(
        id=id_,
        type=type_,
        params=params or {},
        inputs=[Port(name="in", type=PortType.DATA)],
        outputs=outputs if outputs is not None else [Port(name="out", type=PortType.DATA)],
    )


def _def(nodes: list[Node], edges: list[Edge]) -> WorkflowDefinition:
    return WorkflowDefinition(id="test-wf", name="Test Workflow", nodes=nodes, edges=edges)


@pytest.fixture(autouse=True)
def _isolate() -> Any:
    clear_compile_cache()
    reset_file_locks_for_tests()
    yield
    reset_file_locks_for_tests()


# ═══════════════════════════════════════════════════════════════════════════════
# A1 — fan-in merge
# ═══════════════════════════════════════════════════════════════════════════════


def _fan_in_graph(policy: str | None, *, a_value: Any = "A", captured: list[Any]) -> Any:
    sink_params = {} if policy is None else {"merge": {"in": policy}}
    nodes = [
        _start(),
        _data_node("a", NodeType.DATA_JSON),
        _data_node("b", NodeType.DATA_REGEX),
        _data_node("sink", NodeType.DATA_CONVERT, params=sink_params, outputs=[Port(name="out", type=PortType.DATA)]),
        _end(),
    ]
    edges = [
        Edge(source="start", source_port="input", target="a", target_port="in"),
        Edge(source="start", source_port="input", target="b", target_port="in"),
        Edge(source="a", source_port="out", target="sink", target_port="in"),
        Edge(source="b", source_port="out", target="sink", target_port="in"),
        Edge(source="sink", source_port="out", target="end", target_port="in"),
    ]

    def _sink(_rt: Any, _p: dict, i: dict) -> dict[str, Any]:
        captured.append(i.get("in"))
        return {}

    ctx = build_default_registry().build_context()
    ctx.executors[NodeType.DATA_JSON] = lambda _rt, _p, _i: {} if a_value is None else {"out": a_value}
    ctx.executors[NodeType.DATA_REGEX] = lambda _rt, _p, _i: {"out": "B"}
    ctx.executors[NodeType.DATA_CONVERT] = _sink
    return compile_definition(_def(nodes, edges), context=ctx)


class TestFanInMerge:
    @pytest.mark.asyncio
    async def test_overwrite_is_the_default_last_edge_wins(self) -> None:
        captured: list[Any] = []
        graph = _fan_in_graph(None, captured=captured)
        await graph.ainvoke({"wf:start:input": "seed"})
        assert captured == ["B"]

    @pytest.mark.asyncio
    async def test_array_collects_all_upstream_values_in_edge_order(self) -> None:
        captured: list[Any] = []
        graph = _fan_in_graph("array", captured=captured)
        await graph.ainvoke({"wf:start:input": "seed"})
        assert captured == [["A", "B"]]

    @pytest.mark.asyncio
    async def test_array_skips_a_producer_that_wrote_nothing(self) -> None:
        captured: list[Any] = []
        graph = _fan_in_graph("array", a_value=None, captured=captured)
        await graph.ainvoke({"wf:start:input": "seed"})
        assert captured == [["B"]]

    @pytest.mark.asyncio
    async def test_error_policy_raises_on_conflicting_sources(self) -> None:
        captured: list[Any] = []
        graph = _fan_in_graph("error", captured=captured)
        with pytest.raises(WorkflowExecutionError):
            await graph.ainvoke({"wf:start:input": "seed"})

    def test_merge_referencing_unknown_port_is_compile_error(self) -> None:
        nodes = [
            _start(),
            _data_node("a", NodeType.DATA_JSON),
            _data_node("sink", NodeType.DATA_CONVERT, params={"merge": {"nope": "array"}}, outputs=[Port(name="out", type=PortType.DATA)]),
            _end(),
        ]
        edges = [
            Edge(source="start", source_port="input", target="a", target_port="in"),
            Edge(source="start", source_port="input", target="sink", target_port="in"),
            Edge(source="a", source_port="out", target="sink", target_port="in"),
            Edge(source="sink", source_port="out", target="end", target_port="in"),
        ]
        with pytest.raises(WorkflowCompileError):
            compile_definition(_def(nodes, edges), context=build_default_registry().build_context())

    def test_merge_with_unknown_policy_is_compile_error(self) -> None:
        nodes = [
            _start(),
            _data_node("a", NodeType.DATA_JSON),
            _data_node("sink", NodeType.DATA_CONVERT, params={"merge": {"in": "merge-lol"}}, outputs=[Port(name="out", type=PortType.DATA)]),
            _end(),
        ]
        edges = [
            Edge(source="start", source_port="input", target="a", target_port="in"),
            Edge(source="start", source_port="input", target="sink", target_port="in"),
            Edge(source="a", source_port="out", target="sink", target_port="in"),
            Edge(source="sink", source_port="out", target="end", target_port="in"),
        ]
        with pytest.raises(WorkflowCompileError):
            compile_definition(_def(nodes, edges), context=build_default_registry().build_context())


# ═══════════════════════════════════════════════════════════════════════════════
# A2 — node-level resource lock
# ═══════════════════════════════════════════════════════════════════════════════


def _locked_pair_graph(events: list[str], *, timeout: float = 60.0) -> Any:
    async def _exec(_rt: Any, _p: dict, _i: dict) -> dict[str, Any]:
        events.append("enter")
        await asyncio.sleep(0.05)
        events.append("exit")
        return {}

    nodes = [
        _start(),
        _data_node("n1", NodeType.DATA_JSON, params={"resource_lock": "gpu", "resource_lock_timeout": timeout}),
        _data_node("n2", NodeType.DATA_REGEX, params={"resource_lock": "gpu", "resource_lock_timeout": timeout}),
        _end(),
    ]
    edges = [
        Edge(source="start", source_port="input", target="n1", target_port="in"),
        Edge(source="start", source_port="input", target="n2", target_port="in"),
        Edge(source="n1", source_port="out", target="end", target_port="in"),
        Edge(source="n2", source_port="out", target="end", target_port="in"),
    ]
    ctx = build_default_registry().build_context()
    ctx.executors[NodeType.DATA_JSON] = _exec
    ctx.executors[NodeType.DATA_REGEX] = _exec
    return compile_definition(_def(nodes, edges), context=ctx)


class TestResourceLock:
    @pytest.mark.asyncio
    async def test_same_lock_serializes_parallel_nodes(self) -> None:
        events: list[str] = []
        graph = _locked_pair_graph(events)
        await graph.ainvoke({"wf:start:input": "seed"})
        # No interleaving: each node fully enters + exits before the next starts.
        assert events == ["enter", "exit", "enter", "exit"]

    @pytest.mark.asyncio
    async def test_contended_lock_times_out_as_workflow_error(self) -> None:
        events: list[str] = []
        graph = _locked_pair_graph(events, timeout=0.2)
        with resource_lock("gpu"):  # held by this thread; the node's holder must time out
            with pytest.raises(WorkflowExecutionError):
                await graph.ainvoke({"wf:start:input": "seed"})

    def test_invalid_lock_name_is_compile_error(self) -> None:
        nodes = [
            _start(),
            _data_node("n", NodeType.DATA_JSON, params={"resource_lock": "bad/name"}),
            _end(),
        ]
        edges = [
            Edge(source="start", source_port="input", target="n", target_port="in"),
            Edge(source="n", source_port="out", target="end", target_port="in"),
        ]
        with pytest.raises(WorkflowCompileError):
            compile_definition(_def(nodes, edges), context=build_default_registry().build_context())
