"""Harness-layer workflow definition save helper.

``save_workflow_definition`` persists a validated ``WorkflowDefinition``
through ``WorkflowDefinitionRepository`` using the configured persistence
engine. It is used by harness-layer workflow tooling (T17); it deliberately
mirrors the Gateway route logic (``app/gateway/routers/workflow_routes.py``)
without importing any ``app.*`` module, keeping the harness → app dependency
boundary intact (enforced by ``test_harness_boundary.py``).

Behavior contract:

- The definition MUST pass ``validate_definition`` before anything is saved —
  an invalid definition raises ``WorkflowDefinitionSaveError`` carrying the
  validation error list (the "agent can only call registered capabilities"
  enforcement boundary, duplicated at the harness layer).
- Saving requires a SQL database backend. On the ``memory`` backend the
  engine exposes no session factory and saving raises
  ``WorkflowDefinitionSaveError`` explaining the requirement.
- Capability groups are resolved to ``guid@version`` entries exactly like the
  Gateway route's ``_resolve_workflow_metadata``: fail-open on skills-storage
  failures, ``None`` when nothing resolves.
"""

from __future__ import annotations

import logging
import uuid
from datetime import UTC, datetime
from typing import Any

from deerflow.config.app_config import get_app_config
from deerflow.persistence.engine import get_session_factory, init_engine_from_config
from deerflow.persistence.workflow_definitions import WorkflowDefinitionRepository
from deerflow.skills.catalog import SkillCatalog
from deerflow.workflow.schema import WorkflowDefinition, collect_resolved_groups
from deerflow.workflow.workflow_io import SCHEMA_VERSION, validate_definition

logger = logging.getLogger(__name__)


class WorkflowDefinitionSaveError(RuntimeError):
    """Raised when a workflow definition cannot be saved."""


def _resolve_workflow_metadata(definition: WorkflowDefinition, metadata: dict[str, Any]) -> dict[str, Any]:
    """Populate ``metadata["resolved_groups"]`` from the definition's capability groups.

    Only when any node declares ``capability_groups``; otherwise ``resolved_groups``
    is left untouched.  Fail-open: a skills-storage failure leaves metadata
    unchanged rather than rejecting the save.

    Mirrors ``app.gateway.routers.workflow_routes._resolve_workflow_metadata`` —
    logic duplicated here so the harness layer never imports ``app.*``.
    """
    if not any(node.capability_groups for node in definition.nodes):
        return metadata

    try:
        from deerflow.skills.storage import get_or_new_skill_storage

        storage = get_or_new_skill_storage()
        skills = storage.load_skills(enabled_only=False)
        catalog = SkillCatalog(skills=tuple(skills))
        resolved = collect_resolved_groups(definition, catalog)
        result = dict(metadata)
        result["resolved_groups"] = resolved if resolved else None
        return result
    except Exception as e:  # noqa: BLE001 - fail-open by design
        logger.warning("Failed to resolve workflow capability groups: %s", e)
        return metadata


def build_lockfile(definition: WorkflowDefinition, resolved_metadata: dict[str, Any]) -> dict[str, Any]:
    """Freeze a reproducibility snapshot (§5.6) from the definition + resolved groups.

    Captures the capability-group snapshot plus the default model identity so a
    run can be reasoned about after the fact.  Model fields are read from the
    active ``AppConfig`` and are fail-open: a config-read failure leaves the
    capability snapshot intact rather than rejecting the save.
    """
    groups = resolved_metadata.get("resolved_groups") or []
    lockfile: dict[str, Any] = {
        "schema_version": SCHEMA_VERSION,
        "workflow": {"id": definition.id, "version": definition.version},
        "capability_groups": list(groups),
        "created_at": datetime.now(UTC).isoformat(),
    }
    try:
        config = get_app_config()
        default_model = config.models[0] if config.models else None
        if default_model is not None:
            lockfile["model"] = {
                "name": default_model.name,
                "use": getattr(default_model, "use", None),
                "max_tokens": getattr(default_model, "max_tokens", None),
            }
    except Exception as e:  # noqa: BLE001 - fail-open by design
        logger.warning("Failed to snapshot model config into workflow lockfile: %s", e)
    return lockfile


