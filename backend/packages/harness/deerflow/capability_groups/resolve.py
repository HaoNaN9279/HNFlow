"""Client for VibeStack's authoritative ``resolve --json`` plan.

HNFlow does not reimplement repository traversal, version selection, ``extends``
expansion, or MCP aggregation.  It asks the installed ``vibe-stack`` CLI for the
same plan the VibeStack plugins consume, validates the envelope, and exposes
HNFlow's :class:`CapabilityGroup` objects for runtime use.

The CLI is fail-open by design (it reports warnings instead of failing on
missing repositories), but HNFlow's runtime treats an unreadable plan as a hard
error: silently running without the requested rules/skills is worse.
"""

from __future__ import annotations

import json
import logging
import re
import shutil
import subprocess
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

from deerflow.capability_groups.discovery import CapabilityGroup, _load_manifest
from deerflow.capability_groups.vibestack import VibeStackError

logger = logging.getLogger(__name__)

SCHEMA_VERSION = 1
DEFAULT_TIMEOUT_SECONDS = 30.0
_CLI_NAME = "vibe-stack"
_UV = "uv"
_MCP_KEY_PREFIX = "vibe:"
_SAFE_NAME_RE = re.compile(r"[^A-Za-z0-9_-]+")


class VibeStackResolveError(VibeStackError):
    """The VibeStack resolve plan could not be produced or parsed."""


@dataclass(frozen=True)
class ResolvedMcpServer:
    """One MCP server from the resolve plan, normalized for HNFlow."""

    key: str
    name: str
    group: str | None
    transport: str
    command: tuple[str, ...] = ()
    url: str | None = None
    env: dict[str, str] = field(default_factory=dict)
    headers: dict[str, str] = field(default_factory=dict)
    enabled: bool = True

    def to_dict(self) -> dict[str, Any]:
        return {
            "key": self.key,
            "name": self.name,
            "group": self.group,
            "transport": self.transport,
            "command": list(self.command),
            "url": self.url,
            "env": dict(self.env),
            "headers": dict(self.headers),
            "enabled": self.enabled,
        }


@dataclass(frozen=True)
class ResolvedPlan:
    """Validated output of ``vibe-stack resolve --json``."""

    active: bool
    repository: Path | None
    project: Path | None
    core: CapabilityGroup | None
    groups: tuple[CapabilityGroup, ...]
    rules: tuple[dict[str, Any], ...]
    skills: tuple[dict[str, Any], ...]
    mcp: tuple[ResolvedMcpServer, ...]
    warnings: tuple[str, ...]
    fingerprint: str
    raw: dict[str, Any] = field(default_factory=dict)

    @property
    def closure(self) -> tuple[CapabilityGroup, ...]:
        """Core followed by activated groups, matching VibeStack load order."""
        return ((self.core,) if self.core is not None else ()) + self.groups

    @property
    def active_versions(self) -> dict[str, str]:
        return {group.name: group.version for group in self.closure}


def _safe_name(key: str) -> str:
    return _SAFE_NAME_RE.sub("_", key).strip("_") or "mcp"


def _which(name: str) -> str | None:
    return shutil.which(name)


def cli_commands(repository: Path | None = None) -> list[list[str]]:
    """Return CLI invocation candidates in priority order."""
    commands: list[list[str]] = []
    executable = _which(_CLI_NAME)
    if executable:
        commands.append([executable])
    if repository is not None:
        for relative in (Path(".venv/Scripts/vibe-stack.exe"), Path(".venv/Scripts/vibe-stack"), Path(".venv/bin/vibe-stack")):
            candidate = repository / relative
            if candidate.is_file():
                commands.append([str(candidate)])
        uv = _which(_UV)
        if uv:
            commands.append([uv, "run", "--project", str(repository), _CLI_NAME])
    return commands


def _string_list(value: Any, *, field_name: str) -> tuple[str, ...]:
    if value is None:
        return ()
    if not isinstance(value, list) or not all(isinstance(item, str) for item in value):
        raise VibeStackResolveError(f"VibeStack resolve plan: {field_name} must be a list of strings")
    return tuple(item for item in value if item)


