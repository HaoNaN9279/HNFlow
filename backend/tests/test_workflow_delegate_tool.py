"""Tests for the ``invoke_workflow`` delegation tool factory (T10-3).

Covers:
- Building the tool around a compiled child subgraph and executing it
- Missing child input ports degrade to ``None`` without crashing
- Child node failures surface as an error string (not an exception)
- Tool name and args schema expose ``template_id`` / ``inputs``
"""

from __future__ import annotations

from typing import Any

import pytest

from deerflow.workflow.compiler import CompileContext, clear_compile_cache, compile_definition
from deerflow.workflow.delegate import build_invoke_workflow_tool
from deerflow.workflow.executors import WorkflowExecutionError, exec_assign
from deerflow.workflow.schema import Edge, Node, NodeType, Port, PortType, WorkflowDefinition

# ═══════════════════════════════════════════════════════════════════════════════
# Helpers (minimal copies from test_workflow_subgraph.py — test files do not
# share imports to avoid coupling)
# ═══════════════════════════════════════════════════════════════════════════════


def _make_def(nodes: list[Node] | None = None, edges: list[Edge] | None = None, **kwargs: Any) -> WorkflowDefinition:
    kwargs.setdefault("id", "test-wf")
    kwargs.setdefault("name", "Test Workflow")
    return WorkflowDefinition(nodes=nodes or [], edges=edges or [], **kwargs)


def _child_def(*, child_id: str = "child") -> WorkflowDefinition:
    """Build a minimal child subgraph ``cstart → cassign → cend`` (passthrough)."""
    return _make_def(
        nodes=[
            Node(id="cstart", type=NodeType.FLOW_START, inputs=[], outputs=[Port(name="in", type=PortType.DATA)]),
            Node(id="cassign", type=NodeType.DATA_ASSIGN, params={}, inputs=[Port(name="in", type=PortType.DATA)], outputs=[Port(name="out", type=PortType.DATA)]),
            Node(id="cend", type=NodeType.FLOW_END, inputs=[Port(name="in", type=PortType.DATA)], outputs=[Port(name="result", type=PortType.DATA)]),
        ],
        edges=[
            Edge(source="cstart", source_port="in", target="cassign", target_port="in"),
            Edge(source="cassign", source_port="out", target="cend", target_port="in"),
        ],
        id=child_id,
        name=child_id,
    )


def _build_tool(executors: dict[NodeType, Any]) -> Any:
    """Compile the child graph and build the tool around it."""
    child = _child_def()
    ctx = CompileContext(executors=executors)
    graph = compile_definition(child, context=ctx)
    return build_invoke_workflow_tool(graph, child, "cstart", "cend")


# ═══════════════════════════════════════════════════════════════════════════════
# Fixture: isolate cache per test
# ═══════════════════════════════════════════════════════════════════════════════


@pytest.fixture(autouse=True)
def _isolate_cache() -> Any:
    clear_compile_cache()
    yield


# ═══════════════════════════════════════════════════════════════════════════════
# Tests
# ═══════════════════════════════════════════════════════════════════════════════


@pytest.mark.asyncio
async def test_tool_returns_child_outputs() -> None:
    """Child passthrough forwards the caller value back under the child end port name."""
    tool = _build_tool({NodeType.DATA_ASSIGN: exec_assign})
    result = await tool.ainvoke({"template_id": "wf-child", "inputs": {"in": "hello"}})
    assert result == {"result": "hello"}


@pytest.mark.asyncio
async def test_tool_missing_child_port_returns_none() -> None:
    """An empty inputs dict degrades to a ``None`` output without crashing."""
    tool = _build_tool({NodeType.DATA_ASSIGN: exec_assign})
    result = await tool.ainvoke({"template_id": "wf-child", "inputs": {}})
    assert isinstance(result, dict)
    assert result.get("result") is None


@pytest.mark.asyncio
async def test_tool_child_error_surfaces() -> None:
    """A failing child node returns an error string carrying the node path, not a raise."""

    def _explode(_rt: Any, _p: dict, _i: dict) -> dict[str, Any]:
        raise WorkflowExecutionError("cassign > boom")

    tool = _build_tool({NodeType.DATA_ASSIGN: _explode})
    result = await tool.ainvoke({"template_id": "wf-child", "inputs": {"in": "hello"}})
    assert isinstance(result, str)
    assert "cassign" in result
    assert "boom" in result


def test_tool_name_and_schema() -> None:
    """The tool is named ``invoke_workflow`` and exposes ``template_id`` / ``inputs``."""
    tool = _build_tool({NodeType.DATA_ASSIGN: exec_assign})
    assert tool.name == "invoke_workflow"
    assert "Execute the bound sub-workflow" in tool.description
    assert tool.args_schema is not None
    fields = set(tool.args_schema.model_fields.keys())
    assert {"template_id", "inputs"} <= fields
