"""Local-application registry and session read endpoints (N4).

Read-only surface for the workflow canvas / frontend:

- ``GET /api/apps`` — the registered applications and whether each driver can
  operate them.
- ``GET /api/apps/sessions`` — the current live sessions (process-local; slice
  1 keeps sessions in memory — durable instance management is N6).

Both read through the request-scoped ``AppConfig`` so an operator editing
``config.yaml`` sees the new definitions on the next request (the ``apps``
section is restart-required for *driving* — the drivers' lifecycle — but the
registry view itself is cheap to rebuild for reporting).
"""

from fastapi import APIRouter, Depends
from pydantic import BaseModel, Field

from app.gateway.deps import get_config
from deerflow.apps.registry import AppRegistry
from deerflow.apps.session import get_session_manager
from deerflow.config.app_config import AppConfig

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


class AppSessionInfo(BaseModel):
    """One live application session/instance."""

    session_id: str
    app_name: str
    driver: str
    status: str
    pid: int | None = None
    endpoint: str | None = None
    exclusive: bool = True
    created_at: float
    last_active: float
    artifacts: list[str] = Field(default_factory=list)


class AppSessionsResponse(BaseModel):
    """Currently live application sessions."""

    sessions: list[AppSessionInfo]


@router.get(
    "",
    response_model=AppsListResponse,
    summary="List Local Applications",
    description="List the registered local applications and whether each one's driver can operate it.",
)
async def list_apps(config: AppConfig = Depends(get_config)) -> AppsListResponse:
    registry = AppRegistry.from_config(config.apps)
    return AppsListResponse(enabled=config.apps.enabled, apps=[AppInfo(**entry) for entry in registry.describe()])


@router.get(
    "/sessions",
    response_model=AppSessionsResponse,
    summary="List Local Application Sessions",
    description="List the live local-application sessions (process-local, in-memory in this slice).",
)
async def list_app_sessions() -> AppSessionsResponse:
    manager = get_session_manager()
    sessions = [
        AppSessionInfo(
            session_id=session.session_id,
            app_name=session.app_name,
            driver=session.driver,
            status=session.status,
            pid=session.pid,
            endpoint=session.endpoint,
            exclusive=session.exclusive,
            created_at=session.created_at,
            last_active=session.last_active,
            artifacts=list(session.artifacts),
        )
        for session in manager.list_sessions()
    ]
    return AppSessionsResponse(sessions=sessions)
