"""Capability group and tool package loaders."""

from __future__ import annotations

import re
from pathlib import Path

from hnflow_stack.errors import GroupNotFoundError, ToolNotFoundError, HNFlowError
from hnflow_stack.model import GroupMeta, ToolMeta, read_json

_SEMVER = re.compile(r"^v?(\d+)\.(\d+)\.(\d+)")
_CORE_GROUP = "core"
_DOMAIN_DIR = "domain"
_PROJECT_DIR = ".hnflow"
_PROJECT_GROUPS = "groups"


def _version_key(version: str) -> tuple[int, ...]:
    match = _SEMVER.match(version)
    if match is None:
        return (0, 0, 0)
    return tuple(int(part) for part in match.groups())


def _group_base(repo: Path, name: str) -> Path:
    base = repo / "capability-groups"
    if name == _CORE_GROUP:
        return base / _CORE_GROUP
    return base / _DOMAIN_DIR / name


def project_groups_dir(project: Path) -> Path:
    """Return ``<project>/.hnflow/groups``."""
    return project / _PROJECT_DIR / _PROJECT_GROUPS


def _project_group_root(project: Path | None, name: str) -> Path | None:
    """Return the project-local group root, or ``None`` when absent."""
    if project is None:
        return None
    root = project_groups_dir(project) / name
    return root if (root / "group.json").is_file() else None


def load_group(
    repo: Path,
    name: str,
    version: str | None = None,
    *,
    project: Path | None = None,
) -> GroupMeta:
    """Load one capability group.

    Core lives in ``capability-groups/core``; every other repository group lives
    in ``capability-groups/domain``. When *version* is omitted, choose the
    highest semver available.

    A project-local group at ``<project>/.hnflow/groups/<name>`` wins over a
    repository group of the same name. It has no version directory, so its
    ``group.json`` ``version`` is optional.
    """
    local_root = _project_group_root(project, name)
    if local_root is not None:
        return _load_project_group(local_root, name, version)

    base = _group_base(repo, name)
    if not base.is_dir():
        raise GroupNotFoundError(f"capability group '{name}' not found")
    if version:
        root = base / version
        if not (root / "group.json").is_file():
            raise GroupNotFoundError(
                f"capability group '{name}' version '{version}' not found"
            )
    else:
        versions = sorted(
            (p for p in base.iterdir() if (p / "group.json").is_file()),
            key=lambda p: _version_key(p.name),
        )
        if not versions:
            raise GroupNotFoundError(f"capability group '{name}' has no versions")
        root = versions[-1]

    data = read_json(root / "group.json")
    required = ("guid", "name", "version", "description")
    missing = [key for key in required if key not in data]
    if missing:
        raise HNFlowError(
            f"{root / 'group.json'} missing fields: {', '.join(missing)}"
        )
    if str(data["name"]) != name or str(data["version"]) != root.name:
        raise HNFlowError(
            f"{root / 'group.json'} name/version must match the directory"
        )
    return _group_meta(data, root, name, str(data["version"]))


def _load_project_group(root: Path, name: str, version: str | None) -> GroupMeta:
    """Load a project-local group, which carries no version directory."""
    data = read_json(root / "group.json")
    required = ("guid", "name", "description")
    missing = [key for key in required if key not in data]
    if missing:
        raise HNFlowError(
            f"{root / 'group.json'} missing fields: {', '.join(missing)}"
        )
    if str(data["name"]) != name:
        raise HNFlowError(f"{root / 'group.json'} name must match the directory")
    declared = str(data.get("version", ""))
    if version and declared != version:
        raise GroupNotFoundError(
            f"capability group '{name}' version '{version}' not found"
        )
    return _group_meta(data, root, name, declared)


def _group_meta(
    data: dict[str, object], root: Path, name: str, version: str
) -> GroupMeta:
    return GroupMeta(
        guid=str(data["guid"]),
        name=name,
        version=version,
        description=str(data["description"]),
        permissions=_str_list(data.get("permissions")),
        extends=_str_list(data.get("extends")),
        tools=_str_list(data.get("tools")),
        tool_permissions=_str_map(data.get("tool_permissions")),
        root=root,
    )


