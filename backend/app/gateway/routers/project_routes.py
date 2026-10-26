"""File-backed project and workbench API.

Projects are directories with ``.hnflow/project.json``.  Workbenches are JSON
files inside the project; this router never writes the legacy DB-only path.
"""

from __future__ import annotations

import uuid
from typing import Any, NoReturn

from fastapi import APIRouter, HTTPException, Request
from pydantic import BaseModel, Field, ValidationError

from app.gateway.deps import get_current_user, get_project_service, get_workflow_definition_repo
from app.gateway.permissions import require_permission
from app.gateway.routers.thread_runs import RunResponse, _record_to_response
from app.gateway.services import start_workflow_run
from deerflow.projects import (
    ProjectConflictError,
    ProjectError,
    ProjectNotFoundError,
    WorkbenchConflictError,
    WorkbenchNotFoundError,
)
from deerflow.workflow.schema import WorkflowDefinition

router = APIRouter(prefix="/api/projects", tags=["projects"])


class ProjectCreateRequest(BaseModel):
    root_path: str = Field(min_length=1)
    name: str | None = Field(default=None, max_length=255)
    description: str = ""


class ProjectOpenRequest(BaseModel):
    root_path: str = Field(min_length=1)


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


def _raise_service_error(exc: Exception) -> NoReturn:
    if isinstance(exc, ProjectNotFoundError | WorkbenchNotFoundError):
        raise HTTPException(status_code=404, detail=str(exc)) from exc
    if isinstance(exc, ProjectConflictError | WorkbenchConflictError):
        raise HTTPException(status_code=409, detail=str(exc)) from exc
    if isinstance(exc, ProjectError):
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    raise exc


async def _user(request: Request) -> str:
    return str(await get_current_user(request))


@router.get("")
@require_permission("workflows", "read")
async def list_projects(request: Request):
    user_id = await _user(request)
    return await get_project_service(request).list_projects(user_id=user_id)


@router.post("")
@require_permission("workflows", "write")
async def create_project(request: Request, body: ProjectCreateRequest):
    user_id = await _user(request)
    try:
        return await get_project_service(request).create_project(
            root_path=body.root_path,
            user_id=user_id,
            name=body.name,
            description=body.description,
        )
    except Exception as exc:  # noqa: BLE001 - translate the service contract
        _raise_service_error(exc)


@router.post("/open")
@require_permission("workflows", "write")
async def open_project(request: Request, body: ProjectOpenRequest):
    user_id = await _user(request)
    try:
        return await get_project_service(request).open_project(root_path=body.root_path, user_id=user_id)
    except Exception as exc:  # noqa: BLE001 - translate the service contract
        _raise_service_error(exc)


@router.get("/{project_id}")
@require_permission("workflows", "read")
async def get_project(project_id: str, request: Request):
    user_id = await _user(request)
    try:
        return await get_project_service(request).get_project(project_id, user_id=user_id)
    except Exception as exc:  # noqa: BLE001
        _raise_service_error(exc)


@router.delete("/{project_id}")
@require_permission("workflows", "write")
async def close_project(project_id: str, request: Request):
    user_id = await _user(request)
    deleted = await get_project_service(request).close_project(project_id, user_id=user_id)
    if not deleted:
        raise HTTPException(status_code=404, detail="Project not found")
    return {"id": project_id, "deleted": True, "files_kept": True}


@router.get("/{project_id}/workbenches")
@require_permission("workflows", "read")
async def list_workbenches(project_id: str, request: Request):
    user_id = await _user(request)
    try:
        return await get_project_service(request).list_workbenches(project_id, user_id=user_id)
    except Exception as exc:  # noqa: BLE001
        _raise_service_error(exc)


@router.post("/{project_id}/workbenches")
@require_permission("workflows", "write")
async def create_workbench(project_id: str, request: Request, body: WorkbenchCreateRequest):
    user_id = await _user(request)
    try:
        return await get_project_service(request).create_workbench(
            project_id,
            user_id=user_id,
            name=body.name,
            description=body.description,
            layout=body.layout,
            settings=body.settings,
        )
    except Exception as exc:  # noqa: BLE001
        _raise_service_error(exc)


@router.get("/{project_id}/workbenches/{workbench_id}")
@require_permission("workflows", "read")
async def get_workbench(project_id: str, workbench_id: str, request: Request):
    user_id = await _user(request)
    try:
        return await get_project_service(request).get_workbench(project_id, workbench_id, user_id=user_id)
    except Exception as exc:  # noqa: BLE001
        _raise_service_error(exc)


