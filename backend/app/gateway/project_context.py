"""Project-scoped runtime context helpers shared by workflow routes."""

from __future__ import annotations

from typing import Any

from fastapi import HTTPException, Request

from app.gateway.deps import get_project_service
from deerflow.capability_groups import CapabilityGroupRoot, capability_group_content_hash, discover_capability_groups
from deerflow.projects import ProjectError, ProjectNotFoundError


def _raise_project_error(exc: Exception) -> None:
    if isinstance(exc, ProjectNotFoundError):
        raise HTTPException(status_code=404, detail=str(exc)) from exc
    if isinstance(exc, ProjectError):
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    raise exc


async def project_capability_group_roots(
    request: Request,
    project_id: str | None,
    *,
    user_id: str,
) -> list[CapabilityGroupRoot]:
    if not project_id:
        return []
    try:
        return await get_project_service(request).capability_group_roots(project_id, user_id=user_id)
    except Exception as exc:  # noqa: BLE001 - route boundary
        _raise_project_error(exc)
        raise


async def project_run_metadata(
    request: Request,
    project_id: str,
    *,
    user_id: str,
) -> dict[str, Any]:
    """Return the project snapshot and resolved capability-group roots for a run."""
    try:
        service = get_project_service(request)
        project = await service.get_project(project_id, user_id=user_id)
        roots = await service.capability_group_roots(project_id, user_id=user_id)
    except Exception as exc:  # noqa: BLE001 - route boundary
        _raise_project_error(exc)
        raise
    snapshot = dict(project.get("manifest") or {})
    snapshot["root_path"] = project["root_path"]
    groups = discover_capability_groups(user_id=user_id, project_roots=roots)
    group_snapshot = [
        {
            "guid": group.guid,
            "name": group.name,
            "version": group.version,
            "source": group.source,
            "project_id": group.project_id,
            "root_id": group.root_id,
            "content_hash": capability_group_content_hash(group),
        }
        for group in groups
    ]
    return {
        "project_id": project_id,
        "project": snapshot,
        "capability_group_roots": [root.to_dict() for root in roots],
        "capability_group_snapshot": group_snapshot,
    }
