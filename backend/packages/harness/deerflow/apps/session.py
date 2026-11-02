"""Application session / instance lifecycle (N4).

Owns the process-local map of live :class:`AppSession` instances and routes
operations to the driver declared by the application definition.  Slice 1
keeps sessions **in memory** (plan decision 4): durable instance records and
recovery are N6's job, so no half-persisted state exists here.
N8 adds **admission control**: the manager is the single choke point every
application operation passes through (``app:*`` executors and the tool
gateway's ``app`` provider both call it), so the declared GPU/CPU/memory/disk
demand and license slots are enforced here — an instance holds its license slot
for life, an operation holds its numeric demand for its duration.
N10b adds **human/machine sharing control** (§17): before the engine takes an
application it does not already hold, the application's declared presence probe
answers who is using it, the pure decision table in
:mod:`deerflow.apps.presence` turns that plus the configured policy into an
outcome, and a ``wait`` queues here.  Presence lives at the same choke point as
the quota, so both entry points are governed by one implementation.

A session is exposed on a workflow port as a plain JSON dict
(:meth:`AppSession.to_port`) so it flows through the existing ``data`` port
type without a new ``PortType``.
"""

from __future__ import annotations

import logging
import threading
import time
import uuid
from dataclasses import dataclass, field, replace
from typing import Any

from deerflow.apps.driver import AppDriver, AppDriverError, DriverLaunch, DriverScriptResult, DriverUndoResult, DriverWaitResult, driver_presence, driver_supports_undo, driver_undo
from deerflow.apps.presence import (
    ACCESS_WAIT,
    HOLDER_HUMAN,
    HOLDER_MACHINE,
    HOLDERS,
    HUMAN_CONFLICT_FAIL,
    SOURCE_CACHE,
    AccessDecision,
    PresenceReport,
    decide_access,
    holder_for,
)
from deerflow.apps.registry import AppRegistry, get_app_registry
from deerflow.resources.governor import ResourceDemand, ResourceGovernor, ResourceLease

logger = logging.getLogger(__name__)

#: How long a presence answer may be reused before the application is asked
#: again.  A probe spawns a process, so the `/api/apps` style read path must not
#: probe per request; the acquisition path always probes fresh.
_PRESENCE_CACHE_SECONDS = 5.0

#: How often a ``wait`` human-conflict admission re-probes while it queues.
_PRESENCE_POLL_SECONDS = 0.5


# ── Errors ─────────────────────────────────────────────────────────────────────


class AppError(RuntimeError):
    """Base error for the application access layer."""


class AppDisabledError(AppError):
    """Raised when the ``apps`` section is disabled or the app is unknown."""


class AppNotFoundError(AppError):
    """Raised when a referenced application is not registered."""


class AppSessionNotFoundError(AppError):
    """Raised when no live session matches the referenced application/session."""


class AppHumanPresentError(AppError):
    """Raised when a person holds the application and the policy refuses (N10b).

    Carries the observed state and the knob to change so the node failure is
    actionable: the N7 retry/backoff path can retry later, and the operator can
    switch ``apps.on_human_conflict`` (or declare ``allow_preempt``) if taking
    the software over is actually intended.
    """

    def __init__(self, app_name: str, decision: AccessDecision) -> None:
        self.app_name = app_name
        self.decision = decision
        super().__init__(f"application {app_name!r} is not free: {decision.reason} (observed presence: {decision.presence.state}); set apps.on_human_conflict, or declare the application's allow_preempt, if taking it over is intended")


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
    #: N10b (§17): who holds this instance — the engine (:data:`HOLDER_MACHINE`),
    #: a person it attached to or took over from (:data:`HOLDER_HUMAN`), or an
    #: acquisition made while presence could not be determined
    #: (:data:`HOLDER_UNKNOWN`).  This is what the engine *knew when it acquired*,
    #: not a live claim: the live answer is served by ``probe_presence``.
    holder: str = HOLDER_MACHINE
    #: ``"human"`` while this instance is held as a take-over from a person;
    #: cleared by :meth:`AppSessionManager.release`.
    taken_over_from: str | None = None
    #: When the take-over happened (epoch seconds; 0.0 when there was none).
    taken_over_at: float = 0.0
    #: How many operations on this instance ran against an oversubscribed
    #: quota (N8 ``on_conflict: degrade``). Process-local observation only —
    #: deliberately *not* part of the ``to_port`` contract.
    degraded_operations: int = 0
    #: Whether the most recent ``launch`` call itself was admitted by degrading
    #: (N8). Reset on every launch, including the attach path. Not serialized.
    launch_degraded: bool = False
    #: The license slot held for this instance's life (N8). Never serialized.
    resource_lease: ResourceLease | None = field(default=None, repr=False, compare=False)

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
            "holder": self.holder,
            "taken_over_from": self.taken_over_from,
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
        holder = value.get("holder")
        taken_over_from = value.get("taken_over_from")
        return cls(
            session_id=session_id,
            app_name=app_name,
            driver=str(value.get("driver", "")),
            status=str(value.get("status", "ready")),
            pid=value.get("pid") if isinstance(value.get("pid"), int) else None,
            endpoint=value.get("endpoint"),
            handle=dict(handle) if isinstance(handle, dict) else {},
            exclusive=bool(value.get("exclusive", True)),
            # A port value written before N10b carries no holder; the engine's own
            # session is the safe reading for a handle that resolved nothing.
            holder=holder if isinstance(holder, str) and holder in HOLDERS else HOLDER_MACHINE,
            taken_over_from=taken_over_from if isinstance(taken_over_from, str) else None,
        )