@router.put("/{project_id}/workbenches/{workbench_id}")
@require_permission("workflows", "write")
async def update_workbench(project_id: str, workbench_id: str, request: Request, body: WorkbenchUpdateRequest):
    user_id = await _user(request)
    updates = body.model_dump(exclude_unset=True, exclude={"revision"})
    try:
        return await get_project_service(request).update_workbench(
            project_id,
            workbench_id,
            user_id=user_id,
            updates=updates,
            expected_revision=body.revision,
        )
    except Exception as exc:  # noqa: BLE001
        _raise_service_error(exc)


@router.delete("/{project_id}/workbenches/{workbench_id}")
@require_permission("workflows", "write")
async def delete_workbench(project_id: str, workbench_id: str, request: Request):
    user_id = await _user(request)
    try:
        deleted = await get_project_service(request).delete_workbench(project_id, workbench_id, user_id=user_id)
    except Exception as exc:  # noqa: BLE001
        _raise_service_error(exc)
    if not deleted:
        raise HTTPException(status_code=404, detail="Workbench not found")
    return {"id": workbench_id, "deleted": True}


@router.post("/{project_id}/workbenches/{workbench_id}/members")
@require_permission("workflows", "write")
async def add_workbench_member(project_id: str, workbench_id: str, request: Request, body: WorkbenchMemberRequest):
    user_id = await _user(request)
    try:
        return await get_project_service(request).add_member(
            project_id,
            workbench_id,
            user_id=user_id,
            definition_id=body.definition_id,
            settings=body.settings,
        )
    except Exception as exc:  # noqa: BLE001
        _raise_service_error(exc)


@router.delete("/{project_id}/workbenches/{workbench_id}/members/{definition_id}")
@require_permission("workflows", "write")
async def remove_workbench_member(project_id: str, workbench_id: str, definition_id: str, request: Request):
    user_id = await _user(request)
    try:
        removed = await get_project_service(request).remove_member(
            project_id,
            workbench_id,
            definition_id,
            user_id=user_id,
        )
    except Exception as exc:  # noqa: BLE001
        _raise_service_error(exc)
    if not removed:
        raise HTTPException(status_code=404, detail="Workbench member not found")
    return {"workbench_id": workbench_id, "definition_id": definition_id, "removed": True}


@router.post("/{project_id}/workbenches/{workbench_id}/runs", response_model=RunResponse)
@require_permission("runs", "create")
async def create_workbench_run(project_id: str, workbench_id: str, request: Request, body: WorkbenchRunRequest):
    """Launch a member workflow with the project/workbench snapshot in metadata."""
    user_id = await _user(request)
    service = get_project_service(request)
    try:
        project = await service.get_project(project_id, user_id=user_id)
        workbench = await service.get_workbench(project_id, workbench_id, user_id=user_id)
    except Exception as exc:  # noqa: BLE001
        _raise_service_error(exc)

    if not any(member["definition_id"] == body.definition_id for member in workbench["members"]):
        raise HTTPException(status_code=404, detail="Workflow is not a member of this workbench")

    definition_repo = get_workflow_definition_repo(request)
    row = await definition_repo.get(body.definition_id, user_id=user_id)
    if row is None:
        raise HTTPException(status_code=404, detail="Workflow definition not found")
    raw = row.get("definition") if isinstance(row, dict) else getattr(row, "definition", None)
    try:
        definition = WorkflowDefinition.model_validate(raw)
    except ValidationError as exc:
        raise HTTPException(status_code=422, detail={"errors": [str(exc)]}) from exc

    project_snapshot = dict(project.get("manifest") or {})
    project_snapshot["root_path"] = project["root_path"]
    metadata = {
        **body.metadata,
        "project_id": project_id,
        "project": project_snapshot,
        "workbench_id": workbench_id,
        "workbench": {
            "id": workbench_id,
            "project_id": project_id,
            "name": workbench["name"],
            "revision": workbench["revision"],
        },
    }
    record = await start_workflow_run(
        definition_id=body.definition_id,
        definition=definition,
        params=body.params,
        thread_id=f"wf-run-{uuid.uuid4().hex}",
        request=request,
        on_disconnect="continue",
        metadata=metadata,
        debug_step=body.debug_step,
        workbench_id=workbench_id,
    )
    return _record_to_response(record)
