"""Workflow directory folders (arbitrary nesting)."""

from __future__ import annotations

from fastapi import APIRouter, HTTPException, Request
from pydantic import BaseModel, Field

from app.gateway.deps import get_optional_user_from_request, get_workflow_folder_repo
from app.gateway.permissions import require_permission
from deerflow.persistence.workflow_folders import (
    FolderConflictError,
    FolderCycleError,
    FolderNotEmptyError,
    FolderNotFoundError,
)

router = APIRouter(prefix="/api/workflow-folders", tags=["workflow-folders"])


class FolderCreateRequest(BaseModel):
    name: str = Field(min_length=1, max_length=255)
    parent_id: str | None = None


class FolderUpdateRequest(BaseModel):
    name: str | None = Field(default=None, min_length=1, max_length=255)
    parent_id: str | None = None


async def _user(request: Request):
    user = await get_optional_user_from_request(request)
    if user is None:
        raise HTTPException(status_code=401, detail="Authentication required")
    return user


@router.get("")
@require_permission("workflows", "read")
async def list_folders(request: Request):
    user = await _user(request)
    repo = get_workflow_folder_repo(request)
    return await repo.list_by_user(str(user.id))


@router.post("")
@require_permission("workflows", "write")
async def create_folder(request: Request, body: FolderCreateRequest):
    user = await _user(request)
    repo = get_workflow_folder_repo(request)
    try:
        return await repo.create(user_id=str(user.id), name=body.name, parent_id=body.parent_id)
    except FolderNotFoundError as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc
    except FolderConflictError as exc:
        raise HTTPException(status_code=409, detail=str(exc)) from exc


@router.get("/{folder_id}")
@require_permission("workflows", "read")
async def get_folder(folder_id: str, request: Request):
    user = await _user(request)
    repo = get_workflow_folder_repo(request)
    folder = await repo.get(folder_id, user_id=str(user.id))
    if folder is None:
        raise HTTPException(status_code=404, detail="Folder not found")
    return folder


@router.put("/{folder_id}")
@require_permission("workflows", "write")
async def update_folder(folder_id: str, request: Request, body: FolderUpdateRequest):
    user = await _user(request)
    repo = get_workflow_folder_repo(request)
    try:
        folder = await repo.update(
            folder_id,
            user_id=str(user.id),
            name=body.name,
            parent_id=body.parent_id,
            parent_id_set="parent_id" in body.model_fields_set,
        )
    except FolderNotFoundError as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc
    except (FolderConflictError, FolderCycleError) as exc:
        raise HTTPException(status_code=409, detail=str(exc)) from exc
    if folder is None:
        raise HTTPException(status_code=404, detail="Folder not found")
    return folder


@router.delete("/{folder_id}")
@require_permission("workflows", "write")
async def delete_folder(folder_id: str, request: Request):
    user = await _user(request)
    repo = get_workflow_folder_repo(request)
    try:
        deleted = await repo.delete(folder_id, user_id=str(user.id))
    except FolderNotEmptyError as exc:
        raise HTTPException(status_code=409, detail=str(exc)) from exc
    if not deleted:
        raise HTTPException(status_code=404, detail="Folder not found")
    return {"id": folder_id, "deleted": True}
