"""Discovery, validation, and selection of capability-group modules.

A module is a directory below ``<group>/modules/``. Directories without a
``module.json`` are modules too: the directory path *is* the id. Modules are
never versioned on their own and never span groups.
"""

from __future__ import annotations

import json
from pathlib import Path

from hnflow_stack.errors import HNFlowError
from hnflow_stack.model import GroupMeta, ModuleMeta
from hnflow_stack.naming import module_alias, valid_module_path

CONTENT_DIRS = ("rules", "agents", "commands", "skills", "references")
MAX_MODULE_DEPTH = 3
_NESTED_PROJECT_SKIP = {
    ".git",
    ".hnflow",
    "node_modules",
    "Library",
    "Temp",
    "obj",
    "bin",
    ".venv",
    "venv",
    "dist",
    "build",
    "target",
}


def discover_modules(
    group: GroupMeta,
    *,
    warnings: list[str] | None = None,
    strict: bool = False,
) -> list[ModuleMeta]:
    """Return every valid module of *group*, sorted by path.

    Invalid modules are skipped with a warning in fail-open mode and raise in
    strict mode.
    """
    out = warnings if warnings is not None else []
    root = group.modules_root
    if not root.is_dir():
        return []
    found: list[ModuleMeta] = []
    aliases: dict[str, str] = {}
    for directory in sorted(path for path in root.rglob("*") if path.is_dir()):
        relative = directory.relative_to(root).as_posix()
        if any(part.startswith(".") for part in relative.split("/")):
            continue
        if not _is_module_dir(directory):
            continue
        error = _module_error(directory, relative)
        if error:
            _report(out, strict, f"{group.name}: {relative}: {error}")
            continue
        module = _load_module(directory, relative)
        other = aliases.get(module.alias)
        if other is not None:
            _report(
                out,
                strict,
                f"{group.name}: modules '{other}' and '{relative}' share "
                f"alias '{module.alias}'",
            )
            continue
        aliases[module.alias] = relative
        found.append(module)
    _check_depends(group, found, out, strict)
    return found


def activate_modules(
    group: GroupMeta,
    modules: list[ModuleMeta],
    *,
    warnings: list[str] | None = None,
    strict: bool = False,
) -> list[ModuleMeta]:
    """Apply the stack selection plus ``depends`` and return the active modules."""
    out = warnings if warnings is not None else []
    by_path = {module.path: module for module in modules}
    wanted = _selection(group, modules, out, strict)
    selected: list[ModuleMeta] = []
    for module in modules:
        if module.path in wanted:
            selected.append(module)
    excluded = set()
    for pattern in group.excluded_modules:
        matched = [module.path for module in modules if _matches(module.path, pattern)]
        if not matched:
            _report(out, strict, f"{group.name}: exclude pattern '{pattern}' matches no module")
        excluded.update(matched)
    selected = [module for module in selected if module.path not in excluded]
    selected = _with_dependencies(group, selected, by_path, out, strict)
    return _topological_order(group, selected, out, strict)


def active_modules(group: GroupMeta) -> list[ModuleMeta]:
    """Discover and activate one group's modules, discarding diagnostics."""
    return activate_modules(group, discover_modules(group))


def nested_agents_md_files(project: Path, *, max_depth: int = 4, limit: int = 64) -> list[Path]:
    """Return project ``AGENTS.md`` files below *project*, bounded and sorted."""
    base = project.resolve()
    found: list[Path] = []
    stack = [(base, 0)]
    while stack:
        directory, depth = stack.pop()
        if depth > max_depth:
            continue
        try:
            children = sorted(directory.iterdir())
        except OSError:
            continue
        for child in children:
            if child.name in _NESTED_PROJECT_SKIP:
                continue
            if child.is_dir():
                if child.name.startswith("."):
                    continue
                stack.append((child, depth + 1))
            elif child.name == "AGENTS.md" and child.is_file():
                found.append(child)
                if len(found) >= limit:
                    return sorted(found)
    return sorted(found)


def _selection(
    group: GroupMeta,
    modules: list[ModuleMeta],
    warnings: list[str],
    strict: bool,
) -> set[str]:
    wanted = group.selected_modules
    if wanted is None:
        wanted = list(group.default_modules)
        if not wanted:
            wanted = [module.path for module in modules if module.default]
    if "*" in wanted:
        return {module.path for module in modules}
    chosen: set[str] = set()
    for pattern in wanted:
        matched = [module.path for module in modules if _matches(module.path, pattern)]
        if not matched:
            _report(
                warnings,
                strict,
                f"{group.name}: selected module '{pattern}' does not exist",
            )
        chosen.update(matched)
    return chosen


