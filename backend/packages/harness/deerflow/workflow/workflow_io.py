"""Workflow definition validation and JSON serialization layer.

Pure functions for graph-structure validation (cycle detection, start/end node
checks, edge references, port-type matching, params compatibility) plus a
schema-versioned JSON serialisation wrapper.

This module depends only on ``deerflow.workflow.schema`` and stdlib — zero
langgraph / langchain / app dependency.
"""

from __future__ import annotations

import json
from collections.abc import Iterator
from typing import Any

from deerflow.workflow.schema import (
    Edge,
    Node,
    NodeType,
    PortType,
    WorkflowDefinition,
)

# ── Schema version ───────────────────────────────────────────────────────────────

SCHEMA_VERSION = 1

# ── JSON-native type set ─────────────────────────────────────────────────────────

_JSON_TYPES = (str, int, float, bool, type(None), list, dict)


# ── Public API ───────────────────────────────────────────────────────────────────


def ports_compatible(src: PortType, dst: PortType) -> bool:
    """Return True when two port types are compatible (same type)."""
    return src is dst


def validate_definition(def_: WorkflowDefinition) -> list[str]:
    """Validate a workflow definition and return a list of error messages.

    An empty result means the definition is structurally legal.
    Pure function — no IO.
    """
    errors: list[str] = []
    node_ids = {n.id for n in def_.nodes}
    node_map: dict[str, Node] = {n.id: n for n in def_.nodes}

    errors.extend(_find_cycles(node_ids, node_map, def_.edges))
    errors.extend(_check_single_start_end(node_map, def_.edges))
    errors.extend(_check_edge_references(node_map, def_.edges))
    errors.extend(_check_port_types(node_map, def_.edges))
    errors.extend(_check_params_json_compatible(def_.nodes))
    errors.extend(_check_subworkflow_params(def_.nodes))

    return errors


def serialize(def_: WorkflowDefinition) -> str:
    """Serialize a workflow definition to a schema-versioned JSON string.

    Output format::

        {"schema_version": 1, "workflow": <def_.model_dump(mode="json")>}
    """
    outer: dict[str, Any] = {
        "schema_version": SCHEMA_VERSION,
        "workflow": def_.model_dump(mode="json"),
    }
    return json.dumps(outer, ensure_ascii=False, indent=2)


def deserialize(text: str) -> WorkflowDefinition:
    """Deserialize a schema-versioned JSON string back to a WorkflowDefinition.

    Raises:
        ValueError: missing or unsupported schema_version.
        NotImplementedError: schema_version < SCHEMA_VERSION with no migration.
    """
    raw: dict[str, Any] = json.loads(text)

    while True:
        if "schema_version" not in raw:
            raise ValueError("missing schema_version in serialized workflow data")
        version = raw["schema_version"]
        if version == SCHEMA_VERSION:
            break
        if version > SCHEMA_VERSION:
            raise ValueError(f"unsupported schema version {version} (max supported: {SCHEMA_VERSION})")
        # version < SCHEMA_VERSION → attempt migration
        raw = _migrate_schema(raw, version)

    return WorkflowDefinition.model_validate(raw["workflow"])


# ── Private: cycle detection ─────────────────────────────────────────────────────

# Colour constants for iterative DFS
_WHITE = 0  # unvisited
_GRAY = 1  # visiting (on current path)
_BLACK = 2  # fully processed


