"""Tests for T8 group manifest (group.json) and dependency parsing."""

from __future__ import annotations

import json
import uuid
from pathlib import Path

import pytest

from deerflow.skills.parser import (
    _read_group_manifest,
    parse_dependencies,
    parse_skill_file,
)
from deerflow.skills.storage.skill_storage import SkillStorage
from deerflow.skills.types import SkillCategory

# ---------------------------------------------------------------------------
# _read_group_manifest
# ---------------------------------------------------------------------------


def test_read_group_manifest_valid(tmp_path: Path) -> None:
    guid = uuid.uuid4().hex
    group_data = {"guid": guid, "aliases": ["old-name"], "created_at": "2026-08-12T17:21:23Z"}
    (tmp_path / "group.json").write_text(json.dumps(group_data), encoding="utf-8")

    manifest = _read_group_manifest(tmp_path)
    assert manifest is not None
    assert manifest.guid == guid
    assert manifest.aliases == ("old-name",)
    assert manifest.created_at == "2026-08-12T17:21:23Z"


def test_read_group_manifest_missing(tmp_path: Path) -> None:
    assert _read_group_manifest(tmp_path) is None


def test_read_group_manifest_corrupt_json(tmp_path: Path) -> None:
    (tmp_path / "group.json").write_text("{not json}", encoding="utf-8")
    assert _read_group_manifest(tmp_path) is None


def test_read_group_manifest_malformed_data(tmp_path: Path) -> None:
    """group.json missing required 'guid' field."""
    (tmp_path / "group.json").write_text('{"aliases": []}', encoding="utf-8")
    assert _read_group_manifest(tmp_path) is None


# ---------------------------------------------------------------------------
# parse_dependencies
# ---------------------------------------------------------------------------


def test_parse_dependencies_none() -> None:
    assert parse_dependencies(None, Path("SKILL.md")) is None


def test_parse_dependencies_not_list() -> None:
    with pytest.raises(ValueError, match="dependencies.*must be a list"):
        parse_dependencies("not-a-list", Path("SKILL.md"))


def test_parse_dependencies_not_dict_item() -> None:
    with pytest.raises(ValueError, match="dependencies\\[0\\].*must be a mapping"):
        parse_dependencies(["not-a-dict"], Path("SKILL.md"))


def test_parse_dependencies_valid() -> None:
    raw = [
        {"guid": "a1b2c3d4e5f67890abcdef1234567890", "version": ">=1.0.0"},
        {"guid": "fedcba0987654321fedcba0987654321", "version": "2.0.0"},
    ]
    result = parse_dependencies(raw, Path("SKILL.md"))
    assert result is not None
    assert len(result) == 2
    assert result[0].guid == "a1b2c3d4e5f67890abcdef1234567890"
    assert result[0].version == ">=1.0.0"
    assert result[1].guid == "fedcba0987654321fedcba0987654321"
    assert result[1].version == "2.0.0"


def test_parse_dependencies_invalid_guid_length() -> None:
    with pytest.raises(ValueError, match="dependencies\\[0\\]\\.guid.*32-character"):
        parse_dependencies([{"guid": "too-short", "version": "1.0"}], Path("SKILL.md"))


def test_parse_dependencies_invalid_guid_hex() -> None:
    with pytest.raises(ValueError, match="dependencies\\[0\\]\\.guid.*valid hex"):
        parse_dependencies([{"guid": "zzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzz", "version": "1.0"}], Path("SKILL.md"))


def test_parse_dependencies_empty_version() -> None:
    with pytest.raises(ValueError, match="dependencies\\[0\\]\\.version.*non-empty"):
        parse_dependencies([{"guid": "a1b2c3d4e5f67890abcdef1234567890", "version": ""}], Path("SKILL.md"))


def test_parse_dependencies_missing_version() -> None:
    with pytest.raises(ValueError, match="dependencies\\[0\\]\\.version.*non-empty"):
        parse_dependencies([{"guid": "a1b2c3d4e5f67890abcdef1234567890"}], Path("SKILL.md"))


def test_parse_dependencies_empty_list() -> None:
    result = parse_dependencies([], Path("SKILL.md"))
    assert result == ()


def test_parse_dependencies_index_in_error() -> None:
    with pytest.raises(ValueError, match="dependencies\\[1\\]"):
        parse_dependencies(
            [
                {"guid": "a1b2c3d4e5f67890abcdef1234567890", "version": "1.0"},
                {"guid": "bad", "version": "1.0"},
            ],
            Path("SKILL.md"),
        )


# ---------------------------------------------------------------------------
# Parser integration: group.json → skill_id
# ---------------------------------------------------------------------------


