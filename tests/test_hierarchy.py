"""Nested capability-group levels."""

from __future__ import annotations

import json
from pathlib import Path

import pytest

from hnflow_stack.errors import GroupRequiredError, HNFlowError
from hnflow_stack.groups import groups_document
from hnflow_stack.loader import discover_groups, load_group
from hnflow_stack.model import GroupRef
from hnflow_stack.project import (
    activate,
    deactivate,
    init_stack,
    read_stack,
    resolve_order,
)
from hnflow_stack.resolve import build_plan


def _write_json(path: Path, data: dict) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(data, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")


def _write(path: Path, text: str) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(text, encoding="utf-8")


def _group(
    root: Path,
    name: str,
    guid: str,
    *,
    version: str | None = None,
    extends: list[str] | None = None,
) -> None:
    data = {"guid": guid, "name": name, "description": f"{name} group"}
    if version is not None:
        data["version"] = version
    if extends is not None:
        data["extends"] = extends
    _write_json(root / "group.json", data)


def _rule(root: Path, relative: str, name: str, overrides: list[str] | None = None) -> None:
    lines = ["---", f"name: {name}", f"description: {name} rule"]
    if overrides:
        lines.append("overrides:")
        lines.extend(f"  - {item}" for item in overrides)
    lines.extend(["---", "", f"# {name}", ""])
    _write(root / relative, "\n".join(lines))


@pytest.fixture
def arena(tmp_path: Path) -> Path:
    """A repository with ``arena`` -> ``framework`` -> ``editor``/``docs``."""
    repo = tmp_path / "repo"
    core = repo / "capability-groups/core/0.1.0"
    _group(core, "core", "0" * 32, version="0.1.0")
    _rule(core, "rules/00-global.md", "global")

    root = repo / "capability-groups/domain/arena/1.0.0"
    _group(root, "arena", "1" * 32, version="1.0.0", extends=[])
    _rule(root, "rules/00-arena.md", "arena-rule")

    framework = root / "levels/framework"
    _group(framework, "framework", "2" * 32)
    _rule(framework, "rules/10-framework.md", "shared")

    editor = framework / "levels/editor"
    _group(editor, "editor", "3" * 32)
    _rule(editor, "rules/20-editor.md", "shared", overrides=["shared"])
    _write(
        editor / "skills/editor-skill/SKILL.md",
        "---\nname: editor-skill\ndescription: editor skill\n---\n\n# editor skill\n",
    )
    _write(
        editor / "agents/editor-agent.md",
        "---\nname: EditorAgent\ndescription: editor agent\nmode: subagent\n---\n\n# editor\n",
    )

    docs = framework / "levels/docs"
    _group(docs, "docs", "4" * 32)
    _rule(docs, "rules/docs.md", "docs-rule")
    return repo


def test_load_nested_level_exposes_ancestry(arena: Path) -> None:
    group = load_group(arena, "arena/framework/editor")

    assert group.name == "arena/framework/editor"
    assert group.version == "1.0.0"
    assert group.parent == "arena/framework"
    assert group.depth == 2
    assert group.root.name == "editor"
    assert group.description == "editor group"


def test_discover_groups_lists_every_level(arena: Path) -> None:
    names = {group.name for group in discover_groups(arena)}

    assert names == {
        "core",
        "arena",
        "arena/framework",
        "arena/framework/editor",
        "arena/framework/docs",
    }


@pytest.mark.parametrize(
    "name",
    [
        "arena//framework",
        "/arena",
        "arena/",
        "arena/levels",
        "arena/../framework",
        "Arena",
        "arena/framework/editor/deep/too/many/levels/here",
    ],
)
def test_invalid_group_paths_are_rejected(arena: Path, name: str) -> None:
    with pytest.raises(HNFlowError):
        load_group(arena, name)


def test_resolve_loads_ancestors_and_child_override(arena: Path, project: Path) -> None:
    init_stack(project, GroupRef("core", "0.1.0"))
    activate(project, GroupRef("arena/framework/editor", ""), arena)
    stack = read_stack(project)

    order = [group.name for group in resolve_order(arena, stack)]
    assert order == ["core", "arena", "arena/framework", "arena/framework/editor"]

    plan = build_plan(arena, project, stack)
    shared = [rule for rule in plan.rules if rule.name == "shared"]
    assert len(shared) == 1
    assert shared[0].group == "arena/framework/editor"
    assert [rule.name for rule in plan.rules] == ["global", "arena-rule", "shared"]
    assert any(skill.host == "capability-arena-framework-editor-editor-skill" for skill in plan.skills)
    assert "EditorAgent" in plan.agents
    editor = next(group for group in plan.groups if group.name == "arena/framework/editor")
    assert editor.parent == "arena/framework"
    assert editor.depth == 2


def test_groups_document_marks_implicit_ancestors(arena: Path, project: Path) -> None:
    init_stack(project, GroupRef("core", "0.1.0"))
    activate(project, GroupRef("arena/framework/editor", ""), arena)

    document = groups_document(arena, project)
    by_name = {group["name"]: group for group in document["groups"]}

    assert by_name["arena"]["active"] is True
    assert by_name["arena"]["explicit"] is False
    assert by_name["arena"]["depth"] == 0
    assert by_name["arena/framework/editor"]["explicit"] is True
    assert by_name["arena/framework/editor"]["parent"] == "arena/framework"
    assert by_name["arena/framework/editor"]["ancestors"] == ["arena", "arena/framework"]
    assert by_name["arena/framework/docs"]["active"] is False
    assert document["stack"]["groups"][0]["name"] == "arena/framework/editor"


def test_groups_document_keeps_ancestor_version_of_explicit_child(
    arena: Path, project: Path
) -> None:
    newer = arena / "capability-groups/domain/arena/2.0.0"
    _group(newer, "arena", "7" * 32, version="2.0.0")
    _group(newer / "levels/framework", "framework", "8" * 32)

    init_stack(project, GroupRef("core", "0.1.0"))
    activate(project, GroupRef("arena/framework/editor", "1.0.0"), arena)

    document = groups_document(arena, project)
    by_name = {group["name"]: group for group in document["groups"]}

    assert by_name["arena"]["version"] == "1.0.0"
    assert by_name["arena/framework"]["version"] == "1.0.0"
    assert by_name["arena/framework/editor"]["version"] == "1.0.0"


def test_child_override_does_not_reach_an_unrelated_group(
    arena: Path, project: Path
) -> None:
    other = arena / "capability-groups/domain/other/1.0.0"
    _group(other, "other", "9" * 32, version="1.0.0")
    _rule(other, "rules/00-other.md", "shared")

    init_stack(project, GroupRef("core", "0.1.0"))
    activate(project, GroupRef("other", ""), arena)
    activate(project, GroupRef("arena/framework/editor", ""), arena)
    plan = build_plan(arena, project, read_stack(project))

    shared = [rule for rule in plan.rules if rule.name == "shared"]
    assert [rule.group for rule in shared] == ["other", "arena/framework/editor"]


def test_same_level_override_replaces_earlier_rule(arena: Path, project: Path) -> None:
    root = arena / "capability-groups/domain/arena/1.0.0"
    _rule(root, "rules/10-arena.md", "same")
    _rule(root, "rules/20-arena.md", "same", overrides=["same"])

    init_stack(project, GroupRef("core", "0.1.0"))
    activate(project, GroupRef("arena", ""), arena)
    plan = build_plan(arena, project, read_stack(project))

    same = [rule for rule in plan.rules if rule.name == "same"]
    assert len(same) == 1
    assert same[0].path.endswith("20-arena.md")


def test_project_root_shadows_repo_descendants(arena: Path, project: Path) -> None:
    repo_local = arena / "capability-groups/domain/local/1.0.0"
    _group(repo_local, "local", "a" * 32, version="1.0.0")
    _group(repo_local / "levels/child", "child", "b" * 32)
    local = project / ".hnflow/groups/local"
    _group(local, "local", "c" * 32)

    document = groups_document(arena, project)
    by_name = {group["name"]: group for group in document["groups"]}

    assert by_name["local"]["source"] == "project"
    assert "local/child" not in by_name


def test_project_local_nested_group(arena: Path, project: Path) -> None:
    local = project / ".hnflow/groups/local"
    _group(local, "local", "5" * 32)
    child = local / "levels/child"
    _group(child, "child", "6" * 32)

    group = load_group(arena, "local/child", project=project)
    assert group.name == "local/child"
    assert group.version == ""
    assert group.parent == "local"

    document = groups_document(arena, project)
    by_name = {item["name"]: item for item in document["groups"]}
    assert by_name["local"]["source"] == "project"
    assert by_name["local/child"]["source"] == "project"


def test_stopping_one_sibling_keeps_the_other(
    arena: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    project = arena / "workspace"
    project.mkdir()
    monkeypatch.setenv("HNFLOW_HOME", str(arena))
    init_stack(project, GroupRef("core", "0.1.0"))
    for name in ("arena", "arena/framework", "arena/framework/editor", "arena/framework/docs"):
        activate(project, GroupRef(name, ""), arena)

    with pytest.raises(GroupRequiredError):
        deactivate(project, "arena")

    deactivate(project, "arena/framework/editor")
    with pytest.raises(GroupRequiredError):
        deactivate(project, "arena")

    stack = read_stack(project)
    assert [ref.name for ref in stack.groups] == [
        "arena",
        "arena/framework",
        "arena/framework/docs",
    ]
    assert [group.name for group in resolve_order(arena, stack)] == [
        "core",
        "arena",
        "arena/framework",
        "arena/framework/docs",
    ]

    deactivate(project, "arena/framework/docs")
    deactivate(project, "arena/framework")
    deactivate(project, "arena")
    assert read_stack(project).groups == []
