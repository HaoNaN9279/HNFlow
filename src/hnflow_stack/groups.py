"""Capability group inventory for UI surfaces.

The DSH plugin exposes one workspace-local switcher window. It needs more than a
resolved plan can answer: an INACTIVE group is absent from every plan, yet the
window must still list it (and preview its files) before the user turns it on.
This module therefore reads the repository's own group directories and reports
each group with its activation state and its content inventory.

Activation is not decided here: `.hnflow/stack.json` is the single source of
truth, exactly as for the resolver.
"""

from __future__ import annotations

from pathlib import Path

from hnflow_stack.frontmatter import frontmatter_text, parse_frontmatter
from hnflow_stack.loader import discover_groups, project_groups_dir
from hnflow_stack.model import GroupMeta, ProjectStack, read_json
from hnflow_stack.project import read_stack

#: Content kinds reported per group, in display order.
CONTENT_KINDS = ("rules", "agents", "commands", "skills", "references", "flows")


def groups_document(repo: Path, project: Path) -> dict[str, object]:
    """Describe every capability group the workspace can activate.

    Repository groups come first (Core included), then the project's own groups.
    A group is ``active`` when ``.hnflow/stack.json`` names it; Core is fixed and
    always active.
    """
    stack = read_stack(project)
    active = {ref.name for ref in stack.groups} if stack is not None else set()
    core_name = stack.core.name if stack is not None and stack.core is not None else "core"
    groups = []
    for group in discover_groups(repo, project=project):
        fixed = group.name == core_name
        groups.append(
            {
                "name": group.name,
                "version": group.version,
                "guid": group.guid,
                "description": group.description,
                "source": _source(group, project),
                "fixed": fixed,
                "active": fixed or group.name in active,
                "root": str(group.root),
                "contents": _contents(group),
            }
        )
    return {
        "schema_version": 2,
        "repo": str(repo),
        "project": str(project),
        "stack": stack.to_dict() if stack is not None else None,
        "groups": groups,
    }


def _source(group: GroupMeta, project: Path) -> str:
    """Whether the group lives in the repository or in the project."""
    base = project_groups_dir(project).resolve()
    try:
        group.root.resolve().relative_to(base)
        return "project"
    except ValueError:
        return "repo"


def _contents(group: GroupMeta) -> dict[str, list[dict[str, object]]]:
    """Inventory every content file, labelled with the id a preview can use."""
    contents: dict[str, list[dict[str, object]]] = {kind: [] for kind in CONTENT_KINDS}
    for path in group.rules:
        item = _frontmatter_item(group, path, "rule", path.stem)
        item.update(_rule_policy(path))
        contents["rules"].append(item)
    for path in group.agents:
        contents["agents"].append(_frontmatter_item(group, path, "agent", path.stem))
    for path in group.commands:
        contents["commands"].append(_frontmatter_item(group, path, "command", path.stem))
    skills_dir = group.skills_dir
    if skills_dir is not None:
        for directory in sorted(entry for entry in skills_dir.iterdir() if entry.is_dir()):
            manifest = directory / "SKILL.md"
            if manifest.is_file():
                contents["skills"].append(_frontmatter_item(group, manifest, "skill", directory.name))
    for path in group.references:
        contents["references"].append(_frontmatter_item(group, path, "reference", path.stem))
    for path in group.flows:
        contents["flows"].append(_flow_item(group, path))
    agents_md = group.agents_md
    if agents_md is not None:
        contents["references"].append(
            {
                "id": f"{group.name}/AGENTS.md",
                "name": "AGENTS.md",
                "description": "组级 AGENTS.md",
                "kind": "reference",
                "path": str(agents_md),
            }
        )
    for items in contents.values():
        items.sort(key=lambda item: str(item["id"]))
    return contents


def _frontmatter_item(
    group: GroupMeta, path: Path, kind: str, fallback: str
) -> dict[str, object]:
    """Describe one markdown file from its frontmatter, tolerating a bad file."""
    name = fallback
    description = ""
    mode = ""
    text = ""
    try:
        text = path.read_text(encoding="utf-8-sig")
    except OSError:
        text = ""
    if text:
        parsed = parse_frontmatter(text)
        name = frontmatter_text(parsed.data.get("name")) or fallback
        description = frontmatter_text(parsed.data.get("description"))
        mode = frontmatter_text(parsed.data.get("mode"))
    relative = path.relative_to(group.root).as_posix()
    item: dict[str, object] = {
        "id": f"{group.name}/{relative}",
        "name": name,
        "description": description,
        "kind": kind,
        "path": str(path),
    }
    if mode:
        item["mode"] = mode
    return item


def _rule_policy(path: Path) -> dict[str, object]:
    """Rule scope/policy fields the window shows as metadata."""
    try:
        parsed = parse_frontmatter(path.read_text(encoding="utf-8-sig"))
    except OSError:
        return {"scope": "global", "on_demand": False, "priority": 0}
    scope = frontmatter_text(parsed.data.get("scope")) or "global"
    raw_paths = parsed.data.get("paths")
    paths = [str(item) for item in raw_paths] if isinstance(raw_paths, list) else []
    priority = parsed.data.get("priority")
    on_demand = parsed.data.get("on_demand")
    return {
        "scope": scope if scope in {"global", "paths"} else "global",
        "paths": paths,
        "on_demand": _as_bool(on_demand),
        "priority": _as_int(priority),
    }


def _flow_item(group: GroupMeta, path: Path) -> dict[str, object]:
    """Describe one flow definition file."""
    name = path.name.removesuffix(".flow.json")
    description = ""
    try:
        data = read_json(path)
    except Exception:  # noqa: BLE001 - a broken flow must not hide the rest
        data = {}
    flow_id = data.get("id")
    if isinstance(flow_id, str) and flow_id:
        name = flow_id
    raw = data.get("description")
    if isinstance(raw, str):
        description = raw.strip()
    return {
        "id": f"{group.name}/{name}",
        "name": name,
        "description": description,
        "kind": "flow",
        "path": str(path),
    }


def _as_bool(value: object) -> bool:
    """Parse the same frontmatter booleans the resolver accepts."""
    if isinstance(value, bool):
        return value
    if isinstance(value, str):
        return value.strip().lower() in {"true", "yes", "1", "on"}
    return False


def _as_int(value: object) -> int:
    """Parse a frontmatter integer, falling back to zero."""
    if isinstance(value, bool):
        return 0
    if isinstance(value, int):
        return value
    if isinstance(value, str):
        try:
            return int(value.strip())
        except ValueError:
            return 0
    return 0


def active_names(project: Path) -> list[str]:
    """Group names currently listed in ``.hnflow/stack.json``."""
    stack: ProjectStack | None = read_stack(project)
    return [ref.name for ref in stack.groups] if stack is not None else []
