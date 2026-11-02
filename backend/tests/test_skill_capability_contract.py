"""Tests for the N14 §5.5 capability-package contract (:mod:`deerflow.skills.contract` + parser)."""

from __future__ import annotations

from pathlib import Path

from deerflow.skills.contract import CAPABILITY_PERMISSIONS, validate_capability_contract
from deerflow.skills.parser import (
    parse_context_budget,
    parse_permissions,
    parse_skill_file,
    parse_tool_schema_version,
)
from deerflow.skills.types import Skill, SkillCategory


class TestParsePermissions:
    def test_absent(self) -> None:
        assert parse_permissions(None, Path("SKILL.md")) == ()

    def test_valid(self) -> None:
        assert parse_permissions(["fs", "net"], Path("SKILL.md")) == ("fs", "net")

    def test_normalizes_case_and_dedupes(self) -> None:
        assert parse_permissions(["FS", "fs", "net"], Path("SKILL.md")) == ("fs", "net")

    def test_unknown_dropped(self) -> None:
        assert parse_permissions(["fs", "bogus"], Path("SKILL.md")) == ("fs",)

    def test_non_list_ignored(self) -> None:
        assert parse_permissions("fs", Path("SKILL.md")) == ()

    def test_all_allowed(self) -> None:
        assert set(parse_permissions(sorted(CAPABILITY_PERMISSIONS), Path("SKILL.md"))) == CAPABILITY_PERMISSIONS


class TestParseToolSchemaVersion:
    def test_absent(self) -> None:
        assert parse_tool_schema_version(None, Path("SKILL.md")) is None

    def test_valid(self) -> None:
        assert parse_tool_schema_version("2", Path("SKILL.md")) == "2"

    def test_empty(self) -> None:
        assert parse_tool_schema_version("   ", Path("SKILL.md")) is None

    def test_numeric(self) -> None:
        assert parse_tool_schema_version(3, Path("SKILL.md")) == "3"


class TestParseContextBudget:
    def test_absent(self) -> None:
        assert parse_context_budget(None, Path("SKILL.md")) is None

    def test_valid(self) -> None:
        assert parse_context_budget(2000, Path("SKILL.md")) == 2000

    def test_string_int(self) -> None:
        assert parse_context_budget("1500", Path("SKILL.md")) == 1500

    def test_zero_and_negative(self) -> None:
        assert parse_context_budget(0, Path("SKILL.md")) is None
        assert parse_context_budget(-5, Path("SKILL.md")) is None

    def test_bool_and_non_int(self) -> None:
        assert parse_context_budget(True, Path("SKILL.md")) is None
        assert parse_context_budget("lots", Path("SKILL.md")) is None


def _skill(**overrides: object) -> Skill:
    base: dict[str, object] = {
        "name": "s",
        "description": "d",
        "license": None,
        "skill_dir": Path("."),
        "skill_file": Path("SKILL.md"),
        "relative_path": Path("s"),
        "category": SkillCategory.CUSTOM,
    }
    base.update(overrides)
    return Skill(**base)  # type: ignore[arg-type]


class TestValidateCapabilityContract:
    def test_clean_is_empty(self) -> None:
        assert validate_capability_contract(_skill(permissions=("fs", "net"), context_budget=100, tool_schema_version="1")) == []

    def test_unknown_permission(self) -> None:
        problems = validate_capability_contract(_skill(permissions=("fs", "bogus")))
        assert any("unknown permission" in p for p in problems)

    def test_non_positive_budget(self) -> None:
        assert any("context_budget" in p for p in validate_capability_contract(_skill(context_budget=0)))

    def test_empty_schema_version(self) -> None:
        assert any("tool_schema_version" in p for p in validate_capability_contract(_skill(tool_schema_version="  ")))


class TestParseSkillFileContract:
    def test_fields_read_from_frontmatter(self, tmp_path: Path) -> None:
        skill_dir = tmp_path / "kb"
        skill_dir.mkdir()
        skill_file = skill_dir / "SKILL.md"
        skill_file.write_text(
            "---\nname: kb\ndescription: knowledge skill\npermissions: [fs, net, bogus]\ntool-schema-version: 2\ncontext-budget: 3000\n---\nbody\n",
            encoding="utf-8",
        )
        skill = parse_skill_file(skill_file, SkillCategory.CUSTOM)
        assert skill is not None
        assert skill.permissions == ("fs", "net")
        assert skill.tool_schema_version == "2"
        assert skill.context_budget == 3000
        assert validate_capability_contract(skill) == []

    def test_absent_contract_defaults(self, tmp_path: Path) -> None:
        skill_dir = tmp_path / "plain"
        skill_dir.mkdir()
        skill_file = skill_dir / "SKILL.md"
        skill_file.write_text("---\nname: plain\ndescription: no contract\n---\nbody\n", encoding="utf-8")
        skill = parse_skill_file(skill_file, SkillCategory.CUSTOM)
        assert skill is not None
        assert skill.permissions == ()
        assert skill.tool_schema_version is None
        assert skill.context_budget is None
