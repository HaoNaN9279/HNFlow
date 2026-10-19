"""Capability-group management API.

Capability groups are versioned packages that own rules, agents, skills, tools
and other resources; a skill is a child resource, not a group.
"""

from __future__ import annotations

import asyncio
from pathlib import Path

from fastapi import APIRouter, HTTPException, Query
from pydantic import BaseModel, Field

from deerflow.capability_groups import (
    CapabilityGroup,
    CapabilityGroupError,
    discover_capability_groups,
    load_capability_group,
    reveal_in_file_manager,
)
from deerflow.runtime.user_context import get_effective_user_id

router = APIRouter(prefix="/api/capability-groups", tags=["capability-groups"])


class CapabilityGroupListResponse(BaseModel):
    groups: list[dict[str, object]]


class CapabilityGroupRevealRequest(BaseModel):
    path: str = Field(..., min_length=1, description="Group-relative POSIX path")


class CapabilityGroupRevealResponse(BaseModel):
    success: bool
    path: str


async def _group_or_404(identifier: str, *, version: str | None) -> CapabilityGroup:
    try:
        return await asyncio.to_thread(load_capability_group, identifier, version=version, user_id=get_effective_user_id())
    except CapabilityGroupError as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc


@router.get("", response_model=CapabilityGroupListResponse, summary="List Capability Groups")
async def list_capability_groups() -> CapabilityGroupListResponse:
    def _load() -> list[dict[str, object]]:
        return [group.summary_dict() for group in discover_capability_groups(user_id=get_effective_user_id())]

    try:
        groups = await asyncio.to_thread(_load)
    except Exception as exc:  # noqa: BLE001 - API boundary
        raise HTTPException(status_code=500, detail=f"Failed to load capability groups: {exc}") from exc
    return CapabilityGroupListResponse(groups=groups)


@router.get("/{group_id}", summary="Get Capability Group Contents")
async def get_capability_group(
    group_id: str,
    version: str | None = Query(default=None, description="Explicit group version"),
) -> dict[str, object]:
    group = await _group_or_404(group_id, version=version)

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
    version: str | None = Query(default=None, description="Explicit group version"),
) -> CapabilityGroupRevealResponse:
    group = await _group_or_404(group_id, version=version)
    relative = body.path.replace("\\", "/")
    if relative.startswith("/") or ".." in Path(relative).parts:
        raise HTTPException(status_code=400, detail="path must be relative to the capability group")
    root = group.root.resolve()
    target = (root / relative).resolve()
    if not target.is_relative_to(root):
        raise HTTPException(status_code=400, detail="path escapes the capability group")
    if not target.is_file():
        raise HTTPException(status_code=404, detail=f"file not found: {relative}")
    try:
        await asyncio.to_thread(reveal_in_file_manager, target)
    except (FileNotFoundError, OSError, RuntimeError) as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    return CapabilityGroupRevealResponse(success=True, path=relative)
