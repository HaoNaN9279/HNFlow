"""Capability group and tool package loaders."""

from __future__ import annotations

import re
from pathlib import Path

from hnflow_stack.errors import GroupNotFoundError, ToolNotFoundError, HNFlowError
from hnflow_stack.model import GroupMeta, ToolMeta, read_json

_SEMVER = re.compile(r"^v?(\d+)\.(\d+)\.(\d+)")
_SEGMENT = re.compile(r"^[a-z0-9][a-z0-9-]*$")
_CORE_GROUP = "core"
_DOMAIN_DIR = "domain"
_PROJECT_DIR = ".hnflow"
_PROJECT_GROUPS = "groups"
_LEVELS_DIR = "levels"

#: Deepest group path accepted, counting the root group as depth 1.
MAX_GROUP_DEPTH = 8


def _version_key(version: str) -> tuple[int, ...]:
    match = _SEMVER.match(version)
    if match is None:
        return (0, 0, 0)
    return tuple(int(part) for part in match.groups())


def split_group_path(name: str) -> list[str]:
    """Split a capability-group path such as ``unity/framework/editor``.

    A path segment is the directory name of one level. Segments are restricted
    to lowercase letters, digits and hyphens; ``levels`` is reserved for the
    nesting container and path traversal is rejected outright.
    """
    text = name.strip() if isinstance(name, str) else ""
    if not text:
        raise HNFlowError("capability group name is required")
    if "\\" in text:
        raise HNFlowError(f"invalid capability group path '{name}': backslashes are not allowed")
    if text.startswith("/") or text.endswith("/"):
        raise HNFlowError(f"invalid capability group path '{name}': leading or trailing slash")
    parts = text.split("/")
    if len(parts) > MAX_GROUP_DEPTH:
        raise HNFlowError(
            f"invalid capability group path '{name}': at most {MAX_GROUP_DEPTH} levels"
        )
    for part in parts:
        if part in {"", ".", "..", _LEVELS_DIR} or _SEGMENT.match(part) is None:
            raise HNFlowError(
                f"invalid capability group path '{name}': segment '{part}' is not allowed"
            )
    return parts


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
    """Load one capability group or nested level.

    The first path segment picks the tree root: core lives in
    ``capability-groups/core``; every other repository group lives in
    ``capability-groups/domain/<root>``. A project-local root at
    ``<project>/.hnflow/groups/<root>`` shadows the repository tree of the same
    name. Further segments descend through ``levels/<segment>/`` directories.

    A level inherits the root version: its ``group.json`` may omit ``version``,
    and a declared version must equal the root version. When *version* is
    omitted for a repository group, the highest semver root is chosen.
    """
    parts = split_group_path(name)
    root_name = parts[0]
    local_root = _project_group_root(project, root_name)
    if local_root is not None:
        return _load_tree(local_root, parts, version, project=True)

    base = _group_base(repo, root_name)
    if not base.is_dir():
        raise GroupNotFoundError(f"capability group '{name}' not found")
    root = _select_version(base, root_name, version)
    return _load_tree(root, parts, version, project=False)


def _select_version(base: Path, name: str, version: str | None) -> Path:
    """Pick the requested version directory, or the newest one."""
    if version:
        root = base / version
        if not (root / "group.json").is_file():
            raise GroupNotFoundError(
                f"capability group '{name}' version '{version}' not found"
            )
        return root
    versions = sorted(
        (path for path in base.iterdir() if (path / "group.json").is_file()),
        key=lambda path: _version_key(path.name),
    )
    if not versions:
        raise GroupNotFoundError(f"capability group '{name}' has no versions")
    return versions[-1]


def _load_tree(
    root: Path, parts: list[str], version: str | None, *, project: bool
) -> GroupMeta:
    """Read every node from *root* down to the requested level."""
    split_group_path("/".join(parts))
    current = root
    parent: str | None = None
    root_version = ""
    for index, segment in enumerate(parts):
        config = current / "group.json"
        path_name = "/".join(parts[: index + 1])
        if not config.is_file():
            raise GroupNotFoundError(f"capability group '{path_name}' not found")
        data = read_json(config)
        required = ("guid", "name", "description")
        if index == 0 and not project:
            required = ("guid", "name", "version", "description")
        missing = [key for key in required if key not in data]
        if missing:
            raise HNFlowError(f"{config} missing fields: {', '.join(missing)}")
        if str(data["name"]) != segment:
            raise HNFlowError(f"{config} name must match the directory")

        declared = str(data.get("version", ""))
        if index == 0:
            if project:
                if version and declared != version:
                    raise GroupNotFoundError(
                        f"capability group '{path_name}' version '{version}' not found"
                    )
                root_version = declared
            else:
                if declared != current.name:
                    raise HNFlowError(f"{config} name/version must match the directory")
                root_version = declared
        else:
            if declared and declared != root_version:
                raise HNFlowError(
                    f"{config} version must match the root version '{root_version}'"
                )
            if version and version != root_version:
                raise GroupNotFoundError(
                    f"capability group '{path_name}' version '{version}' not found"
                )

        meta = _group_meta(
            data,
            current,
            path_name,
            root_version,
            parent=parent,
            depth=index,
        )
        if index == len(parts) - 1:
            return meta
        parent = path_name
        current = current / _LEVELS_DIR / parts[index + 1]

    raise GroupNotFoundError(f"capability group '{'/'.join(parts)}' not found")


def _group_meta(
    data: dict[str, object],
    root: Path,
    name: str,
    version: str,
    *,
    parent: str | None = None,
    depth: int = 0,
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
        parent=parent,
        depth=depth,
    )


def discover_groups(repo: Path, *, project: Path | None = None) -> list[GroupMeta]:
    """Discover repository trees plus the project's own group trees."""
    groups = _discover_repo_groups(repo)
    if project is not None:
        base = project_groups_dir(project)
        if base.is_dir():
            for config in sorted(base.glob("*/group.json")):
                try:
                    groups.extend(_walk_tree(config.parent, [config.parent.name], True))
                except HNFlowError:
                    continue
    return groups


def _discover_repo_groups(repo: Path) -> list[GroupMeta]:
    base = repo / "capability-groups"
    if not base.is_dir():
        return []
    entries: list[tuple[str, Path]] = []
    core_base = base / _CORE_GROUP
    if core_base.is_dir():
        entries.extend(
            (_CORE_GROUP, config.parent)
            for config in sorted(core_base.glob("*/group.json"))
        )
    domain_base = base / _DOMAIN_DIR
    if domain_base.is_dir():
        entries.extend(
            (config.parent.parent.name, config.parent)
            for config in sorted(domain_base.glob("*/*/group.json"))
        )
    groups: list[GroupMeta] = []
    for name, root in entries:
        try:
            groups.extend(_walk_tree(root, [name], False))
        except HNFlowError:
            continue
    return groups


def _walk_tree(root: Path, parts: list[str], project: bool) -> list[GroupMeta]:
    """Load one root and every valid level below it, depth first."""
    found = [_load_tree(root, parts, None, project=project)]
    current = root
    for segment in parts[1:]:
        current = current / _LEVELS_DIR / segment
    levels = current / _LEVELS_DIR
    if not levels.is_dir():
        return found
    for child in sorted(levels.iterdir()):
        if not child.is_dir() or not (child / "group.json").is_file():
            continue
        try:
            found.extend(_walk_tree(root, [*parts, child.name], project))
        except HNFlowError:
            continue
    return found


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
