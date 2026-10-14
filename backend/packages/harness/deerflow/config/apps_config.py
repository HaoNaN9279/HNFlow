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

N8 (plan §19) adds the **declared** resource layer the host-side governor
enforces: per-application ``resources`` (GPU/CPU/memory/disk/license), the
global ``resources`` capacity caps, and the ``licenses`` slot groups.  Nothing
here measures real hardware — a declaration is what the app *says* it needs,
and an omitted dimension means "occupies nothing".
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

#: Conflict policy when a declared quota or license slot is exhausted (N8).
ResourceConflictPolicy = Literal["wait", "fail", "degrade"]

#: Stable app-name grammar — mirrors the workflow id contract
#: (``^[A-Za-z0-9_-]{1,64}$``), kept local so this module has no workflow
#: import edge.
_APP_NAME_PATTERN = re.compile(r"^[A-Za-z0-9_-]{1,64}$")

#: License group names double as lock-file stems, so the grammar matches the
#: host-side file-lock contract (``deerflow.locks.file_lock``).
_LICENSE_NAME_PATTERN = re.compile(r"^[A-Za-z0-9_][A-Za-z0-9_.-]{0,63}$")

#: Resource dimensions the governor understands. Kept as an explicit tuple so
#: the config layer, the governor, and the API snapshot cannot drift.
RESOURCE_DIMENSIONS: tuple[str, ...] = ("gpu", "cpu", "memory_mb", "disk_mb")


class AppResourceDemand(BaseModel):
    """What one application *declares* it occupies while it runs.

    ``license`` is the license group the app belongs to (N8 §19: instances
    sharing one license must not preempt each other).  Every numeric dimension
    defaults to 0 = "occupies nothing", so an existing definition that declares
    no resources keeps behaving exactly as before.
    """

    model_config = ConfigDict(extra="forbid")

    gpu: int = Field(default=0, ge=0, description="GPU units the app occupies while running.")
    cpu: int = Field(default=0, ge=0, description="CPU slots the app occupies while running.")
    memory_mb: int = Field(default=0, ge=0, description="Memory the app occupies (MB).")
    disk_mb: int = Field(default=0, ge=0, description="Scratch/spool disk the app occupies (MB).")
    license: str | None = Field(default=None, description="License group this application belongs to (see apps.licenses).")

    @field_validator("license")
    @classmethod
    def _validate_license_name(cls, value: str | None) -> str | None:
        if value is None:
            return None
        stripped = value.strip()
        if not stripped:
            return None
        if not _LICENSE_NAME_PATTERN.match(stripped):
            raise ValueError(f"license group must match {_LICENSE_NAME_PATTERN.pattern!r}; got {stripped!r}")
        return stripped

    def numeric(self) -> dict[str, int]:
        """Return the non-license dimensions as a plain dict."""
        return {dimension: getattr(self, dimension) for dimension in RESOURCE_DIMENSIONS}


class ResourceLimits(BaseModel):
    """Global host capacity the governor admits work against.

    ``None`` means *unlimited* for that dimension — the default, so an
    untouched configuration never queues anything.
    """

    model_config = ConfigDict(extra="forbid")

    gpu: int | None = Field(default=None, ge=0, description="Total GPU units available to local applications (None = unlimited).")
    cpu: int | None = Field(default=None, ge=0, description="Total CPU slots available to local applications (None = unlimited).")
    memory_mb: int | None = Field(default=None, ge=0, description="Total memory available to local applications in MB (None = unlimited).")
    disk_mb: int | None = Field(default=None, ge=0, description="Total scratch disk available to local applications in MB (None = unlimited).")

    def as_dict(self) -> dict[str, int | None]:
        return {dimension: getattr(self, dimension) for dimension in RESOURCE_DIMENSIONS}


class LicenseGroup(BaseModel):
    """One license pool: how many instances may hold it at the same time."""

    model_config = ConfigDict(extra="forbid")

    slots: int = Field(default=1, ge=1, le=1000, description="Concurrent holders allowed by this license.")


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
    # -- N8 resource governance --
    resources: AppResourceDemand = Field(default_factory=AppResourceDemand, description="Declared resource demand (N8); all-zero means the app is not governed.")

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
    persist_sessions: bool = Field(default=True, description="Persist instance records to the SQL database when one is configured (ignored on the in-memory backend).")
    session_retention_days: int = Field(default=30, ge=1, le=3650, description="Retention window for archived/stopped/orphaned instance records swept by the cleanup endpoint.")
    # -- N8 resource governance --
    resources: ResourceLimits = Field(default_factory=ResourceLimits, description="Global host capacity caps for local applications (N8). Omit a dimension = unlimited.")
    licenses: dict[str, LicenseGroup] = Field(default_factory=dict, description="License group → concurrent slot count (N8).")
    on_conflict: ResourceConflictPolicy = Field(default="wait", description="What to do when a declared quota or license is exhausted: wait (queue, then fail on timeout), fail, or degrade (proceed and warn).")
    acquire_timeout_seconds: float = Field(default=60.0, ge=1, le=86400, description="How long a 'wait' admission may queue before failing (N8).")

    @field_validator("definitions")
    @classmethod
    def _validate_names(cls, value: dict[str, AppDefinition]) -> dict[str, AppDefinition]:
        for name in value:
            if not _APP_NAME_PATTERN.match(name):
                raise ValueError(f"app name must match {_APP_NAME_PATTERN.pattern!r}; got {name!r}")
        return value

    @field_validator("licenses")
    @classmethod
    def _validate_license_groups(cls, value: dict[str, LicenseGroup]) -> dict[str, LicenseGroup]:
        for name in value:
            if not _LICENSE_NAME_PATTERN.match(name):
                raise ValueError(f"license group must match {_LICENSE_NAME_PATTERN.pattern!r}; got {name!r}")
        return value

    @model_validator(mode="after")
    def _cross_check_resources(self) -> AppsConfig:
        declared = {name: definition.resources for name, definition in self.definitions.items()}

        unknown = sorted({demand.license for demand in declared.values() if demand.license and demand.license not in self.licenses})
        if unknown:
            raise ValueError(f"app resources reference undeclared license group(s) {unknown}; declare them under apps.licenses")

        # A demand larger than its cap can never be admitted: warn loudly at load
        # instead of letting the first run time out somewhere far away.
        limits = self.resources.as_dict()
        for name, demand in declared.items():
            for dimension, need in demand.numeric().items():
                cap = limits[dimension]
                if need and cap is not None and need > cap:
                    logger.warning("App %r declares %s=%d but apps.resources.%s=%d; the app can never be admitted", name, dimension, need, dimension, cap)
        return self


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
    "AppResourceDemand",
    "AppDefinition",
    "AppsConfig",
    "LicenseGroup",
    "RESOURCE_DIMENSIONS",
    "ResourceConflictPolicy",
    "ResourceLimits",
    "get_apps_config",
    "load_apps_config_from_dict",
    "reset_apps_config",
]
