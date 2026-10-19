"""Compile-time capability-group wiring for workflow definitions.

Capability-group selector and merge nodes are authoring constructs: they exist
on the canvas so a workflow can express *which* groups an AI node receives and
in *what order*, but they are not runtime nodes.  LangGraph fan-in would
otherwise make an AI node with a main-flow edge and a capability edge run twice
(or wait for a root selector it cannot schedule), so the compiler resolves the
wiring statically and removes these edges from the executable graph.

Pure functions only — no IO and no LangGraph dependency.
"""

from __future__ import annotations

from collections.abc import Iterable, Mapping
from typing import Any

from deerflow.workflow.schema import Edge, Node, NodeType, WorkflowDefinition

#: Node types that exist only to describe capability-group wiring.
CAPABILITY_CONFIG_TYPES: frozenset[NodeType] = frozenset({NodeType.AI_CAPABILITY_GROUP, NodeType.AI_CAPABILITY_MERGE})

#: The AI input port that receives a capability-group list.
CAPABILITY_GROUPS_PORT = "capability_groups"

#: Output port every capability config node exposes.
CAPABILITY_GROUPS_OUTPUT = "groups"


class CapabilityWiringError(ValueError):
    """A capability-group edge/params shape the compiler cannot resolve."""


def is_capability_config_node(node: Node) -> bool:
    """Return True when *node* is an authoring-only capability node."""
    return node.type in CAPABILITY_CONFIG_TYPES


def _flatten_group_value(value: Any) -> list[str]:
    """Flatten a selector/merge value into a sequence of non-empty names."""
    if isinstance(value, str):
        return [value] if value else []
    if isinstance(value, Mapping):
        nested = value.get("groups", value.get("group"))
        return _flatten_group_value(nested) if nested is not None else []
    if isinstance(value, Iterable) and not isinstance(value, (bytes, bytearray, str)):
        names: list[str] = []
        for item in value:
            names.extend(_flatten_group_value(item))
        return names
    return []


def merge_capability_groups(groups: Iterable[str]) -> list[str]:
    """Deduplicate capability-group names while preserving first-seen order."""
    return list(dict.fromkeys(group for group in groups if group))


def normalize_capability_groups(value: Any) -> list[str]:
    """Normalize a runtime selector/merge payload into ordered group names."""
    return merge_capability_groups(_flatten_group_value(value))


def _edges_by_target(definition: WorkflowDefinition) -> dict[tuple[str, str], list[Edge]]:
    index: dict[tuple[str, str], list[Edge]] = {}
    for edge in definition.edges:
        index.setdefault((edge.target, edge.target_port), []).append(edge)
    return index


def _resolve_source(
    definition: WorkflowDefinition,
    node_map: Mapping[str, Node],
    node_id: str,
    *,
    path: tuple[str, ...],
) -> list[str]:
    if node_id in path:
        raise CapabilityWiringError(f"capability-group cycle: {' -> '.join((*path, node_id))}")
    node = node_map.get(node_id)
    if node is None:
        raise CapabilityWiringError(f"capability-group source node '{node_id}' not found")
    if node.type == NodeType.AI_CAPABILITY_GROUP:
        raw = node.params.get("group")
        if raw is None or raw == "":
            return []
        if not isinstance(raw, str):
            raise CapabilityWiringError(f"capability-group node '{node.id}': params.group must be a string")
        return merge_capability_groups(_flatten_group_value(raw))
    if node.type == NodeType.AI_CAPABILITY_MERGE:
        index = _edges_by_target(definition)
        groups: list[str] = []
        for port in node.inputs:
            for edge in index.get((node.id, port.name), []):
                groups.extend(_resolve_source(definition, node_map, edge.source, path=(*path, node.id)))
        return merge_capability_groups(groups)
    raise CapabilityWiringError(f"capability-group source '{node.id}' must be a capability-group selector or merge node, got '{node.type.value}'")


