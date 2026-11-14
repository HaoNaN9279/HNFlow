"""Core ships the group and flow authoring content and is always loaded."""

from __future__ import annotations

from pathlib import Path

from hnflow_stack.loader import load_group
from hnflow_stack.model import GroupRef
from hnflow_stack.project import init_stack
from hnflow_stack.resolve import MODE_CAPABILITIES, resolve_project

REPO = Path(__file__).resolve().parents[1]

AUTHORING_SKILLS = {
    "custom-agent",
    "custom-command",
    "custom-group",
    "custom-mcp",
    "custom-rule",
    "custom-skill",
    "custom-tool",
    "flow-author",
    "flow-boundary",
    "flow-capability",
    "flow-intake",
    "flow-review",
}


def test_core_ships_the_authoring_content() -> None:
    group = load_group(REPO, "core")
    assert group.version == "0.1.0"
    skills = {path.name for path in (group.root / "skills").iterdir()}
    assert AUTHORING_SKILLS <= skills
    assert (group.root / "agents/hephaestus.md").is_file()
    assert (group.root / "agents/argus.md").is_file()
    assert (group.root / "agents/daedalus.md").is_file()
    assert (group.root / "rules/group-authoring.md").is_file()
    assert (group.root / "rules/hnflow-forge.md").is_file()
    assert (group.root / "commands/group-new.md").is_file()
    assert (group.root / "commands/flow-new.md").is_file()
    assert not (REPO / "capability-groups/domain/group-forge").exists()
    assert not (REPO / "capability-groups/domain/hnflow-forge").exists()


def test_core_loads_the_authoring_content_without_a_group(tmp_path: Path) -> None:
    project = tmp_path / "project"
    project.mkdir()
    init_stack(project, GroupRef("core", "0.1.0"))

    plan = resolve_project(REPO, project, mode=MODE_CAPABILITIES)
    assert plan.active is True
    assert plan.core is not None and plan.core.name == "core"
    assert plan.groups == []
    assert {"Athena", "Hermes", "Hephaestus", "Argus", "Daedalus"} <= set(plan.agents)
    assert {"group-new", "group-validate", "flow-new"} <= set(plan.commands)
    skills = {skill.name for skill in plan.skills}
    assert {"custom-group", "flow-author"} <= skills
    assert plan.rules and all(rule.on_demand for rule in plan.rules)
