"""Local-application registry + instance endpoints (N4/N6).

- ``GET /api/apps`` — the registered applications and whether each driver can
  operate them.
- ``GET /api/apps/sessions`` — instance records. On a SQL backend these are the
  durable ``app_instances`` rows (with live status merged in and ``?status=`` /
  ``?include_archived=`` / ``?include_orphaned=`` filters); on the memory
  backend they fall back to the current live sessions.
- ``GET /api/apps/sessions/{id}`` — one instance.
- ``POST /api/apps/sessions/{id}/close`` — stop the live session (if in memory)
  and persist ``stopped``.
- ``POST /api/apps/sessions/{id}/archive`` — archive a non-live instance.
- ``DELETE /api/apps/sessions/{id}`` — delete the record.
- ``POST /api/apps/sessions/cleanup`` — delete terminal records older than the
  configured retention window (``apps.session_retention_days``).

The registry read goes through the request-scoped ``AppConfig`` so an operator
editing ``config.yaml`` sees new definitions on the next request. The instance
*management* routes require a SQL backend (503 on ``database.backend: memory``);
the read-only list falls back to live sessions.
"""

from datetime import UTC, datetime

from fastapi import APIRouter, Depends, HTTPException, Query, Request
from pydantic import BaseModel, Field

from app.gateway.deps import get_app_instance_repo, get_config
from deerflow.apps.registry import AppRegistry
from deerflow.apps.session import AppSession, AppSessionManager, get_session_manager
from deerflow.config.app_config import AppConfig
from deerflow.persistence.app_instances import CLEANUP_STATUSES
from deerflow.runtime.user_context import DEFAULT_USER_ID

router = APIRouter(prefix="/api/apps", tags=["apps"])


class AppInfo(BaseModel):
    """One registered application."""

    name: str
    driver: str
    description: str = ""
    available: bool = Field(..., description="Whether the declared driver can operate this application")
    error: str | None = Field(default=None, description="Driver construction error, when unavailable")


class AppsListResponse(BaseModel):
    """The application registry."""

    enabled: bool
    apps: list[AppInfo]


class AppInstanceInfo(BaseModel):
    """One application instance record (durable row or a live in-memory session)."""

    session_id: str
    app_name: str
    driver: str
    status: str
    pid: int | None = None
    endpoint: str | None = None
    exclusive: bool = True
    created_at: str | None = None
    last_active: str | None = None
    artifacts: list[str] = Field(default_factory=list)
    resources: dict = Field(default_factory=dict)
    archived: bool = False
    live: bool = False


class AppInstancesResponse(BaseModel):
    """Instance records."""

    sessions: list[AppInstanceInfo]
    persisted: bool = Field(..., description="True when the list comes from the durable store (SQL backend)")


class CleanupRequest(BaseModel):
    """Optional overrides for the retention sweep."""

    older_than_days: int | None = Field(default=None, ge=0, description="Defaults to apps.session_retention_days.")
    statuses: list[str] | None = Field(default=None, description="Statuses to sweep. Defaults to the terminal set.")


class CleanupResponse(BaseModel):
    removed: int


# ── helpers ──────────────────────────────────────────────────────────────────


def _epoch_iso(value: float | None) -> str | None:
    if not value:
        return None
    return datetime.fromtimestamp(value, tz=UTC).isoformat()


def _session_info(session: AppSession, *, live: bool) -> AppInstanceInfo:
    return AppInstanceInfo(
        session_id=session.session_id,
        app_name=session.app_name,
        driver=session.driver,
        status=session.status,
        pid=session.pid,
        endpoint=session.endpoint,
        exclusive=session.exclusive,
        created_at=_epoch_iso(session.created_at),
        last_active=_epoch_iso(session.last_active),
        artifacts=list(session.artifacts),
        resources={},
        archived=session.status == "archived",
        live=live,
    )


def _row_info(row: dict, *, live: bool) -> AppInstanceInfo:
    return AppInstanceInfo(
        session_id=row["id"],
        app_name=row["app_name"],
        driver=row["driver"],
        status=row["status"],
        pid=row.get("pid"),
        endpoint=row.get("endpoint"),
        exclusive=bool(row.get("exclusive", True)),
        created_at=row.get("created_at"),
        last_active=row.get("last_active"),
        artifacts=list(row.get("artifacts") or []),
        resources=dict(row.get("resources") or {}),
        archived=row.get("status") == "archived",
        live=live,
    )


def _live_by_id(manager: AppSessionManager) -> dict[str, AppSession]:
    return {session.session_id: session for session in manager.list_sessions()}


# ── registry ─────────────────────────────────────────────────────────────────


@router.get(
    "",
    response_model=AppsListResponse,
    summary="List Local Applications",
    description="List the registered local applications and whether each one's driver can operate it.",
)
async def list_apps(config: AppConfig = Depends(get_config)) -> AppsListResponse:
    registry = AppRegistry.from_config(config.apps)
    return AppsListResponse(enabled=config.apps.enabled, apps=[AppInfo(**entry) for entry in registry.describe()])


# ── instances ────────────────────────────────────────────────────────────────


