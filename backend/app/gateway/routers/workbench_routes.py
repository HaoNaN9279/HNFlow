"""Saved workflow workbenches.

A workbench is a monitoring surface: it references root workflow definitions,
stores layout/settings, and records the workbench a manual run was launched
from.  It never compiles into a graph and never owns a run's lifecycle.
"""

from __future__ import annotations

import uuid
from typing import Any

from fastapi import APIRouter, HTTPException, Request
from pydantic import BaseModel, Field, ValidationError

from app.gateway.deps import (
    get_optional_user_from_request,
    get_workflow_definition_repo,
    get_workflow_workbench_repo,
)
from app.gateway.permissions import require_permission
from app.gateway.routers.thread_runs import RunResponse, _record_to_response
from app.gateway.services import start_workflow_run
from deerflow.persistence.workflow_workbenches import (
    WorkbenchMemberConflict,
    WorkbenchRevisionConflict,
)
from deerflow.workflow.schema import WorkflowDefinition

router = APIRouter(prefix="/api/workbenches", tags=["workbenches"])


class WorkbenchCreateRequest(BaseModel):
    name: str = Field(min_length=1, max_length=255)
    description: str = ""
    layout: dict[str, Any] | None = None
    settings: dict[str, Any] | None = None


class WorkbenchUpdateRequest(BaseModel):
    name: str | None = Field(default=None, min_length=1, max_length=255)
    description: str | None = None
    layout: dict[str, Any] | None = None
    settings: dict[str, Any] | None = None
    revision: int | None = None


class WorkbenchMemberRequest(BaseModel):
    definition_id: str = Field(min_length=1)
    settings: dict[str, Any] | None = None


class WorkbenchRunRequest(BaseModel):
    definition_id: str = Field(min_length=1)
    params: dict[str, Any] = Field(default_factory=dict)
    debug_step: bool = False
    metadata: dict[str, Any] = Field(default_factory=dict)


async def _user(request: Request):
    user = await get_optional_user_from_request(request)
    if user is None:
        raise HTTPException(status_code=401, detail="Authentication required")
    return user


@router.get("")
@require_permission("workflows", "read")
async def list_workbenches(request: Request):
    user = await _user(request)
    repo = get_workflow_workbench_repo(request)
    return await repo.list_by_user(str(user.id))


@router.post("")
@require_permission("workflows", "write")
async def create_workbench(request: Request, body: WorkbenchCreateRequest):
    user = await _user(request)
    repo = get_workflow_workbench_repo(request)
    return await repo.create(
        user_id=str(user.id),
        name=body.name,
        description=body.description,
        layout=body.layout,
        settings=body.settings,
    )


@router.get("/{workbench_id}")
@require_permission("workflows", "read")
async def get_workbench(workbench_id: str, request: Request):
    user = await _user(request)
    repo = get_workflow_workbench_repo(request)
    result = await repo.get(workbench_id, user_id=str(user.id))
    if result is None:
        raise HTTPException(status_code=404, detail="Workbench not found")
    return result


@router.put("/{workbench_id}")
@require_permission("workflows", "write")
async def update_workbench(workbench_id: str, request: Request, body: WorkbenchUpdateRequest):
    user = await _user(request)
    repo = get_workflow_workbench_repo(request)
    updates = body.model_dump(exclude_unset=True, exclude={"revision"})
    try:
        result = await repo.update(
            workbench_id,
            user_id=str(user.id),
            updates=updates,
            expected_revision=body.revision,
        )
    except WorkbenchRevisionConflict as exc:
        raise HTTPException(status_code=409, detail=str(exc)) from exc
    if result is None:
        raise HTTPException(status_code=404, detail="Workbench not found")
    return result


@router.delete("/{workbench_id}")
@require_permission("workflows", "write")
async def delete_workbench(workbench_id: str, request: Request):
    user = await _user(request)
    repo = get_workflow_workbench_repo(request)
    deleted = await repo.delete(workbench_id, user_id=str(user.id))
    if not deleted:
        raise HTTPException(status_code=404, detail="Workbench not found")
    return {"id": workbench_id, "deleted": True}


@router.post("/{workbench_id}/members")
@require_permission("workflows", "write")
async def add_workbench_member(workbench_id: str, request: Request, body: WorkbenchMemberRequest):
    user = await _user(request)
    repo = get_workflow_workbench_repo(request)
    try:
        member = await repo.add_member(
            workbench_id,
            user_id=str(user.id),
            definition_id=body.definition_id,
            settings=body.settings,
        )
    except LookupError as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc
    except WorkbenchMemberConflict as exc:
        raise HTTPException(status_code=409, detail=str(exc)) from exc
    return member


@router.delete("/{workbench_id}/members/{definition_id}")
@require_permission("workflows", "write")
async def remove_workbench_member(workbench_id: str, definition_id: str, request: Request):
    user = await _user(request)
    repo = get_workflow_workbench_repo(request)
    removed = await repo.remove_member(workbench_id, user_id=str(user.id), definition_id=definition_id)
    if not removed:
        raise HTTPException(status_code=404, detail="Workbench member not found")
    return {"workbench_id": workbench_id, "definition_id": definition_id, "removed": True}


@router.post("/{workbench_id}/runs", response_model=RunResponse)
@require_permission("runs", "create")
async def create_workbench_run(workbench_id: str, request: Request, body: WorkbenchRunRequest):
    """Launch a run for a workbench member.

    The run is deliberately background-only (``on_disconnect="continue"``):
    closing the workbench or the browser must never stop it.
    """
    user = await _user(request)
    workbench_repo = get_workflow_workbench_repo(request)
    member = await workbench_repo.get_member(
        workbench_id,
        user_id=str(user.id),
        definition_id=body.definition_id,
    )
    if member is None:
        raise HTTPException(status_code=404, detail="Workflow is not a member of this workbench")

    definition_repo = get_workflow_definition_repo(request)
    row = await definition_repo.get(body.definition_id, user_id=str(user.id))
    if row is None:
        raise HTTPException(status_code=404, detail="Workflow definition not found")
    raw = row.get("definition") if isinstance(row, dict) else getattr(row, "definition", None)
    try:
        definition = WorkflowDefinition.model_validate(raw)
    except ValidationError as exc:
        raise HTTPException(status_code=422, detail={"errors": [str(exc)]}) from exc

    record = await start_workflow_run(
        definition_id=body.definition_id,
        definition=definition,
        params=body.params,
        thread_id=f"wf-run-{uuid.uuid4().hex}",
        request=request,
        on_disconnect="continue",
        metadata={**body.metadata, "workbench_id": workbench_id},
        debug_step=body.debug_step,
        workbench_id=workbench_id,
    )
    return _record_to_response(record)
