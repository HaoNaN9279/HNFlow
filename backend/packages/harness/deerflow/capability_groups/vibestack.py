"""VibeStack repository, project stack, and capability-group resolution.

VibeStack owns the external ``capability-groups/<name>/<version>/`` and
``tools/<name>/<version>/`` trees.  A project activates groups through
``<project>/.vibestack/stack.json``.  This module is the single adapter between
that on-disk contract and HNFlow's workflow runtime.

The project stack is **additive** for HNFlow writes: activating a group only
inserts or updates that group, and every unrelated entry is preserved.
"""

from __future__ import annotations

import hashlib
import json
import logging
import os
import re
import tempfile
from collections.abc import Iterable
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

from deerflow.capability_groups.discovery import CapabilityGroup, CapabilityGroupError, _load_manifest, _version_key
from deerflow.locks.file_lock import resource_lock

logger = logging.getLogger(__name__)

GUID_RE = re.compile(r"^[0-9a-f]{32}$")
_NAME_VERSION_RE = re.compile(r"^(?P<name>[^@]+)@v?(?P<version>\d+(?:\.\d+)*)$")
_DEFAULT_CORE = ("core", "0.1.0")
_STACK_SCHEMA_VERSION = 1
_STACK_DIR = ".vibestack"
_STACK_FILE = "stack.json"
_MAX_STACK_BYTES = 2 * 1024 * 1024


class VibeStackError(ValueError):
    """The VibeStack repository or project stack is invalid."""


@dataclass(frozen=True)
class VibeStackGroupRef:
    """A project-stack reference to one group version."""

    name: str
    version: str

    def to_dict(self) -> dict[str, str]:
        return {"name": self.name, "version": self.version}

    def __str__(self) -> str:
        return f"{self.name}@{self.version}"


@dataclass(frozen=True)
class VibeStackStack:
    """The parsed ``.vibestack/stack.json`` document."""

    path: Path
    schema_version: int
    core: VibeStackGroupRef | None
    agents: tuple[str, ...] = ()
    groups: tuple[VibeStackGroupRef, ...] = ()
    raw: dict[str, Any] = field(default_factory=dict)

    def to_dict(self) -> dict[str, Any]:
        data = dict(self.raw)
        data["schema_version"] = self.schema_version
        if self.core is not None:
            data["core"] = self.core.to_dict()
        data["agents"] = list(self.agents)
        data["groups"] = [group.to_dict() for group in self.groups]
        return data

    @property
    def group_names(self) -> tuple[str, ...]:
        return tuple(group.name for group in self.groups)


@dataclass(frozen=True)
class ActivationResult:
    """Difference produced by an additive project-stack update."""

    stack: VibeStackStack
    changed: bool
    activated: tuple[VibeStackGroupRef, ...] = ()
    updated: tuple[VibeStackGroupRef, ...] = ()
    created: bool = False

    def to_dict(self) -> dict[str, Any]:
        return {
            "changed": self.changed,
            "created": self.created,
            "activated": [group.to_dict() for group in self.activated],
            "updated": [group.to_dict() for group in self.updated],
            "stack": self.stack.to_dict(),
        }


def stack_path(project_root: Path) -> Path:
    return project_root / _STACK_DIR / _STACK_FILE


def global_config_path() -> Path:
    return Path.home() / ".config" / "vibestack" / "config.json"


def _expand_path(value: str) -> Path:
    expanded = os.path.expandvars(value)
    return Path(expanded).expanduser()


def _read_global_config() -> dict[str, Any]:
    path = global_config_path()
    if not path.is_file():
        return {}
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return {}
    return data if isinstance(data, dict) else {}


def resolve_repository(config: Any | None = None) -> Path | None:
    """Return the configured VibeStack repository, or ``None``.

    Priority: HNFlow ``vibestack.repository``, ``VIBESTACK_HOME``,
    ``VIBESTACK_REPO``, then VibeStack's own global config.  An explicitly
    configured path that is not a VibeStack checkout raises rather than silently
    falling back to a different repository.
    """
    explicit: str | None = None
    vibestack = getattr(config, "vibestack", None) if config is not None else None
    if vibestack is None and config is None:
        try:
            from deerflow.config.app_config import get_app_config

            vibestack = getattr(get_app_config(), "vibestack", None)
        except Exception:  # noqa: BLE001 - config may be unavailable in unit tests
            vibestack = None
    if vibestack is not None:
        explicit = getattr(vibestack, "repository", None)
    if explicit:
        candidate = _expand_path(str(explicit))
        if not (candidate / "capability-groups").is_dir():
            raise VibeStackError(f"configured VibeStack repository is not a checkout: {candidate}")
        return candidate.resolve()

    for env_name in ("VIBESTACK_HOME", "VIBESTACK_REPO"):
        value = os.environ.get(env_name)
        if value:
            candidate = _expand_path(value)
            if not (candidate / "capability-groups").is_dir():
                raise VibeStackError(f"{env_name} is not a VibeStack checkout: {candidate}")
            return candidate.resolve()

    configured = _read_global_config().get("repository")
    if isinstance(configured, str) and configured.strip():
        candidate = _expand_path(configured)
        if (candidate / "capability-groups").is_dir():
            return candidate.resolve()
        logger.warning("Ignoring VibeStack global config repository that is not a checkout: %s", candidate)
    return None


