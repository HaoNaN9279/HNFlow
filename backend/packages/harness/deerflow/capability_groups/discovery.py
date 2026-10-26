"""Discover versioned capability groups from project, user, and public roots."""

from __future__ import annotations

import hashlib
import json
import logging
import re
from collections.abc import Iterable
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

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

_ROOT_SOURCE_ORDER = {"project": 0, "user": 1, "public": 2}

GUID_RE = re.compile(r"^[0-9a-f]{32}$")
VERSION_RE = re.compile(r"^\d+(?:\.\d+)*$")
_GROUP_MANIFEST = "group.json"


class CapabilityGroupError(ValueError):
    """A capability-group package is malformed or cannot be found."""


@dataclass(frozen=True)
class CapabilityGroupRoot:
    """One effective capability-group search root.

    Project roots are supplied by the project service after validating
    ``project.json``.  ``path`` is already resolved; symlinks/junctions are
    intentionally transparent.
    """

    path: Path
    source: str
    project_id: str | None = None
    root_id: str | None = None

    def to_dict(self) -> dict[str, Any]:
        return {
            "path": str(self.path),
            "source": self.source,
            "project_id": self.project_id,
            "root_id": self.root_id,
        }


@dataclass(frozen=True)
class _RootSpec:
    path: Path
    source: str
    project_id: str | None
    root_id: str | None
    priority: int


@dataclass(frozen=True)
class _Candidate:
    group: CapabilityGroup
    priority: int


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
    project_id: str | None = None
    root_id: str | None = None

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
            "project_id": self.project_id,
            "root_id": self.root_id,
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


def _load_manifest(
    group_dir: Path,
    *,
    name_hint: str,
    version_hint: str,
    source: str,
    project_id: str | None = None,
    root_id: str | None = None,
) -> CapabilityGroup:
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
    if name.strip() != name_hint:
        raise CapabilityGroupError(f"{manifest_path}: name {name.strip()!r} does not match directory {name_hint!r}")
    if not isinstance(version, str) or not version.strip():
        raise CapabilityGroupError(f"{manifest_path}: version must be a non-empty string")
    if version.strip() != version_hint:
        raise CapabilityGroupError(f"{manifest_path}: version {version.strip()!r} does not match directory {version_hint!r}")
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
        project_id=project_id,
        root_id=root_id,
    )


def _public_root() -> Path:
    """Return the user-editable capability-group root (``{HNFLOW_HOME}/capability-groups``)."""
    return get_paths().capability_groups_dir


def _user_root(user_id: str) -> Path:
    return get_paths().user_dir(user_id) / "capability-groups"


def _dedupe_roots(roots: Iterable[_RootSpec]) -> list[_RootSpec]:
    seen: set[str] = set()
    result: list[_RootSpec] = []
    for root in roots:
        key = str(root.path.resolve(strict=False))
        if key in seen:
            continue
        seen.add(key)
        result.append(root)
    return result


def _roots(
    user_id: str | None = None,
    project_roots: Iterable[CapabilityGroupRoot] = (),
) -> list[_RootSpec]:
    specs: list[_RootSpec] = []
    priority = 0
    for root in project_roots:
        specs.append(
            _RootSpec(
                path=Path(root.path),
                source=root.source or "project",
                project_id=root.project_id,
                root_id=root.root_id,
                priority=priority,
            )
        )
        priority += 1
    specs.append(
        _RootSpec(
            path=_user_root(user_id or get_effective_user_id()),
            source="user",
            project_id=None,
            root_id=None,
            priority=priority,
        )
    )
    priority += 1
    specs.append(
        _RootSpec(
            path=_public_root(),
            source="public",
            project_id=None,
            root_id=None,
            priority=priority,
        )
    )
    return _dedupe_roots(specs)


def _iter_group_dirs(root: _RootSpec) -> list[tuple[Path, str, str]]:
    if not root.path.is_dir():
        return []
    found: list[tuple[Path, str, str]] = []
    for name_dir in sorted(root.path.iterdir(), key=lambda item: item.name.lower()):
        if not name_dir.is_dir() or name_dir.name.startswith("."):
            continue
        version_dirs = [entry for entry in name_dir.iterdir() if entry.is_dir() and not entry.name.startswith(".")]
        for version_dir in sorted(version_dirs, key=lambda item: _version_key(item.name) if VERSION_RE.fullmatch(item.name) else ()):
            if not (version_dir / _GROUP_MANIFEST).is_file():
                continue
            found.append((version_dir, name_dir.name, version_dir.name))
    return found


def _candidates(
    *,
    user_id: str | None = None,
    project_roots: Iterable[CapabilityGroupRoot] = (),
) -> list[_Candidate]:
    candidates: list[_Candidate] = []
    for root in _roots(user_id, project_roots):
        for group_dir, name_hint, version_hint in _iter_group_dirs(root):
            try:
                group = _load_manifest(
                    group_dir,
                    name_hint=name_hint,
                    version_hint=version_hint,
                    source=root.source,
                    project_id=root.project_id,
                    root_id=root.root_id,
                )
            except CapabilityGroupError as exc:
                logger.warning("Skipping malformed capability group at %s: %s", group_dir, exc)
                continue
            candidates.append(_Candidate(group=group, priority=root.priority))
    return candidates


