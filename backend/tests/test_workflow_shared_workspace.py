"""Tests for the N14 shared workspace (blackboard) - ``data:shared`` + ``wf:shared:*``.

A shared variable is a workflow-level channel read/written by several nodes.
Its write policy lives in ``metadata.shared``: ``overwrite`` (default),
``array`` (parallel appends merge via a reducer), or ``conflict``.
"""

from __future__ import annotations

from typing import Any

import pytest

from deerflow.workflow.compiler import (
    WorkflowCompileError,
    clear_compile_cache,
    compile_definition,
)
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
# Helpers
# ═══════════════════════════════════════════════════════════════════════════════


def _start() -> Node:
    return Node(id="start", type=NodeType.FLOW_START, inputs=[], outputs=[Port(name="input", type=PortType.DATA)])


def _end() -> Node:
    return Node(id="end", type=NodeType.FLOW_END, inputs=[Port(name="in", type=PortType.DATA)], outputs=[])


def _shared(id_: str, *, operation: str, name: str, value: Any = None) -> Node:
    params: dict[str, Any] = {"operation": operation, "name": name}
    if value is not None:
        params["value"] = value
    return Node(
        id=id_,
        type=NodeType.DATA_SHARED,
        params=params,
        inputs=[Port(name="in", type=PortType.DATA)],
        outputs=[Port(name="out", type=PortType.DATA)],
    )


def _def(nodes: list[Node], edges: list[Edge], *, shared: dict[str, str] | None = None) -> WorkflowDefinition:
    metadata = {"shared": shared} if shared is not None else {}
    return WorkflowDefinition(id="test-wf", name="Test Workflow", nodes=nodes, edges=edges, metadata=metadata)


@pytest.fixture(autouse=True)
def _isolate() -> Any:
    clear_compile_cache()
    yield


def _ctx() -> Any:
    return build_default_registry().build_context()


# ═══════════════════════════════════════════════════════════════════════════════
# Behaviour
# ═══════════════════════════════════════════════════════════════════════════════


class TestSharedWorkspace:
    @pytest.mark.asyncio
    async def test_write_then_read_roundtrip(self) -> None:
        nodes = [
            _start(),
            _shared("w", operation="write", name="log"),
            _shared("r", operation="read", name="log"),
            _end(),
        ]
        edges = [
            Edge(source="start", source_port="input", target="w", target_port="in"),
            Edge(source="w", source_port="out", target="r", target_port="in"),
            Edge(source="r", source_port="out", target="end", target_port="in"),
        ]
        graph = compile_definition(_def(nodes, edges), context=_ctx())
        state = await graph.ainvoke({"wf:start:input": "hello"})

        assert state.get("wf:shared:log") == "hello"
        assert state.get("wf:r:out") == "hello"

    @pytest.mark.asyncio
    async def test_read_uninitialized_is_none(self) -> None:
        nodes = [_start(), _shared("r", operation="read", name="log"), _end()]
        edges = [
            Edge(source="start", source_port="input", target="r", target_port="in"),
            Edge(source="r", source_port="out", target="end", target_port="in"),
        ]
        graph = compile_definition(_def(nodes, edges), context=_ctx())
        state = await graph.ainvoke({"wf:start:input": "seed"})
        assert state.get("wf:r:out") is None

    @pytest.mark.asyncio
    async def test_array_policy_merges_parallel_appends(self) -> None:
        nodes = [
            _start(),
            _shared("a1", operation="append", name="acc", value="A"),
            _shared("a2", operation="append", name="acc", value="B"),
            _end(),
        ]
        edges = [
            Edge(source="start", source_port="input", target="a1", target_port="in"),
            Edge(source="start", source_port="input", target="a2", target_port="in"),
            Edge(source="a1", source_port="out", target="end", target_port="in"),
            Edge(source="a2", source_port="out", target="end", target_port="in"),
        ]
        graph = compile_definition(_def(nodes, edges, shared={"acc": "array"}), context=_ctx())
        state = await graph.ainvoke({"wf:start:input": "seed"})

        merged = state.get("wf:shared:acc")
        assert isinstance(merged, list)
        assert sorted(merged) == ["A", "B"]

    @pytest.mark.asyncio
    async def test_overwrite_is_last_write_wins_across_steps(self) -> None:
        nodes = [
            _start(),
            _shared("w1", operation="write", name="x", value=1),
            _shared("w2", operation="write", name="x", value=2),
            _end(),
        ]
        edges = [
            Edge(source="start", source_port="input", target="w1", target_port="in"),
            Edge(source="w1", source_port="out", target="w2", target_port="in"),
            Edge(source="w2", source_port="out", target="end", target_port="in"),
        ]
        graph = compile_definition(_def(nodes, edges), context=_ctx())
        state = await graph.ainvoke({"wf:start:input": "seed"})
        assert state.get("wf:shared:x") == 2

    @pytest.mark.asyncio
    async def test_overwrite_conflicts_on_parallel_same_step_write(self) -> None:
        nodes = [
            _start(),
            _shared("w1", operation="write", name="x", value=1),
            _shared("w2", operation="write", name="x", value=2),
            _end(),
        ]
        edges = [
            Edge(source="start", source_port="input", target="w1", target_port="in"),
            Edge(source="start", source_port="input", target="w2", target_port="in"),
            Edge(source="w1", source_port="out", target="end", target_port="in"),
            Edge(source="w2", source_port="out", target="end", target_port="in"),
        ]
        graph = compile_definition(_def(nodes, edges), context=_ctx())
        with pytest.raises(Exception):  # LangGraph InvalidUpdateError on conflicting same-step writes
            await graph.ainvoke({"wf:start:input": "seed"})


class TestSharedValidation:
    def test_invalid_operation_is_compile_error(self) -> None:
        nodes = [_start(), _shared("s", operation="merge", name="x"), _end()]
        edges = [
            Edge(source="start", source_port="input", target="s", target_port="in"),
            Edge(source="s", source_port="out", target="end", target_port="in"),
        ]
        with pytest.raises(WorkflowCompileError):
            compile_definition(_def(nodes, edges), context=_ctx())

    def test_invalid_name_is_compile_error(self) -> None:
        nodes = [_start(), _shared("s", operation="write", name="bad name"), _end()]
        edges = [
            Edge(source="start", source_port="input", target="s", target_port="in"),
            Edge(source="s", source_port="out", target="end", target_port="in"),
        ]
        with pytest.raises(WorkflowCompileError):
            compile_definition(_def(nodes, edges), context=_ctx())

    def test_invalid_metadata_policy_is_compile_error(self) -> None:
        nodes = [_start(), _shared("s", operation="append", name="acc"), _end()]
        edges = [
            Edge(source="start", source_port="input", target="s", target_port="in"),
            Edge(source="s", source_port="out", target="end", target_port="in"),
        ]
        with pytest.raises(WorkflowCompileError):
            compile_definition(_def(nodes, edges, shared={"acc": "lol"}), context=_ctx())
