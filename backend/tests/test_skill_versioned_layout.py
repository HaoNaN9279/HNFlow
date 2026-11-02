"""T7 versioned-layout end-to-end tests.

Covers the versioned skill directory layout
(``<root>/public/<name>/v<semver>/SKILL.md``) from the perspective of the
runtime loader: current-version selection, container paths carrying the
version segment, and the write→edit→multi-version read cycle.
"""

from pathlib import Path

from deerflow.skills.storage import get_or_new_skill_storage
from deerflow.skills.storage.local_skill_storage import LocalSkillStorage
from deerflow.skills.types import SKILL_MD_FILE


def _skill_content(name: str, description: str, version: str | None = None) -> str:
    version_line = f"version: {version}\n" if version is not None else ""
    return f"---\nname: {name}\n{version_line}description: {description}\n---\n\n# {name}\n"


def _write_versioned_skill(skills_root: Path, name: str, version: str, description: str) -> None:
    skill_dir = skills_root / "public" / name / f"v{version}"
    skill_dir.mkdir(parents=True, exist_ok=True)
    (skill_dir / SKILL_MD_FILE).write_text(_skill_content(name, description, version), encoding="utf-8")


def test_versioned_public_skill_container_path_carries_version_segment(tmp_path: Path):
    skills_root = tmp_path / "skills"
    _write_versioned_skill(skills_root, "demo", "0.1.0", "Demo skill")

    skills = get_or_new_skill_storage(skills_path=skills_root).load_skills(enabled_only=False)
    by_name = {skill.name: skill for skill in skills}

    assert "demo" in by_name
    skill = by_name["demo"]
    assert skill.version == "0.1.0"
    assert skill.skill_path == "demo/v0.1.0"
    assert skill.get_container_file_path() == "/mnt/skills/public/demo/v0.1.0/SKILL.md"


def test_load_skills_selects_current_version_directory(tmp_path: Path):
    skills_root = tmp_path / "skills"
    _write_versioned_skill(skills_root, "demo", "0.1.0", "v1")
    _write_versioned_skill(skills_root, "demo", "0.2.0", "v2")
    _write_versioned_skill(skills_root, "demo", "0.1.5", "v1.5")

    skills = get_or_new_skill_storage(skills_path=skills_root).load_skills(enabled_only=False)
    by_name = {skill.name: skill for skill in skills}

    assert by_name["demo"].version == "0.2.0"
    assert by_name["demo"].get_container_file_path() == "/mnt/skills/public/demo/v0.2.0/SKILL.md"


def test_write_edit_read_multiple_versions_cycle(tmp_path: Path):
    storage = get_or_new_skill_storage(skills_path=tmp_path / "skills")

    written = storage.write_custom_skill("demo", SKILL_MD_FILE, _skill_content("demo", "first"))
    assert written == "0.1.0"

    second = storage.write_custom_skill("demo", SKILL_MD_FILE, _skill_content("demo", "second"))
    assert second == "0.1.1"

    assert storage.list_skill_versions("demo") == ["0.1.0", "0.1.1"]
    assert storage.resolve_current_version("demo") == "0.1.1"

    current = storage.read_custom_skill("demo")
    assert "second" in current
    assert "version: 0.1.1" in current

    older = storage.read_custom_skill("demo", version="0.1.0")
    assert "first" in older
    assert "second" not in older
    # The published v0.1.0 directory is immutable: its content never changed.
    assert "version: 0.1.0" in older


def test_published_version_dir_is_not_mutated_by_edit(tmp_path: Path):
    storage = get_or_new_skill_storage(skills_path=tmp_path / "skills")

    storage.write_custom_skill("demo", SKILL_MD_FILE, _skill_content("demo", "first"))
    v010_dir = tmp_path / "skills" / "custom" / "demo" / "v0.1.0"

    storage.write_custom_skill("demo", SKILL_MD_FILE, _skill_content("demo", "second"))

    original = (v010_dir / SKILL_MD_FILE).read_text(encoding="utf-8")
    assert "first" in original
    assert "second" not in original


def test_support_file_write_bumps_version_and_copies_tree(tmp_path: Path):
    storage: LocalSkillStorage = get_or_new_skill_storage(skills_path=tmp_path / "skills")

    storage.write_custom_skill("demo", SKILL_MD_FILE, _skill_content("demo", "first"))
    storage.write_custom_skill("demo", "references/guide.md", "# guide")

    assert storage.list_skill_versions("demo") == ["0.1.0", "0.1.1"]
    v011 = tmp_path / "skills" / "custom" / "demo" / "v0.1.1"
    assert (v011 / SKILL_MD_FILE).exists(), "support-file bump must copy the SKILL.md tree"
    assert (v011 / "references" / "guide.md").exists()
    # v0.1.0 must not gain the support file.
    assert not (tmp_path / "skills" / "custom" / "demo" / "v0.1.0" / "references" / "guide.md").exists()
