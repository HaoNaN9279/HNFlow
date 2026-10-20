"""Versioned custom tool packages.

A tool package is the first-class, shareable definition of a custom tool::

    {repo}/tools/<name>/<version>/tool.json

Capability groups do not own tools; they reference the stable tool ids produced
by this module (``tool:<guid>@v<version>``).  The package is intentionally
public-only: user-scoped tools would execute user code in the Gateway process,
which is a separate (and currently rejected) trust decision.
"""

from __future__ import annotations

import json
import logging
import re
from dataclasses import dataclass
from pathlib import Path
from typing import Any

from deerflow.config.paths import get_paths
from deerflow.skills.contract import CAPABILITY_PERMISSIONS

logger = logging.getLogger(__name__)

GUID_RE = re.compile(r"^[0-9a-f]{32}$")
VERSION_RE = re.compile(r"^\d+(?:\.\d+)*$")
NAME_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9_.-]*$")
_MANIFEST = "tool.json"
_SUPPORTED_PROVIDERS = frozenset({"python", "mcp", "builtin", "sandbox", "app"})


class ToolPackageError(ValueError):
    """A tool package is malformed, missing, or cannot be loaded."""


@dataclass(frozen=True)
class ToolPackage:
    """One concrete installed tool package version."""

    guid: str
    name: str
    version: str
    description: str
    provider: str
    root: Path
    permissions: tuple[str, ...] = ()
    permissions_declared: bool = False
    idempotent: bool = True
    entrypoint: str | None = None
    server: str | None = None
    tool: str | None = None
    app: str | None = None
    model_name: str | None = None

    @property
    def ref(self) -> str:
        """Stable, version-pinned reference used by capability groups."""
        return f"tool:{self.guid}@v{self.version}"


def _root() -> Path:
    """Public tool-package root, next to ``capability-groups/``."""
    return get_paths().base_dir.parent.parent / "tools"


def _version_key(version: str) -> tuple[int, ...]:
    if not VERSION_RE.fullmatch(version):
        raise ToolPackageError(f"invalid tool version {version!r}; expected numeric dotted version")
    return tuple(int(part) for part in version.split("."))


def _read_manifest(manifest_path: Path) -> dict[str, Any]:
    try:
        raw = json.loads(manifest_path.read_text(encoding="utf-8"))
    except FileNotFoundError as exc:
        raise ToolPackageError(f"missing {_MANIFEST} in {manifest_path.parent}") from exc
    except (OSError, json.JSONDecodeError) as exc:
        raise ToolPackageError(f"cannot read {manifest_path}: {exc}") from exc
    if not isinstance(raw, dict):
        raise ToolPackageError(f"{manifest_path} must contain a JSON object")
    return raw


def _parse_permissions(raw: Any, manifest_path: Path) -> tuple[tuple[str, ...], bool]:
    if raw is None:
        return (), False
    if not isinstance(raw, list) or not all(isinstance(item, str) for item in raw):
        raise ToolPackageError(f"{manifest_path}: permissions must be a list of strings")
    permissions: list[str] = []
    for item in raw:
        permission = item.strip().lower()
        if not permission:
            continue
        if permission not in CAPABILITY_PERMISSIONS:
            raise ToolPackageError(f"{manifest_path}: unknown permission {permission!r}; allowed: {sorted(CAPABILITY_PERMISSIONS)}")
        permissions.append(permission)
    return tuple(dict.fromkeys(permissions)), True


