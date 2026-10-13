"""Local professional-software application access layer (N4, plan §17).

Public surface:

- :class:`~deerflow.apps.registry.AppRegistry` / ``get_app_registry`` — resolve
  configured applications to definitions and drivers.
- :class:`~deerflow.apps.session.AppSessionManager` / ``get_session_manager`` —
  process-local instance/session lifecycle.
- :func:`~deerflow.apps.driver.AppDriver` protocol — how a driver family is
  plugged in.

App access runs on the **host** — a deliberate exception to the
"commands must go through the sandbox" rule (GUI / long-lived professional
software cannot run in the command sandbox).  See the layer docstring in
``deerflow.config.apps_config`` for the rationale.
"""

from __future__ import annotations

from deerflow.apps.driver import (
    AppDriver,
    AppDriverError,
    DriverLaunch,
    DriverScriptResult,
    DriverWaitResult,
)
from deerflow.apps.registry import AppRegistry, get_app_registry
from deerflow.apps.session import (
    AppDisabledError,
    AppError,
    AppNotFoundError,
    AppSession,
    AppSessionManager,
    AppSessionNotFoundError,
    get_session_manager,
    reset_session_manager,
)

__all__ = [
    "AppDriver",
    "AppDriverError",
    "DriverLaunch",
    "DriverScriptResult",
    "DriverWaitResult",
    "AppRegistry",
    "get_app_registry",
    "AppError",
    "AppDisabledError",
    "AppNotFoundError",
    "AppSessionNotFoundError",
    "AppSession",
    "AppSessionManager",
    "get_session_manager",
    "reset_session_manager",
]
