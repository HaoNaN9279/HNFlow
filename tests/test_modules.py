"""Tests for nested capability-group modules."""

from __future__ import annotations

import json
from pathlib import Path

import pytest

from hnflow_stack.cli import main
from hnflow_stack.errors import HNFlowError
from hnflow_stack.loader import load_group
from hnflow_stack.model import ProjectStack
from hnflow_stack.modules import activate_modules, discover_modules
from hnflow_stack.project import read_stack
from hnflow_stack.resolve import build_plan, resolve_project

# --------------------------------------------------------------------------- helpers


def _write(path: Path, text: str) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(text, encoding="utf-8")


def _write_json(path: Path, data: object) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(data, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")


def _group(
    repo: Path, name: str, version: str, *, project: bool = False, **extra: object
) -> Path:
    if project:
        base = repo / ".hnflow/groups" / name
    elif name == "core":
        base = repo / "capability-groups/core" / version
    else:
        base = repo / "capability-groups/domain" / name / version
    data: dict[str, object] = {
        "guid": (name * 32)[:32],
        "name": name,
        "version": version,
        "description": f"{name} group",
        "permissions": [],
        "extends": [],
        "tools": [],
    }
    data.update(extra)
    if project:
        data.pop("version", None)
    _write_json(base / "group.json", data)
    return base


def _stack(project: Path, groups: list[dict[str, object]]) -> None:
    _write_json(
        project / ".hnflow/stack.json",
        {
            "schema_version": 2,
            "core": {"name": "core", "version": "0.1.0"},
            "groups": groups,
        },
    )


# --------------------------------------------------------------------------- fixtures


@pytest.fixture
def game(tmp_path: Path) -> tuple[Path, Path]:
    """A repository with one nested ``game`` group and a project selecting it."""
    repo = tmp_path / "repo"
    core = _group(repo, "core", "0.1.0")
    _write(core / "rules/00-global.md", "---\nname: global\n---\n\nglobal rule\n")

    base = _group(repo, "game", "1.0.0", default_modules=["battle"])
    _write(base / "rules/root.md", "---\nname: root\n---\n\nroot rule\n")
    _write(base / "rules/shared.md", "---\nname: shared\n---\n\nshared rule\n")
    _write(base / "AGENTS.md", "# Game group conventions\n")

    battle = base / "modules/battle"
    _write_json(
        battle / "module.json",
        {"title": "Battle", "paths": ["Assets/Battle/**"], "depends": ["ui"]},
    )
    _write(
        battle / "rules/battle.md",
        "---\nname: battle\noverrides: [shared]\n---\n\nbattle rule\n",
    )
    _write(battle / "AGENTS.md", "# Battle module conventions\n")
    _write(
        battle / "agents/battle-dev.md",
        "---\nname: BattleDev\ndescription: battle agent\nmode: subagent\n---\n\n# Battle dev\n",
    )
    _write(
        battle / "commands/battle-build.md",
        "---\nname: battle-build\ndescription: build battle\n---\n\nBuild.\n",
    )
    _write(
        battle / "skills/battle-tips/SKILL.md",
        "---\nname: battle-tips\ndescription: battle tips\n---\n\n# tips\n",
    )

    ai = battle / "ai"
    _write_json(ai / "module.json", {"title": "Battle AI", "alias": "battle-ai"})
    _write(ai / "rules/ai.md", "---\nname: ai\npriority: 10\n---\n\nai rule\n")

    ui = base / "modules/ui"
    _write(ui / "rules/ui.md", "---\nname: ui\npaths: [Assets/UI/**]\n---\n\nui rule\n")

    project = tmp_path / "project"
    project.mkdir()
    _stack(project, [{"name": "game", "version": "1.0.0", "modules": "*"}])
    return repo, project


# --------------------------------------------------------------------------- discovery


def test_discover_modules(game: tuple[Path, Path]) -> None:
    repo, _ = game
    group = load_group(repo, "game", "1.0.0")
    modules = discover_modules(group)
    assert [module.path for module in modules] == ["battle", "battle/ai", "ui"]
    assert [module.alias for module in modules] == ["battle", "battle-ai", "ui"]
    assert modules[0].paths == ["Assets/Battle/**"]
    assert modules[0].depends == ["ui"]
    assert modules[0].depth == 0
    assert modules[1].depth == 1


def test_activation_uses_default_modules_and_depends(game: tuple[Path, Path]) -> None:
    repo, _ = game
    group = load_group(repo, "game", "1.0.0")
    active = activate_modules(group, discover_modules(group))
    # ``battle`` selects ``battle/ai`` by prefix; ``ui`` is pulled in by depends.
    assert [module.path for module in active] == ["battle/ai", "ui", "battle"]


def test_exclude_and_missing_selection(game: tuple[Path, Path]) -> None:
    repo, _ = game
    group = load_group(repo, "game", "1.0.0")
    modules = discover_modules(group)
    group.excluded_modules = ["battle/ai"]
    assert [module.path for module in activate_modules(group, modules)] == [
        "ui",
        "battle",
    ]

    group.excluded_modules = ["nope"]
    warnings: list[str] = []
    activate_modules(group, modules, warnings=warnings)
    assert any("matches no module" in item for item in warnings)

    group.excluded_modules = []
    group.selected_modules = ["ghost"]
    warnings = []
    activate_modules(group, modules, warnings=warnings)
    assert any("does not exist" in item for item in warnings)


def test_alias_collision_is_reported(tmp_path: Path) -> None:
    repo = tmp_path / "repo"
    base = _group(repo, "dup", "1.0.0")
    first = base / "modules/foo/bar"
    _write(first / "rules/x.md", "---\nname: x\n---\n")
    second = base / "modules/foo-bar"
    _write(second / "rules/y.md", "---\nname: y\n---\n")

    group = load_group(repo, "dup", "1.0.0")
    warnings: list[str] = []
    modules = discover_modules(group, warnings=warnings)
    assert any("share alias" in item for item in warnings)
    assert [module.path for module in modules] == ["foo/bar"]

    with pytest.raises(HNFlowError):
        discover_modules(group, strict=True)


# --------------------------------------------------------------------------- resolution


def test_module_content_is_namespaced(game: tuple[Path, Path]) -> None:
    repo, project = game
    plan = resolve_project(repo, project)

    assert [rule.name for rule in plan.rules] == [
        "global",
        "agents-md",
        "root",
        "agents-md",
        "battle",
        "ui",
        "ai",
    ]
    assert "shared" not in [rule.name for rule in plan.rules]

    roles = {rule.name: rule for rule in plan.rules if rule.kind == "rule"}
    assert roles["root"].id == "game/root"
    assert roles["root"].scope == "global"
    assert roles["battle"].id == "game/battle/battle"
    assert roles["battle"].scope == "paths"
    assert roles["battle"].paths == ["Assets/Battle/**"]
    assert roles["ui"].scope == "paths"
    assert roles["ai"].scope == "module"
    assert roles["ai"].priority == 10

    agents_md = [rule for rule in plan.rules if rule.kind == "agents"]
    assert [rule.id for rule in agents_md] == ["game/agents-md", "game/battle/agents-md"]

    agent = plan.agents["battle/BattleDev"]
    assert agent.id == "game/battle/BattleDev"
    assert agent.module == "battle"
    assert agent.label == "game/battle"
    assert "Battle dev" in agent.system
    assert plan.names["agents"]["game/battle/BattleDev"] == "battle/BattleDev"

    command = plan.commands["battle/battle-build"]
    assert command.template_path.endswith("battle-build.md")
    assert (
        plan.names["commands"]["game/battle/battle-build"]
        == "capability-game-battle-battle-build"
    )

    skill = plan.skills[0]
    assert skill.id == "game/battle/battle-tips"
    assert skill.host == "capability-game-battle-battle-tips"
    assert plan.names["skills"]["game/battle/battle-tips"] == skill.host

    assert [module["path"] for module in plan.groups[0].modules] == [
        "battle/ai",
        "ui",
        "battle",
    ]
    payload = plan.to_dict()
    assert payload["schema_version"] == 2
    assert payload["names"]["skills"]["game/battle/battle-tips"] == skill.host


def test_modules_are_selectable_and_disable_rules(game: tuple[Path, Path]) -> None:
    repo, project = game
    _stack(
        project,
        [{"name": "game", "version": "1.0.0", "modules": ["ui"]}],
    )
    plan = resolve_project(repo, project)
    assert [rule.name for rule in plan.rules] == ["global", "agents-md", "root", "shared", "ui"]
    assert plan.agents == {}

    _stack(
        project,
        [
            {
                "name": "game",
                "version": "1.0.0",
                "modules": "*",
                "disable": ["game/battle/battle", "ui"],
            }
        ],
    )
    plan = resolve_project(repo, project)
    names = [rule.name for rule in plan.rules]
    assert "battle" not in names
    assert "ui" not in names


def test_missing_module_warns_and_strict_raises(game: tuple[Path, Path]) -> None:
    repo, project = game
    _stack(project, [{"name": "game", "version": "1.0.0", "modules": ["ghost"]}])
    plan = resolve_project(repo, project)
    assert any("does not exist" in item for item in plan.warnings)

    stack = read_stack(project)
    assert stack is not None
    with pytest.raises(HNFlowError):
        build_plan(repo, project, stack, strict=True)


def test_nested_project_agents_md(game: tuple[Path, Path]) -> None:
    repo, project = game
    _write(project / "Assets/Battle/AGENTS.md", "# Battle assets\n")
    _stack(project, [{"name": "game", "version": "1.0.0", "modules": "*"}])
    stack = read_stack(project)
    assert stack is not None
    stack.agents_md = "nested"

    plan = build_plan(repo, project, stack)
    absorbed = [rule for rule in plan.rules if rule.group == "project"]
    assert len(absorbed) == 1
    assert absorbed[0].id == "project/Assets/Battle/agents-md"
    assert absorbed[0].module == "Assets/Battle"
    assert absorbed[0].scope == "paths"
    assert absorbed[0].paths == ["Assets/Battle/**"]


def test_stack_schema_is_required(tmp_path: Path) -> None:
    project = tmp_path / "project"
    _write_json(project / ".hnflow/stack.json", {"schema_version": 1})
    with pytest.raises(HNFlowError):
        read_stack(project)


# --------------------------------------------------------------------------- CLI


def test_cli_module_list_and_toggle(game: tuple[Path, Path], capsysbinary) -> None:
    repo, project = game
    base = ["--repo", str(repo), "--project", str(project), "module"]
    assert main([*base, "list"]) == 0
    out = capsysbinary.readouterr().out.decode()
    assert "battle/ai (alias: battle-ai)" in out

    assert main([*base, "disable", "game:battle/ai"]) == 0
    stack = read_stack(project)
    assert stack is not None
    assert stack.groups[0].exclude == ["battle/ai"]

    assert main([*base, "enable", "game:battle/ai"]) == 0
    stack = read_stack(project)
    assert stack is not None
    assert stack.groups[0].exclude == []


def test_cli_info_reports_stack_selected_modules(
    game: tuple[Path, Path], capsysbinary
) -> None:
    repo, project = game
    base = ["--repo", str(repo), "--project", str(project), "info", "game", "--modules"]
    assert main(base) == 0
    out = capsysbinary.readouterr().out.decode()
    assert "modules: 3" in out
    assert "alias: battle-ai" in out


def test_cli_rules_show_for_path(game: tuple[Path, Path], capsysbinary) -> None:
    repo, project = game
    base = ["--repo", str(repo), "--project", str(project)]
    assert main([*base, "rules", "show", "--for", "Assets/Battle/Enemy.cs", "--json"]) == 0
    payload = json.loads(capsysbinary.readouterr().out.decode())
    names = [rule["name"] for rule in payload["rules"]]
    assert "battle" in names
    assert "ui" not in names
    assert payload["for"] == "Assets/Battle/Enemy.cs"

    assert main([*base, "rules", "list", "--json"]) == 0
    listed = json.loads(capsysbinary.readouterr().out.decode())
    assert [rule["id"] for rule in listed["rules"]][0] == "core/global"


def test_project_group_modules(tmp_path: Path) -> None:
    repo = tmp_path / "repo"
    _group(repo, "core", "0.1.0")
    project_group = _group(repo, "local", "", project=True)
    _write_json(
        project_group / "modules/battle/module.json", {"title": "Local battle"}
    )
    _write(
        project_group / "modules/battle/rules/local.md", "---\nname: local\n---\n"
    )
    project = repo
    _stack(project, [{"name": "local", "modules": "*"}])

    plan = resolve_project(repo, project)
    assert [rule.name for rule in plan.rules] == ["local"]
    assert plan.rules[0].id == "local/battle/local"
