"""Local professional-software application registry configuration (N4, plan §17).

Defines the operator-managed ``apps`` section of ``config.yaml``: a map of
application name → :class:`AppDefinition`.  The registry is the *definition*
layer only — it declares how an application is detected and driven; runtime
instances/sessions live in :mod:`deerflow.apps.session`.

Design notes (dev plan §17, P1 slice 1 decisions):

- ``apps`` is a **startup-required** section (drivers own child-process and
  HTTP-client lifecycles), so it is registered in
  :data:`deerflow.config.reload_boundary.STARTUP_ONLY_FIELDS`.
- App driving runs on the **host** — a deliberate, documented exception to the
  "commands must go through the sandbox" rule, because GUI/long-lived
  professional software cannot run inside the command sandbox.  ``tool:bash``
  and the ``sandbox`` provider are unaffected.
- Definitions are fail-open to *unavailable* (a declared app whose driver
  cannot construct simply reports ``available: false``); a malformed
  definition is a config error and raises at load time.
"""

from __future__ import annotations

import logging
import re
from collections.abc import Mapping
from typing import Any, Literal

from pydantic import BaseModel, ConfigDict, Field, field_validator, model_validator

logger = logging.getLogger(__name__)

#: Supported driver names (slice 1 driver matrix, plan §3.1).
#: ``unity`` is deliberately deferred — the Unity Pipeline bridge needs an
#: Editor-attached project and is out of scope for slice 1.
AppDriverName = Literal["cli", "mock"]

#: Stable app-name grammar — mirrors the workflow id contract
#: (``^[A-Za-z0-9_-]{1,64}$``), kept local so this module has no workflow
#: import edge.
_APP_NAME_PATTERN = re.compile(r"^[A-Za-z0-9_-]{1,64}$")


class AppDefinition(BaseModel):
    """How one local application is detected and driven.

    Fields are intentionally driver-agnostic where possible; a driver ignores
    the fields it does not use.  ``cli`` requires ``command``; ``unity``
    defaults ``endpoint`` from the environment; ``mock`` needs neither and
    exists for offline tests and demos.
    """

    model_config = ConfigDict(extra="forbid")

    driver: AppDriverName = Field(default="cli", description="Driver used to talk to the application.")
    description: str = Field(default="", description="Human-readable summary shown in tool/palette help.")
    # -- cli driver --
    command: str | None = Field(default=None, description="Executable to launch / run scripts with (cli driver).")
    args: list[str] = Field(default_factory=list, description="Arguments always passed before any script/extra args.")
    env: dict[str, str] = Field(default_factory=dict, description="Extra environment variables. Values starting with $ resolve from the host environment.")
    working_dir: str | None = Field(default=None, description="Working directory for launched processes.")
    spawn_on_launch: bool = Field(default=False, description="When true the cli driver starts the command as a long-lived background process on launch; when false launch just opens an attach-style session.")
    # -- shared --
    script_args: list[str] = Field(default_factory=list, description="Arguments inserted after `args` and before any per-call script/args.")
    version_command: str | None = Field(default=None, description="Optional command whose output names the detected version.")
    endpoint: str | None = Field(default=None, description="Base URL for HTTP-driven applications (reserved for future drivers).")
    artifact_globs: list[str] = Field(default_factory=list, description="Glob patterns (relative to working_dir) that collect() returns.")
    timeout_seconds: int = Field(default=600, ge=1, description="Default per-operation timeout in seconds.")
    exclusive: bool = Field(default=True, description="When true a second launch of the same app reattaches to the existing session (single-instance apps).")

    @field_validator("command")
    @classmethod
    def _command_strip(cls, value: str | None) -> str | None:
        if value is None:
            return None
        stripped = value.strip()
        return stripped or None

    @model_validator(mode="after")
    def _require_driver_fields(self) -> AppDefinition:
        if self.driver == "cli" and not self.command:
            raise ValueError("cli driver requires a non-empty 'command'")
        return self


class AppsConfig(BaseModel):
    """The ``apps`` section: a global switch plus the application registry."""

    model_config = ConfigDict(extra="forbid")

    enabled: bool = Field(default=False, description="Master switch for the local-application access layer.")
    definitions: dict[str, AppDefinition] = Field(default_factory=dict, description="Application name → definition.")

    @field_validator("definitions")
    @classmethod
    def _validate_names(cls, value: dict[str, AppDefinition]) -> dict[str, AppDefinition]:
        for name in value:
            if not _APP_NAME_PATTERN.match(name):
                raise ValueError(f"app name must match {_APP_NAME_PATTERN.pattern!r}; got {name!r}")
        return value


# ── Process-wide singleton (mirrors acp_config / checkpointer_config) ──────────

_apps_config: AppsConfig = AppsConfig()


def get_apps_config() -> AppsConfig:
    """Return the currently loaded ``apps`` configuration (default: disabled)."""
    return _apps_config


def load_apps_config_from_dict(config_dict: Mapping[str, Any] | None) -> None:
    """Load the ``apps`` section from a plain dict (typically from config.yaml)."""
    global _apps_config
    if config_dict is None:
        config_dict = {}
    _apps_config = AppsConfig.model_validate(config_dict)
    if _apps_config.enabled:
        logger.info("App registry loaded: %d definition(s): %s", len(_apps_config.definitions), sorted(_apps_config.definitions))
    else:
        logger.debug("App registry disabled (apps.enabled=false)")


def reset_apps_config() -> None:
    """Reset the singleton to the disabled default (tests / hot-reload)."""
    global _apps_config
    _apps_config = AppsConfig()


__all__ = [
    "AppDriverName",
    "AppDefinition",
    "AppsConfig",
    "get_apps_config",
    "load_apps_config_from_dict",
    "reset_apps_config",
]