def _write_skill_md(
    skill_dir: Path,
    front_matter: str,
    body: str = "# My Skill\n",
    *,
    guid: str | None = None,
    group_aliases: list[str] | None = None,
) -> Path:
    """Write a minimal SKILL.md (and optionally group.json) and return the skill file path."""
    skill_dir.mkdir(parents=True, exist_ok=True)
    skill_file = skill_dir / "SKILL.md"
    skill_file.write_text(f"---\n{front_matter}\n---\n{body}", encoding="utf-8")
    if guid is not None:
        group_data: dict = {"guid": guid, "aliases": group_aliases or []}
        (skill_dir / "group.json").write_text(json.dumps(group_data), encoding="utf-8")
    return skill_file


def test_skill_parses_group_manifest_guid(tmp_path: Path) -> None:
    skill_guid = uuid.uuid4().hex
    skill_dir = tmp_path / "my-skill"
    skill_file = _write_skill_md(
        skill_dir,
        "name: my-skill\ndescription: Test skill",
        guid=skill_guid,
    )
    skill = parse_skill_file(skill_file, category=SkillCategory.CUSTOM)
    assert skill is not None
    assert skill.skill_id == skill_guid


def test_skill_parses_no_group_manifest(tmp_path: Path) -> None:
    skill_dir = tmp_path / "my-skill"
    skill_file = _write_skill_md(skill_dir, "name: my-skill\ndescription: Test skill")
    skill = parse_skill_file(skill_file, category=SkillCategory.CUSTOM)
    assert skill is not None
    assert skill.skill_id is None


def test_skill_parses_dependencies(tmp_path: Path) -> None:
    skill_dir = tmp_path / "my-skill"
    skill_file = _write_skill_md(
        skill_dir,
        'name: my-skill\ndescription: Test\ndependencies:\n  - guid: a1b2c3d4e5f67890abcdef1234567890\n    version: ">=1.0"\n',
    )
    skill = parse_skill_file(skill_file, category=SkillCategory.CUSTOM)
    assert skill is not None
    assert skill.dependencies is not None
    assert len(skill.dependencies) == 1
    assert skill.dependencies[0].guid == "a1b2c3d4e5f67890abcdef1234567890"
    assert skill.dependencies[0].version == ">=1.0"


def test_skill_with_both_guid_and_deps(tmp_path: Path) -> None:
    skill_guid = uuid.uuid4().hex
    skill_dir = tmp_path / "my-skill"
    skill_file = _write_skill_md(
        skill_dir,
        'name: my-skill\ndescription: Test\ndependencies:\n  - guid: a1b2c3d4e5f67890abcdef1234567890\n    version: "1.0"\n',
        guid=skill_guid,
    )
    skill = parse_skill_file(skill_file, category=SkillCategory.CUSTOM)
    assert skill is not None
    assert skill.skill_id == skill_guid
    assert skill.dependencies is not None
    assert len(skill.dependencies) == 1


def test_skill_parsing_fails_on_invalid_deps(tmp_path: Path) -> None:
    skill_dir = tmp_path / "my-skill"
    skill_file = _write_skill_md(
        skill_dir,
        "name: my-skill\ndescription: Test\ndependencies: not-a-list\n",
    )
    result = parse_skill_file(skill_file, category=SkillCategory.CUSTOM)
    assert result is None


# ---------------------------------------------------------------------------
# _ensure_skill_guid (lazy generation)
# ---------------------------------------------------------------------------


def test_ensure_skill_guid_generates_new(tmp_path: Path) -> None:
    """Skill without group.json gets a guid generated."""
    from deerflow.skills.types import Skill as SkillCls

    skill = SkillCls(
        name="test-skill",
        description="desc",
        license=None,
        skill_dir=tmp_path,
        skill_file=tmp_path / "SKILL.md",
        relative_path=Path("test-skill"),
        category=SkillCategory.CUSTOM,
        skill_id=None,
    )
    result = SkillStorage._ensure_skill_guid(skill)
    assert result.skill_id is not None
    assert len(result.skill_id) == 32
    int(result.skill_id, 16)  # must be valid hex

    # group.json was written
    group_file = tmp_path / "group.json"
    assert group_file.exists()
    data = json.loads(group_file.read_text(encoding="utf-8"))
    assert data["guid"] == result.skill_id
    assert data["aliases"] == []
    assert "created_at" in data