def default_core(config: Any | None = None) -> VibeStackGroupRef:
    """Return the configured fixed Core reference or ``core@0.1.0``."""
    raw: Any = None
    vibestack = getattr(config, "vibestack", None) if config is not None else None
    if vibestack is not None:
        raw = getattr(vibestack, "core", None)
    if isinstance(raw, str) and raw.strip():
        return parse_ref(raw.strip())
    global_core = _read_global_config().get("core")
    if isinstance(global_core, dict):
        name = str(global_core.get("name") or _DEFAULT_CORE[0])
        version = str(global_core.get("version") or _DEFAULT_CORE[1])
        return VibeStackGroupRef(name=name, version=version)
    return VibeStackGroupRef(*_DEFAULT_CORE)


def parse_ref(value: str) -> VibeStackGroupRef:
    """Parse ``name`` / ``name@version`` / ``name@v<version>``.

    A bare reference without a version is returned with an empty version; the
    caller resolves it against the repository or the active stack.
    """
    token = value.strip()
    if not token:
        raise VibeStackError("capability group reference must be non-empty")
    match = _NAME_VERSION_RE.match(token)
    if match:
        return VibeStackGroupRef(name=match.group("name"), version=match.group("version"))
    return VibeStackGroupRef(name=token, version="")


def _iter_group_dirs(repository: Path) -> list[tuple[Path, str, str]]:
    """Yield ``(group_dir, name, version)`` for both repository layouts.

    VibeStack mixes flat core packages (``capability-groups/core/<version>``)
    with scoped domain packages (``capability-groups/domain/<name>/<version>``).
    The group name always comes from the directory immediately above the
    version directory, so a flat ``<name>/<version>`` keeps working.
    """
    base = repository / "capability-groups"
    if not base.is_dir():
        return []
    found: list[tuple[Path, str, str]] = []
    for manifest in base.rglob("group.json"):
        group_dir = manifest.parent
        try:
            parts = group_dir.relative_to(base).parts
        except ValueError:
            continue
        if len(parts) not in {2, 3} or any(part.startswith(".") for part in parts):
            continue
        name, version = parts[-2], parts[-1]
        if not re.fullmatch(r"\d+(?:\.\d+)*", version):
            continue
        found.append((group_dir, name, version))
    return sorted(found, key=lambda item: (item[1].lower(), _version_key(item[2])))


def discover_repository_groups(repository: Path) -> list[CapabilityGroup]:
    """Return every concrete ``<name>@<version>`` package in the repository."""
    groups: list[CapabilityGroup] = []
    for group_dir, name_hint, version_hint in _iter_group_dirs(repository):
        try:
            groups.append(
                _load_manifest(
                    group_dir,
                    name_hint=name_hint,
                    version_hint=version_hint,
                    source="vibestack",
                )
            )
        except CapabilityGroupError as exc:
            logger.warning("Skipping malformed VibeStack capability group at %s: %s", group_dir, exc)
    return sorted(groups, key=lambda group: (group.name.lower(), _version_key(group.version)))


def find_group(
    repository: Path,
    reference: str,
    *,
    active: dict[str, str] | None = None,
) -> CapabilityGroup:
    """Resolve one reference against the repository.

    * ``guid`` selects the highest version of that GUID.
    * ``guid@v<version>`` selects the exact version.
    * ``name`` uses the active stack version when one exists, else latest.
    * ``name@<version>`` selects the exact version.
    """
    parsed = parse_ref(reference)
    groups = discover_repository_groups(repository)
    matches = [group for group in groups if parsed.name in {group.guid, group.name} and (not parsed.version or group.version == parsed.version)]
    if not matches:
        raise VibeStackError(f"capability group {reference!r} not found in {repository}")
    if parsed.version:
        return max(matches, key=lambda group: _version_key(group.version))
    if GUID_RE.fullmatch(parsed.name):
        return max(matches, key=lambda group: _version_key(group.version))
    active_version = (active or {}).get(parsed.name)
    if active_version:
        for group in matches:
            if group.version == active_version:
                return group
    return max(matches, key=lambda group: _version_key(group.version))