# ── Manager ────────────────────────────────────────────────────────────────────


class AppSessionManager:
    """Process-local application instance/session manager."""

    def __init__(self, registry: AppRegistry | None = None, *, governor: ResourceGovernor | None = None) -> None:
        self._registry = registry if registry is not None else get_app_registry()
        self._governor = governor
        self._sessions: dict[str, AppSession] = {}
        self._drivers: dict[str, AppDriver] = {}
        self._lock = threading.Lock()
        #: Short-lived presence answers, keyed by application name (N10b).
        self._presence_cache: dict[str, tuple[float, PresenceReport]] = {}

    @property
    def governor(self) -> ResourceGovernor | None:
        """The admission gate this manager enforces (``None`` = ungoverned)."""
        return self._governor

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
        Reattaching does **not** take a second license slot (the live instance
        already holds one); creating a new instance does.

        N10b: reuse of a session the engine already holds never consults
        presence (there is nobody to arbitrate with — it is our instance), but
        taking an application we do *not* hold goes through
        :meth:`acquire_access` first, so a person working in the software is
        respected before the driver is ever called.
        """
        definition = self._require_definition(app_name)
        if definition.exclusive and mode != "attach":
            existing = self._active_session_for(app_name)
            if existing is not None:
                existing.status = "attached"
                existing.last_active = time.time()
                existing.launch_degraded = False
                return existing

        decision = self.acquire_access(app_name)
        if not decision.allowed:
            raise AppHumanPresentError(app_name, decision)

        # N8: the license slot is held for the instance's whole life.
        lease = self._acquire_license(definition)
        try:
            driver = self._driver_for(app_name)
            launch: DriverLaunch = driver.launch(definition, mode=mode)
        except BaseException:
            self._governor_release(lease)
            raise

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
            degraded_operations=1 if lease is not None and lease.degraded else 0,
            launch_degraded=bool(lease is not None and lease.degraded),
            resource_lease=lease if lease is not None and lease.reserved else None,
            holder=holder_for(decision),
            taken_over_from=decision.taken_over_from,
            taken_over_at=now if decision.taken_over_from else 0.0,
        )
        with self._lock:
            self._sessions[session.session_id] = session
        return session

    # -- N10b: presence / human-machine sharing --

    def probe_presence(self, app_name: str, *, force: bool = False) -> PresenceReport:
        """Ask whether a person is using *app_name* (N10b, §17).

        Answers come from the application's own declared probe; an application
        that declares none answers ``unknown``, which is a real answer and not a
        failure.  Results are cached briefly because a probe spawns a process —
        callers that must not act on a stale answer (acquisition, the ``wait``
        loop) pass ``force=True``.
        """
        definition = self._require_definition(app_name)
        now = time.monotonic()
        if not force:
            with self._lock:
                cached = self._presence_cache.get(app_name)
            if cached is not None and now - cached[0] < _PRESENCE_CACHE_SECONDS:
                # Re-stamp the source so a reused answer is never mistaken for a
                # probe taken now (the stored report keeps its own provenance).
                return replace(cached[1], source=SOURCE_CACHE)

        report = driver_presence(self._driver_for(app_name), definition)
        if not report.observed_at:
            report = replace(report, observed_at=time.time())
        with self._lock:
            self._presence_cache[app_name] = (now, report)
        return report

    def check_access(self, app_name: str, *, force: bool = False) -> AccessDecision:
        """Apply the configured human-conflict policy to one observed presence.

        Does not block: a ``wait`` outcome is returned as such, and
        :meth:`acquire_access` is the caller that acts on it.
        """
        definition = self._require_definition(app_name)
        return decide_access(
            self.probe_presence(app_name, force=force),
            policy=self._human_conflict_policy(),
            allow_preempt=bool(getattr(definition, "allow_preempt", False)),
        )

    def acquire_access(self, app_name: str, *, timeout: float | None = None) -> AccessDecision:
        """Decide whether the engine may take *app_name* right now (N10b).

        Honours the ``wait`` policy by re-probing until the application is free
        or the budget runs out (``apps.acquire_timeout_seconds``, overridable
        here for callers with their own budget), and returns the final decision
        — including a ``refuse`` that explains the timeout.  A ``preempt``
        outcome is returned as-is; recording the take-over is the caller's
        (``launch``) job, because only the caller knows whether it then commits.
        """
        budget = self._human_conflict_budget() if timeout is None else max(0.0, float(timeout))
        deadline = time.monotonic() + budget
        while True:
            decision = self.check_access(app_name, force=True)
            if decision.outcome != ACCESS_WAIT:
                return decision
            remaining = deadline - time.monotonic()
            if remaining <= 0:
                return replace(
                    decision,
                    outcome="refuse",
                    reason=f"{decision.reason}; gave up after {budget:g}s (raise apps.acquire_timeout_seconds or change apps.on_human_conflict)",
                )
            time.sleep(min(_PRESENCE_POLL_SECONDS, remaining))

    def release(self, session_id: str, *, to: str = HOLDER_HUMAN) -> AppSession | None:
        """Hand an instance back to a person without stopping it (N10b).

        Distinct from :meth:`close`: the instance keeps running (and keeps
        holding its license slot — it still occupies the machine), but the
        engine no longer claims it, so a human can take over the software while
        the run leaves the session alone.  Returns ``None`` for an unknown or
        already-closed session.
        """
        if to not in HOLDERS:
            raise ValueError(f"unknown holder {to!r}; expected one of {sorted(HOLDERS)}")
        with self._lock:
            session = self._sessions.get(session_id)
        if session is None:
            return None
        session.holder = to
        session.taken_over_from = None
        session.last_active = time.time()
        self._forget_presence(session.app_name)
        return session

    def _human_conflict_policy(self) -> str:
        value = getattr(self._registry, "on_human_conflict", HUMAN_CONFLICT_FAIL)
        return value if isinstance(value, str) else HUMAN_CONFLICT_FAIL

    def _human_conflict_budget(self) -> float:
        value = getattr(self._registry, "acquire_timeout_seconds", 60.0)
        try:
            return max(0.0, float(value))
        except (TypeError, ValueError):
            return 60.0

    def _forget_presence(self, app_name: str) -> None:
        with self._lock:
            self._presence_cache.pop(app_name, None)

    # -- N8 admission helpers --

    def _acquire_license(self, definition: Any) -> ResourceLease | None:
        """Take the definition's license slot, if it declares one."""
        if self._governor is None:
            return None
        license_name = getattr(getattr(definition, "resources", None), "license", None)
        if not license_name:
            return None
        return self._governor.acquire(ResourceDemand(license=license_name))

    def _acquire_operation(self, definition: Any, session: AppSession) -> ResourceLease | None:
        """Take the definition's numeric demand for one operation.

        The license is deliberately excluded: it is held by the instance, not
        by each operation.
        """
        if self._governor is None:
            return None
        demand = ResourceDemand.from_declaration(getattr(definition, "resources", None))
        numeric = replace(demand, license=None)
        if numeric.total() == 0:
            return None
        lease = self._governor.acquire(numeric)
        if lease.degraded:
            session.degraded_operations += 1
        return lease

    def _governor_release(self, lease: ResourceLease | None) -> None:
        if lease is not None and self._governor is not None:
            self._governor.release(lease)

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
        lease = self._acquire_operation(definition, session)
        session.status = "busy"
        try:
            result = driver.run_script(definition, DriverLaunch(status=session.status, pid=session.pid, endpoint=session.endpoint, handle=session.handle), script=script, args=list(args or []), env=env)
        finally:
            session.status = "ready"
            session.last_active = time.time()
            self._governor_release(lease)
        return result

    def wait(self, session: AppSession, *, reason: str | None = None, timeout: float | None = None) -> DriverWaitResult:
        driver = self._driver_for(session.app_name)
        definition = self._definition_for_session(session)
        lease = self._acquire_operation(definition, session)
        try:
            result = driver.wait(definition, DriverLaunch(status=session.status, pid=session.pid, endpoint=session.endpoint, handle=session.handle), reason=reason, timeout=timeout)
        finally:
            session.last_active = time.time()
            self._governor_release(lease)
        return result

    def collect(self, session: AppSession, *, globs: list[str] | None = None) -> list[str]:
        driver = self._driver_for(session.app_name)
        definition = self._definition_for_session(session)
        lease = self._acquire_operation(definition, session)
        try:
            artifacts = driver.collect(definition, DriverLaunch(status=session.status, pid=session.pid, endpoint=session.endpoint, handle=session.handle), globs=globs)
        finally:
            session.last_active = time.time()
            self._governor_release(lease)
        session.artifacts = list(artifacts)
        return artifacts

    def supports_undo(self, app_name: str) -> bool:
        """Whether the application's driver can undo in-app steps (N10).

        Answered through the driver registry rather than a cached flag, so a
        reloaded definition or a swapped driver cannot leave a stale capability
        claim behind.
        """
        try:
            return driver_supports_undo(self._driver_for(app_name))
        except (AppError, AppDriverError):
            return False

    def undo(self, session: AppSession, *, steps: int = 1) -> DriverUndoResult:
        """Ask the application to roll back *steps* in-app steps (N10).

        Goes through the same admission gate as every other operation (N8): a
        compensation is still host-side work on a licensed instance, so it must
        not be able to bypass the quota.  The session must still be live — undoing
        against an instance that is gone would silently report a rollback that
        never happened.
        """
        live = self.get(session.session_id)
        if live is None:
            raise AppSessionNotFoundError(f"no live session {session.session_id!r}; cannot undo against an instance that is no longer running")
        session = live
        driver = self._driver_for(session.app_name)
        definition = self._definition_for_session(session)
        lease = self._acquire_operation(definition, session)
        session.status = "busy"
        try:
            result = driver_undo(driver, definition, DriverLaunch(status=session.status, pid=session.pid, endpoint=session.endpoint, handle=session.handle), steps=steps)
        finally:
            session.status = "ready"
            session.last_active = time.time()
            self._governor_release(lease)
        return result

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
        finally:
            # N8: the instance is gone, so its license slot goes back.
            self._governor_release(session.resource_lease)
            session.resource_lease = None
        session.status = "stopped"
        self._forget_presence(session.app_name)
        return True

    def reset(self) -> None:
        """Stop every session and clear the map (tests / shutdown)."""
        for session in list(self.list_sessions()):
            self.close(session.session_id)
        with self._lock:
            self._presence_cache.clear()


# ── Process-wide default manager ───────────────────────────────────────────────

_default_manager: AppSessionManager | None = None
_default_lock = threading.Lock()


def get_session_manager() -> AppSessionManager:
    """Return the process-wide session manager (built from current config).

    The manager is built with the N8 resource governor derived from
    ``apps.resources`` / ``apps.licenses``.  A configuration that declares
    neither makes the governor a no-op, so an untouched deployment behaves
    exactly as it did before N8.
    """
    global _default_manager
    with _default_lock:
        if _default_manager is None:
            _default_manager = AppSessionManager(governor=build_governor_from_config())
        return _default_manager


def build_governor_from_config() -> ResourceGovernor:
    """Build the N8 governor from the loaded ``apps`` configuration."""
    from deerflow.config.apps_config import get_apps_config

    return ResourceGovernor.from_apps_config(get_apps_config())


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
    "AppHumanPresentError",
    "AppSessionNotFoundError",
    "AppSession",
    "AppSessionManager",
    "build_governor_from_config",
    "get_session_manager",
    "reset_session_manager",
]