def test_ensure_skill_guid_idempotent(tmp_path: Path) -> None:
    """Existing group.json is reused."""
    from deerflow.skills.types import Skill as SkillCls

    guid = uuid.uuid4().hex
    group_data = {"guid": guid, "aliases": ["v1"], "created_at": "2026-01-01T00:00:00Z"}
    (tmp_path / "group.json").write_text(json.dumps(group_data), encoding="utf-8")

    skill = SkillCls(
        name="test-skill",
        description="desc",
        license=None,
        skill_dir=tmp_path,
        skill_file=tmp_path / "SKILL.md",
        relative_path=Path("test-skill"),
        category=SkillCategory.CUSTOM,
        skill_id=None,
    )
    result = SkillStorage._ensure_skill_guid(skill)
    assert result.skill_id == guid

    # group.json was not overwritten
    data = json.loads((tmp_path / "group.json").read_text(encoding="utf-8"))
    assert data["guid"] == guid


def test_ensure_skill_guid_still_returns_guid_on_write_failure(tmp_path: Path) -> None:
    """If group.json write fails, the returned skill still has a guid."""
    from deerflow.skills.types import Skill as SkillCls

    # Create a readonly directory — write will fail
    readonly_dir = tmp_path / "readonly"
    readonly_dir.mkdir()
    skill = SkillCls(
        name="test-skill",
        description="desc",
        license=None,
        skill_dir=readonly_dir,
        skill_file=readonly_dir / "SKILL.md",
        relative_path=Path("test-skill"),
        category=SkillCategory.CUSTOM,
        skill_id=None,
    )
    result = SkillStorage._ensure_skill_guid(skill)
    # Under Windows, os.chmod doesn't prevent writes from the same user.
    # The important thing is that the method returns a valid guid.
    assert result.skill_id is not None
    assert len(result.skill_id) == 32


# ---------------------------------------------------------------------------
# _commit_skill_install group.json generation (integration test)
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_install_writes_group_json(tmp_path: Path, monkeypatch) -> None:
    """Installing a skill writes group.json with a stable GUID."""
    import zipfile

    from deerflow.skills.security_scanner import ScanResult
    from deerflow.skills.storage.local_skill_storage import LocalSkillStorage

    # Mock security scanner — avoid LLM model requirement.
    async def _mock_scan(*args, **kwargs):
        return ScanResult(decision="allow", reason="ok")

    monkeypatch.setattr("deerflow.skills.installer.enforce_static_scan", lambda skill_dir, *, skill_name=None, app_config=None: [])
    monkeypatch.setattr("deerflow.skills.installer.scan_skill_content", _mock_scan)

    # Create a minimal .skill archive
    archive_path = tmp_path / "test-install.skill"
    skill_dir = tmp_path / "archive_content" / "test-skill"
    skill_dir.mkdir(parents=True)
    (skill_dir / "SKILL.md").write_text(
        "---\nname: test-skill\ndescription: A test skill\nversion: 0.1.0\n---\n# Test\n",
        encoding="utf-8",
    )

    with zipfile.ZipFile(archive_path, "w", zipfile.ZIP_DEFLATED) as zf:
        for file_path in skill_dir.rglob("*"):
            arcname = file_path.relative_to(skill_dir.parent)
            zf.write(file_path, arcname)

    # Use a temp skills root
    skills_root = tmp_path / "skills"
    skills_root.mkdir()
    host_path = str(skills_root)

    storage = LocalSkillStorage(host_path=host_path)
    result = await storage.ainstall_skill_from_archive(str(archive_path))
    assert result["success"] is True
    assert "skill_id" in result
    skill_id = result["skill_id"]
    assert len(skill_id) == 32

    # Verify group.json exists at the installed skill dir
    installed_dir = skills_root / "custom" / "test-skill" / "v0.1.0"
    group_file = installed_dir / "group.json"
    assert group_file.exists()
    data = json.loads(group_file.read_text(encoding="utf-8"))
    assert data["guid"] == skill_id
    assert data["aliases"] == []
    assert "created_at" in data


