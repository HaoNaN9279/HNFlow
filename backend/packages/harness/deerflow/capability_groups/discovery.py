"""Discover versioned capability groups from the public and per-user roots."""

from __future__ import annotations

import json
import logging
import re
from dataclasses import dataclass, field
from pathlib import Path

from deerflow.capability_groups.contents import (
    CAPABILITY_CATEGORIES,
    CapabilityGroupFile,
    build_capability_contents,
    category_sort_key,
)
from deerflow.config.paths import get_paths
from deerflow.runtime.user_context import get_effective_user_id
from deerflow.skills.contract import CAPABILITY_PERMISSIONS

logger = logging.getLogger(__name__)

GUID_RE = re.compile(r"^[0-9a-f]{32}$")
VERSION_RE = re.compile(r"^\d+(?:\.\d+)*$")
_GROUP_MANIFEST = "group.json"


class CapabilityGroupError(ValueError):
    """A capability-group package is malformed or cannot be found."""


@dataclass(frozen=True)
class CapabilityGroup:
    """A discovery-time capability group (one concrete installed version)."""

    guid: str
    name: str
    version: str
    description: str
    source: str
    root: Path
    permissions: tuple[str, ...] = ()
    extends: tuple[str, ...] = ()
    tools: tuple[str, ...] = ()
    tool_permissions: dict[str, tuple[str, ...]] = field(default_factory=dict)
    files: tuple[CapabilityGroupFile, ...] = field(default_factory=tuple)

    @property
    def counts(self) -> dict[str, int]:
        result = {category: 0 for category in CAPABILITY_CATEGORIES}
        for item in self.files:
            result[item.category] = result.get(item.category, 0) + 1
        return result

    def summary_dict(self) -> dict[str, object]:
        return {
            "guid": self.guid,
            "name": self.name,
            "version": self.version,
            "description": self.description,
            "source": self.source,
            "permissions": list(self.permissions),
            "extends": list(self.extends),
            "tools": list(self.tools),
            "tool_permissions": {name: list(values) for name, values in self.tool_permissions.items()},
            "counts": self.counts,
        }

    def detail_dict(self) -> dict[str, object]:
        result = self.summary_dict()
        result["categories"] = _grouped_files(self.files)
        return result


def _grouped_files(files: tuple[CapabilityGroupFile, ...]) -> list[dict[str, object]]:
    grouped: dict[str, list[dict[str, object]]] = {}
    for item in files:
        grouped.setdefault(item.category, []).append(item.to_dict())
    order = sorted(grouped, key=category_sort_key)
    return [{"id": category, "files": grouped[category]} for category in order]


def _version_key(version: str) -> tuple[int, ...]:
    if not VERSION_RE.fullmatch(version):
        raise CapabilityGroupError(f"invalid capability-group version {version!r}; expected numeric dotted version")
    return tuple(int(part) for part in version.split("."))


def _load_manifest(group_dir: Path, *, name_hint: str, version_hint: str, source: str) -> CapabilityGroup:
    manifest_path = group_dir / _GROUP_MANIFEST
    try:
        raw = json.loads(manifest_path.read_text(encoding="utf-8"))
    except FileNotFoundError as exc:
        raise CapabilityGroupError(f"missing {_GROUP_MANIFEST} in {group_dir}") from exc
    except (OSError, json.JSONDecodeError) as exc:
        raise CapabilityGroupError(f"cannot read {manifest_path}: {exc}") from exc
    if not isinstance(raw, dict):
        raise CapabilityGroupError(f"{manifest_path} must contain a JSON object")

    guid = raw.get("guid")
    if not isinstance(guid, str) or not GUID_RE.fullmatch(guid):
        raise CapabilityGroupError(f"{manifest_path}: guid must be a 32-character lowercase hex string")
    name = raw.get("name") or name_hint
    version = raw.get("version") or version_hint
    if not isinstance(name, str) or not name.strip():
        raise CapabilityGroupError(f"{manifest_path}: name must be a non-empty string")
    if not isinstance(version, str) or not version.strip():
        raise CapabilityGroupError(f"{manifest_path}: version must be a non-empty string")
    _version_key(version)
    description = raw.get("description") or ""
    if not isinstance(description, str):
        raise CapabilityGroupError(f"{manifest_path}: description must be a string")
    permissions_raw = raw.get("permissions") or []
    extends_raw = raw.get("extends") or []
    tools_raw = raw.get("tools") or []
    tool_permissions_raw = raw.get("tool_permissions") or {}
    if not isinstance(permissions_raw, list) or not all(isinstance(item, str) for item in permissions_raw):
        raise CapabilityGroupError(f"{manifest_path}: permissions must be a list of strings")
    permissions = tuple(item.strip().lower() for item in permissions_raw if item.strip())
    unknown_permissions = sorted({item for item in permissions if item not in CAPABILITY_PERMISSIONS})
    if unknown_permissions:
        raise CapabilityGroupError(f"{manifest_path}: unknown permissions {unknown_permissions}; allowed: {sorted(CAPABILITY_PERMISSIONS)}")
    if not isinstance(extends_raw, list) or not all(isinstance(item, str) for item in extends_raw):
        raise CapabilityGroupError(f"{manifest_path}: extends must be a list of strings")
    if not isinstance(tools_raw, list) or not all(isinstance(item, str) and item.strip() for item in tools_raw):
        raise CapabilityGroupError(f"{manifest_path}: tools must be a list of non-empty strings")
    if not isinstance(tool_permissions_raw, dict):
        raise CapabilityGroupError(f"{manifest_path}: tool_permissions must be an object")
    tool_permissions: dict[str, tuple[str, ...]] = {}
    for tool_ref, values in tool_permissions_raw.items():
        if not isinstance(tool_ref, str) or not tool_ref.strip():
            raise CapabilityGroupError(f"{manifest_path}: tool_permissions keys must be non-empty strings")
        if not isinstance(values, list) or not all(isinstance(item, str) for item in values):
            raise CapabilityGroupError(f"{manifest_path}: tool_permissions[{tool_ref!r}] must be a list of strings")
        normalized = tuple(item.strip().lower() for item in values if item.strip())
        unknown = sorted({item for item in normalized if item not in CAPABILITY_PERMISSIONS})
        if unknown:
            raise CapabilityGroupError(f"{manifest_path}: tool_permissions[{tool_ref!r}] has unknown permissions {unknown}; allowed: {sorted(CAPABILITY_PERMISSIONS)}")
        tool_permissions[tool_ref.strip()] = normalized
    tools = tuple(dict.fromkeys(item.strip() for item in tools_raw))
    return CapabilityGroup(
        guid=guid,
        name=name.strip(),
        version=version.strip(),
        description=description.strip(),
        source=source,
        root=group_dir.resolve(),
        permissions=permissions,
        extends=tuple(item.strip() for item in extends_raw if item.strip()),
        tools=tools,
        tool_permissions=tool_permissions,
        files=tuple(build_capability_contents(group_dir)),
    )


