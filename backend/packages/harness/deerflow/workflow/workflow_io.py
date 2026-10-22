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

from deerflow.workflow.review import (
    REVIEW_APPROVED_PORT,
    REVIEW_INPUT_PORT,
    REVIEW_REJECTED_PORT,
)
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


def validate_definition(def_: WorkflowDefinition, known_agent_names: set[str] | None = None) -> list[str]:
    """Validate a workflow definition and return a list of error messages.

    An empty result means the definition is structurally legal.
    Pure function — no IO.

    When *known_agent_names* is provided, every node carrying a non-``None``
    ``agent_name`` must reference a name in that set (the custom-agent
    catalog); an unknown binding is reported with the node's id.  ``None``
    (the default) skips this existence check entirely, preserving backward
    compatibility for callers that do not yet resolve the catalog.
    """
    errors: list[str] = []
    node_ids = {n.id for n in def_.nodes}
    node_map: dict[str, Node] = {n.id: n for n in def_.nodes}

    errors.extend(_find_cycles(node_ids, node_map, def_.edges))
    errors.extend(_check_single_start_end(node_map, def_.edges))
    errors.extend(_check_edge_references(node_map, def_.edges))
    errors.extend(_check_single_inbound_ports(def_.edges, node_map))
    errors.extend(_check_port_types(node_map, def_.edges))
    errors.extend(_check_review_nodes(node_map, def_.edges))
    errors.extend(_check_params_json_compatible(def_.nodes))
    errors.extend(_check_subworkflow_params(def_.nodes))
    if known_agent_names is not None:
        errors.extend(_check_agent_name_references(def_.nodes, known_agent_names))

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
    """Deserialize a current-version, schema-tagged workflow JSON string."""
    raw: dict[str, Any] = json.loads(text)
    if "schema_version" not in raw:
        raise ValueError("missing schema_version in serialized workflow data")
    version = raw["schema_version"]
    if version != SCHEMA_VERSION:
        raise ValueError(f"unsupported schema version {version} (expected {SCHEMA_VERSION})")
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

    # Build adjacency list (source → list of targets, ignoring port names).
    # A review's rejected edge is the one intentional back-edge in the graph;
    # it is validated separately (target must be an upstream AI node) and is
    # excluded here so the remaining graph still rejects every other cycle.
    adj: dict[str, list[str]] = {}
    for e in edges:
        if _is_review_reject_edge(e, node_map):
            continue
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


def _is_review_reject_edge(edge: Edge, node_map: dict[str, Node]) -> bool:
    source = node_map.get(edge.source)
    return source is not None and source.type == NodeType.HUMAN_REVIEW and edge.source_port == REVIEW_REJECTED_PORT


def _reachable(
    start: str,
    target: str,
    edges: list[Edge],
    node_map: dict[str, Node],
) -> bool:
    """Return whether *target* is reachable from *start* without review back-edges."""
    if start == target:
        return True
    adjacency: dict[str, list[str]] = {}
    for edge in edges:
        if _is_review_reject_edge(edge, node_map):
            continue
        adjacency.setdefault(edge.source, []).append(edge.target)
    seen: set[str] = set()
    stack = [start]
    while stack:
        current = stack.pop()
        if current == target:
            return True
        if current in seen:
            continue
        seen.add(current)
        stack.extend(adjacency.get(current, []))
    return False


# ── Private: human review node checks ────────────────────────────────────────────


_REVIEW_CONTINUE_PORT = "continue_prompt"
_REVIEW_INCOMPATIBLE_AI_PARAMS = ("model_profile",)