def load_group_closure(
    repository: Path,
    references: Iterable[str],
    *,
    active: dict[str, str] | None = None,
    core: VibeStackGroupRef | None = None,
    include_core: bool = True,
    bases_first: bool = True,
) -> list[CapabilityGroup]:
    """Load Core + selected groups and their ``extends`` closure."""
    ordered: list[CapabilityGroup] = []
    seen_guids: set[str] = set()
    seen_names: dict[str, str] = {}

    def add(group: CapabilityGroup) -> None:
        if group.guid in seen_guids:
            return
        existing_version = seen_names.get(group.name)
        if existing_version is not None and existing_version != group.version:
            raise VibeStackError(f"capability group {group.name!r} is selected with multiple versions: {existing_version} and {group.version}")
        seen_guids.add(group.guid)
        seen_names[group.name] = group.version
        if bases_first:
            for dependency in group.extends:
                add(find_group(repository, dependency, active=active))
        ordered.append(group)
        if not bases_first:
            for dependency in group.extends:
                add(find_group(repository, dependency, active=active))

    if include_core:
        core_ref = core or default_core()
        add(find_group(repository, f"{core_ref.name}@v{core_ref.version}", active=active))
    for reference in references:
        if not str(reference).strip():
            continue
        add(find_group(repository, str(reference), active=active))
    return ordered


def read_project_stack(project_root: Path) -> VibeStackStack | None:
    path = stack_path(project_root)
    if not path.is_file():
        return None
    try:
        size = path.stat().st_size
        if size > _MAX_STACK_BYTES:
            raise VibeStackError(f"{path} is too large ({size} bytes; max {_MAX_STACK_BYTES})")
        raw = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, UnicodeError, json.JSONDecodeError) as exc:
        raise VibeStackError(f"cannot read {path}: {exc}") from exc
    if not isinstance(raw, dict):
        raise VibeStackError(f"{path} must contain a JSON object")
    schema_version = raw.get("schema_version", 1)
    if schema_version != _STACK_SCHEMA_VERSION:
        raise VibeStackError(f"unsupported VibeStack stack schema_version {schema_version!r}")
    core_data = raw.get("core")
    core = None
    if isinstance(core_data, dict) and core_data.get("name"):
        core = VibeStackGroupRef(name=str(core_data["name"]), version=str(core_data.get("version", "")))
    groups: list[VibeStackGroupRef] = []
    raw_groups = raw.get("groups", [])
    if not isinstance(raw_groups, list):
        raise VibeStackError(f"invalid {path}: 'groups' must be an array")
    for item in raw_groups:
        if not isinstance(item, dict) or not item.get("name"):
            raise VibeStackError(f"invalid {path}: every group entry needs a name")
        groups.append(VibeStackGroupRef(name=str(item["name"]), version=str(item.get("version", ""))))
    agents_raw = raw.get("agents", [])
    agents = tuple(str(item) for item in agents_raw) if isinstance(agents_raw, list) else ()
    return VibeStackStack(
        path=path,
        schema_version=_STACK_SCHEMA_VERSION,
        core=core,
        agents=agents,
        groups=tuple(groups),
        raw=dict(raw),
    )


