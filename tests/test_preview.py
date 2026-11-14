"""Tests for the simulated session view behind `hnflow-stack preview`."""

from __future__ import annotations

import json
from pathlib import Path
from types import SimpleNamespace

import pytest

from hnflow_stack.cli import main
from hnflow_stack.errors import HNFlowError
from hnflow_stack.preview import build_session
from hnflow_stack.rules import RULES_FOOTER, RULES_HEADER, read_body


def _write(path: Path, text: str) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(text, encoding="utf-8")


def _json(path: Path, data: dict) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(data, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")


@pytest.fixture(autouse=True)
def isolated_home(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> Path:
    """Keep the host instruction chain inside the test tree."""
    home = tmp_path / "home"
    home.mkdir(parents=True, exist_ok=True)
    monkeypatch.setenv("DSH_HOME", str(home / ".dsh"))
    monkeypatch.setattr(Path, "home", classmethod(lambda cls: home))
    return home


@pytest.fixture
def game(tmp_path: Path) -> tuple[Path, Path]:
    """A repository + project with one module so scope filtering is exercised."""
    repo = tmp_path / "repo"
    core = repo / "capability-groups/core/0.1.0"
    _json(
        core / "group.json",
        {
            "guid": "a" * 32,
            "name": "core",
            "version": "0.1.0",
            "description": "core",
            "permissions": [],
            "extends": [],
            "tools": [],
        },
    )
    _write(
        core / "rules/00-global.md",
        "---\nname: global\ndescription: Global rules\n---\n\n# Global\n\nAlways applies.\n",
    )
    _write(
        core / "rules/later.md",
        "---\nname: later\ndescription: Later rule\npriority: 10\n---\n\n# Later\n",
    )
    _write(
        core / "agents/main.md",
        "---\nname: Main\ndescription: main agent\nmode: primary\nmodel: strong\n---\n\nMain body.\n",
    )
    _write(
        core / "agents/sub.md",
        "---\nname: Sub\ndescription: sub agent\nmode: subagent\n---\n\nSub body.\n",
    )
    _write(
        core / "commands/build.md",
        "---\nname: build\ndescription: build it\n---\n\nBuild {{target}}\n",
    )
    _write(
        core / "skills/core-skill/SKILL.md",
        "---\nname: core-skill\ndescription: core skill\n---\n\n# Core skill\n\nSteps.\n",
    )

    game = repo / "capability-groups/domain/game/1.0.0"
    _json(
        game / "group.json",
        {
            "guid": "c" * 32,
            "name": "game",
            "version": "1.0.0",
            "description": "game",
            "permissions": [],
            "extends": [],
            "tools": [],
            "default_modules": ["battle"],
        },
    )
    _write(
        game / "rules/root.md",
        "---\nname: root\ndescription: Game root\n---\n\n# Game root\n",
    )
    _json(game / "modules/battle/module.json", {"title": "Battle", "paths": ["Assets/Battle/**"]})
    _write(
        game / "modules/battle/rules/physics.md",
        "---\nname: physics\ndescription: Physics rules\n---\n\n# Physics\n",
    )
    _write(
        game / "modules/battle/rules/lazy.md",
        "---\nname: lazy\ndescription: Lazy rules\nalways: false\n---\n\n# Lazy\n",
    )
    _write(
        game / "modules/battle/agents/enemy.md",
        "---\nname: EnemyAI\ndescription: enemy agent\nmode: subagent\n---\n\nEnemy body.\n",
    )

    project = tmp_path / "project"
    (project / ".git").mkdir(parents=True, exist_ok=True)
    _json(
        project / ".hnflow/stack.json",
        {
            "schema_version": 2,
            "core": {"name": "core", "version": "0.1.0"},
            "agents": [],
            "groups": [{"name": "game", "version": "1.0.0"}],
        },
    )
    return repo, project


def test_sections_follow_the_session_order(game: tuple[Path, Path]) -> None:
    repo, project = game
    view = build_session(repo, project)
    assert [section.kind for section in view.sections] == [
        "agents-md",
        "persona",
        "skills",
        "commands",
        "flows",
        "mcp",
        "rules",
        "rules-skipped",
        "agents",
    ]
    persona = next(section for section in view.sections if section.kind == "persona").items[0]
    assert persona.id == "core/Main"
    assert persona.current is True
    assert view.agent["name"] == "Main"
    assert view.model["default"] == "standard"
    assert view.model["agent"] == "strong"


def test_default_agent_skips_subagents(game: tuple[Path, Path]) -> None:
    repo, project = game
    assert build_session(repo, project).agent["name"] == "Main"
    assert build_session(repo, project, agent_name="Sub").agent["name"] == "Sub"


def test_unknown_agent_is_rejected(game: tuple[Path, Path]) -> None:
    repo, project = game
    with pytest.raises(HNFlowError, match="unknown agent"):
        build_session(repo, project, agent_name="Nobody")


def test_rules_at_project_root_skip_path_scoped_rules(game: tuple[Path, Path]) -> None:
    repo, project = game
    view = build_session(repo, project)
    rules = next(section for section in view.sections if section.kind == "rules")
    assert [item.id for item in rules.items] == ["core/global", "core/later", "game/root"]
    assert {item.status for item in rules.items} == {"injected"}

    skipped = next(section for section in view.sections if section.kind == "rules-skipped")
    assert skipped.collapsed is True
    assert [item.id for item in skipped.items] == ["game/battle/lazy", "game/battle/physics"]
    assert {item.status for item in skipped.items} == {"skipped"}


def test_matching_cwd_injects_module_rules_and_indexes_lazy_ones(
    game: tuple[Path, Path],
) -> None:
    repo, project = game
    view = build_session(repo, project, cwd="Assets/Battle")
    assert view.cwd == "Assets/Battle"
    rules = next(section for section in view.sections if section.kind == "rules")
    assert [item.id for item in rules.items] == [
        "core/global",
        "core/later",
        "game/root",
        "game/battle/physics",
        "game/battle/lazy",
    ]
    status = {item.id: item.status for item in rules.items}
    assert status["game/battle/physics"] == "injected"
    assert status["game/battle/lazy"] == "indexed"
    assert all(section.kind != "rules-skipped" for section in view.sections)


def test_absolute_cwd_is_made_project_relative(game: tuple[Path, Path]) -> None:
    repo, project = game
    view = build_session(repo, project, cwd=str(project / "Assets" / "Battle"))
    assert view.cwd == "Assets/Battle"


def test_budget_omits_everything_that_does_not_fit(game: tuple[Path, Path]) -> None:
    repo, project = game
    header = len(RULES_HEADER.encode("utf-8")) + len(RULES_FOOTER.encode("utf-8"))
    view = build_session(repo, project, max_rules_bytes=header + 20)
    rules = next(section for section in view.sections if section.kind == "rules")
    assert {item.status for item in rules.items} == {"omitted"}
    assert view.budget == {"limit": header + 20, "used": header, "omitted": 3}


def test_module_agent_joins_the_roster(game: tuple[Path, Path]) -> None:
    repo, project = game
    view = build_session(repo, project)
    roster = next(section for section in view.sections if section.kind == "agents")
    assert roster.collapsed is True
    assert [item.name for item in roster.items] == ["Main", "Sub", "EnemyAI"]
    enemy = next(item for item in roster.items if item.name == "EnemyAI")
    assert enemy.id == "game/battle/EnemyAI"
    assert enemy.group == "game"
    assert enemy.module == "battle"


def test_with_text_embeds_content(game: tuple[Path, Path]) -> None:
    repo, project = game
    view = build_session(repo, project, with_text=True)
    rules = next(section for section in view.sections if section.kind == "rules")
    first = rules.items[0]
    assert "Always applies." in (first.text or "")
    skill = next(section for section in view.sections if section.kind == "skills").items[0]
    assert "Steps." in (skill.text or "")
    command = next(section for section in view.sections if section.kind == "commands").items[0]
    assert "Build {{target}}" in (command.text or "")


def test_text_is_clipped_by_bytes(game: tuple[Path, Path]) -> None:
    repo, project = game
    view = build_session(repo, project, with_text=True, text_bytes=10)
    first = next(section for section in view.sections if section.kind == "rules").items[0]
    assert first.truncated is True
    assert len((first.text or "").encode("utf-8")) <= 10


def test_json_view_is_serializable(game: tuple[Path, Path]) -> None:
    repo, project = game
    data = build_session(repo, project, cwd="Assets/Battle").to_dict()
    assert data["schema_version"] == 1
    assert set(data) == {
        "schema_version",
        "project",
        "cwd",
        "mode",
        "agent",
        "model",
        "sections",
        "budget",
        "warnings",
        "fingerprint",
    }
    rules = next(section for section in data["sections"] if section["kind"] == "rules")
    assert set(rules["items"][0]) >= {
        "kind",
        "id",
        "name",
        "group",
        "module",
        "scope",
        "status",
        "bytes",
        "path",
        "description",
        "summary",
    }


def test_cli_preview_json(game: tuple[Path, Path], capsysbinary) -> None:
    repo, project = game
    base = ["--repo", str(repo), "--project", str(project)]
    capsysbinary.readouterr()
    assert main([*base, "preview", "--json", "--cwd", "Assets/Battle"]) == 0
    data = json.loads(capsysbinary.readouterr().out.decode("utf-8"))
    assert data["schema_version"] == 1
    assert data["cwd"] == "Assets/Battle"
    assert data["agent"]["name"] == "Main"
    assert [section["kind"] for section in data["sections"]][:7] == [
        "agents-md",
        "persona",
        "skills",
        "commands",
        "flows",
        "mcp",
        "rules",
    ]


def test_cli_preview_unknown_agent_fails(game: tuple[Path, Path], capsysbinary) -> None:
    repo, project = game
    base = ["--repo", str(repo), "--project", str(project)]
    capsysbinary.readouterr()
    assert main([*base, "preview", "--agent", "Nobody"]) == 1
    assert "unknown agent" in capsysbinary.readouterr().err.decode("utf-8")


def test_rule_selection_matches_rules_show(game: tuple[Path, Path]) -> None:
    repo, project = game
    view = build_session(repo, project, cwd="Assets/Battle")
    rules = next(section for section in view.sections if section.kind == "rules")
    loaded = [item.id for item in rules.items]
    skipped = next(
        (section for section in view.sections if section.kind == "rules-skipped"),
        None,
    )
    skipped_ids = [item.id for item in skipped.items] if skipped is not None else []

    from hnflow_stack.resolve import resolve_project
    from hnflow_stack.rules import relative_to, rule_applies

    plan = resolve_project(repo, project)
    relative = relative_to(project, Path("Assets/Battle"))
    matched = [rule.id for rule in plan.rules if rule_applies(rule, relative)]

    # The rules section groups injected -> indexed -> omitted, so compare the
    # selection as a set: `rules show` reports plain plan order.
    assert sorted(loaded) == sorted(matched)
    assert set(loaded).isdisjoint(skipped_ids)


def test_rule_bytes_keep_crlf_like_the_plugin(tmp_path: Path) -> None:
    """The plugin reads files with `readFile`, so CRLF must survive here too."""
    from hnflow_stack.model import ResolvedRule
    from hnflow_stack.rules import plan_rules

    file = tmp_path / "crlf.md"
    file.write_bytes(b"---\r\nname: crlf\r\n---\r\n\r\n# CRLF\r\n\r\nBody.\r\n")
    body = read_body(str(file))
    assert body == "# CRLF\r\n\r\nBody."
    plan = SimpleNamespace(rules=[ResolvedRule(name="crlf", path=str(file), group="core", id="core/crlf")], groups=[])
    planned = plan_rules(plan, "", max_bytes=65536)
    block = f"Instructions from: {file} (group: core)\n\n{body}"
    assert planned.injected[0].bytes == len(block.encode("utf-8"))


def test_strip_frontmatter_matches_plugin() -> None:
    assert read_body_text("\ufeff---\nname: x\n---\n\nBody\n") == "Body"
    assert read_body_text("no frontmatter\n") == "no frontmatter"


def read_body_text(text: str) -> str:
    """Small helper so the frontmatter contract is asserted without a file."""
    from hnflow_stack.rules import strip_frontmatter

    return strip_frontmatter(text)


def test_host_instructions_run_global_then_project_broad_to_specific(
    game: tuple[Path, Path], isolated_home: Path
) -> None:
    """The host injects its own AGENTS.md chain before any HNFlow rule."""
    repo, project = game
    _write(isolated_home / ".dsh/AGENTS.md", "# Global DSH\n\nglobal.\n")
    _write(isolated_home / ".agents/AGENTS.md", "# Global agents\n\nagents.\n")
    _write(project / "AGENTS.md", "# Root rules\n\nroot.\n")
    _write(project / "CLAUDE.md", "# Root claude\n\nclaude.\n")
    _write(project / "Assets/AGENTS.md", "# Assets rules\n\nassets.\n")
    _write(project / "Assets/Battle/AGENTS.local.md", "# Battle local\n\nlocal.\n")

    view = build_session(repo, project, cwd="Assets/Battle")
    chain = view.sections[0]
    assert chain.kind == "agents-md"
    assert chain.collapsed is False
    assert [item.name for item in chain.items] == [
        "~/.dsh/AGENTS.md",
        "~/.agents/AGENTS.md",
        "AGENTS.md",
        "CLAUDE.md",
        "Assets/AGENTS.md",
        "Assets/Battle/AGENTS.local.md",
    ]
    assert [item.scope for item in chain.items] == [
        "global",
        "global",
        "global",
        "global",
        "paths",
        "paths",
    ]
    assert all(item.kind == "agents-md" and item.group == "host" for item in chain.items)
    assert all(item.status == "injected" for item in chain.items)
    assert chain.items[0].summary == "Global DSH"


def test_host_instructions_skip_repeated_content(game: tuple[Path, Path]) -> None:
    repo, project = game
    _write(project / "AGENTS.md", "# Duplicate\n\nsame body.\n")
    _write(project / "Assets/CLAUDE.md", "\n# Duplicate\n\nsame body.\n\n")

    chain = build_session(repo, project, cwd="Assets").sections[0]
    assert [item.status for item in chain.items] == ["injected", "skipped"]
    assert "AGENTS.md" in chain.items[1].description


def test_host_instructions_ignore_blank_files(game: tuple[Path, Path]) -> None:
    repo, project = game
    _write(project / "AGENTS.md", "   \n\n")
    assert build_session(repo, project).sections[0].items == []


def test_host_instructions_embed_text_when_requested(game: tuple[Path, Path]) -> None:
    repo, project = game
    _write(project / "AGENTS.md", "# Root\n\nbody.\n")
    chain = build_session(repo, project, with_text=True, text_bytes=4).sections[0]
    assert chain.items[0].text == "# Ro"
    assert chain.items[0].truncated is True