def _check_review_nodes(node_map: dict[str, Node], edges: list[Edge]) -> list[str]:
    """Validate a ``human:review`` node's fixed approve/reject routing shape.

    The rejected edge is the graph's one intentional back-edge.  To keep that
    from becoming an arbitrary-cycle escape hatch every review must have
    exactly one approved edge and one rejected edge, and the rejected edge must
    target an upstream ``ai:llm_agent`` node through its ``continue_prompt``
    input.  The target's first template turn is compiled with a session, so a
    later rejection can genuinely continue the conversation.
    """
    errors: list[str] = []
    starts = [node for node in node_map.values() if node.type == NodeType.FLOW_START]
    start_id = starts[0].id if len(starts) == 1 else None

    for node in node_map.values():
        if node.type != NodeType.HUMAN_REVIEW:
            continue

        input_ports = {port.name: port for port in node.inputs}
        if REVIEW_INPUT_PORT not in input_ports:
            errors.append(f"node '{node.id}': human:review requires a '{REVIEW_INPUT_PORT}' input port")
        elif input_ports[REVIEW_INPUT_PORT].type is not PortType.DATA:
            errors.append(f"node '{node.id}': human:review input '{REVIEW_INPUT_PORT}' must be data")

        output_ports = {port.name: port for port in node.outputs}
        for port_name in (REVIEW_APPROVED_PORT, REVIEW_REJECTED_PORT):
            if port_name not in output_ports:
                errors.append(f"node '{node.id}': human:review requires a '{port_name}' output port")
            elif output_ports[port_name].type is not PortType.DATA:
                errors.append(f"node '{node.id}': human:review output '{port_name}' must be data")

        approved_edges = [edge for edge in edges if edge.source == node.id and edge.source_port == REVIEW_APPROVED_PORT]
        rejected_edges = [edge for edge in edges if edge.source == node.id and edge.source_port == REVIEW_REJECTED_PORT]
        if len(approved_edges) != 1:
            errors.append(f"node '{node.id}': human:review requires exactly one '{REVIEW_APPROVED_PORT}' out-edge (found {len(approved_edges)})")
        if len(rejected_edges) != 1:
            errors.append(f"node '{node.id}': human:review requires exactly one '{REVIEW_REJECTED_PORT}' out-edge (found {len(rejected_edges)})")
        if len(approved_edges) == 1 and len(rejected_edges) == 1 and approved_edges[0].target == rejected_edges[0].target:
            errors.append(f"node '{node.id}': approved and rejected edges must target different nodes")

        for edge in rejected_edges:
            target = node_map.get(edge.target)
            if target is None:
                continue  # _check_edge_references already reported it
            if target.id in (node.id, start_id) or target.type == NodeType.FLOW_END:
                errors.append(f"node '{node.id}': rejected target '{target.id}' cannot be the review itself, flow:start, or flow:end")
                continue
            if target.type != NodeType.AI_LLM_AGENT:
                errors.append(f"node '{node.id}': rejected target '{target.id}' must be an ai:llm_agent (got '{target.type.value}')")
                continue
            target_inputs = {port.name: port for port in target.inputs}
            if _REVIEW_CONTINUE_PORT not in target_inputs:
                errors.append(f"node '{node.id}': rejected target '{target.id}' must declare a '{_REVIEW_CONTINUE_PORT}' input")
            elif edge.target_port != _REVIEW_CONTINUE_PORT:
                errors.append(f"node '{node.id}': rejected edge must target '{target.id}.{_REVIEW_CONTINUE_PORT}' (got '{edge.target_port}')")
            incompatible = [key for key in _REVIEW_INCOMPATIBLE_AI_PARAMS if (target.params or {}).get(key) is not None]
            if incompatible:
                errors.append(f"node '{node.id}': rejected target '{target.id}' uses {', '.join(incompatible)}, which is not supported with session continuation")
            from deerflow.workflow.structured_output import INPUT_SCHEMA_PORT, OUTPUT_SCHEMA_PORT

            for schema_port in (INPUT_SCHEMA_PORT, OUTPUT_SCHEMA_PORT):
                if any(item.target == target.id and item.target_port == schema_port for item in edges):
                    errors.append(f"node '{node.id}': rejected target '{target.id}' has an '{schema_port}' input, which is not supported with session continuation")
            if start_id is not None:
                if not _reachable(start_id, target.id, edges, node_map):
                    errors.append(f"node '{node.id}': rejected target '{target.id}' is not reachable from flow:start")
                if not _reachable(target.id, node.id, edges, node_map):
                    errors.append(f"node '{node.id}': rejected target '{target.id}' has no forward path back to the review")

    return errors


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


