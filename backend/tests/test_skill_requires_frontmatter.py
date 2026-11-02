"""N11 S4 — binding requirements to capability groups (SKILL.md `requires:`).

The parser reuses the same ``RequirementSpec`` model the application registry
does, and drops malformed entries with a warning rather than failing the skill —
mirroring ``parse_required_secrets``.
"""

from __future__ import annotations

from pathlib import Path

from deerflow.skills.parser import parse_requirements, parse_skill_file
from deerflow.skills.types import SkillCategory


def _write_skill(tmp_path: Path, frontmatter: str, *, name: str = "cad-export") -> Path:
    skill_dir = tmp_path / name
    skill_dir.mkdir(parents=True, exist_ok=True)
    skill_file = skill_dir / "SKILL.md"
    skill_file.write_text(f"---\n{frontmatter}\n---\n\nBody.\n", encoding="utf-8")
    return skill_file


class TestParseRequirements:
    def test_missing_field_is_empty(self, tmp_path: Path) -> None:
        assert parse_requirements(None, tmp_path / "SKILL.md") == ()

    def test_parses_each_kind(self, tmp_path: Path) -> None:
        raw = [
            {"kind": "version", "name": "blender", "command": ["blender", "--version"], "expect": ">=4.0"},
            {"kind": "plugin", "name": "addons/x", "optional": True},
            {"kind": "path", "name": "$SHOT_DIR"},
            {"kind": "runtime", "name": "python", "expect": "^3.11"},
            {"kind": "executable", "name": "uv"},
        ]
        specs = parse_requirements(raw, tmp_path / "SKILL.md")
        assert [str(spec.kind) for spec in specs] == ["version", "plugin", "path", "runtime", "executable"]
        assert specs[0].resolved_command() == ["blender", "--version"]
        assert specs[1].optional is True

    def test_malformed_entries_are_dropped_not_fatal(self, tmp_path: Path) -> None:
        """A typo in one optional declaration must not make the package unloadable."""
        raw = [
            {"kind": "executable", "name": "uv"},
            "not-a-mapping",
            {"kind": "vibes", "name": "x"},
            {"kind": "path", "name": "/x", "command": ["x"]},
            {"kind": "version", "name": "blender"},
        ]
        specs = parse_requirements(raw, tmp_path / "SKILL.md")
        assert [spec.name for spec in specs] == ["uv", "blender"]

    def test_non_list_field_is_ignored(self, tmp_path: Path) -> None:
        assert parse_requirements({"kind": "executable", "name": "uv"}, tmp_path / "SKILL.md") == ()


class TestSkillFileIntegration:
    def test_requires_lands_on_the_skill(self, tmp_path: Path) -> None:
        skill_file = _write_skill(
            tmp_path,
            'name: cad-export\ndescription: Export CAD.\nrequires:\n  - { kind: version, name: blender, expect: ">=4.0" }\n  - { kind: plugin, name: "addons/my-addon", optional: true }\n',
        )
        skill = parse_skill_file(skill_file, SkillCategory.CUSTOM)
        assert skill is not None
        assert len(skill.requirements) == 2
        assert str(skill.requirements[0].kind) == "version"
        assert skill.requirements[0].expect == ">=4.0"
        assert skill.requirements[1].optional is True

    def test_skill_without_requires_is_unchanged(self, tmp_path: Path) -> None:
        skill_file = _write_skill(tmp_path, "name: plain\ndescription: No requirements.\n")
        skill = parse_skill_file(skill_file, SkillCategory.CUSTOM)
        assert skill is not None
        assert skill.requirements == ()

    def test_malformed_requires_does_not_fail_the_skill(self, tmp_path: Path) -> None:
        skill_file = _write_skill(
            tmp_path,
            "name: squishy\ndescription: Partly broken.\nrequires:\n  - { kind: nope, name: x }\n  - { kind: executable, name: uv }\n",
        )
        skill = parse_skill_file(skill_file, SkillCategory.CUSTOM)
        assert skill is not None
        assert [spec.name for spec in skill.requirements] == ["uv"]

    def test_non_list_requires_does_not_fail_the_skill(self, tmp_path: Path) -> None:
        skill_file = _write_skill(tmp_path, "name: odd\ndescription: Odd shape.\nrequires: just-a-string\n")
        skill = parse_skill_file(skill_file, SkillCategory.CUSTOM)
        assert skill is not None
        assert skill.requirements == ()

    def test_other_frontmatter_fields_still_parse(self, tmp_path: Path) -> None:
        skill_file = _write_skill(
            tmp_path,
            "name: full\ndescription: Everything.\nversion: 1.2.0\nallowed-tools: [read_file]\nrequires:\n  - { kind: executable, name: uv }\n",
        )
        skill = parse_skill_file(skill_file, SkillCategory.CUSTOM)
        assert skill is not None
        assert skill.version == "1.2.0"
        assert skill.allowed_tools == ("read_file",)
        assert len(skill.requirements) == 1