def _atomic_write_json(path: Path, payload: dict[str, Any]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    text = json.dumps(payload, ensure_ascii=False, indent=2) + "\n"
    temp_name: str | None = None
    try:
        with tempfile.NamedTemporaryFile(
            mode="w",
            encoding="utf-8",
            dir=path.parent,
            prefix=f".{path.name}.",
            suffix=".tmp",
            delete=False,
            newline="\n",
        ) as handle:
            temp_name = handle.name
            handle.write(text)
            handle.flush()
            os.fsync(handle.fileno())
        os.replace(temp_name, path)
        temp_name = None
    finally:
        if temp_name is not None:
            try:
                Path(temp_name).unlink(missing_ok=True)
            except OSError:
                logger.warning("failed to remove temporary VibeStack stack file %s", temp_name, exc_info=True)


def _stack_lock(project_root: Path):
    digest = hashlib.sha256(str(project_root.resolve(strict=False)).casefold().encode("utf-8")).hexdigest()[:24]
    return resource_lock(f"vibestack_stack_{digest}")


def write_project_stack(project_root: Path, stack: VibeStackStack) -> None:
    with _stack_lock(project_root):
        _atomic_write_json(stack.path, stack.to_dict())


def ensure_project_stack(
    project_root: Path,
    *,
    core: VibeStackGroupRef | None = None,
) -> tuple[VibeStackStack, bool]:
    """Ensure ``.vibestack/stack.json`` exists and has a fixed Core.

    Returns ``(stack, created)``.  Existing group entries are preserved; only a
    missing Core is added.
    """
    existing = read_project_stack(project_root)
    fixed_core = core or default_core()
    if existing is None:
        stack = VibeStackStack(
            path=stack_path(project_root),
            schema_version=_STACK_SCHEMA_VERSION,
            core=fixed_core,
            agents=(),
            groups=(),
            raw={"schema_version": _STACK_SCHEMA_VERSION},
        )
        write_project_stack(project_root, stack)
        return stack, True
    if existing.core is None:
        stack = VibeStackStack(
            path=existing.path,
            schema_version=existing.schema_version,
            core=fixed_core,
            agents=existing.agents,
            groups=existing.groups,
            raw=existing.raw,
        )
        write_project_stack(project_root, stack)
        return stack, False
    return existing, False


def upsert_project_groups(
    project_root: Path,
    groups: Iterable[VibeStackGroupRef],
    *,
    core: VibeStackGroupRef | None = None,
) -> ActivationResult:
    """Add or update only the supplied group entries.

    Every unrelated existing entry is preserved.  This is deliberately not a
    recomputation: HNFlow only changes the groups a workflow actually needs.
    """
    existing, created = ensure_project_stack(project_root, core=core)
    fixed_core = core or existing.core or default_core()
    current = [VibeStackGroupRef(name=item.name, version=item.version) for item in existing.groups]
    by_name = {item.name: index for index, item in enumerate(current)}
    activated: list[VibeStackGroupRef] = []
    updated: list[VibeStackGroupRef] = []
    changed = created or existing.core is None

    for group in groups:
        if group.name == fixed_core.name:
            continue
        index = by_name.get(group.name)
        if index is None:
            by_name[group.name] = len(current)
            current.append(group)
            activated.append(group)
            changed = True
        elif current[index].version != group.version:
            current[index] = group
            updated.append(group)
            changed = True

    if not changed:
        return ActivationResult(stack=existing, changed=False)

    stack = VibeStackStack(
        path=existing.path,
        schema_version=_STACK_SCHEMA_VERSION,
        core=fixed_core,
        agents=existing.agents,
        groups=tuple(current),
        raw=existing.raw,
    )
    write_project_stack(project_root, stack)
    return ActivationResult(
        stack=stack,
        changed=True,
        activated=tuple(activated),
        updated=tuple(updated),
        created=created,
    )


def active_versions(stack: VibeStackStack | None) -> dict[str, str]:
    if stack is None:
        return {}
    return {group.name: group.version for group in stack.groups if group.version}


def verify_group_snapshot(
    repository: Path,
    references: Iterable[str],
    *,
    active: dict[str, str] | None = None,
    core: VibeStackGroupRef | None = None,
    snapshot: Iterable[dict[str, Any]] = (),
) -> None:
    """Reject a run whose effective groups no longer match its run snapshot."""
    from deerflow.capability_groups.discovery import capability_group_content_hash

    expected = {f"{item.get('guid')}@{item.get('version')}": item.get("content_hash") for item in snapshot if isinstance(item, dict) and item.get("guid") and item.get("version")}
    if not expected:
        return
    for group in load_group_closure(repository, references, active=active, core=core, bases_first=True):
        key = f"{group.guid}@{group.version}"
        expected_hash = expected.get(key)
        if expected_hash is None:
            raise VibeStackError(f"capability group {group.name}@{group.version} is not part of this run snapshot")
        if capability_group_content_hash(group) != expected_hash:
            raise VibeStackError(f"capability group {group.name}@{group.version} changed after the run started")


__all__ = [
    "ActivationResult",
    "VibeStackError",
    "VibeStackGroupRef",
    "VibeStackStack",
    "active_versions",
    "default_core",
    "discover_repository_groups",
    "ensure_project_stack",
    "find_group",
    "global_config_path",
    "load_group_closure",
    "parse_ref",
    "read_project_stack",
    "resolve_repository",
    "stack_path",
    "upsert_project_groups",
    "write_project_stack",
]
