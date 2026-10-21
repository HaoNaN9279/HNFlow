"""Migrate saved workflow definitions to the current AI-node contract.

Pure transformation only; the CLI under ``backend/scripts`` owns persistence.
The migration is intentionally conservative: it converts legacy ``instruction``
into a ``data:assign`` task node and legacy ``output_schema`` into a
``data:schema`` node, drops removed author parameters, and reports multi-inbound
ports instead of guessing which edge to keep.
"""

from __future__ import annotations

import copy
from dataclasses import dataclass, field
from typing import Any

_REMOVED_AI_PARAMS = (
    "instruction",
    "autonomy",
    "context_policy",
    "memory",
    "retrieval",
    "model_policy",
    "merge",
    "rollback_on_failure",
    "output_schema",
)


@dataclass
class MigrationResult:
    definition: dict[str, Any]
    changed: bool = False
    notes: list[str] = field(default_factory=list)
    conflicts: list[str] = field(default_factory=list)


def _port(name: str, type_: str, *, required: bool = False) -> dict[str, Any]:
    return {"name": name, "type": type_, "required": required}


def _ensure_port(inputs: list[dict[str, Any]], name: str, type_: str) -> None:
    if not any(port.get("name") == name for port in inputs):
        inputs.append(_port(name, type_))


def _unique_id(existing: set[str], base: str) -> str:
    candidate = base
    index = 2
    while candidate in existing:
        candidate = f"{base}_{index}"
        index += 1
    existing.add(candidate)
    return candidate


def migrate_definition(raw: dict[str, Any]) -> MigrationResult:
    """Return a migrated copy plus notes/conflicts."""
    definition = copy.deepcopy(raw)
    nodes = definition.get("nodes") or []
    edges = definition.get("edges") or []
    notes: list[str] = []
    conflicts: list[str] = []
    changed = False

    # Remove the retired knowledge node and every edge touching it.
    knowledge_ids = {node.get("id") for node in nodes if node.get("type") == "data:knowledge"}
    if knowledge_ids:
        nodes[:] = [node for node in nodes if node.get("id") not in knowledge_ids]
        edges[:] = [edge for edge in edges if edge.get("source") not in knowledge_ids and edge.get("target") not in knowledge_ids]
        notes.append(f"removed data:knowledge nodes: {', '.join(sorted(str(item) for item in knowledge_ids))}")
        changed = True

    node_ids = {str(node.get("id")) for node in nodes}
    start = next((node for node in nodes if node.get("type") == "flow:start"), None)

    for node in nodes:
        if node.get("type") != "ai:llm_agent":
            continue
        node_id = str(node.get("id"))
        params = node.setdefault("params", {})
        inputs = node.setdefault("inputs", [])
        instruction = params.get("instruction")
        schema = params.get("output_schema")

        changed_here = False
        for key in _REMOVED_AI_PARAMS:
            if key in params:
                params.pop(key, None)
                changed_here = True

        has_task = any(edge.get("target") == node_id and edge.get("target_port") == "template_prompt" for edge in edges)
        if isinstance(instruction, str) and instruction and not has_task:
            task_id = _unique_id(node_ids, f"{node_id}__task")
            nodes.append(
                {
                    "id": task_id,
                    "type": "data:assign",
                    "inputs": [_port("in", "data")],
                    "outputs": [_port("out", "data", required=True), _port("task", "data", required=True)],
                    "params": {"task": instruction},
                }
            )
            existing_in = next((edge for edge in edges if edge.get("target") == node_id and edge.get("target_port") == "in"), None)
            if existing_in is not None:
                source_id = existing_in.get("source")
                source_port = existing_in.get("source_port")
                edges.remove(existing_in)
            elif start is not None:
                source_id = start.get("id")
                source_port = (start.get("outputs") or [{}])[0].get("name", "out")
            else:
                source_id = None
                source_port = None
            if source_id is not None:
                edges.append({"source": source_id, "source_port": source_port, "target": task_id, "target_port": "in"})
            edges.append({"source": task_id, "source_port": "out", "target": node_id, "target_port": "in"})
            edges.append({"source": task_id, "source_port": "task", "target": node_id, "target_port": "template_prompt"})
            _ensure_port(inputs, "template_prompt", "data")
            notes.append(f"{node_id}: instruction -> {task_id} (data:assign) -> template_prompt")
            changed_here = True

        has_schema = any(edge.get("target") == node_id and edge.get("target_port") == "output_schema" for edge in edges)
        if isinstance(schema, dict) and schema and not has_schema:
            schema_id = _unique_id(node_ids, f"{node_id}__schema")
            nodes.append(
                {
                    "id": schema_id,
                    "type": "data:schema",
                    "inputs": [],
                    "outputs": [_port("schema", "record", required=True)],
                    "params": {"schema": schema},
                }
            )
            edges.append({"source": schema_id, "source_port": "schema", "target": node_id, "target_port": "output_schema"})
            _ensure_port(inputs, "output_schema", "record")
            notes.append(f"{node_id}: output_schema -> {schema_id} (data:schema) -> output_schema")
            changed_here = True

        if changed_here:
            changed = True

    node_map = {str(node.get("id")): node for node in nodes}
    seen: dict[tuple[str, str], int] = {}
    for index, edge in enumerate(edges):
        target = node_map.get(str(edge.get("target")))
        if target is not None and target.get("type") in ("flow:end", "flow:loop"):
            continue
        key = (str(edge.get("target")), str(edge.get("target_port")))
        if key in seen:
            conflicts.append(f"multiple inbound edges into {key[0]}.{key[1]} (edges {seen[key]} and {index})")
        else:
            seen[key] = index

    return MigrationResult(definition=definition, changed=changed, notes=notes, conflicts=conflicts)


__all__ = ["MigrationResult", "migrate_definition"]
