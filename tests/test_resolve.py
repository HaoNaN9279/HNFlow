"""Capability resolution and injection plan tests."""

from __future__ import annotations

import json
from pathlib import Path

from hnflow_stack.model import GroupRef, ProjectStack
from hnflow_stack.project import activate, init_stack, lock_path, read_stack, write_stack
from hnflow_stack.resolve import MODE_CAPABILITIES, resolve_project


def _write(path: Path, text: str) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(text, encoding="utf-8")


def _write_json(path: Path, data: dict) -> None:
    _write(path, json.dumps(data, ensure_ascii=False, indent=2) + "\n")


def test_resolve_inactive_without_stack(repo: Path, project: Path) -> None:
    plan = resolve_project(repo, project)
    assert plan.active is False
    assert plan.mode == "project"
    assert plan.core is None
    assert plan.rules == []
    assert plan.agents == {}


def test_capabilities_mode_loads_core_without_stack(
    repo: Path, project: Path
) -> None:
    plan = resolve_project(repo, project, mode=MODE_CAPABILITIES)
    assert plan.active is True
    assert plan.mode == "capabilities"
    assert plan.core is not None
    assert plan.core.name == "core"
    assert [rule.name for rule in plan.rules] == ["global"]
    assert plan.agents["Helper"].group == "core"
    assert [skill.name for skill in plan.skills] == ["core-skill"]


def test_capabilities_mode_falls_back_to_the_newest_core(
    repo: Path, project: Path
) -> None:
    write_stack(project, ProjectStack(core=GroupRef("core", "9.9.9")))
    plan = resolve_project(repo, project, mode=MODE_CAPABILITIES)
    assert plan.active is True
    assert plan.core is not None
    assert plan.core.version == "0.1.0"
    assert any("unavailable" in warning for warning in plan.warnings)


def test_capabilities_mode_unions_core_and_project_groups(
    repo: Path, project: Path
) -> None:
    init_stack(project, GroupRef("core", "0.1.0"))
    activate(project, GroupRef("data", ""), repo)
    plan = resolve_project(repo, project, mode=MODE_CAPABILITIES)
    assert plan.active is True
    assert plan.core is not None
    assert [group.name for group in plan.groups] == ["base", "data"]
    assert [rule.name for rule in plan.rules] == ["global", "base", "data"]
    assert plan.agents["Helper"].group == "core"


def test_resolve_core_groups_and_dependencies(repo: Path, project: Path) -> None:
    init_stack(project, GroupRef("core", "0.1.0"))
    activate(project, GroupRef("data", ""), repo)
    plan = resolve_project(repo, project)
    assert plan.active is True
    assert plan.core is not None
    assert plan.core.name == "core"
    assert [group.name for group in plan.groups] == ["base", "data"]
    assert [rule.name for rule in plan.rules] == ["global", "base", "data"]
    assert plan.agents["Helper"].group == "core"
    assert plan.skills[0].name == "core-skill"


def test_resolve_missing_group_is_warning(repo: Path, project: Path) -> None:
    write_stack(
        project,
        ProjectStack(
            core=GroupRef("core", "0.1.0"),
            groups=[GroupRef("missing", "")],
        ),
    )
    plan = resolve_project(repo, project)
    assert plan.active is True
    assert plan.groups == []
    assert any("missing" in warning for warning in plan.warnings)


def test_resolve_skips_invalid_content_and_collects_warnings(
    repo: Path, project: Path
) -> None:
    core = repo / "capability-groups/core/0.1.0"
    _write(core / "rules/missing-name.md", "# no frontmatter\n")
    _write(
        core / "agents/bad-mode.md",
        "---\nname: BadMode\ndescription: bad\nmode: worker\n---\nbody\n",
    )
    _write(
        core / "commands/no-description.md",
        "---\nname: no-description\n---\nbody\n",
    )
    _write(
        core / "commands/Bad-Name.md",
        "---\nname: Bad-Name\ndescription: bad\n---\nbody\n",
    )
    _write(
        core / "skills/Bad-Name/SKILL.md",
        "---\nname: Bad-Name\ndescription: bad\n---\nbody\n",
    )
    _write(
        core / "skills/has-metadata/SKILL.md",
        "---\nname: has-metadata\ndescription: bad\nmetadata:\n  x: y\n---\nbody\n",
    )
    init_stack(project, GroupRef("core", "0.1.0"))
    plan = resolve_project(repo, project)
    assert all("missing-name" not in rule.path for rule in plan.rules)
    assert "BadMode" not in plan.agents
    assert "no-description" not in plan.commands
    assert "Bad-Name" not in plan.commands
    assert all("Bad-Name" not in skill.path for skill in plan.skills)
    assert all("has-metadata" not in skill.path for skill in plan.skills)
    assert any("missing-name.md" in warning for warning in plan.warnings)
    assert any("bad-mode.md" in warning for warning in plan.warnings)
    assert any("no-description.md" in warning for warning in plan.warnings)
    assert any("Bad-Name.md" in warning for warning in plan.warnings)
    assert any("Bad-Name" in warning for warning in plan.warnings)
    assert any("has-metadata" in warning for warning in plan.warnings)


