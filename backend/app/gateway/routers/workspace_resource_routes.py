"""Lead Agent resource-change history and Undo endpoints."""

from __future__ import annotations

from fastapi import APIRouter, HTTPException, Query, Request
from pydantic import BaseModel, Field

from app.gateway.deps import get_optional_user_from_request
from app.gateway.permissions import require_permission
from deerflow.persistence.engine import get_session_factory
from deerflow.utils.thread_id import ThreadId
from deerflow.workspace import (
    WorkspaceResourceConflict,
    WorkspaceResourceError,
    WorkspaceResourceNotFound,
    WorkspaceResourceService,
    WorkspaceResourceValidationError,
    WorkspaceUndoConflict,
    WorkspaceUndoEmpty,
)

router = APIRouter(prefix="/api/threads/{thread_id}/resource-changes", tags=["workspace-resources"])


class WorkspaceUndoRequest(BaseModel):
    change_id: str | None = Field(default=None, description="Optional change id; defaults to the latest run group.")
    dry_run: bool = Field(default=False, description="Report the undo plan without changing anything.")


async def _service(request: Request) -> WorkspaceResourceService:
    user = await get_optional_user_from_request(request)
    if user is None:
        raise HTTPException(status_code=401, detail="Authentication required")
    session_factory = get_session_factory()
    if session_factory is None:
        raise HTTPException(status_code=503, detail="Resource change history requires a SQL database backend")
    return WorkspaceResourceService(session_factory, user_id=str(user.id))


def _http_error(exc: Exception) -> HTTPException:
    if isinstance(exc, WorkspaceResourceNotFound):
        return HTTPException(status_code=404, detail=str(exc))
    if isinstance(exc, WorkspaceUndoConflict):
        return HTTPException(status_code=409, detail={"error": "undo_conflict", "conflicts": exc.conflicts})
    if isinstance(exc, WorkspaceUndoEmpty):
        return HTTPException(status_code=409, detail={"error": "nothing_to_undo", "message": str(exc)})
    if isinstance(exc, WorkspaceResourceValidationError):
        return HTTPException(status_code=422, detail={"error": "validation_failed", "errors": exc.errors})
    if isinstance(exc, WorkspaceResourceConflict):
        return HTTPException(status_code=409, detail={"error": "conflict", "message": str(exc)})
    if isinstance(exc, WorkspaceResourceError):
        return HTTPException(status_code=400, detail=str(exc))
    return HTTPException(status_code=500, detail=f"{type(exc).__name__}: {exc}")


@router.get("")
@require_permission("threads", "read")
async def list_resource_changes(
    thread_id: ThreadId,
    request: Request,
    limit: int = Query(default=50, ge=1, le=200),
):
    """Return this conversation's resource changes and latest undoable group."""
    service = await _service(request)
    try:
        return await service.list_changes(thread_id=thread_id, limit=limit)
    except Exception as exc:  # noqa: BLE001 - API boundary
        raise _http_error(exc) from exc


@router.post("/undo")
@require_permission("threads", "write")
async def undo_resource_changes(thread_id: ThreadId, request: Request, body: WorkspaceUndoRequest | None = None):
    """Undo the latest completed Lead Agent turn's resource changes."""
    service = await _service(request)
    payload = body or WorkspaceUndoRequest()
    try:
        return await service.undo(thread_id=thread_id, change_id=payload.change_id, dry_run=payload.dry_run)
    except Exception as exc:  # noqa: BLE001 - API boundary
        raise _http_error(exc) from exc
