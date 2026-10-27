"""Project-scoped runtime context helpers shared by workflow routes."""

from __future__ import annotations

import asyncio
from pathlib import Path
from typing import Any

from fastapi import HTTPException, Request

from app.gateway.deps import get_project_service
from deerflow.capability_groups import capability_group_content_hash
from deerflow.capability_groups.resolve import resolve_project_plan
from deerflow.capability_groups.vibestack import (
    VibeStackError,
    active_versions,
    default_core,
    read_project_stack,
    resolve_repository,
)
from deerflow.projects import ProjectError, ProjectNotFoundError


def _raise_project_error(exc: Exception) -> None:
    if isinstance(exc, ProjectNotFoundError):
        raise HTTPException(status_code=404, detail=str(exc)) from exc
    if isinstance(exc, ProjectError):
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    raise exc


async def project_capability_scope(
    request: Request,
    project_id: str | None,
    *,
    user_id: str,
) -> dict[str, Any]:
    """Resolve the project's VibeStack repository, stack, and group closure."""
    if not project_id:
        return {"repository": None, "stack": None, "active": {}}
    try:
        project = await get_project_service(request).get_project(project_id, user_id=user_id)
    except Exception as exc:  # noqa: BLE001 - route boundary
        _raise_project_error(exc)
        raise
    root = project["root_path"]
    try:
        repository = resolve_repository()
        stack = read_project_stack(Path(root))
        plan = await asyncio.to_thread(resolve_project_plan, Path(root), repository=repository) if repository is not None and stack is not None and stack.groups else None
    except VibeStackError as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc
    if plan is not None and plan.core is not None:
        core = plan.core
    else:
        core = stack.core if stack is not None and stack.core is not None else default_core()
    active = plan.active_versions if plan is not None else active_versions(stack)
    if core.name not in active:
        active[core.name] = core.version
    return {
        "project_id": project_id,
        "root_path": root,
        "repository": str(repository) if repository is not None else None,
        "stack": stack.to_dict() if stack is not None else None,
        "core": {"name": core.name, "version": core.version},
        "active": active,
        "_plan": plan,
    }


async def project_run_metadata(
    request: Request,
    project_id: str,
    *,
    user_id: str,
) -> dict[str, Any]:
    """Return the project snapshot and resolved capability-group closure for a run."""
    scope = await project_capability_scope(request, project_id, user_id=user_id)
    try:
        service = get_project_service(request)
        project = await service.get_project(project_id, user_id=user_id)
        repository = resolve_repository()
        stack = read_project_stack(Path(scope["root_path"]))
        plan = scope.get("_plan")
        groups = list(plan.closure) if plan is not None else []
    except VibeStackError as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc
    snapshot = dict(project.get("manifest") or {})
    snapshot["root_path"] = project["root_path"]
    group_snapshot = [
        {
            "guid": group.guid,
            "name": group.name,
            "version": group.version,
            "source": group.source,
            "content_hash": capability_group_content_hash(group),
        }
        for group in groups
    ]
    return {
        "project_id": project_id,
        "project": snapshot,
        "vibestack_repository": str(repository) if repository is not None else None,
        "vibestack_mcp": [server.to_dict() for server in getattr(plan, "mcp", ())] if plan is not None else [],
        "vibestack_fingerprint": getattr(plan, "fingerprint", None) if plan is not None else None,
        "project_stack": stack.to_dict() if stack is not None else None,
        "capability_group_snapshot": group_snapshot,
    }