def _resolve_metadata_with_lockfile(definition: WorkflowDefinition) -> dict[str, Any]:
    """Resolve capability groups and attach a frozen lockfile to the metadata dict."""
    metadata = _resolve_workflow_metadata(definition, definition.metadata.model_dump(exclude_none=True))
    metadata["lockfile"] = build_lockfile(definition, metadata)
    return metadata


async def get_workflow_definition(user_id: str, definition_id: str) -> dict[str, Any] | None:
    """Fetch one workflow definition row owned by *user_id*, or ``None``.

    Requires a SQL database backend; the ``memory`` backend raises
    ``WorkflowDefinitionSaveError`` (the same requirement as saving).
    """
    config = get_app_config()
    await init_engine_from_config(config.database)
    session_factory = get_session_factory()
    if session_factory is None:
        raise WorkflowDefinitionSaveError("workflow definition persistence requires a SQL database backend (database.backend: sqlite or postgres); the configured backend is 'memory'")

    repo = WorkflowDefinitionRepository(session_factory)
    return await repo.get(definition_id, user_id=user_id)


async def update_workflow_definition(
    *,
    definition_id: str,
    definition: WorkflowDefinition,
    user_id: str,
    name: str | None = None,
    version: str = "0.1.0",
) -> dict[str, Any]:
    """Validate and persist an edited definition under its existing id.

    Uses ``WorkflowDefinitionRepository.update`` so the original
    ``definition_id`` is preserved — an edit never re-creates the row.

    Raises:
        WorkflowDefinitionSaveError: the definition failed structural
            validation (message carries the error list), the configured
            persistence backend is ``memory``, or no row owned by *user_id*
            carries *definition_id*.
    """
    errors = validate_definition(definition)
    if errors:
        raise WorkflowDefinitionSaveError("workflow definition is invalid: " + "; ".join(errors))

    config = get_app_config()
    await init_engine_from_config(config.database)
    session_factory = get_session_factory()
    if session_factory is None:
        raise WorkflowDefinitionSaveError("workflow definition persistence requires a SQL database backend (database.backend: sqlite or postgres); the configured backend is 'memory'")

    repo = WorkflowDefinitionRepository(session_factory)
    metadata = _resolve_metadata_with_lockfile(definition)
    result = await repo.update(
        definition_id,
        user_id=user_id,
        updates={
            "name": name or definition.name,
            "schema_version": SCHEMA_VERSION,
            "definition": definition.model_dump(mode="json"),
            "metadata": metadata,
            "version": version,
            "resolved_at": datetime.now(UTC),
        },
    )
    if result is None:
        raise WorkflowDefinitionSaveError(f"workflow definition '{definition_id}' not found for user '{user_id}'")
    return result


async def save_workflow_definition(
    *,
    definition: WorkflowDefinition,
    user_id: str,
    name: str | None = None,
    version: str = "0.1.0",
) -> dict[str, Any]:
    """Validate and persist a workflow definition, returning the repo row dict.

    Raises:
        WorkflowDefinitionSaveError: the definition failed structural
            validation (message carries the error list), or the configured
            persistence backend is ``memory`` (no SQL session factory).
    """
    errors = validate_definition(definition)
    if errors:
        raise WorkflowDefinitionSaveError("workflow definition is invalid: " + "; ".join(errors))

    config = get_app_config()
    await init_engine_from_config(config.database)
    session_factory = get_session_factory()
    if session_factory is None:
        raise WorkflowDefinitionSaveError("workflow definition persistence requires a SQL database backend (database.backend: sqlite or postgres); the configured backend is 'memory'")

    repo = WorkflowDefinitionRepository(session_factory)
    metadata = _resolve_metadata_with_lockfile(definition)
    return await repo.create(
        definition_id=f"wf-{uuid.uuid4().hex}",
        user_id=user_id,
        name=name or definition.name,
        schema_version=SCHEMA_VERSION,
        definition=definition.model_dump(mode="json"),
        metadata=metadata,
        version=version,
        resolved_at=datetime.now(UTC),
    )