def _find_cycles(node_ids: set[str], node_map: dict[str, Node], edges: list[Edge]) -> list[str]:
    """Detect directed cycles using iterative DFS with an explicit stack.

    Returns one error per cycle containing the full path like ``"A→B→C→A"``.

    Cycles that contain at least one ``flow:loop`` node are exempt —
    loop nodes intentionally introduce a recursive self-loop.
    """
    errors: list[str] = []

    # Build adjacency list (source → list of targets, ignoring port names)
    adj: dict[str, list[str]] = {}
    for e in edges:
        adj.setdefault(e.source, []).append(e.target)

    # Ensure all nodes have entries (isolated nodes have no edges)
    for nid in node_ids:
        adj.setdefault(nid, [])

    color: dict[str, int] = {nid: _WHITE for nid in node_ids}

    for start_node in node_ids:
        if color[start_node] != _WHITE:
            continue

        # Stack entries: (node, iterator over neighbours, path_index)
        # path holds the current DFS path.
        color[start_node] = _GRAY
        path: list[str] = [start_node]
        stack: list[tuple[str, Iterator[str]]] = [(start_node, iter(adj.get(start_node, [])))]

        while stack:
            current, neighbours = stack[-1]
            try:
                neighbour = next(neighbours)
                if neighbour not in color:
                    # Node referenced by edge but not in node_ids — handled by edge-reference checks.
                    continue
                if color[neighbour] == _GRAY:
                    # Found a back edge → cycle detected
                    cycle_start_idx = path.index(neighbour)
                    cycle_path = path[cycle_start_idx:] + [neighbour]
                    # Exempt cycles that contain at least one flow:loop node
                    if not _cycle_contains_loop(cycle_path, node_map):
                        errors.append("→".join(cycle_path))
                elif color[neighbour] == _WHITE:
                    # Unexplored node — descend
                    color[neighbour] = _GRAY
                    path.append(neighbour)
                    stack.append((neighbour, iter(adj.get(neighbour, []))))
            except StopIteration:
                # All neighbours processed — mark black and backtrack
                color[current] = _BLACK
                stack.pop()
                path.pop()

    return errors


def _cycle_contains_loop(cycle_path: list[str], node_map: dict[str, Node]) -> bool:
    """Return True if any node in *cycle_path* is a ``flow:loop`` node."""
    for nid in cycle_path:
        node = node_map.get(nid)
        if node is not None and node.type == NodeType.FLOW_LOOP:
            return True
    return False


# ── Private: start/end node checks ───────────────────────────────────────────────


def _check_single_start_end(node_map: dict[str, Node], edges: list[Edge]) -> list[str]:
    """Ensure exactly one flow:start (no incoming edges) and one flow:end (no outgoing edges)."""
    errors: list[str] = []

    start_nodes = [n for n in node_map.values() if n.type == NodeType.FLOW_START]
    end_nodes = [n for n in node_map.values() if n.type == NodeType.FLOW_END]

    # Compute incoming/outgoing edge targets/sources
    incoming_targets = {e.target for e in edges}
    outgoing_sources = {e.source for e in edges}

    # ── flow:start ──
    if len(start_nodes) == 0:
        errors.append("missing flow:start node (exactly one required)")
    elif len(start_nodes) > 1:
        start_ids = [n.id for n in start_nodes]
        errors.append(f"multiple flow:start nodes found ({', '.join(start_ids)}); exactly one required")
    else:
        start = start_nodes[0]
        if start.id in incoming_targets:
            errors.append(f"flow:start node '{start.id}' has incoming edges (must have none)")

    # ── flow:end ──
    if len(end_nodes) == 0:
        errors.append("missing flow:end node (exactly one required)")
    elif len(end_nodes) > 1:
        end_ids = [n.id for n in end_nodes]
        errors.append(f"multiple flow:end nodes found ({', '.join(end_ids)}); exactly one required")
    else:
        end = end_nodes[0]
        if end.id in outgoing_sources:
            errors.append(f"flow:end node '{end.id}' has outgoing edges (must have none)")

    return errors


# ── Private: edge reference checks ───────────────────────────────────────────────


def _check_edge_references(node_map: dict[str, Node], edges: list[Edge]) -> list[str]:
    """Verify every edge references existing nodes and port names."""
    errors: list[str] = []

    for i, edge in enumerate(edges):
        # Source node exists?
        if edge.source not in node_map:
            errors.append(f"edge[{i}]: source node '{edge.source}' not found")
            continue
        # Target node exists?
        if edge.target not in node_map:
            errors.append(f"edge[{i}]: target node '{edge.target}' not found")
            continue

        src = node_map[edge.source]
        dst = node_map[edge.target]

        # Source port exists in source node's outputs
        src_port_names = {p.name for p in src.outputs}
        if edge.source_port not in src_port_names:
            errors.append(f"edge[{i}]: source_port '{edge.source_port}' not found in outputs of node '{edge.source}' (available: {sorted(src_port_names)})")

        # Target port exists in target node's inputs
        dst_port_names = {p.name for p in dst.inputs}
        if edge.target_port not in dst_port_names:
            errors.append(f"edge[{i}]: target_port '{edge.target_port}' not found in inputs of node '{edge.target}' (available: {sorted(dst_port_names)})")

    return errors


