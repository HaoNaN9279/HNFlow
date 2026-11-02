"""Immutable definition snapshot persisted on a workflow run.

A workflow definition can be edited while a run is suspended or after it
finished.  Resume, rewind and continue must keep executing the definition the
run was admitted with — not whatever ``workflow_definitions`` currently points
at.  Until definition revisions are a first-class table, the run's ``kwargs``
carry the validated definition plus a content hash.

This module is deliberately pure: callers decide where the snapshot is stored.
"""

from __future__ import annotations

import hashlib
from typing import Any

from deerflow.workflow.schema import WorkflowDefinition
from deerflow.workflow.workflow_io import serialize


def definition_content_hash(definition: WorkflowDefinition) -> str:
    """Stable hash of the serialized definition (including metadata)."""
    return hashlib.sha256(serialize(definition).encode("utf-8")).hexdigest()


def definition_snapshot(definition: WorkflowDefinition) -> dict[str, Any]:
    """Serialize a definition for a run record's ``kwargs``."""
    return {
        "definition": definition.model_dump(mode="json"),
        "definition_hash": definition_content_hash(definition),
    }


def load_definition_snapshot(kwargs: Any) -> WorkflowDefinition | None:
    """Load the pinned definition from a run's kwargs, or ``None`` for legacy runs.

    Malformed snapshots are treated as absent so legacy rows keep working; the
    caller then falls back to the current definition (documented compatibility
    path), while new runs always carry a valid snapshot.
    """
    if not isinstance(kwargs, dict):
        return None
    raw = kwargs.get("definition")
    if not isinstance(raw, dict):
        return None
    try:
        return WorkflowDefinition.model_validate(raw)
    except Exception:
        return None


__all__ = [
    "definition_content_hash",
    "definition_snapshot",
    "load_definition_snapshot",
]
