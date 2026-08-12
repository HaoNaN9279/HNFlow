"""Workflow definition CRUD routes.

REST endpoints for creating, listing, reading, updating, and deleting
workflow definitions.  Every definition is user-scoped and structurally
validated against the ``WorkflowDefinition`` schema before persistence.
"""

from __future__ import annotations

import uuid
from typing import Any

from fastapi import APIRouter, HTTPException, Request
from pydantic import BaseModel, Field, ValidationError

from app.gateway.authz import require_permission
from app.gateway.deps import get_optional_user_from_request, get_workflow_definition_repo
from deerflow.workflow.schema import WorkflowDefinition
from deerflow.workflow.workflow_io import SCHEMA_VERSION, validate_definition

router = APIRouter(prefix="/api", tags=["workflows"])


# ── Request / Response models ─────────────────────────────────────────────────


class WorkflowCreateRequest(BaseModel):
    name: str = Field(min_length=1)
    definition: dict[str, Any]
    metadata: dict[str, Any] = Field(default_factory=dict)
    version: str = "0.1.0"


class WorkflowUpdateRequest(BaseModel):
    name: str | None = None
    definition: dict[str, Any] | None = None
    metadata: dict[str, Any] | None = None
    version: str | None = None


# ── Helpers ───────────────────────────────────────────────────────────────────


def _format_validation_errors(exc: ValidationError) -> list[str]:
    """Convert a Pydantic v2 ValidationError into a list of human-readable strings."""
    return [f"定义结构非法: {'.'.join(str(loc) for loc in e['loc'])} — {e['msg']}" for e in exc.errors(include_url=False)]


# ── Routes ────────────────────────────────────────────────────────────────────


@router.get("/workflows")
@require_permission("threads", "read")
async def list_workflows(request: Request):
    user = await get_optional_user_from_request(request)
    if user is None:
        return []
    repo = get_workflow_definition_repo(request)
    return await repo.list_by_user(str(user.id))


@router.post("/workflows")
@require_permission("threads", "write")
async def create_workflow(request: Request, body: WorkflowCreateRequest):
    user = await get_optional_user_from_request(request)
    if user is None:
        raise HTTPException(status_code=401, detail="Authentication required")

    # Structural validation — must be a valid WorkflowDefinition
    try:
        model = WorkflowDefinition.model_validate(body.definition)
    except ValidationError as exc:
        raise HTTPException(status_code=422, detail={"errors": _format_validation_errors(exc)}) from exc

    # Graph-structure validation — cycles, start/end, edge refs, port types, params
    errors = validate_definition(model)
    if errors:
        raise HTTPException(status_code=422, detail={"errors": errors})

    repo = get_workflow_definition_repo(request)
    result = await repo.create(
        definition_id=f"wf-{uuid.uuid4().hex}",
        user_id=str(user.id),
        name=body.name,
        schema_version=SCHEMA_VERSION,
        definition=model.model_dump(mode="json"),
        metadata=body.metadata,
        version=body.version,
    )
    return result


@router.get("/workflows/{definition_id}")
@require_permission("threads", "read")
async def get_workflow(definition_id: str, request: Request):
    user = await get_optional_user_from_request(request)
    if user is None:
        raise HTTPException(status_code=401, detail="Authentication required")
    repo = get_workflow_definition_repo(request)
    result = await repo.get(definition_id, user_id=str(user.id))
    if result is None:
        raise HTTPException(status_code=404, detail="Workflow definition not found")
    return result


@router.put("/workflows/{definition_id}")
@require_permission("threads", "write")
async def update_workflow(definition_id: str, request: Request, body: WorkflowUpdateRequest):
    user = await get_optional_user_from_request(request)
    if user is None:
        raise HTTPException(status_code=401, detail="Authentication required")

    repo = get_workflow_definition_repo(request)

    # Verify the definition exists
    existing = await repo.get(definition_id, user_id=str(user.id))
    if existing is None:
        raise HTTPException(status_code=404, detail="Workflow definition not found")

    updates: dict[str, Any] = {}

    if body.definition is not None:
        try:
            model = WorkflowDefinition.model_validate(body.definition)
        except ValidationError as exc:
            raise HTTPException(status_code=422, detail={"errors": _format_validation_errors(exc)}) from exc

        errors = validate_definition(model)
        if errors:
            raise HTTPException(status_code=422, detail={"errors": errors})

        updates["definition"] = model.model_dump(mode="json")
        updates["schema_version"] = SCHEMA_VERSION

    if body.name is not None:
        updates["name"] = body.name

    if body.metadata is not None:
        updates["metadata"] = body.metadata

    if body.version is not None:
        updates["version"] = body.version

    if not updates:
        # Nothing to update — return the existing definition
        return existing

    result = await repo.update(definition_id, user_id=str(user.id), updates=updates)
    if result is None:
        raise HTTPException(status_code=404, detail="Workflow definition not found")
    return result


@router.delete("/workflows/{definition_id}")
@require_permission("threads", "write")
async def delete_workflow(definition_id: str, request: Request):
    user = await get_optional_user_from_request(request)
    if user is None:
        raise HTTPException(status_code=401, detail="Authentication required")
    repo = get_workflow_definition_repo(request)
    deleted = await repo.delete(definition_id, user_id=str(user.id))
    if not deleted:
        raise HTTPException(status_code=404, detail="Workflow definition not found")
    return {"id": definition_id, "deleted": True}