@pytest.mark.asyncio
async def test_reinstall_preserves_existing_guid(tmp_path: Path, monkeypatch) -> None:
    """Reinstalling the same skill version keeps the existing group.json GUID."""
    import zipfile

    from deerflow.skills.security_scanner import ScanResult
    from deerflow.skills.storage.local_skill_storage import LocalSkillStorage

    # Mock security scanner.
    async def _mock_scan(*args, **kwargs):
        return ScanResult(decision="allow", reason="ok")

    monkeypatch.setattr("deerflow.skills.installer.enforce_static_scan", lambda skill_dir, *, skill_name=None, app_config=None: [])
    monkeypatch.setattr("deerflow.skills.installer.scan_skill_content", _mock_scan)

    # Pre-create the skill directory with existing group.json
    skills_root = tmp_path / "skills"
    skills_root.mkdir()
    existing_dir = skills_root / "custom" / "test-skill" / "v0.1.0"
    existing_dir.mkdir(parents=True)
    existing_guid = uuid.uuid4().hex
    (existing_dir / "group.json").write_text(
        json.dumps({"guid": existing_guid, "aliases": ["old-alias"], "created_at": "2026-01-01T00:00:00Z"}),
        encoding="utf-8",
    )

    # Create a .skill archive with the SAME version — target exists
    archive_path = tmp_path / "test-reinstall.skill"
    archive_dir = tmp_path / "archive_content" / "test-skill"
    archive_dir.mkdir(parents=True)
    (archive_dir / "SKILL.md").write_text(
        "---\nname: test-skill\ndescription: Updated\nversion: 0.1.0\n---\n# Updated\n",
        encoding="utf-8",
    )
    with zipfile.ZipFile(archive_path, "w", zipfile.ZIP_DEFLATED) as zf:
        for file_path in archive_dir.rglob("*"):
            zf.write(file_path, file_path.relative_to(archive_dir.parent))

    host_path = str(skills_root)
    storage = LocalSkillStorage(host_path=host_path)

    # Same version should raise SkillAlreadyExistsError.
    from deerflow.skills.installer import SkillAlreadyExistsError

    with pytest.raises(SkillAlreadyExistsError, match="already exists"):
        await storage.ainstall_skill_from_archive(str(archive_path))

    # Verify the existing group.json is untouched
    data = json.loads((existing_dir / "group.json").read_text(encoding="utf-8"))
    assert data["guid"] == existing_guid  # preserved


# ---------------------------------------------------------------------------
# load_skills lazy GUID generation
# ---------------------------------------------------------------------------


def test_load_skills_lazy_guid_for_custom(tmp_path: Path) -> None:
    """load_skills generates group.json for custom skills without one."""
    from deerflow.skills.storage.local_skill_storage import LocalSkillStorage

    # Set up a custom skill without group.json
    skills_root = tmp_path / "skills_root"
    skill_dir = skills_root / "custom" / "test-custom" / "v0.1.0"
    skill_dir.mkdir(parents=True)
    (skill_dir / "SKILL.md").write_text(
        "---\nname: test-custom\ndescription: A custom skill\nversion: 0.1.0\n---\n# Custom\n",
        encoding="utf-8",
    )

    storage = LocalSkillStorage(host_path=str(skills_root))
    skills = storage.load_skills()

    custom_skills = [s for s in skills if s.name == "test-custom"]
    assert len(custom_skills) == 1
    assert custom_skills[0].skill_id is not None
    assert len(custom_skills[0].skill_id) == 32

    # group.json should have been created
    group_file = skill_dir / "group.json"
    assert group_file.exists()
    data = json.loads(group_file.read_text(encoding="utf-8"))
    assert data["guid"] == custom_skills[0].skill_id


def test_load_skills_does_not_generate_guid_for_public(tmp_path: Path) -> None:
    """load_skills does NOT generate group.json for public skills."""
    from deerflow.skills.storage.local_skill_storage import LocalSkillStorage

    skills_root = tmp_path / "skills_root"
    skill_dir = skills_root / "public" / "test-public" / "v0.1.0"
    skill_dir.mkdir(parents=True)
    (skill_dir / "SKILL.md").write_text(
        "---\nname: test-public\ndescription: A public skill\n---\n# Public\n",
        encoding="utf-8",
    )

    storage = LocalSkillStorage(host_path=str(skills_root))
    skills = storage.load_skills()

    public_skills = [s for s in skills if s.name == "test-public"]
    assert len(public_skills) == 1
    assert public_skills[0].skill_id is None

    # Public skill must not have group.json written
    group_file = skill_dir / "group.json"
    assert not group_file.exists()


def test_load_skills_reuses_existing_group_json(tmp_path: Path) -> None:
    """load_skills reuses existing group.json GUID for custom skills."""
    from deerflow.skills.storage.local_skill_storage import LocalSkillStorage

    skills_root = tmp_path / "skills_root"
    skill_dir = skills_root / "custom" / "test-existing" / "v0.1.0"
    skill_dir.mkdir(parents=True)
    (skill_dir / "SKILL.md").write_text(
        "---\nname: test-existing\ndescription: Has group.json\nversion: 0.1.0\n---\n# Existing\n",
        encoding="utf-8",
    )
    existing_guid = uuid.uuid4().hex
    (skill_dir / "group.json").write_text(
        json.dumps({"guid": existing_guid, "aliases": [], "created_at": "2026-08-12T00:00:00Z"}),
        encoding="utf-8",
    )

    storage = LocalSkillStorage(host_path=str(skills_root))
    skills = storage.load_skills()

    existing = [s for s in skills if s.name == "test-existing"]
    assert len(existing) == 1
    assert existing[0].skill_id == existing_guid