# ── Private: port type compatibility checks ──────────────────────────────────────


def _check_port_types(node_map: dict[str, Node], edges: list[Edge]) -> list[str]:
    """Verify that connected ports have compatible types."""
    errors: list[str] = []

    for i, edge in enumerate(edges):
        if edge.source not in node_map or edge.target not in node_map:
            continue  # already reported by _check_edge_references

        src = node_map[edge.source]
        dst = node_map[edge.target]

        # Find the source port
        src_port = next((p for p in src.outputs if p.name == edge.source_port), None)
        dst_port = next((p for p in dst.inputs if p.name == edge.target_port), None)

        if src_port is None or dst_port is None:
            continue  # already reported by _check_edge_references

        if not ports_compatible(src_port.type, dst_port.type):
            errors.append(f"edge[{i}]: incompatible port types — '{edge.source}.{edge.source_port}' is {src_port.type.value} but '{edge.target}.{edge.target_port}' is {dst_port.type.value}")

    return errors


# ── Private: params JSON compatibility checks ─────────────────────────────────────


def _check_params_json_compatible(nodes: list[Node]) -> list[str]:
    """Verify that every node's param values are JSON-native types."""
    errors: list[str] = []

    for node in nodes:
        for key, value in node.params.items():
            if not isinstance(value, _JSON_TYPES):
                errors.append(f"node '{node.id}': param '{key}' has non-JSON-compatible type {type(value).__name__} (allowed: str, int, float, bool, None, list, dict)")

    return errors


# ── Private: subworkflow spec shape checks ────────────────────────────────────────


def _check_subworkflow_params(nodes: list[Node]) -> list[str]:
    """Validate the ``params["subworkflow"]`` spec shape on ``nested:subworkflow`` nodes.

    Shape-only validation — deliberately fail-open: it does NOT load or
    ``model_validate`` the referenced sub-workflow content (that is
    compile-time work owned by ``deerflow.workflow.compiler``).  Only the
    ``nested:subworkflow`` node type is inspected; an unrelated node carrying a
    ``subworkflow`` key is ignored.
    """
    errors: list[str] = []

    for node in nodes:
        if node.type != NodeType.NESTED_SUBWORKFLOW:
            continue
        spec = node.params.get("subworkflow")
        if spec is None:
            continue
        if not isinstance(spec, dict):
            errors.append(f"node '{node.id}': subworkflow spec must be a dict")
            continue

        spec_type = spec.get("type")
        if spec_type not in ("inline", "template"):
            errors.append(f"node '{node.id}': subworkflow spec 'type' must be 'inline' or 'template'")
            continue

        has_definition = "definition" in spec
        has_template_id = "template_id" in spec
        if has_definition and has_template_id:
            errors.append(f"node '{node.id}': subworkflow spec cannot combine inline 'definition' with 'template_id'")
            continue

        if spec_type == "inline":
            if not isinstance(spec.get("definition"), dict):
                errors.append(f"node '{node.id}': subworkflow inline spec requires a 'definition' dict")
        else:  # template
            template_id = spec.get("template_id")
            if not isinstance(template_id, str) or not template_id:
                errors.append(f"node '{node.id}': subworkflow template spec requires a non-empty 'template_id' string")
            version = spec.get("version")
            if version is not None and not isinstance(version, str):
                errors.append(f"node '{node.id}': subworkflow template 'version' must be a string")

    return errors


# ── Private: schema migration hook ───────────────────────────────────────────────


def _migrate_schema(raw: dict[str, Any], from_version: int) -> dict[str, Any]:
    """Migrate a serialized workflow from *from_version* to the next version.

    T2 has no historical versions — raises NotImplementedError for now.
    Future versions should implement a version-by-version upgrade chain here
    and return the updated dict.
    """
    raise NotImplementedError(f"schema migration from version {from_version} to {SCHEMA_VERSION} is not yet implemented")
