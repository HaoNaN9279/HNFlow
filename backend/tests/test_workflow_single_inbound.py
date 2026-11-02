"""Single-inbound input port validation."""

from __future__ import annotations

from deerflow.workflow.schema import Edge, Node, NodeType, Port, PortType, WorkflowDefinition
from deerflow.workflow.workflow_io import validate_definition


def _port(name: str) -> Port:
    return Port(name=name, type=PortType.DATA)


def _definition(target_type: NodeType, *, second_source: str = "b") -> WorkflowDefinition:
    nodes = [
        Node(id="start", type=NodeType.FLOW_START, outputs=[_port("out")]),
        Node(id="a", type=NodeType.DATA_ASSIGN, outputs=[_port("out")]),
        Node(id="b", type=NodeType.DATA_ASSIGN, outputs=[_port("out")]),
        Node(id="target", type=target_type, inputs=[_port("in")], outputs=[_port("out")]),
        Node(id="end", type=NodeType.FLOW_END, inputs=[_port("in")]),
    ]
    edges = [
        Edge(source="a", source_port="out", target="target", target_port="in"),
        Edge(source=second_source, source_port="out", target="target", target_port="in"),
        Edge(source="target", source_port="out", target="end", target_port="in"),
    ]
    if target_type == NodeType.FLOW_LOOP:
        edges.append(Edge(source="target", source_port="out", target="target", target_port="in"))
    return WorkflowDefinition(id="wf", name="wf", nodes=nodes, edges=edges)


def test_duplicate_input_port_is_rejected() -> None:
    errors = validate_definition(_definition(NodeType.DATA_ASSIGN))
    assert any("already has an incoming edge" in error for error in errors)


def test_end_and_loop_ports_are_exempt() -> None:
    assert not any("already has an incoming edge" in error for error in validate_definition(_definition(NodeType.FLOW_END)))
    assert not any("already has an incoming edge" in error for error in validate_definition(_definition(NodeType.FLOW_LOOP)))
