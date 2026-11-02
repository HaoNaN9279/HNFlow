"""Parse capability-group manifests and hash concrete package contents."""

from __future__ import annotations

import hashlib
import json
import re
from dataclasses import dataclass, field
from pathlib import Path

from deerflow.capability_groups.contents import (
    CAPABILITY_CATEGORIES,
    CapabilityGroupFile,
    build_capability_contents,
    category_sort_key,
)
from deerflow.skills.contract import CAPABILITY_PERMISSIONS

GUID_RE = re.compile(r"^[0-9a-f]{32}$")
VERSION_RE = re.compile(r"^\d+(?:\.\d+)*$")
_GROUP_MANIFEST = "group.json"


class CapabilityGroupError(ValueError):
    """A capability-group package is malformed or cannot be found."""


@dataclass(frozen=True)
class CapabilityGroup:
    """One concrete capability-group version parsed from ``group.json``."""

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
