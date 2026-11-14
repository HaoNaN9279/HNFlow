"""The group-forge capability group: repository content and Core union."""

from __future__ import annotations

from pathlib import Path

from hnflow_stack.loader import load_group
from hnflow_stack.model import GroupRef
from hnflow_stack.project import activate, init_stack
from hnflow_stack.resolve import MODE_CAPABILITIES, resolve_project

REPO = Path(__file__).resolve().parents[1]


def test_group_forge_is_a_valid_group_with_the_custom_skills() -> None:
    group = load_group(REPO, "group-forge")
    assert group.version == "0.1.0"
    skill_names = sorted(path.name for path in (group.root / "skills").iterdir())
    assert skill_names == [
        "custom-agent",
        "custom-command",
        "custom-group",
        "custom-mcp",
        "custom-module",
        "custom-rule",
        "custom-skill",
        "custom-tool",
    ]
    assert (group.root / "agents/hephaestus.md").is_file()
    assert (group.root / "rules/group-authoring.md").is_file()
    assert (group.root / "commands/group-new.md").is_file()
    assert not (REPO / "capability-groups/core/0.1.0/skills/custom-agent").exists()


def test_group_forge_unions_with_core_in_HNFLOW_mode(tmp_path: Path) -> None:
    project = tmp_path / "project"
    project.mkdir()
    init_stack(project, GroupRef("core", "0.1.0"))
    activate(project, GroupRef("group-forge", "0.1.0"), REPO)

    plan = resolve_project(REPO, project, mode=MODE_CAPABILITIES)
    assert plan.active is True
    assert plan.core is not None
    assert [group.name for group in plan.groups] == ["group-forge"]
    assert {"Athena", "Hermes", "Hephaestus"} <= set(plan.agents)
    assert plan.agents["Hephaestus"].group == "group-forge"
    assert {"group-new", "group-validate"} <= set(plan.commands)
    skill_names = {skill.name for skill in plan.skills}
    assert {"caveman", "custom-group", "custom-tool"} <= skill_names
