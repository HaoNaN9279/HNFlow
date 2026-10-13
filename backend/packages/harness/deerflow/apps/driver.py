"""Local-application access layer (N4) — driver contract and shared types.

An *application* is a local professional-software process (Blender, Unity,
Photoshop, …) driven across a process/HTTP boundary.  The :class:`AppDriver`
protocol is the pluggable surface: each driver knows how to launch/attach,
run a script command, wait for an in-app task, collect artifacts and report
health for one application family.

Drivers are **synchronous** and run on the host (dev plan §17; slice-1
decision 3 — a deliberate exception to the "commands must go through the
sandbox" rule).  Async workflow executors offload driver calls to a worker
thread so the event loop is never blocked.

This module is dependency-light (stdlib + the config dataclasses): concrete
drivers under :mod:`deerflow.apps.drivers` import their own backends lazily.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any, Protocol, runtime_checkable

from deerflow.config.apps_config import AppDefinition


@dataclass
class DriverLaunch:
    """Result of a driver ``launch``/``attach`` call."""

    status: str  # "ready" | "attached"
    pid: int | None = None
    endpoint: str | None = None
    #: Driver-private handle (serialised into the ``session`` port value and
    #: passed back to the driver on later calls).
    handle: dict[str, Any] = field(default_factory=dict)


@dataclass
class DriverScriptResult:
    """Result of a driver ``run_script`` call."""

    status: str  # "completed" | "failed"
    exit_code: int | None = None
    stdout: str = ""
    stderr: str = ""


@dataclass
class DriverWaitResult:
    """Result of a driver ``wait`` call."""

    status: str  # "done" | "timeout"
    detail: str = ""


@runtime_checkable
class AppDriver(Protocol):
    """How one application family is driven."""

    name: str

    def available(self, definition: AppDefinition) -> bool:
        """Return ``True`` when this driver can operate the definition."""
        ...

    def launch(self, definition: AppDefinition, *, mode: str) -> DriverLaunch:
        """Start a new instance (``mode="launch"``) or attach to an existing one."""
        ...

    def run_script(
        self,
        definition: AppDefinition,
        launch: DriverLaunch,
        *,
        script: str | None,
        args: list[str],
        env: dict[str, str] | None = None,
    ) -> DriverScriptResult:
        """Execute an in-app script command and capture its result."""
        ...

    def wait(
        self,
        definition: AppDefinition,
        launch: DriverLaunch,
        *,
        reason: str | None,
        timeout: float | None,
    ) -> DriverWaitResult:
        """Wait for an in-app task (render / compile / idle) to finish."""
        ...

    def collect(
        self,
        definition: AppDefinition,
        launch: DriverLaunch,
        *,
        globs: list[str] | None,
    ) -> list[str]:
        """Return artifact paths produced by the application."""
        ...

    def health(self, definition: AppDefinition, launch: DriverLaunch) -> bool:
        """Return ``True`` when the instance still looks alive."""
        ...

    def close(self, definition: AppDefinition, launch: DriverLaunch) -> None:
        """Release / stop the instance (best effort)."""
        ...


class AppDriverError(RuntimeError):
    """Raised by a driver when an operation cannot be performed."""


__all__ = [
    "DriverLaunch",
    "DriverScriptResult",
    "DriverWaitResult",
    "AppDriver",
    "AppDriverError",
]