def _string_map(value: Any, *, field_name: str) -> dict[str, str]:
    if value is None:
        return {}
    if not isinstance(value, dict) or not all(isinstance(key, str) and isinstance(item, str) for key, item in value.items()):
        raise VibeStackResolveError(f"VibeStack resolve plan: {field_name} must be an object of strings")
    return dict(value)


def _parse_group(raw: Any, *, repository: Path | None, field_name: str) -> CapabilityGroup:
    if not isinstance(raw, dict):
        raise VibeStackResolveError(f"VibeStack resolve plan: {field_name} must be an object")
    name = raw.get("name")
    version = raw.get("version")
    root_value = raw.get("root")
    if not isinstance(name, str) or not name.strip():
        raise VibeStackResolveError(f"VibeStack resolve plan: {field_name}.name must be a non-empty string")
    if not isinstance(version, str) or not version.strip():
        raise VibeStackResolveError(f"VibeStack resolve plan: {field_name}.version must be a non-empty string")
    if not isinstance(root_value, str) or not root_value.strip():
        raise VibeStackResolveError(f"VibeStack resolve plan: {field_name}.root must be a non-empty string")

    root = Path(root_value).expanduser().resolve()
    if not root.is_dir():
        raise VibeStackResolveError(f"VibeStack resolve plan: group root does not exist: {root}")
    if repository is not None:
        groups_root = (repository / "capability-groups").resolve()
        try:
            root.relative_to(groups_root)
        except ValueError as exc:
            raise VibeStackResolveError(f"VibeStack resolve plan: group root {root} is outside {groups_root}") from exc
    try:
        return _load_manifest(root, name_hint=name, version_hint=version, source="vibestack")
    except ValueError as exc:
        raise VibeStackResolveError(f"VibeStack resolve plan: invalid group {name}@{version}: {exc}") from exc


def _mcp_group(key: str) -> str | None:
    if not key.startswith(_MCP_KEY_PREFIX):
        return None
    rest = key[len(_MCP_KEY_PREFIX) :]
    group, separator, _ = rest.partition("_")
    return group if separator and group else None


def _parse_mcp(raw: Any) -> tuple[ResolvedMcpServer, ...]:
    if raw is None:
        return ()
    if not isinstance(raw, dict):
        raise VibeStackResolveError("VibeStack resolve plan: mcp must be an object")
    servers: list[ResolvedMcpServer] = []
    for key, value in raw.items():
        if not isinstance(key, str) or not isinstance(value, dict):
            raise VibeStackResolveError("VibeStack resolve plan: mcp entries must be objects keyed by name")
        raw_type = str(value.get("type") or "local").lower()
        command = _string_list(value.get("command"), field_name=f"mcp[{key!r}].command")
        url = value.get("url")
        if url is not None and not isinstance(url, str):
            raise VibeStackResolveError(f"VibeStack resolve plan: mcp[{key!r}].url must be a string")
        if raw_type == "local":
            transport = "stdio"
            if not command:
                raise VibeStackResolveError(f"VibeStack resolve plan: local MCP server {key!r} has no command")
        elif raw_type == "remote":
            if not url:
                raise VibeStackResolveError(f"VibeStack resolve plan: remote MCP server {key!r} has no url")
            transport = "sse" if url.rstrip("/").endswith("/sse") else "http"
        elif raw_type in {"stdio", "http", "sse"}:
            transport = raw_type
        else:
            raise VibeStackResolveError(f"VibeStack resolve plan: unsupported MCP transport {raw_type!r} for {key!r}")
        servers.append(
            ResolvedMcpServer(
                key=key,
                name=_safe_name(key),
                group=_mcp_group(key),
                transport=transport,
                command=command,
                url=url,
                env=_string_map(value.get("env"), field_name=f"mcp[{key!r}].env"),
                headers=_string_map(value.get("headers"), field_name=f"mcp[{key!r}].headers"),
                enabled=bool(value.get("enabled", True)),
            )
        )
    return tuple(servers)


