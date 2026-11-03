"""Node/port catalog for agent-facing discovery.

``workflow/describe`` answers "what may a definition contain?" without shipping
a second copy of the schema to the plugin.  The catalog is derived from
:class:`deerflow.workflow.schema.NodeType` so a new node kind shows up here
automatically; only the human-readable description needs maintaining.
"""

from __future__ import annotations

from typing import Any

from deerflow.workflow.schema import NodeType, PortType
from deerflow.workflow.workflow_io import SCHEMA_VERSION

#: Short, model-facing descriptions.  A missing entry is not an error: the
#: catalog still lists the node type with an empty description.
_NODE_DESCRIPTIONS: dict[str, str] = {
    "flow:start": "Entry node; its output ports become the run inputs.",
    "flow:end": "Terminal node; its input becomes the run result.",
    "flow:if": "Conditional branch on a boolean expression.",
    "flow:switch": "Multi-case branch.",
    "flow:loop": "Bounded loop with a condition route.",
    "flow:parallel": "Fan out to several branches and join.",
    "flow:wait": "Delay for a configured duration.",
    "flow:try": "Run a body with a failure route.",
    "flow:handoff": "Route to one whitelisted expert node (budgeted).",
    "data:assign": "Static value or pass-through.",
    "data:convert": "Type conversion.",
    "data:file": "Read or write a workspace file (sandboxed).",
    "data:asset": "Inspect, import, export, or convert an asset.",
    "data:shared": "Read, write, or append a shared-workspace entry.",
    "data:schema": "Declare an input/output schema for an AI node.",
    "data:json": "Serialize or parse JSON.",
    "data:regex": "Regex search.",
    "data:spec": "Formal-specification lifecycle.",
    "tool:bash": "Shell command (always through the sandbox).",
    "tool:http": "HTTP request.",
    "tool:notify": "User-facing notification.",
    "tool:log": "Log line.",
    "tool:invoke": "Call one gateway tool directly, without a model turn.",
    "ai:llm_agent": "AI node driven by a model profile.",
    "ai:capability_group": "Authoring-only capability-group selector.",
    "ai:prompt_preview": "Render the final prompt an AI node would send.",
    "human:task": "Suspend the run and wait for a submitted form.",
    "human:review": "Suspend for approve/reject with a comment.",
    "verify:gate": "Three-way verification gate (verified/failed/inconclusive).",
    "app:launch": "Launch a local application.",
    "app:script": "Run a script in a local application.",
    "app:wait": "Wait for a local application event.",
    "app:collect": "Collect local application output.",
    "nested:subworkflow": "Inline-expand another workflow definition.",
}


def _category(node_type: NodeType) -> str:
    """Return the ``category:name`` prefix of a node type."""
    return node_type.value.split(":", 1)[0]


def describe() -> dict[str, Any]:
    """Return the catalog shared with the plugin and the agent skill."""
    nodes = [
        {
            "type": node_type.value,
            "category": _category(node_type),
            "description": _NODE_DESCRIPTIONS.get(node_type.value, ""),
        }
        for node_type in NodeType
    ]
    return {
        "schemaVersion": SCHEMA_VERSION,
        "nodeTypes": nodes,
        "portTypes": [port_type.value for port_type in PortType],
    }


__all__ = ["describe"]
