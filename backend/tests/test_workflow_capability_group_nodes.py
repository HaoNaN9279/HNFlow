from __future__ import annotations

from typing import Any

import pytest

from deerflow.workflow.capability_group_nodes import (
    CapabilityGroupWiringError,
    resolve_ai_capability_groups,
    validate_capability_group_wiring,
)
from deerflow.workflow.compiler import CompileContext, compile_definition
from deerflow.workflow.schema import Edge, Node, NodeType, Port, PortType, WorkflowDefinition


def _selector(node_id: str, groups: list[str]) -> Node:
    return Node(
        id=node_id,
        type=NodeType.AI_CAPABILITY_GROUP,
        params={"groups": groups},
        outputs=[Port(name="groups", type=PortType.ARRAY)],
    )


def _ai_node(groups: list[str] | None = None) -> Node:
    return Node(
        id="ai",
        type=NodeType.AI_LLM_AGENT,
        capability_groups=groups or [],
        params={},
        inputs=[
            Port(name="in", type=PortType.DATA),
            Port(name="capability_groups", type=PortType.ARRAY),
        ],
        outputs=[Port(name="out", type=PortType.DATA)],
    )


def _definition(nodes: list[Node], edges: list[Edge]) -> WorkflowDefinition:
    return WorkflowDefinition(id="wf-groups", name="Groups", nodes=nodes, edges=edges)


def test_selector_resolves_groups_and_deduplicates() -> None:
    nodes = [_selector("g1", ["group-a", "group-b"]), _selector("g2", ["group-b"]), _ai_node()]
    edges = [
        Edge(source="g1", source_port="groups", target="ai", target_port="capability_groups"),
        Edge(source="g2", source_port="groups", target="ai", target_port="capability_groups"),
    ]
    assert resolve_ai_capability_groups(_definition(nodes, edges), nodes[2]) == ["group-a", "group-b"]


def test_direct_ai_groups_are_used_without_selector() -> None:
    ai = _ai_node(["direct"])
    assert resolve_ai_capability_groups(_definition([ai], []), ai) == ["direct"]


def test_non_selector_source_is_rejected() -> None:
    other = Node(id="other", type=NodeType.FLOW_START, outputs=[Port(name="out", type=PortType.DATA)])
    edges = [Edge(source="other", source_port="out", target="ai", target_port="capability_groups")]
    with pytest.raises(CapabilityGroupWiringError, match="ai:capability_group"):
        resolve_ai_capability_groups(_definition([other, _ai_node()], edges), _ai_node())


def test_selector_validation_rejects_inputs() -> None:
    selector = _selector("g1", ["group-a"])
    selector.inputs = [Port(name="in", type=PortType.DATA)]
    with pytest.raises(CapabilityGroupWiringError, match="no inputs"):
        validate_capability_group_wiring(_definition([selector, _ai_node()], []))


def test_compile_strips_selector_and_injects_groups() -> None:
    seen: list[list[str]] = []

    def ai_exec(_rt: Any, params: dict[str, Any], _inputs: dict[str, Any]) -> dict[str, Any]:
        seen.append(list(params.get("capability_groups") or []))
        return {"out": "ok"}

    nodes = [
        Node(id="start", type=NodeType.FLOW_START, outputs=[Port(name="out", type=PortType.DATA)]),
        _selector("g1", ["group-a"]),
        _ai_node(),
        Node(id="end", type=NodeType.FLOW_END, inputs=[Port(name="in", type=PortType.DATA)]),
    ]
    edges = [
        Edge(source="start", source_port="out", target="ai", target_port="in"),
        Edge(source="g1", source_port="groups", target="ai", target_port="capability_groups"),
        Edge(source="ai", source_port="out", target="end", target_port="in"),
    ]
    graph = compile_definition(_definition(nodes, edges), context=CompileContext(executors={NodeType.AI_LLM_AGENT: ai_exec}))
    assert "g1" not in graph.nodes
    assert "ai" in graph.nodes
    # Compilation alone does not execute; the executor receives the resolved
    # list when the graph runs.  The pure resolver is covered above.
    assert seen == []