def _parse_plan(payload: Any, *, repository: Path | None) -> ResolvedPlan:
    if not isinstance(payload, dict):
        raise VibeStackResolveError("VibeStack resolve plan must be a JSON object")
    schema_version = payload.get("schema_version")
    if schema_version != SCHEMA_VERSION:
        raise VibeStackResolveError(f"unsupported VibeStack resolve schema_version {schema_version!r}; expected {SCHEMA_VERSION}")

    repository_value = payload.get("repository")
    repository_path = Path(repository_value).expanduser().resolve() if isinstance(repository_value, str) and repository_value.strip() else repository
    project_value = payload.get("project")
    project_path = Path(project_value).expanduser().resolve() if isinstance(project_value, str) and project_value.strip() else None

    raw_core = payload.get("core")
    core = _parse_group(raw_core, repository=repository_path, field_name="core") if raw_core is not None else None
    raw_groups = payload.get("groups") or []
    if not isinstance(raw_groups, list):
        raise VibeStackResolveError("VibeStack resolve plan: groups must be a list")
    groups = tuple(_parse_group(item, repository=repository_path, field_name=f"groups[{index}]") for index, item in enumerate(raw_groups))

    raw_rules = payload.get("rules") or []
    raw_skills = payload.get("skills") or []
    if not isinstance(raw_rules, list) or not all(isinstance(item, dict) for item in raw_rules):
        raise VibeStackResolveError("VibeStack resolve plan: rules must be a list of objects")
    if not isinstance(raw_skills, list) or not all(isinstance(item, dict) for item in raw_skills):
        raise VibeStackResolveError("VibeStack resolve plan: skills must be a list of objects")

    warnings = _string_list(payload.get("warnings"), field_name="warnings")
    fingerprint = payload.get("fingerprint")
    if not isinstance(fingerprint, str) or not fingerprint:
        raise VibeStackResolveError("VibeStack resolve plan: fingerprint must be a non-empty string")

    return ResolvedPlan(
        active=bool(payload.get("active")),
        repository=repository_path,
        project=project_path,
        core=core,
        groups=groups,
        rules=tuple(dict(item) for item in raw_rules),
        skills=tuple(dict(item) for item in raw_skills),
        mcp=_parse_mcp(payload.get("mcp")),
        warnings=warnings,
        fingerprint=fingerprint,
        raw=dict(payload),
    )


def _run_plan_cli(project_root: Path, repository: Path | None, timeout: float) -> str:
    commands = cli_commands(repository)
    if not commands:
        raise VibeStackResolveError("vibe-stack CLI not found; install VibeStack or set a repository with a .venv")
    args = ["resolve", "--json", "--project", str(project_root)]
    if repository is not None:
        args.extend(["--repo", str(repository)])
    last_error: OSError | None = None
    for command in commands:
        try:
            completed = subprocess.run(
                [*command, *args],
                cwd=str(project_root),
                capture_output=True,
                text=True,
                encoding="utf-8",
                errors="replace",
                timeout=timeout,
                check=False,
            )
        except FileNotFoundError as exc:
            last_error = exc
            continue
        except subprocess.TimeoutExpired as exc:
            raise VibeStackResolveError(f"vibe-stack resolve timed out after {timeout:.0f}s") from exc
        if completed.returncode != 0:
            detail = (completed.stderr or completed.stdout or "").strip()
            raise VibeStackResolveError(f"vibe-stack resolve failed (exit {completed.returncode}): {detail or 'no output'}")
        return completed.stdout
    raise VibeStackResolveError(f"vibe-stack CLI could not be executed: {last_error}")


def resolve_project_plan(
    project_root: Path,
    *,
    repository: Path | None = None,
    timeout: float = DEFAULT_TIMEOUT_SECONDS,
) -> ResolvedPlan:
    """Run ``vibe-stack resolve --json`` for ``project_root`` and validate it."""
    project_root = Path(project_root).expanduser().resolve()
    if not project_root.is_dir():
        raise VibeStackResolveError(f"project root does not exist: {project_root}")
    output = _run_plan_cli(project_root, repository, timeout)
    try:
        payload = json.loads(output)
    except json.JSONDecodeError as exc:
        raise VibeStackResolveError(f"vibe-stack resolve returned invalid JSON: {exc}") from exc
    return _parse_plan(payload, repository=repository)


__all__ = [
    "DEFAULT_TIMEOUT_SECONDS",
    "SCHEMA_VERSION",
    "ResolvedMcpServer",
    "ResolvedPlan",
    "VibeStackResolveError",
    "cli_commands",
    "resolve_project_plan",
]