def test_resolve_mcp_and_missing_tool(repo: Path, project: Path) -> None:
    _write_json(
        repo / "capability-groups/domain/broken/1.0.0/group.json",
        {
            "guid": "f" * 32,
            "name": "broken",
            "version": "1.0.0",
            "description": "broken",
            "tools": ["tool:" + "0" * 32 + "@v0.1.0"],
        },
    )
    write_stack(
        project,
        ProjectStack(
            core=GroupRef("core", "0.1.0"),
            groups=[GroupRef("data", ""), GroupRef("broken", "")],
        ),
    )
    plan = resolve_project(repo, project)
    assert plan.mcp["capability:core_mcp_tool"]["url"] == "http://example.test/mcp"
    assert plan.mcp["capability:data_demo_tool"]["url"] == "http://example.test/mcp"
    assert "name" not in plan.mcp["capability:core_mcp_tool"]
    assert any("broken" in warning for warning in plan.warnings)


def test_resolve_keeps_last_agent_and_drops_invalid_model(
    repo: Path, project: Path
) -> None:
    _write(
        repo / "capability-groups/domain/base/1.0.0/agents/helper.md",
        "---\nname: Helper\ndescription: base\nmode: primary\n---\nbase\n",
    )
    _write(
        repo / "capability-groups/domain/data/1.0.0/agents/helper.md",
        "---\nname: Helper\ndescription: data\nmode: primary\nmodel: x/y\n---\ndata\n",
    )
    init_stack(project, GroupRef("core", "0.1.0"))
    activate(project, GroupRef("data", ""), repo)
    plan = resolve_project(repo, project)
    assert plan.agents["Helper"].system == "data"
    assert "model" not in plan.to_dict()["agents"]["Helper"]
    assert any("invalid model" in warning for warning in plan.warnings)


def test_resolve_model_references_are_syntax_checked(
    repo: Path, project: Path
) -> None:
    core = repo / "capability-groups/core/0.1.0"
    _write(
        core / "agents/model-agent.md",
        "---\nname: ModelAgent\ndescription: model\nmode: all\n"
        "model: strong\n---\nbody\n",
    )
    _write(
        core / "commands/model-command.md",
        "---\nname: model-command\ndescription: model\n"
        "model: fast\n---\nbody\n",
    )
    _write(
        core / "skills/model-skill/SKILL.md",
        "---\nname: model-skill\ndescription: model\nmodel: strong\n---\nbody\n",
    )
    _write(
        core / "agents/bad-model.md",
        "---\nname: BadModel\ndescription: bad\nmode: all\n"
        "model: Bad Layer\n---\nbody\n",
    )
    init_stack(project, GroupRef("core", "0.1.0"))
    plan = resolve_project(repo, project)
    assert plan.agents["ModelAgent"].model == "strong"
    assert plan.commands["model-command"].model == "fast"
    assert plan.skills[-1].model == "strong"
    assert plan.agents["BadModel"].model is None
    assert any("invalid model" in warning for warning in plan.warnings)
    assert "model" not in plan.to_dict()["agents"]["BadModel"]


def test_resolve_is_read_only_and_fingerprint_tracks_content(
    repo: Path, project: Path
) -> None:
    init_stack(project, GroupRef("core", "0.1.0"))
    first = resolve_project(repo, project)
    assert not lock_path(project).is_file()
    _write(
        repo / "capability-groups/core/0.1.0/rules/extra.md",
        "---\nname: extra\ndescription: extra rules\n---\nbody\n",
    )
    second = resolve_project(repo, project)
    assert first.fingerprint != second.fingerprint
    stack = read_stack(project)
    assert stack is not None