def _prefer(candidates: list[_Candidate], *, version: str | None = None) -> _Candidate:
    if version is not None:
        candidates = [item for item in candidates if item.group.version == version]
    if not candidates:
        raise CapabilityGroupError("capability group not found")
    lowest_priority = min(item.priority for item in candidates)
    preferred = [item for item in candidates if item.priority == lowest_priority]
    return max(preferred, key=lambda item: _version_key(item.group.version))


def _by_name(
    candidates: list[_Candidate],
    *,
    version: str | None = None,
) -> dict[str, _Candidate]:
    result: dict[str, _Candidate] = {}
    for candidate in candidates:
        if version is not None and candidate.group.version != version:
            continue
        name = candidate.group.name
        existing = result.get(name)
        if existing is None:
            result[name] = candidate
            continue
        if candidate.priority < existing.priority:
            result[name] = candidate
            continue
        if candidate.priority > existing.priority:
            continue
        if candidate.group.guid != existing.group.guid:
            raise CapabilityGroupError(f"capability group name {name!r} resolves to multiple GUIDs in the same scope: {existing.group.guid} and {candidate.group.guid}")
        if _version_key(candidate.group.version) > _version_key(existing.group.version):
            result[name] = candidate
    return result


def discover_capability_groups(
    *,
    user_id: str | None = None,
    project_roots: Iterable[CapabilityGroupRoot] = (),
) -> list[CapabilityGroup]:
    """Return the effective version of every installed capability group.

    Project roots take precedence over the user root, which takes precedence
    over the shared public/global root.  A malformed package is skipped with a
    warning; one broken package must not hide every healthy group from the
    management page.
    """
    selected = _by_name(_candidates(user_id=user_id, project_roots=project_roots))
    return sorted((candidate.group for candidate in selected.values()), key=lambda item: (item.name.lower(), _ROOT_SOURCE_ORDER.get(item.source, 9)))


def load_capability_group(
    identifier: str,
    *,
    version: str | None = None,
    user_id: str | None = None,
    project_roots: Iterable[CapabilityGroupRoot] = (),
) -> CapabilityGroup:
    """Load a group by GUID or name, optionally selecting an explicit version.

    Name lookup follows the same project -> user -> public precedence as
    discovery.  GUID lookup is scope-independent and therefore safe for
    cross-project workflow definitions.
    """
    candidates = _candidates(user_id=user_id, project_roots=project_roots)
    if GUID_RE.fullmatch(identifier):
        matches = [item for item in candidates if item.group.guid == identifier]
        if version is not None:
            matches = [item for item in matches if item.group.version == version]
        if not matches:
            raise CapabilityGroupError(f"capability group {identifier!r} not found")
        return _prefer(matches).group
    selected = _by_name(candidates, version=version)
    candidate = selected.get(identifier)
    if candidate is None:
        raise CapabilityGroupError(f"capability group {identifier!r} not found")
    return candidate.group


def load_capability_group_closure(
    references: list[str],
    *,
    user_id: str | None = None,
    project_roots: Iterable[CapabilityGroupRoot] = (),
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
        group = load_capability_group(reference, user_id=user_id, project_roots=project_roots)
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


def capability_group_content_hash(group: CapabilityGroup) -> str:
    """Stable hash of every file in a concrete group directory."""
    digest = hashlib.sha256()
    root = group.root
    for path in sorted(root.rglob("*")):
        if not path.is_file():
            continue
        relative = path.relative_to(root).as_posix()
        if "__pycache__" in path.parts or relative.startswith(".git/"):
            continue
        digest.update(relative.encode("utf-8"))
        digest.update(b"\0")
        try:
            digest.update(path.read_bytes())
        except OSError as exc:
            raise CapabilityGroupError(f"cannot hash capability group file {path}: {exc}") from exc
        digest.update(b"\0")
    return digest.hexdigest()


def verify_capability_group_snapshot(
    references: Iterable[str],
    *,
    user_id: str | None = None,
    project_roots: Iterable[CapabilityGroupRoot] = (),
    snapshot: Iterable[dict[str, Any]] = (),
) -> None:
    """Reject a run when its selected groups no longer match the run snapshot."""
    expected = {f"{item.get('guid')}@{item.get('version')}": item.get("content_hash") for item in snapshot if isinstance(item, dict) and item.get("guid") and item.get("version")}
    if not expected:
        return
    for group in load_capability_group_closure(
        list(references),
        user_id=user_id,
        project_roots=project_roots,
        bases_first=True,
    ):
        key = f"{group.guid}@{group.version}"
        expected_hash = expected.get(key)
        if expected_hash is None:
            raise CapabilityGroupError(f"capability group {group.name}@{group.version} is not part of this run snapshot")
        actual_hash = capability_group_content_hash(group)
        if actual_hash != expected_hash:
            raise CapabilityGroupError(f"capability group {group.name}@{group.version} changed after the run started")
