"""Application session / instance lifecycle (N4).

Owns the process-local map of live :class:`AppSession` instances and routes
operations to the driver declared by the application definition.  Slice 1
keeps sessions **in memory** (plan decision 4): durable instance records and
recovery are N6's job, so no half-persisted state exists here.

A session is exposed on a workflow port as a plain JSON dict
(:meth:`AppSession.to_port`) so it flows through the existing ``data`` port
type without a new ``PortType``.
"""

from __future__ import annotations

import logging
import threading
import time
import uuid
from dataclasses import dataclass, field
from typing import Any

from deerflow.apps.driver import AppDriver, AppDriverError, DriverLaunch, DriverScriptResult, DriverWaitResult
from deerflow.apps.registry import AppRegistry, get_app_registry

logger = logging.getLogger(__name__)


# ── Errors ─────────────────────────────────────────────────────────────────────


class AppError(RuntimeError):
    """Base error for the application access layer."""


class AppDisabledError(AppError):
    """Raised when the ``apps`` section is disabled or the app is unknown."""


class AppNotFoundError(AppError):
    """Raised when a referenced application is not registered."""


class AppSessionNotFoundError(AppError):
    """Raised when no live session matches the referenced application/session."""


# ── Session model ──────────────────────────────────────────────────────────────


@dataclass
class AppSession:
    """A live (or attached) application instance."""

    session_id: str
    app_name: str
    driver: str
    status: str  # "ready" | "attached" | "busy" | "crashed" | "stopped"
    pid: int | None = None
    endpoint: str | None = None
    handle: dict[str, Any] = field(default_factory=dict)
    exclusive: bool = True
    created_at: float = 0.0
    last_active: float = 0.0
    artifacts: list[str] = field(default_factory=list)

    def to_port(self) -> dict[str, Any]:
        """Serialize to a JSON-safe dict for the ``session`` workflow port."""
        return {
            "session_id": self.session_id,
            "app_name": self.app_name,
            "driver": self.driver,
            "status": self.status,
            "pid": self.pid,
            "endpoint": self.endpoint,
            "handle": dict(self.handle),
            "exclusive": self.exclusive,
        }

    @classmethod
    def from_port(cls, value: Any) -> AppSession | None:
        """Rebuild a session handle from a ``session`` port value, if shaped right."""
        if not isinstance(value, dict):
            return None
        session_id = value.get("session_id")
        app_name = value.get("app_name")
        if not isinstance(session_id, str) or not isinstance(app_name, str):
            return None
        handle = value.get("handle")
        return cls(
            session_id=session_id,
            app_name=app_name,
            driver=str(value.get("driver", "")),
            status=str(value.get("status", "ready")),
            pid=value.get("pid") if isinstance(value.get("pid"), int) else None,
            endpoint=value.get("endpoint"),
            handle=dict(handle) if isinstance(handle, dict) else {},
            exclusive=bool(value.get("exclusive", True)),
        )


# ── Manager ────────────────────────────────────────────────────────────────────


