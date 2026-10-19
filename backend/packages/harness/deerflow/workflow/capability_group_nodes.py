"""Compile-time capability-group selector wiring.

An ``ai:capability_group`` node is an authoring construct: it records one or
more capability-group GUIDs/names and feeds an AI node's ``capability_groups``
input port. It is not a runtime node, so the compiler resolves the selection
statically and removes the selector and its edge from the executable graph.
"""

from __future__ import annotations

from collections.abc import Iterable

from deerflow.workflow.schema import Node, NodeType, WorkflowDefinition

CAPABILITY_GROUPS_PORT = "capability_groups"
CAPABILITY_GROUPS_OUTPUT = "groups"


class CapabilityGroupWiringError(ValueError):
    """A capability-group selector edge/params shape the compiler cannot resolve."""


def is_capability_group_node(node: Node) -> bool:
    return node.type == NodeType.AI_CAPABILITY_GROUP


def normalize_group_selection(value: object) -> list[str]:
    """Normalize a selector payload into ordered, deduplicated group references."""
    if isinstance(value, str):
        values: Iterable[object] = [value]
    elif isinstance(value, Iterable) and not isinstance(value, (bytes, bytearray, dict)):
        values = value
    else:
        values = ()
    return list(dict.fromkeys(str(item).strip() for item in values if isinstance(item, str) and item.strip()))


def resolve_ai_capability_groups(definition: WorkflowDefinition, ai_node: Node) -> list[str]:
    """Resolve the capability groups feeding *ai_node*.

    No edge into ``capability_groups`` means the node's own top-level list is
    authoritative. Otherwise every source must be a selector node and the
    selected references are concatenated in edge order.
    """
    node_map = {node.id: node for node in definition.nodes}
    groups: list[str] = []
    for edge in definition.edges:
        if edge.target != ai_node.id or edge.target_port != CAPABILITY_GROUPS_PORT:
            continue
        source = node_map.get(edge.source)
        if source is None:
            raise CapabilityGroupWiringError(f"capability-group source node '{edge.source}' not found")
        if not is_capability_group_node(source):
            raise CapabilityGroupWiringError(f"node '{ai_node.id}': input '{CAPABILITY_GROUPS_PORT}' must be connected to an ai:capability_group node")
        groups.extend(normalize_group_selection(source.params.get("groups")))
    if not groups:
        return list(ai_node.capability_groups)
    return list(dict.fromkeys(groups))


def validate_capability_group_wiring(definition: WorkflowDefinition) -> None:
    """Validate selector params and the edges attached to selectors."""
    node_map = {node.id: node for node in definition.nodes}
    selector_ids = {node.id for node in definition.nodes if is_capability_group_node(node)}

    for node in definition.nodes:
        if not is_capability_group_node(node):
            continue
        raw = node.params.get("groups")
        if raw is not None and not isinstance(raw, list):
            raise CapabilityGroupWiringError(f"node '{node.id}': params.groups must be a list")
        if raw is not None and not all(isinstance(item, str) for item in raw):
            raise CapabilityGroupWiringError(f"node '{node.id}': params.groups must contain strings")
        if node.inputs:
            raise CapabilityGroupWiringError(f"node '{node.id}': a capability-group selector has no inputs")
        if [port.name for port in node.outputs] != [CAPABILITY_GROUPS_OUTPUT]:
            raise CapabilityGroupWiringError(f"node '{node.id}': capability-group selector must output only '{CAPABILITY_GROUPS_OUTPUT}'")

    for edge in definition.edges:
        source = node_map.get(edge.source)
        target = node_map.get(edge.target)
        if source is None or target is None:
            continue
        if source.id in selector_ids:
            allowed = target.type == NodeType.AI_LLM_AGENT and edge.target_port == CAPABILITY_GROUPS_PORT
            if not allowed:
                raise CapabilityGroupWiringError(f"edge '{source.id}.{edge.source_port}' -> '{target.id}.{edge.target_port}': selector output may only feed an AI node's '{CAPABILITY_GROUPS_PORT}' port")
        if target.id in selector_ids:
            raise CapabilityGroupWiringError(f"edge '{source.id}.{edge.source_port}' -> '{target.id}.{edge.target_port}': a capability-group selector accepts no input edges")