def _public_root() -> Path:
    """Return the user-editable capability-group root (``{HNFLOW_HOME}/capability-groups``)."""
    return get_paths().capability_groups_dir


def _user_root(user_id: str) -> Path:
    return get_paths().user_dir(user_id) / "capability-groups"


def _roots(user_id: str | None = None) -> list[tuple[Path, str]]:
    return [(_public_root(), "public"), (_user_root(user_id or get_effective_user_id()), "user")]


def _iter_group_dirs(root: Path, source: str) -> list[tuple[Path, str, str, str]]:
    if not root.is_dir():
        return []
    found: list[tuple[Path, str, str, str]] = []
    for name_dir in sorted(root.iterdir(), key=lambda item: item.name.lower()):
        if not name_dir.is_dir() or name_dir.name.startswith("."):
            continue
        version_dirs = [entry for entry in name_dir.iterdir() if entry.is_dir() and not entry.name.startswith(".")]
        for version_dir in sorted(version_dirs, key=lambda item: _version_key(item.name) if VERSION_RE.fullmatch(item.name) else ()):
            if not (version_dir / _GROUP_MANIFEST).is_file():
                continue
            found.append((version_dir, name_dir.name, version_dir.name, source))
    return found


def discover_capability_groups(*, user_id: str | None = None) -> list[CapabilityGroup]:
    """Return the current version of every installed capability group.

    A malformed package is skipped with a warning; one broken package must not
    hide every healthy group from the management page.
    """
    current: dict[tuple[str, str], CapabilityGroup] = {}
    for root, source in _roots(user_id):
        for group_dir, name_hint, version_hint, source_name in _iter_group_dirs(root, source):
            try:
                group = _load_manifest(group_dir, name_hint=name_hint, version_hint=version_hint, source=source_name)
            except CapabilityGroupError as exc:
                logger.warning("Skipping malformed capability group at %s: %s", group_dir, exc)
                continue
            key = (group.source, group.name)
            existing = current.get(key)
            if existing is None or _version_key(group.version) > _version_key(existing.version):
                current[key] = group
    return sorted(current.values(), key=lambda item: (item.name.lower(), item.source))


def load_capability_group(identifier: str, *, version: str | None = None, user_id: str | None = None) -> CapabilityGroup:
    """Load a group by GUID or name, optionally selecting an explicit version."""
    candidates: list[CapabilityGroup] = []
    for root, source in _roots(user_id):
        for group_dir, name_hint, version_hint, source_name in _iter_group_dirs(root, source):
            if version is not None and version_hint != version:
                continue
            try:
                group = _load_manifest(group_dir, name_hint=name_hint, version_hint=version_hint, source=source_name)
            except CapabilityGroupError as exc:
                logger.warning("Skipping malformed capability group at %s: %s", group_dir, exc)
                continue
            if identifier in {group.guid, group.name}:
                candidates.append(group)
    if not candidates:
        raise CapabilityGroupError(f"capability group {identifier!r} not found")
    if version is not None:
        return max(candidates, key=lambda item: (item.source == "user", _version_key(item.version)))
    return max(candidates, key=lambda item: (_version_key(item.version), item.source == "user"))


def load_capability_group_closure(
    references: list[str],
    *,
    user_id: str | None = None,
    bases_first: bool = False,
) -> list[CapabilityGroup]:
    """Load selected groups plus their ``extends`` bases, de-duplicated by GUID.

    ``bases_first=False`` (the default) preserves the author-facing order used
    by tool resolution: each selected group is visited before its bases.
    ``bases_first=True`` returns a dependency order suitable for prompt
    assembly, where a base's rules/skills are read before the group that
    extends it.
    """
    ordered: list[CapabilityGroup] = []
    seen: set[str] = set()

    def visit(reference: str) -> None:
        group = load_capability_group(reference, user_id=user_id)
        if group.guid in seen:
            return
        seen.add(group.guid)
        if bases_first:
            for base in group.extends:
                visit(base)
        ordered.append(group)
        if not bases_first:
            for base in group.extends:
                visit(base)

    for reference in references:
        visit(reference)
    return ordered