def _with_dependencies(
    group: GroupMeta,
    selected: list[ModuleMeta],
    by_path: dict[str, ModuleMeta],
    warnings: list[str],
    strict: bool,
) -> list[ModuleMeta]:
    active = {module.path: module for module in selected}
    changed = True
    while changed:
        changed = False
        for module in list(active.values()):
            for dependency in module.depends:
                if dependency in active:
                    continue
                target = by_path.get(dependency)
                if target is None:
                    _report(
                        warnings,
                        strict,
                        f"{group.name}: module '{module.path}' depends on "
                        f"missing module '{dependency}'",
                    )
                    continue
                active[dependency] = target
                changed = True
    return list(active.values())


def _topological_order(
    group: GroupMeta,
    modules: list[ModuleMeta],
    warnings: list[str],
    strict: bool,
) -> list[ModuleMeta]:
    by_path = {module.path: module for module in modules}
    pending = sorted(by_path)
    ordered: list[ModuleMeta] = []
    emitted: set[str] = set()
    while pending:
        ready = [
            path
            for path in pending
            if all(dep in emitted or dep not in by_path for dep in by_path[path].depends)
        ]
        if not ready:
            cycle = ", ".join(pending)
            _report(
                warnings,
                strict,
                f"{group.name}: module dependency cycle: {cycle}",
            )
            ordered.extend(by_path[path] for path in pending)
            break
        for path in ready:
            ordered.append(by_path[path])
            emitted.add(path)
        pending = [path for path in pending if path not in emitted]
    return ordered


def _matches(path: str, pattern: str) -> bool:
    if pattern == "*":
        return True
    return path == pattern or path.startswith(pattern + "/")


def _is_module_dir(directory: Path) -> bool:
    if (directory / "module.json").is_file():
        return True
    return any((directory / name).is_dir() for name in CONTENT_DIRS)


def _module_error(directory: Path, relative: str) -> str:
    if not valid_module_path(relative, MAX_MODULE_DEPTH):
        return (
            f"invalid module path (expected lowercase kebab-case segments, "
            f"at most {MAX_MODULE_DEPTH})"
        )
    meta_path = directory / "module.json"
    if not meta_path.is_file():
        return ""
    try:
        data = json.loads(meta_path.read_text(encoding="utf-8-sig"))
    except (OSError, UnicodeDecodeError, json.JSONDecodeError) as exc:
        return f"invalid module.json: {exc}"
    if not isinstance(data, dict):
        return "module.json must contain a JSON object"
    declared = data.get("name")
    if declared is not None and not isinstance(declared, str):
        return "module.json 'name' must be a string"
    if declared and declared != relative.split("/")[-1]:
        return (
            f"module.json name '{declared}' does not match directory "
            f"'{relative.split('/')[-1]}'"
        )
    alias = data.get("alias")
    if alias is not None and (not isinstance(alias, str) or not alias.strip()):
        return "module.json 'alias' must be a non-empty string"
    if alias and alias != alias.strip():
        return "module.json 'alias' must not have surrounding spaces"
    if alias and not valid_module_path(alias, 1):
        return f"module.json alias '{alias}' must be lowercase kebab-case"
    for key in ("depends", "tools", "paths"):
        value = data.get(key)
        if value is not None and not isinstance(value, list):
            return f"module.json '{key}' must be an array"
        if isinstance(value, list) and any(not isinstance(item, str) for item in value):
            return f"module.json '{key}' entries must be strings"
    if "default" in data and not isinstance(data["default"], bool):
        return "module.json 'default' must be a boolean"
    return ""


def _load_module(directory: Path, relative: str) -> ModuleMeta:
    meta_path = directory / "module.json"
    data: dict[str, object] = {}
    if meta_path.is_file():
        loaded = json.loads(meta_path.read_text(encoding="utf-8-sig"))
        if isinstance(loaded, dict):
            data = loaded
    alias = str(data.get("alias") or module_alias(relative))
    return ModuleMeta(
        path=relative,
        root=directory,
        alias=alias,
        title=str(data.get("title") or ""),
        description=str(data.get("description") or ""),
        paths=[str(item) for item in data.get("paths", [])] if isinstance(data.get("paths"), list) else [],
        default=bool(data.get("default", False)),
        depends=[str(item) for item in data.get("depends", [])] if isinstance(data.get("depends"), list) else [],
        tools=[str(item) for item in data.get("tools", [])] if isinstance(data.get("tools"), list) else [],
    )


def _check_depends(
    group: GroupMeta,
    modules: list[ModuleMeta],
    warnings: list[str],
    strict: bool,
) -> None:
    paths = {module.path for module in modules}
    for module in modules:
        for dependency in module.depends:
            if dependency not in paths:
                _report(
                    warnings,
                    strict,
                    f"{group.name}: module '{module.path}' depends on "
                    f"unknown module '{dependency}'",
                )


def _report(warnings: list[str], strict: bool, message: str) -> None:
    if strict:
        raise HNFlowError(message)
    warnings.append(message)