def _parse_package(manifest_path: Path, *, name_hint: str, version_hint: str) -> ToolPackage:
    raw = _read_manifest(manifest_path)
    schema_version = raw.get("schema_version", 1)
    if schema_version != 1:
        raise ToolPackageError(f"{manifest_path}: unsupported schema_version {schema_version!r}")

    guid = raw.get("guid")
    if not isinstance(guid, str) or not GUID_RE.fullmatch(guid):
        raise ToolPackageError(f"{manifest_path}: guid must be a 32-character lowercase hex string")

    name = raw.get("name") or name_hint
    version = raw.get("version") or version_hint
    if not isinstance(name, str) or not NAME_RE.fullmatch(name):
        raise ToolPackageError(f"{manifest_path}: name must be a non-empty slug")
    if not isinstance(version, str):
        raise ToolPackageError(f"{manifest_path}: version must be a string")
    _version_key(version)

    description = raw.get("description") or ""
    if not isinstance(description, str):
        raise ToolPackageError(f"{manifest_path}: description must be a string")

    provider = raw.get("provider")
    if not isinstance(provider, str) or provider not in _SUPPORTED_PROVIDERS:
        raise ToolPackageError(f"{manifest_path}: provider must be one of {sorted(_SUPPORTED_PROVIDERS)}")

    permissions, permissions_declared = _parse_permissions(raw.get("permissions"), manifest_path)
    idempotent = raw.get("idempotent", True)
    if not isinstance(idempotent, bool):
        raise ToolPackageError(f"{manifest_path}: idempotent must be a boolean")

    entrypoint = raw.get("entrypoint")
    server = raw.get("server")
    tool = raw.get("tool")
    app = raw.get("app")
    model_name = raw.get("tool_name") or name
    for field_name, value in (("entrypoint", entrypoint), ("server", server), ("tool", tool), ("app", app), ("tool_name", model_name)):
        if value is not None and (not isinstance(value, str) or not value.strip()):
            raise ToolPackageError(f"{manifest_path}: {field_name} must be a non-empty string when present")

    if provider == "python":
        if not entrypoint:
            raise ToolPackageError(f"{manifest_path}: python tools require entrypoint")
    elif provider == "mcp":
        if not server or not tool:
            raise ToolPackageError(f"{manifest_path}: mcp tools require server and tool")
    elif provider in {"builtin", "sandbox"}:
        if not tool:
            raise ToolPackageError(f"{manifest_path}: {provider} tools require tool")
    elif provider == "app" and not (app or tool):
        raise ToolPackageError(f"{manifest_path}: app tools require app")

    return ToolPackage(
        guid=guid,
        name=name,
        version=version,
        description=description.strip(),
        provider=provider,
        root=manifest_path.parent.resolve(),
        permissions=permissions,
        permissions_declared=permissions_declared,
        idempotent=idempotent,
        entrypoint=entrypoint,
        server=server,
        tool=tool,
        app=app,
        model_name=model_name,
    )


def _iter_package_dirs(root: Path) -> list[tuple[Path, str, str]]:
    if not root.is_dir():
        return []
    found: list[tuple[Path, str, str]] = []
    for name_dir in sorted(root.iterdir(), key=lambda item: item.name.lower()):
        if not name_dir.is_dir() or name_dir.name.startswith("."):
            continue
        for version_dir in sorted(name_dir.iterdir(), key=lambda item: item.name):
            if not version_dir.is_dir() or version_dir.name.startswith("."):
                continue
            if not VERSION_RE.fullmatch(version_dir.name):
                continue
            if (version_dir / _MANIFEST).is_file():
                found.append((version_dir, name_dir.name, version_dir.name))
    return found


def discover_tool_packages(*, root: Path | None = None) -> list[ToolPackage]:
    """Return the current version of every installed public tool package."""
    package_root = root or _root()
    current: dict[str, ToolPackage] = {}
    for package_dir, name_hint, version_hint in _iter_package_dirs(package_root):
        try:
            package = _parse_package(package_dir / _MANIFEST, name_hint=name_hint, version_hint=version_hint)
        except ToolPackageError as exc:
            logger.warning("Skipping malformed tool package at %s: %s", package_dir, exc)
            continue
        existing = current.get(package.name)
        if existing is None or _version_key(package.version) > _version_key(existing.version):
            current[package.name] = package
    return sorted(current.values(), key=lambda item: item.name.lower())


def load_tool_package(identifier: str, *, version: str | None = None, root: Path | None = None) -> ToolPackage:
    """Load a package by GUID or name, optionally selecting an explicit version."""
    package_root = root or _root()
    candidates: list[ToolPackage] = []
    errors: list[ToolPackageError] = []
    for package_dir, name_hint, version_hint in _iter_package_dirs(package_root):
        if version is not None and version_hint != version:
            continue
        try:
            package = _parse_package(package_dir / _MANIFEST, name_hint=name_hint, version_hint=version_hint)
        except ToolPackageError as exc:
            if identifier == name_hint:
                errors.append(exc)
            logger.warning("Skipping malformed tool package at %s: %s", package_dir, exc)
            continue
        if identifier in {package.guid, package.name}:
            candidates.append(package)
    if not candidates:
        if errors:
            raise errors[-1]
        raise ToolPackageError(f"tool package {identifier!r} not found")
    if version is not None:
        return max(candidates, key=lambda item: _version_key(item.version))
    return max(candidates, key=lambda item: _version_key(item.version))


__all__ = [
    "ToolPackage",
    "ToolPackageError",
    "discover_tool_packages",
    "load_tool_package",
]