def resolve_ai_capability_groups(definition: WorkflowDefinition, ai_node: Node) -> list[str]:
    """Resolve the capability groups feeding *ai_node*.

    No incoming edge means a legacy node: its top-level ``capability_groups``
    list is returned unchanged.  Otherwise every edge into the
    ``capability_groups`` port must originate at a selector/merge node, and the
    merged result is flattened/deduplicated in slot order.
    """
    node_map = {node.id: node for node in definition.nodes}
    index = _edges_by_target(definition)
    edges = index.get((ai_node.id, CAPABILITY_GROUPS_PORT), [])
    if not edges:
        return merge_capability_groups(ai_node.capability_groups)
    groups: list[str] = []
    for edge in edges:
        groups.extend(_resolve_source(definition, node_map, edge.source, path=()))
    return merge_capability_groups(groups)


def validate_capability_wiring(definition: WorkflowDefinition) -> None:
    """Validate selector/merge params and the edges attached to them.

    Raises :class:`CapabilityWiringError` on the first problem.  The compiler
    wraps this into a ``WorkflowCompileError`` with the node id.
    """
    node_map = {node.id: node for node in definition.nodes}
    config_ids = {node.id for node in definition.nodes if is_capability_config_node(node)}

    for node in definition.nodes:
        if node.type == NodeType.AI_CAPABILITY_GROUP:
            raw = node.params.get("group")
            if raw is not None and not isinstance(raw, str):
                raise CapabilityWiringError(f"node '{node.id}': params.group must be a string")
            if node.inputs:
                raise CapabilityWiringError(f"node '{node.id}': a capability-group selector has no inputs")
        elif node.type == NodeType.AI_CAPABILITY_MERGE:
            seen: set[str] = set()
            for port in node.inputs:
                if port.type.value != "array":
                    raise CapabilityWiringError(f"node '{node.id}': merge input '{port.name}' must be an array port")
                if port.name in seen:
                    raise CapabilityWiringError(f"node '{node.id}': duplicate merge input '{port.name}'")
                seen.add(port.name)
            for port in node.outputs:
                if port.name != CAPABILITY_GROUPS_OUTPUT:
                    raise CapabilityWiringError(f"node '{node.id}': capability merge may only output '{CAPABILITY_GROUPS_OUTPUT}'")

    by_target_port: dict[tuple[str, str], list[Edge]] = {}
    for edge in definition.edges:
        by_target_port.setdefault((edge.target, edge.target_port), []).append(edge)
        source = node_map.get(edge.source)
        target = node_map.get(edge.target)
        if source is None or target is None:
            continue  # structural validation reports missing nodes
        if source.id in config_ids:
            allowed = target.type == NodeType.AI_CAPABILITY_MERGE or (target.type == NodeType.AI_LLM_AGENT and edge.target_port == CAPABILITY_GROUPS_PORT)
            if not allowed:
                raise CapabilityWiringError(f"edge '{source.id}.{edge.source_port}' -> '{target.id}.{edge.target_port}': capability-group output may only feed a merge input or an AI node's '{CAPABILITY_GROUPS_PORT}' port")
        if target.id in config_ids:
            if target.type != NodeType.AI_CAPABILITY_MERGE or source.id not in config_ids:
                raise CapabilityWiringError(f"edge '{source.id}.{edge.source_port}' -> '{target.id}.{edge.target_port}': capability-group nodes accept only selector/merge inputs")

    for node in definition.nodes:
        if node.type != NodeType.AI_LLM_AGENT:
            continue
        for edge in by_target_port.get((node.id, CAPABILITY_GROUPS_PORT), []):
            source = node_map.get(edge.source)
            if source is None:
                continue
            if not is_capability_config_node(source):
                raise CapabilityWiringError(f"node '{node.id}': input '{CAPABILITY_GROUPS_PORT}' must be connected to a capability-group selector or merge node, got '{source.type.value}'")
    for node in definition.nodes:
        if node.type != NodeType.AI_CAPABILITY_MERGE:
            continue
        for port in node.inputs:
            edges = by_target_port.get((node.id, port.name), [])
            if len(edges) > 1:
                raise CapabilityWiringError(f"node '{node.id}': merge input '{port.name}' accepts exactly one connection (got {len(edges)})")


__all__ = [
    "CAPABILITY_CONFIG_TYPES",
    "CAPABILITY_GROUPS_OUTPUT",
    "CAPABILITY_GROUPS_PORT",
    "CapabilityWiringError",
    "is_capability_config_node",
    "merge_capability_groups",
    "normalize_capability_groups",
    "resolve_ai_capability_groups",
    "validate_capability_wiring",
]