@router.get(
    "/sessions",
    response_model=AppInstancesResponse,
    summary="List Local Application Sessions",
    description="List application instance records. Durable on a SQL backend; live in-memory sessions on the memory backend.",
)
async def list_app_sessions(
    request: Request,
    status: str | None = Query(default=None, description="Filter by a single status."),
    include_archived: bool = Query(default=True, description="Include archived instances."),
    include_orphaned: bool = Query(default=True, description="Include orphaned instances."),
) -> AppInstancesResponse:
    repo = getattr(request.app.state, "app_instance_repo", None)
    live = _live_by_id(get_session_manager())

    if repo is None:
        sessions = [session for session in live.values() if _matches(session.status, status, include_archived, include_orphaned)]
        return AppInstancesResponse(sessions=[_session_info(s, live=True) for s in sessions], persisted=False)

    rows = await repo.list_by_user(DEFAULT_USER_ID, status=status, include_archived=include_archived, include_orphaned=include_orphaned)
    infos = []
    for row in rows:
        session = live.get(row["id"])
        if session is not None:
            info = _session_info(session, live=True)
            info.resources = dict(row.get("resources") or {})
            infos.append(info)
        else:
            infos.append(_row_info(row, live=False))
    return AppInstancesResponse(sessions=infos, persisted=True)


def _matches(status_value: str, status: str | None, include_archived: bool, include_orphaned: bool) -> bool:
    if status is not None:
        return status_value == status
    if not include_archived and status_value == "archived":
        return False
    if not include_orphaned and status_value == "orphaned":
        return False
    return True


@router.get(
    "/sessions/{session_id}",
    response_model=AppInstanceInfo,
    summary="Get Local Application Session",
    description="Return one application instance record.",
)
async def get_app_session(session_id: str, request: Request) -> AppInstanceInfo:
    repo = getattr(request.app.state, "app_instance_repo", None)
    live_session = get_session_manager().get(session_id)
    if repo is None:
        if live_session is None:
            raise HTTPException(status_code=404, detail="App instance not found")
        return _session_info(live_session, live=True)

    row = await repo.get(session_id, user_id=DEFAULT_USER_ID)
    if row is None:
        raise HTTPException(status_code=404, detail="App instance not found")
    if live_session is not None:
        info = _session_info(live_session, live=True)
        info.resources = dict(row.get("resources") or {})
        return info
    return _row_info(row, live=False)


@router.post(
    "/sessions/{session_id}/close",
    response_model=AppInstanceInfo,
    summary="Close Local Application Session",
    description="Stop the live session (if in memory) and persist the stopped status.",
)
async def close_app_session(session_id: str, request: Request) -> AppInstanceInfo:
    manager = get_session_manager()
    repo = getattr(request.app.state, "app_instance_repo", None)

    live_session = manager.get(session_id)
    if live_session is not None:
        manager.close(session_id)

    row = await repo.get(session_id, user_id=DEFAULT_USER_ID) if repo is not None else None
    if row is None:
        if live_session is None:
            raise HTTPException(status_code=404, detail="App instance not found")
        # No durable row: report the now-stopped live session without persisting.
        return _session_info(live_session, live=False)

    if repo is not None and row["status"] not in ("stopped", "archived"):
        updated = await repo.set_status(session_id, user_id=DEFAULT_USER_ID, to_status="stopped", allowed_from=("launching", "ready", "attached", "busy", "crashed", "orphaned"))
        if updated is not None:
            row = updated
    return _row_info(row, live=False)


@router.post(
    "/sessions/{session_id}/archive",
    response_model=AppInstanceInfo,
    summary="Archive Local Application Session",
    description="Archive a non-live instance record (409 while the instance is live).",
)
async def archive_app_session(session_id: str, request: Request, repo=Depends(get_app_instance_repo)) -> AppInstanceInfo:
    archived = await repo.archive(session_id, user_id=DEFAULT_USER_ID)
    if archived is None:
        existing = await repo.get(session_id, user_id=DEFAULT_USER_ID)
        if existing is None:
            raise HTTPException(status_code=404, detail="App instance not found")
        raise HTTPException(status_code=409, detail="Cannot archive a live instance; close it first")
    return _row_info(archived, live=False)


@router.delete(
    "/sessions/{session_id}",
    status_code=204,
    summary="Delete Local Application Session",
    description="Delete an instance record.",
)
async def delete_app_session(session_id: str, repo=Depends(get_app_instance_repo)) -> None:
    if not await repo.delete(session_id, user_id=DEFAULT_USER_ID):
        raise HTTPException(status_code=404, detail="App instance not found")


@router.post(
    "/sessions/cleanup",
    response_model=CleanupResponse,
    summary="Cleanup Local Application Sessions",
    description="Delete terminal instance records idle longer than the retention window.",
)
async def cleanup_app_sessions(body: CleanupRequest | None = None, repo=Depends(get_app_instance_repo), config: AppConfig = Depends(get_config)) -> CleanupResponse:
    body = body or CleanupRequest()
    older_than_days = body.older_than_days if body.older_than_days is not None else config.apps.session_retention_days
    statuses = tuple(body.statuses) if body.statuses else CLEANUP_STATUSES
    removed = await repo.cleanup(older_than_days=older_than_days, user_id=DEFAULT_USER_ID, statuses=statuses)
    return CleanupResponse(removed=removed)