def _check_single_inbound_ports(edges: list[Edge], node_map: dict[str, Node]) -> list[str]:
    """Reject more than one edge into the same target input port.

    ``flow:end`` is the one deliberate exception: it is a terminal sink, not a
    data-merging node, and every branch needs a legal path to the single end.
    """
    seen: dict[tuple[str, str], int] = {}
    errors: list[str] = []
    for index, edge in enumerate(edges):
        target = node_map.get(edge.target)
        if target is not None and target.type in (NodeType.FLOW_END, NodeType.FLOW_LOOP):
            continue
        key = (edge.target, edge.target_port)
        if key in seen:
            errors.append(f"edge[{index}]: input port '{edge.target}.{edge.target_port}' already has an incoming edge (edge[{seen[key]}]); multiple edges into one input port are not allowed")
        else:
            seen[key] = index
    return errors


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
    """Validate ``params["subworkflow"]`` specs on nodes that can carry one.

    Inspected node types: ``nested:subworkflow`` (its body), ``flow:try`` (its
    protected body **and** its ``finally_subworkflow``), and ``flow:loop`` (its
    declared body — N14ak).  Shape-only validation — deliberately fail-open: it
    does NOT load or ``model_validate`` the referenced sub-workflow content (that
    is compile-time work owned by ``deerflow.workflow.compiler``).  An unrelated
    node carrying a ``subworkflow`` key is ignored.
    """
    errors: list[str] = []

    for node in nodes:
        if node.type not in (NodeType.NESTED_SUBWORKFLOW, NodeType.FLOW_TRY, NodeType.FLOW_LOOP):
            continue
        candidates: list[tuple[str, Any]] = [(node.id, node.params.get("subworkflow"))]
        if node.type == NodeType.FLOW_TRY and node.params.get("finally_subworkflow") is not None:
            candidates.append((f"{node.id} (finally)", node.params.get("finally_subworkflow")))
        for label, spec in candidates:
            errors.extend(_check_one_subworkflow_spec(label, spec))

    return errors


def _check_one_subworkflow_spec(node_label: str, spec: Any) -> list[str]:
    """Shape-check one subworkflow spec; returns zero or more error strings."""
    errors: list[str] = []
    if spec is None:
        return errors
    if not isinstance(spec, dict):
        return [f"node '{node_label}': subworkflow spec must be a dict"]

    spec_type = spec.get("type")
    if spec_type not in ("inline", "template"):
        return [f"node '{node_label}': subworkflow spec 'type' must be 'inline' or 'template'"]

    has_definition = "definition" in spec
    has_template_id = "template_id" in spec
    if has_definition and has_template_id:
        return [f"node '{node_label}': subworkflow spec cannot combine inline 'definition' with 'template_id'"]

    if spec_type == "inline":
        if not isinstance(spec.get("definition"), dict):
            errors.append(f"node '{node_label}': subworkflow inline spec requires a 'definition' dict")
    else:  # template
        template_id = spec.get("template_id")
        if not isinstance(template_id, str) or not template_id:
            errors.append(f"node '{node_label}': subworkflow template spec requires a non-empty 'template_id' string")
        version = spec.get("version")
        if version is not None and not isinstance(version, str):
            errors.append(f"node '{node_label}': subworkflow template 'version' must be a string")

    return errors


# ── Private: agent_name reference checks ──────────────────────────────────────────


def _check_agent_name_references(nodes: list[Node], known_agent_names: set[str]) -> list[str]:
    """Verify every bound ``agent_name`` exists in the custom-agent catalog.

    A node with ``agent_name=None`` (the default lead-agent binding) is skipped.
    Any non-``None`` binding must name a known custom agent, regardless of node
    type — binding an agent implies the agent must exist.
    """
    errors: list[str] = []

    for node in nodes:
        if node.agent_name is None:
            continue
        if node.agent_name not in known_agent_names:
            errors.append(f"node '{node.id}': agent_name '{node.agent_name}' does not exist")

    return errors
