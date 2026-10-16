"""Dangerous-node detection for workflow definitions — pure helpers.

This module decides which nodes of a :class:`WorkflowDefinition` need a
runtime confirmation before they execute (the "pending review" concept,
T17).  It is a pure, zero-dependency layer: it only imports the workflow
schema types and deliberately re-declares the dangerous-type set instead of
importing :mod:`deerflow.workflow.registry` (whose ``_NON_IDEMPOTENT_TYPES``
is private), so there is no import cycle and no coupling to the executor
registry.
"""

from __future__ import annotations

from deerflow.workflow.schema import NodeType, WorkflowDefinition, WorkflowMetadata

# Non-idempotent / dangerous node types whose side-effects must be confirmed
# at runtime before execution.  Mirrors the semantics of
# ``registry.crash_confirm_required`` (bash, http and the local-application
# launch/script nodes are the non-idempotent types) without importing the
# registry.
_DANGEROUS_TYPES: frozenset[NodeType] = frozenset(
    {
        NodeType.TOOL_BASH,
        NodeType.TOOL_HTTP,
        # §25 工具节点化: the resolved tool may be bash/app/HTTP, so the node is
        # dangerous by construction, exactly like the static dangerous types.
        NodeType.TOOL_INVOKE,
        NodeType.APP_LAUNCH,
        NodeType.APP_SCRIPT,
    }
)


def dangerous_node_types() -> frozenset[NodeType]:
    """Return the node types that require pending-review confirmation.

    ``tool:bash``, ``tool:http`` and the ``app:launch`` / ``app:script`` nodes —
    the same set the executor registry treats as non-idempotent (see
    ``registry.crash_confirm_required``).
    """
    return _DANGEROUS_TYPES


def collect_pending_review_nodes(def_: WorkflowDefinition) -> list[str]:
    """Return ids of dangerous nodes that still need runtime confirmation.

    A dangerous node is collected unless its ``params`` carry an explicit
    ``crash_confirm=False`` (author opted out).  Results are in definition
    order and deduplicated.
    """
    dangerous = dangerous_node_types()
    pending: list[str] = []
    for node in def_.nodes:
        if node.type not in dangerous:
            continue
        if node.params.get("crash_confirm") is False:
            continue
        if node.id not in pending:
            pending.append(node.id)
    return pending


def mark_pending_review(def_: WorkflowDefinition) -> WorkflowMetadata:
    """Return a metadata copy with ``pending_review_nodes`` merged in.

    A non-empty pending list overwrites any previous value; an empty list is
    written as ``None`` so old data keeps no pending-review key.  Existing
    metadata keys are preserved (a new instance is returned; the definition
    is not mutated).
    """
    pending = collect_pending_review_nodes(def_)
    return def_.metadata.model_copy(update={"pending_review_nodes": pending or None})
