"""Capability-group management API.

Capability groups are versioned packages that own rules, agents, skills and
other resources; a skill is a child resource, not a group.  Tools are a
separate first-class layer referenced by ``group.json.tools``.
"""

from __future__ import annotations

import asyncio

from fastapi import APIRouter, HTTPException, Query, Request
from pydantic import BaseModel, Field

from app.gateway.deps import get_project_service
from deerflow.capability_groups import (
    CapabilityGroup,
    CapabilityGroupError,
    CapabilityGroupRoot,
    discover_capability_groups,
    load_capability_group,
    resolve_reveal_target,
    reveal_in_file_manager,
)
from deerflow.projects.service import ProjectError, ProjectNotFoundError
from deerflow.runtime.user_context import get_effective_user_id

router = APIRouter(prefix="/api/capability-groups", tags=["capability-groups"])


class CapabilityGroupListResponse(BaseModel):
    groups: list[dict[str, object]]


class CapabilityGroupRevealRequest(BaseModel):
    path: str = Field(
        default=".",
        min_length=1,
        description="Group-relative POSIX path; '.' reveals the group root",
    )


class CapabilityGroupRevealResponse(BaseModel):
    success: bool
    path: str


def _raise_project_error(exc: Exception) -> None:
    if isinstance(exc, ProjectNotFoundError):
        raise HTTPException(status_code=404, detail=str(exc)) from exc
    if isinstance(exc, ProjectError):
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    raise exc


async def _project_roots(request: Request, project_id: str | None, user_id: str) -> list[CapabilityGroupRoot]:
    if not project_id:
        return []
    try:
        return await get_project_service(request).capability_group_roots(project_id, user_id=user_id)
    except Exception as exc:  # noqa: BLE001 - translate the project contract
        _raise_project_error(exc)
        raise


async def _group_or_404(
    identifier: str,
    *,
    version: str | None,
    project_roots: list[CapabilityGroupRoot],
) -> CapabilityGroup:
    try:
        return await asyncio.to_thread(
            load_capability_group,
            identifier,
            version=version,
            user_id=get_effective_user_id(),
            project_roots=project_roots,
        )
    except CapabilityGroupError as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc


@router.get("", response_model=CapabilityGroupListResponse, summary="List Capability Groups")
async def list_capability_groups(
    request: Request,
    project_id: str | None = Query(default=None, description="Project scope for project-specific capability groups"),
) -> CapabilityGroupListResponse:
    user_id = get_effective_user_id()
    project_roots = await _project_roots(request, project_id, user_id)

    def _load() -> list[dict[str, object]]:
        return [group.summary_dict() for group in discover_capability_groups(user_id=user_id, project_roots=project_roots)]

    try:
        groups = await asyncio.to_thread(_load)
    except Exception as exc:  # noqa: BLE001 - API boundary
        raise HTTPException(status_code=500, detail=f"Failed to load capability groups: {exc}") from exc
    return CapabilityGroupListResponse(groups=groups)


@router.get("/{group_id}", summary="Get Capability Group Contents")
async def get_capability_group(
    group_id: str,
    request: Request,
    version: str | None = Query(default=None, description="Explicit group version"),
    project_id: str | None = Query(default=None, description="Project scope for project-specific capability groups"),
) -> dict[str, object]:
    project_roots = await _project_roots(request, project_id, get_effective_user_id())
    group = await _group_or_404(group_id, version=version, project_roots=project_roots)

    def _load() -> dict[str, object]:
        return group.detail_dict()

    try:
        return await asyncio.to_thread(_load)
    except Exception as exc:  # noqa: BLE001 - API boundary
        raise HTTPException(status_code=500, detail=f"Failed to read capability group: {exc}") from exc


@router.post("/{group_id}/reveal", response_model=CapabilityGroupRevealResponse, summary="Reveal Capability Group File")
async def reveal_capability_group_file(
    group_id: str,
    body: CapabilityGroupRevealRequest,
    request: Request,
    version: str | None = Query(default=None, description="Explicit group version"),
    project_id: str | None = Query(default=None, description="Project scope for project-specific capability groups"),
) -> CapabilityGroupRevealResponse:
    project_roots = await _project_roots(request, project_id, get_effective_user_id())
    group = await _group_or_404(group_id, version=version, project_roots=project_roots)
    relative = body.path.replace("\\", "/")
    try:
        target = resolve_reveal_target(group.root, relative)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    if not target.exists():
        raise HTTPException(status_code=404, detail=f"path not found: {relative}")
    try:
        await asyncio.to_thread(reveal_in_file_manager, target)
    except (FileNotFoundError, OSError, RuntimeError) as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    return CapabilityGroupRevealResponse(success=True, path=relative)