def discover_groups(repo: Path, *, project: Path | None = None) -> list[GroupMeta]:
    """Discover repository groups plus the project's own groups."""
    groups = _discover_repo_groups(repo)
    if project is not None:
        base = project_groups_dir(project)
        if base.is_dir():
            for config in sorted(base.glob("*/group.json")):
                try:
                    groups.append(
                        _load_project_group(config.parent, config.parent.name, None)
                    )
                except HNFlowError:
                    continue
    return groups


def _discover_repo_groups(repo: Path) -> list[GroupMeta]:
    base = repo / "capability-groups"
    if not base.is_dir():
        return []
    entries: list[tuple[str, str]] = []
    core_base = base / _CORE_GROUP
    if core_base.is_dir():
        entries.extend(
            (_CORE_GROUP, config.parent.name)
            for config in sorted(core_base.glob("*/group.json"))
        )
    domain_base = base / _DOMAIN_DIR
    if domain_base.is_dir():
        entries.extend(
            (config.parent.parent.name, config.parent.name)
            for config in sorted(domain_base.glob("*/*/group.json"))
        )
    groups: list[GroupMeta] = []
    for name, version in entries:
        try:
            groups.append(load_group(repo, name, version))
        except HNFlowError:
            continue
    return groups


def load_tool(repo: Path, name: str, version: str) -> ToolMeta:
    """Load one ``tools/<name>/<version>/tool.json``."""
    root = repo / "tools" / name / version
    path = root / "tool.json"
    if not path.is_file():
        raise ToolNotFoundError(f"tool '{name}@{version}' not found")
    data = read_json(path)
    return ToolMeta(
        guid=str(data.get("guid", "")),
        name=str(data.get("name", name)),
        tool_name=str(data.get("tool_name", name)),
        version=str(data.get("version", version)),
        description=str(data.get("description", "")),
        provider=str(data.get("provider", "python")),
        permissions=_str_list(data.get("permissions")),
        entrypoint=_opt_str(data.get("entrypoint")),
        idempotent=bool(data.get("idempotent", True)),
        source=dict(data.get("source") or {}),
        run=dict(data["run"]) if isinstance(data.get("run"), dict) else None,
        mcp=dict(data["mcp"]) if isinstance(data.get("mcp"), dict) else None,
        root=root,
    )


def discover_tools(repo: Path) -> list[ToolMeta]:
    """Discover every tool package."""
    base = repo / "tools"
    if not base.is_dir():
        return []
    tools: list[ToolMeta] = []
    for config in sorted(base.glob("*/*/tool.json")):
        try:
            tools.append(load_tool(repo, config.parent.parent.name, config.parent.name))
        except HNFlowError:
            continue
    return tools


def find_tool(repo: Path, identifier: str) -> ToolMeta:
    """Find a tool by ``tool:<guid>@v<version>``, ``name@version``, name, or guid."""
    version = ""
    token = identifier
    if token.startswith("tool:"):
        token = token[5:]
    if "@v" in token:
        token, version = token.rsplit("@v", 1)
    elif "@" in token:
        token, version = token.rsplit("@", 1)

    candidates = discover_tools(repo)
    matches = [
        tool
        for tool in candidates
        if token in (tool.guid, tool.name, tool.tool_name) and (not version or tool.version == version)
    ]
    if not matches:
        raise ToolNotFoundError(f"tool '{identifier}' not found")
    matches.sort(key=lambda tool: _version_key(tool.version))
    return matches[-1]


def _str_list(value: object) -> list[str]:
    if isinstance(value, list):
        return [str(item) for item in value]
    return []


def _str_map(value: object) -> dict[str, list[str]]:
    if not isinstance(value, dict):
        return {}
    return {str(key): _str_list(item) for key, item in value.items()}


def _opt_str(value: object) -> str | None:
    return str(value) if value is not None else None
