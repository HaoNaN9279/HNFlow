"""Read-only VibeStack capability-group catalog API.

The panel lists every ``<name>/<version>`` package in the configured VibeStack
repository.  HNFlow does not provide create/update/delete endpoints for
capability groups; project activation is derived from workflow/workbench
selection and written to ``.vibestack/stack.json`` elsewhere.
"""

from __future__ import annotations

import asyncio

from fastapi import APIRouter, HTTPException, Query, Request
from pydantic import BaseModel, Field

from app.gateway.project_context import project_capability_scope
from deerflow.capability_groups import resolve_reveal_target, reveal_in_file_manager
from deerflow.capability_groups.vibestack import (
    VibeStackError,
    default_core,
    discover_repository_groups,
    find_group,
    resolve_repository,
)
from deerflow.runtime.user_context import get_effective_user_id

router = APIRouter(prefix="/api/capability-groups", tags=["capability-groups"])


class CapabilityGroupListResponse(BaseModel):
    repository: dict[str, object]
    core: dict[str, object]
    groups: list[dict[str, object]]
    warnings: list[str] = Field(default_factory=list)


class CapabilityGroupRevealRequest(BaseModel):
    path: str = Field(default=".", min_length=1, description="Group-relative POSIX path; '.' reveals the group root")


class CapabilityGroupRevealResponse(BaseModel):
    success: bool
    path: str


def _mark(summary: dict[str, object], *, core_name: str, active: dict[str, str]) -> dict[str, object]:
    name = str(summary.get("name") or "")
    version = str(summary.get("version") or "")
    summary["is_core"] = name == core_name
    summary["active"] = active.get(name) == version or (name == core_name and active.get(name) == version)
    return summary


async def _active_for_request(request: Request, project_id: str | None, user_id: str) -> dict[str, str]:
    if not project_id:
        core = default_core()
        return {core.name: core.version}
    scope = await project_capability_scope(request, project_id, user_id=user_id)
    return dict(scope.get("active") or {})


@router.get("", response_model=CapabilityGroupListResponse, summary="List VibeStack Capability Groups")
async def list_capability_groups(
    request: Request,
    project_id: str | None = Query(default=None, description="Project scope used to mark active groups"),
) -> CapabilityGroupListResponse:
    user_id = get_effective_user_id()
    try:
        repository = resolve_repository()
    except VibeStackError as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc
    active = await _active_for_request(request, project_id, user_id)
    core = default_core()
    if repository is None:
        return CapabilityGroupListResponse(
            repository={"path": None, "configured": False, "exists": False},
            core=core.to_dict(),
            groups=[],
            warnings=["VibeStack repository is not configured"],
        )

    def _load() -> list[dict[str, object]]:
        return [_mark(group.summary_dict(), core_name=core.name, active=active) for group in discover_repository_groups(repository)]

    groups = await asyncio.to_thread(_load)
    return CapabilityGroupListResponse(
        repository={"path": str(repository), "configured": True, "exists": (repository / "capability-groups").is_dir()},
        core=core.to_dict(),
        groups=groups,
    )


@router.get("/{group_id}", summary="Get Capability Group Contents")
async def get_capability_group(
    group_id: str,
    request: Request,
    version: str | None = Query(default=None, description="Explicit group version"),
    project_id: str | None = Query(default=None, description="Project scope used to mark active groups"),
) -> dict[str, object]:
    try:
        repository = resolve_repository()
        if repository is None:
            raise HTTPException(status_code=422, detail="VibeStack repository is not configured")
        active = await _active_for_request(request, project_id, get_effective_user_id())
        group = await asyncio.to_thread(find_group, repository, f"{group_id}@v{version}" if version else group_id, active=active)
    except VibeStackError as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc
    detail = group.detail_dict()
    detail["is_core"] = group.name == default_core().name
    detail["active"] = active.get(group.name) == group.version or detail["is_core"]
    return detail


@router.post("/{group_id}/reveal", response_model=CapabilityGroupRevealResponse, summary="Reveal Capability Group File")
async def reveal_capability_group_file(
    group_id: str,
    body: CapabilityGroupRevealRequest,
    request: Request,
    version: str | None = Query(default=None, description="Explicit group version"),
    project_id: str | None = Query(default=None, description="Project scope used to mark active groups"),
) -> CapabilityGroupRevealResponse:
    try:
        repository = resolve_repository()
        if repository is None:
            raise HTTPException(status_code=422, detail="VibeStack repository is not configured")
        active = await _active_for_request(request, project_id, get_effective_user_id())
        group = await asyncio.to_thread(find_group, repository, f"{group_id}@v{version}" if version else group_id, active=active)
    except VibeStackError as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc
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
