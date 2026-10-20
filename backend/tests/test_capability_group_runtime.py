"""Tests for capability-group runtime content (rules, skills, scoped reader)."""

from __future__ import annotations

from pathlib import Path
from types import SimpleNamespace

import pytest

from deerflow.capability_groups.runtime import (
    CapabilityContentError,
    load_capability_rules,
    load_capability_skills,
)
from deerflow.workflow.capability_skills import build_read_capability_skill_tool


def _file(path: str, *, category: str, is_markdown: bool = True) -> SimpleNamespace:
    return SimpleNamespace(
        path=path,
        name=Path(path).name,
        category=category,
        is_markdown=is_markdown,
        summary="",
        size=0,
        modified_at="",
    )


def _group(
    root: Path,
    *,
    guid: str,
    name: str,
    version: str = "0.1.0",
    extends: tuple[str, ...] = (),
    files: tuple[SimpleNamespace, ...] = (),
) -> SimpleNamespace:
    return SimpleNamespace(
        guid=guid,
        name=name,
        version=version,
        extends=extends,
        root=root,
        files=files,
    )


def _write(path: Path, text: str) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(text, encoding="utf-8")


def test_rules_follow_base_then_derived_and_derived_wins(monkeypatch, tmp_path: Path) -> None:
    base_root = tmp_path / "base"
    derived_root = tmp_path / "derived"
    _write(base_root / "rules" / "a.md", "BASE A")
    _write(derived_root / "rules" / "a.md", "DERIVED A")
    _write(derived_root / "rules" / "b.md", "DERIVED B")
    base = _group(
        base_root,
        guid="a" * 32,
        name="base",
        files=(_file("rules/a.md", category="rules"),),
    )
    derived = _group(
        derived_root,
        guid="b" * 32,
        name="derived",
        extends=("base",),
        files=(
            _file("rules/a.md", category="rules"),
            _file("rules/b.md", category="rules"),
        ),
    )
    monkeypatch.setattr(
        "deerflow.capability_groups.runtime.load_capability_group_closure",
        lambda refs, user_id=None, bases_first=False: [base, derived],
    )

    rules = load_capability_rules(["derived"])

    assert [rule.path for rule in rules] == ["rules/a.md", "rules/b.md"]
    assert rules[0].content == "DERIVED A"
    assert rules[0].source == "capability_group:derived@0.1.0/rules/a.md"
    assert rules[1].content == "DERIVED B"


def test_skills_load_only_metadata(monkeypatch, tmp_path: Path) -> None:
    root = tmp_path / "group"
    _write(
        root / "skills" / "profile" / "SKILL.md",
        "---\nname: profile\ndescription: Build a profile\n---\n\nFULL BODY",
    )
    group = _group(
        root,
        guid="c" * 32,
        name="data",
        files=(_file("skills/profile/SKILL.md", category="skills"),),
    )
    monkeypatch.setattr(
        "deerflow.capability_groups.runtime.load_capability_group_closure",
        lambda refs, user_id=None, bases_first=False: [group],
    )

    skills = load_capability_skills(["data"])

    assert len(skills) == 1
    assert skills[0].name == "profile"
    assert skills[0].description == "Build a profile"
    assert "FULL BODY" not in skills[0].description
    assert skills[0].skill_file.read_text(encoding="utf-8").endswith("FULL BODY")


def test_duplicate_skill_names_fail_loud(monkeypatch, tmp_path: Path) -> None:
    first_root = tmp_path / "first"
    second_root = tmp_path / "second"
    content = "---\nname: shared\ndescription: one\n---\n"
    _write(first_root / "skills" / "shared" / "SKILL.md", content)
    _write(second_root / "skills" / "shared" / "SKILL.md", content)
    first = _group(
        first_root,
        guid="d" * 32,
        name="first",
        files=(_file("skills/shared/SKILL.md", category="skills"),),
    )
    second = _group(
        second_root,
        guid="e" * 32,
        name="second",
        files=(_file("skills/shared/SKILL.md", category="skills"),),
    )
    monkeypatch.setattr(
        "deerflow.capability_groups.runtime.load_capability_group_closure",
        lambda refs, user_id=None, bases_first=False: [first, second],
    )

    with pytest.raises(CapabilityContentError, match="duplicate capability skill"):
        load_capability_skills(["first", "second"])


def test_reader_reads_skill_and_rejects_traversal(monkeypatch, tmp_path: Path) -> None:
    root = tmp_path / "group"
    _write(
        root / "skills" / "profile" / "SKILL.md",
        "---\nname: profile\ndescription: Build a profile\n---\n\nFULL BODY",
    )
    _write(root / "skills" / "profile" / "notes.txt", "NOTE")
    group = _group(
        root,
        guid="f" * 32,
        name="data",
        files=(_file("skills/profile/SKILL.md", category="skills"),),
    )
    monkeypatch.setattr(
        "deerflow.capability_groups.runtime.load_capability_group_closure",
        lambda refs, user_id=None, bases_first=False: [group],
    )
    skill = load_capability_skills(["data"])[0]
    tool = build_read_capability_skill_tool([skill])

    assert "FULL BODY" in tool.invoke({"name": "profile"})
    assert tool.invoke({"name": "profile", "path": "notes.txt"}) == "NOTE"
    assert tool.invoke({"name": "profile", "path": "../outside.txt"}).startswith("Error:")
    assert tool.invoke({"name": "missing"}).startswith("Error:")