class AppSessionManager:
    """Process-local application instance/session manager."""

    def __init__(self, registry: AppRegistry | None = None) -> None:
        self._registry = registry if registry is not None else get_app_registry()
        self._sessions: dict[str, AppSession] = {}
        self._drivers: dict[str, AppDriver] = {}
        self._lock = threading.Lock()

    # -- registry helpers --

    @property
    def registry(self) -> AppRegistry:
        return self._registry

    def set_registry(self, registry: AppRegistry) -> None:
        """Replace the registry view (e.g. after a config reload)."""
        self._registry = registry

    def _require_definition(self, app_name: str):
        if not self._registry.enabled:
            raise AppDisabledError("the local-application layer is disabled (set apps.enabled=true)")
        definition = self._registry.get(app_name)
        if definition is None:
            raise AppNotFoundError(f"application {app_name!r} is not registered")
        return definition

    def _driver_for(self, app_name: str) -> AppDriver:
        definition = self._require_definition(app_name)
        with self._lock:
            driver = self._drivers.get(definition.driver)
            if driver is None:
                driver = self._registry.build_driver(app_name)
                self._drivers[definition.driver] = driver
        return driver

    # -- lifecycle --

    def launch(self, app_name: str, *, mode: str = "launch") -> AppSession:
        """Start a new instance or attach to an existing one.

        For an ``exclusive`` app, an existing live session is reused and its
        status reported as ``attached`` rather than leaking a second instance.
        """
        definition = self._require_definition(app_name)
        if definition.exclusive and mode != "attach":
            existing = self._active_session_for(app_name)
            if existing is not None:
                existing.status = "attached"
                existing.last_active = time.time()
                return existing

        driver = self._driver_for(app_name)
        launch: DriverLaunch = driver.launch(definition, mode=mode)
        now = time.time()
        session = AppSession(
            session_id=f"app-{uuid.uuid4().hex}",
            app_name=app_name,
            driver=driver.name,
            status=launch.status,
            pid=launch.pid,
            endpoint=launch.endpoint,
            handle=dict(launch.handle),
            exclusive=definition.exclusive,
            created_at=now,
            last_active=now,
        )
        with self._lock:
            self._sessions[session.session_id] = session
        return session

    def get(self, session_id: str) -> AppSession | None:
        with self._lock:
            return self._sessions.get(session_id)

    def list_sessions(self) -> list[AppSession]:
        with self._lock:
            return list(self._sessions.values())

    def _active_session_for(self, app_name: str) -> AppSession | None:
        with self._lock:
            candidates = [s for s in self._sessions.values() if s.app_name == app_name and s.status not in ("stopped", "crashed")]
        if not candidates:
            return None
        return max(candidates, key=lambda s: s.last_active)

    def resolve(self, app_name: str | None, session_port: Any = None) -> AppSession:
        """Resolve the session an app executor should operate on.

        Priority: an explicit ``session`` port value, then the app's most
        recently active live session.  Raises :class:`AppSessionNotFoundError`
        when neither yields a live session.
        """
        port_session = AppSession.from_port(session_port)
        if port_session is not None:
            live = self.get(port_session.session_id)
            if live is not None:
                return live
        if app_name:
            existing = self._active_session_for(app_name)
            if existing is not None:
                return existing
        target = app_name or (port_session.app_name if port_session else "<unknown>")
        raise AppSessionNotFoundError(f"no live session for application {target!r}; run an app:launch node first")

    def _definition_for_session(self, session: AppSession):
        return self._require_definition(session.app_name)

    # -- operations --

    def run_script(
        self,
        session: AppSession,
        *,
        script: str | None,
        args: list[str] | None = None,
        env: dict[str, str] | None = None,
    ) -> DriverScriptResult:
        driver = self._driver_for(session.app_name)
        definition = self._definition_for_session(session)
        session.status = "busy"
        try:
            result = driver.run_script(definition, DriverLaunch(status=session.status, pid=session.pid, endpoint=session.endpoint, handle=session.handle), script=script, args=list(args or []), env=env)
        finally:
            session.status = "ready"
            session.last_active = time.time()
        return result

    def wait(self, session: AppSession, *, reason: str | None = None, timeout: float | None = None) -> DriverWaitResult:
        driver = self._driver_for(session.app_name)
        definition = self._definition_for_session(session)
        result = driver.wait(definition, DriverLaunch(status=session.status, pid=session.pid, endpoint=session.endpoint, handle=session.handle), reason=reason, timeout=timeout)
        session.last_active = time.time()
        return result

    def collect(self, session: AppSession, *, globs: list[str] | None = None) -> list[str]:
        driver = self._driver_for(session.app_name)
        definition = self._definition_for_session(session)
        artifacts = driver.collect(definition, DriverLaunch(status=session.status, pid=session.pid, endpoint=session.endpoint, handle=session.handle), globs=globs)
        session.artifacts = list(artifacts)
        session.last_active = time.time()
        return artifacts

    def health(self, session: AppSession) -> bool:
        try:
            driver = self._driver_for(session.app_name)
            definition = self._definition_for_session(session)
            return driver.health(definition, DriverLaunch(status=session.status, pid=session.pid, endpoint=session.endpoint, handle=session.handle))
        except AppError:
            return False
        except AppDriverError:
            return False

    def close(self, session_id: str) -> bool:
        """Stop and forget a session.  Returns ``True`` when one was closed."""
        with self._lock:
            session = self._sessions.pop(session_id, None)
        if session is None:
            return False
        try:
            driver = self._driver_for(session.app_name)
            definition = self._definition_for_session(session)
            driver.close(definition, DriverLaunch(status=session.status, pid=session.pid, endpoint=session.endpoint, handle=session.handle))
        except Exception:  # noqa: BLE001 - best-effort teardown
            logger.warning("app session %s: driver close failed", session_id, exc_info=True)
        session.status = "stopped"
        return True

    def reset(self) -> None:
        """Stop every session and clear the map (tests / shutdown)."""
        for session in list(self.list_sessions()):
            self.close(session.session_id)


# ── Process-wide default manager ───────────────────────────────────────────────

_default_manager: AppSessionManager | None = None
_default_lock = threading.Lock()


def get_session_manager() -> AppSessionManager:
    """Return the process-wide session manager (built from current config)."""
    global _default_manager
    with _default_lock:
        if _default_manager is None:
            _default_manager = AppSessionManager()
        return _default_manager


def reset_session_manager() -> None:
    """Tear down and drop the process-wide session manager (tests / shutdown)."""
    global _default_manager
    with _default_lock:
        manager = _default_manager
        _default_manager = None
    if manager is not None:
        manager.reset()


__all__ = [
    "AppError",
    "AppDisabledError",
    "AppNotFoundError",
    "AppSessionNotFoundError",
    "AppSession",
    "AppSessionManager",
    "get_session_manager",
    "reset_session_manager",
]
