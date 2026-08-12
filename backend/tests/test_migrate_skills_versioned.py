"""Tests for ``scripts/migrate_skills_versioned.py``."""

from __future__ import annotations

import json
import shutil
from pathlib import Path

from scripts.migrate_skills_versioned import (
    _MIGRATED_DIR_NAME,
    _MIGRATED_VERSION,
    _RECOVERY_SUBDIR,
    SKILL_MD_FILE,
    _check_frontmatter_version,
    _insert_version_frontmatter,
    _is_legacy_skill_dir,
    _journal_commit,
    _journal_prepare,
    _migrate_skill_dir,
    _parse_skill_md_frontmatter,
    _recover_if_needed,
    _scan_legacy_skill_dirs,
    main,
)

# ---------------------------------------------------------------------------
# Fixtures
# ---------------------------------------------------------------------------


def _make_skill_dir(root: Path, rel_path: str) -> Path:
    """Create a directory under *root* and return it."""
    d = root / rel_path
    d.mkdir(parents=True, exist_ok=True)
    return d


def _write_file(path: Path, content: str) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(content, encoding="utf-8")


def _make_legacy_skill(root: Path, name: str, *, category: str = "custom") -> Path:
    """Create a legacy skill directory and return it."""
    skill_dir = _make_skill_dir(root / category, name)
    _write_file(
        skill_dir / SKILL_MD_FILE,
        f"---\nname: {name}\ndescription: Test skill\n---\n\n# Test\n",
    )
    return skill_dir


# ---------------------------------------------------------------------------
# Frontmatter helpers
# ---------------------------------------------------------------------------


class TestParseFrontmatter:
    def test_parses_valid_frontmatter(self) -> None:
        content = "---\nname: test\nversion: 0.1.0\n---\n\nBody text"
        metadata, body = _parse_skill_md_frontmatter(content)
        assert metadata == {"name": "test", "version": "0.1.0"}
        assert body == "Body text"

    def test_returns_empty_for_no_frontmatter(self) -> None:
        content = "# Just a markdown file"
        metadata, body = _parse_skill_md_frontmatter(content)
        assert metadata == {}
        assert body == content


class TestInsertVersionFrontmatter:
    def test_inserts_version_after_name(self) -> None:
        content = "---\nname: test\n---\n\nBody"
        new, inserted = _insert_version_frontmatter(content)
        assert inserted is True
        assert "version: 0.1.0" in new
        assert "name: test" in new
        # version should appear after name
        lines = new.split("\n")
        name_idx = next(i for i, line in enumerate(lines) if line.strip() == "name: test")
        ver_idx = next(i for i, line in enumerate(lines) if line.strip().startswith("version:"))
        assert ver_idx == name_idx + 1

    def test_noop_when_version_exists(self) -> None:
        content = "---\nname: test\nversion: 0.2.0\n---\n\nBody"
        new, inserted = _insert_version_frontmatter(content)
        assert inserted is False
        assert new == content

    def test_prepends_frontmatter_when_none(self) -> None:
        content = "# No frontmatter"
        new, inserted = _insert_version_frontmatter(content)
        assert inserted is True
        assert new.startswith("---\nversion: 0.1.0\n---")

    def test_inserts_after_opening_when_no_name(self) -> None:
        content = "---\ndescription: A skill\n---\n\nBody"
        new, inserted = _insert_version_frontmatter(content)
        assert inserted is True
        # version should be first metadata line
        lines = new.split("\n")
        assert lines[1].strip() == "version: 0.1.0"


class TestCheckFrontmatterVersion:
    def test_returns_version_when_present(self) -> None:
        content = "---\nname: test\nversion: 0.2.0\n---\n\nBody"
        assert _check_frontmatter_version(content) == "0.2.0"

    def test_returns_none_when_missing(self) -> None:
        content = "---\nname: test\n---\n\nBody"
        assert _check_frontmatter_version(content) is None


# ---------------------------------------------------------------------------
# Legacy detection
# ---------------------------------------------------------------------------


class TestIsLegacySkillDir:
    def test_detects_legacy_skill(self, tmp_path: Path) -> None:
        skill_dir = _make_legacy_skill(tmp_path, "my-skill")
        assert _is_legacy_skill_dir(skill_dir) is True

    def test_rejects_versioned_skill(self, tmp_path: Path) -> None:
        skill_dir = _make_legacy_skill(tmp_path, "my-skill")
        # Create a version dir — no longer legacy
        (skill_dir / _MIGRATED_DIR_NAME).mkdir()
        assert _is_legacy_skill_dir(skill_dir) is False

    def test_rejects_dir_without_skill_md(self, tmp_path: Path) -> None:
        d = _make_skill_dir(tmp_path / "custom", "not-a-skill")
        _write_file(d / "README.md", "hello")
        assert _is_legacy_skill_dir(d) is False

    def test_rejects_non_directory(self, tmp_path: Path) -> None:
        f = tmp_path / "file.txt"
        f.write_text("x")
        assert _is_legacy_skill_dir(f) is False


# ---------------------------------------------------------------------------
# Scanning
# ---------------------------------------------------------------------------


class TestScanLegacySkillDirs:
    def test_scans_global_custom(self, tmp_path: Path) -> None:
        _make_legacy_skill(tmp_path, "skill-a")
        _make_legacy_skill(tmp_path, "skill-b")
        # Already versioned — skipped
        versioned = _make_legacy_skill(tmp_path, "skill-v")
        (versioned / _MIGRATED_DIR_NAME).mkdir()
        # Not a skill — skipped
        _make_skill_dir(tmp_path / "custom", "not-skill")

        results = _scan_legacy_skill_dirs(tmp_path)
        names = {p.name for p in results}
        assert names == {"skill-a", "skill-b"}

    def test_scans_per_user_custom(self, tmp_path: Path) -> None:
        _make_legacy_skill(tmp_path / "users" / "alice" / "skills", "alice-skill")
        _make_legacy_skill(tmp_path / "users" / "bob" / "skills", "bob-skill")

        results = _scan_legacy_skill_dirs(tmp_path)
        names = {p.name for p in results}
        assert names == {"alice-skill", "bob-skill"}

    def test_handles_missing_directories(self, tmp_path: Path) -> None:
        results = _scan_legacy_skill_dirs(tmp_path)
        assert results == []

    def test_skips_dotfile_dirs_in_scan(self, tmp_path: Path) -> None:
        # Directories starting with dot are not skill dirs (no SKILL.md)
        # but the scanner uses iterdir which includes them naturally
        _make_skill_dir(tmp_path / "custom", ".history")
        results = _scan_legacy_skill_dirs(tmp_path)
        # .history dir has no SKILL.md, so it won't be detected
        assert len(results) == 0


# ---------------------------------------------------------------------------
# Migration
# ---------------------------------------------------------------------------


class TestMigrateSkillDir:
    def test_migrates_legacy_to_versioned(self, tmp_path: Path) -> None:
        skill_dir = _make_legacy_skill(tmp_path, "test-skill")
        # Add support files
        (skill_dir / "references").mkdir()
        _write_file(skill_dir / "references" / "guide.md", "# Guide")
        (skill_dir / "scripts").mkdir()
        _write_file(skill_dir / "scripts" / "setup.py", "print('hi')")
        # Add a dotfile that should be excluded from migrate
        (skill_dir / ".hidden").mkdir()

        result = _migrate_skill_dir(skill_dir)
        assert result["status"] == "migrated"

        # Verify version directory created
        version_dir = skill_dir / _MIGRATED_DIR_NAME
        assert version_dir.is_dir()

        # Verify SKILL.md moved and version inserted
        migrated_skill_md = version_dir / SKILL_MD_FILE
        assert migrated_skill_md.exists()
        content = migrated_skill_md.read_text(encoding="utf-8")
        assert f"version: {_MIGRATED_VERSION}" in content

        # Verify support files moved
        assert (version_dir / "references" / "guide.md").exists()
        assert (version_dir / "scripts" / "setup.py").exists()

        # Verify old SKILL.md no longer at root
        assert not (skill_dir / SKILL_MD_FILE).exists()

    def test_idempotent_second_run_skips(self, tmp_path: Path) -> None:
        skill_dir = _make_legacy_skill(tmp_path, "test-skill")
        result1 = _migrate_skill_dir(skill_dir)
        assert result1["status"] == "migrated"

        result2 = _migrate_skill_dir(skill_dir)
        assert result2["status"] == "already_versioned"

    def test_dry_run_does_not_modify(self, tmp_path: Path) -> None:
        skill_dir = _make_legacy_skill(tmp_path, "test-skill")

        result = _migrate_skill_dir(skill_dir, dry_run=True)
        assert result["status"] == "skipped_dry_run"

        # Directory should still be in legacy layout
        assert (skill_dir / SKILL_MD_FILE).exists()
        assert not (skill_dir / _MIGRATED_DIR_NAME).exists()

    def test_skips_non_skill_dir(self, tmp_path: Path) -> None:
        d = _make_skill_dir(tmp_path / "custom", "empty-dir")
        result = _migrate_skill_dir(d)
        assert result["status"] == "no_skill_md"

    def test_warns_on_frontmatter_version_mismatch(self, tmp_path: Path) -> None:
        skill_dir = _make_legacy_skill(tmp_path, "test-skill")
        _write_file(
            skill_dir / SKILL_MD_FILE,
            "---\nname: test-skill\nversion: 0.2.0\n---\n\nBody",
        )

        result = _migrate_skill_dir(skill_dir)
        assert result["status"] == "migrated"
        assert len(result["warnings"]) == 1
        assert "0.2.0" in result["warnings"][0]

        # Frontmatter should retain the original version
        migrated = (skill_dir / _MIGRATED_DIR_NAME / SKILL_MD_FILE).read_text(encoding="utf-8")
        assert "version: 0.2.0" in migrated


# ---------------------------------------------------------------------------
# Journal recovery
# ---------------------------------------------------------------------------


class TestJournalRecovery:
    def test_rollback_on_prepared_journal(self, tmp_path: Path) -> None:
        skill_dir = _make_legacy_skill(tmp_path, "test-skill")
        _write_file(skill_dir / "references" / "guide.md", "# Guide")

        parent_dir = skill_dir.parent
        name = skill_dir.name

        # Simulate a prepared journal: backup exists, but migration incomplete
        recovery_root = parent_dir / _RECOVERY_SUBDIR
        operation_id = _journal_prepare(parent_dir, name, recovery_root, skill_dir)

        # Simulate incomplete migration: create empty version dir, remove original
        version_dir = skill_dir / _MIGRATED_DIR_NAME
        skill_md_original = skill_dir / SKILL_MD_FILE
        ref_original = skill_dir / "references"
        version_dir.mkdir()
        shutil.move(str(skill_md_original), str(version_dir / SKILL_MD_FILE))
        shutil.move(str(ref_original), str(version_dir / "references"))

        # Now recovery should rollback
        result = _recover_if_needed(parent_dir, name)
        assert result is not None
        assert result["action"] == "rolled_back"

        # Original files should be restored
        assert (skill_dir / "references" / "guide.md").exists()
        assert (skill_dir / SKILL_MD_FILE).exists()
        # Version dir should be gone
        assert not (skill_dir / _MIGRATED_DIR_NAME).exists()
        # Journal and recovery dir should be cleaned
        assert not (parent_dir / f".skills-version-migration-{name}.json").exists()
        assert not (parent_dir / _RECOVERY_SUBDIR / operation_id).exists()

    def test_cleans_up_committed_journal(self, tmp_path: Path) -> None:
        skill_dir = _make_legacy_skill(tmp_path, "test-skill")
        parent_dir = skill_dir.parent
        name = skill_dir.name

        # Create a committed journal with recovery artifacts
        operation_id = "test-op-id"
        recovery_dir = parent_dir / _RECOVERY_SUBDIR / operation_id
        recovery_dir.mkdir(parents=True)
        (recovery_dir / "dummy").write_text("x")
        journal_path = parent_dir / f".skills-version-migration-{name}.json"
        journal_path.write_text(json.dumps({"operationId": operation_id, "state": "committed", "skillName": name}), encoding="utf-8")

        result = _recover_if_needed(parent_dir, name)
        assert result is not None
        assert result["action"] == "cleaned_committed"

        assert not journal_path.exists()
        assert not recovery_dir.exists()

    def test_journal_commit_cleans_up(self, tmp_path: Path) -> None:
        skill_dir = _make_legacy_skill(tmp_path, "test-skill")
        parent_dir = skill_dir.parent
        name = skill_dir.name

        recovery_root = parent_dir / _RECOVERY_SUBDIR
        operation_id = _journal_prepare(parent_dir, name, recovery_root, skill_dir)

        # Verify journal exists
        journal_path = parent_dir / f".skills-version-migration-{name}.json"
        assert journal_path.exists()

        _journal_commit(parent_dir, name, operation_id)
        assert not journal_path.exists()
        assert not (parent_dir / _RECOVERY_SUBDIR / operation_id).exists()

    def test_migration_recovery_on_next_run(self, tmp_path: Path) -> None:
        """Full round-trip: prepare journal, simulate interruption, recover on next run."""
        skill_dir = _make_legacy_skill(tmp_path, "test-skill")
        _write_file(skill_dir / "data.json", '{"key": "value"}')
        parent_dir = skill_dir.parent
        name = skill_dir.name

        # Simulate a migration that was prepared but didn't complete
        recovery_root = parent_dir / _RECOVERY_SUBDIR
        _journal_prepare(parent_dir, name, recovery_root, skill_dir)

        # Create a partial v0.1.0 with some files moved but not complete
        version_dir = skill_dir / _MIGRATED_DIR_NAME
        version_dir.mkdir()
        shutil.move(str(skill_dir / SKILL_MD_FILE), str(version_dir / SKILL_MD_FILE))
        # Leave data.json in place (incomplete move)

        # Journal should still be in "prepared" state
        journal = json.loads((parent_dir / f".skills-version-migration-{name}.json").read_text(encoding="utf-8"))
        assert journal["state"] == "prepared"

        # Now simulate next run: recovery happens inside _migrate_skill_dir
        # First, call _recover_if_needed to rollback
        result = _recover_if_needed(parent_dir, name)
        assert result is not None
        assert result["action"] == "rolled_back"

        # Verify original layout restored
        assert (skill_dir / SKILL_MD_FILE).exists()
        assert (skill_dir / "data.json").exists()
        assert not (skill_dir / _MIGRATED_DIR_NAME).exists()

        # Now migration can proceed cleanly
        result2 = _migrate_skill_dir(skill_dir)
        assert result2["status"] == "migrated"
        assert (skill_dir / _MIGRATED_DIR_NAME / SKILL_MD_FILE).exists()
        assert (skill_dir / _MIGRATED_DIR_NAME / "data.json").exists()


# ---------------------------------------------------------------------------
# End-to-end via CLI main()
# ---------------------------------------------------------------------------


class TestMain:
    def test_dry_run_output(self, tmp_path: Path) -> None:
        _make_legacy_skill(tmp_path, "skill-a")
        _make_legacy_skill(tmp_path, "skill-b")

        exit_code = main(["--root", str(tmp_path), "--dry-run"])
        assert exit_code == 0

        # Nothing should be modified
        assert (tmp_path / "custom" / "skill-a" / SKILL_MD_FILE).exists()
        assert not (tmp_path / "custom" / "skill-a" / _MIGRATED_DIR_NAME).exists()

    def test_migration_run(self, tmp_path: Path) -> None:
        _make_legacy_skill(tmp_path, "skill-a")
        _make_legacy_skill(tmp_path, "skill-b")

        exit_code = main(["--root", str(tmp_path)])
        assert exit_code == 0

        assert (tmp_path / "custom" / "skill-a" / _MIGRATED_DIR_NAME / SKILL_MD_FILE).exists()
        assert (tmp_path / "custom" / "skill-b" / _MIGRATED_DIR_NAME / SKILL_MD_FILE).exists()

    def test_already_migrated_is_idempotent(self, tmp_path: Path) -> None:
        _make_legacy_skill(tmp_path, "skill-a")
        main(["--root", str(tmp_path)])
        # Second run should be no-op
        exit_code = main(["--root", str(tmp_path)])
        assert exit_code == 0

    def test_handles_no_skills(self, tmp_path: Path) -> None:
        exit_code = main(["--root", str(tmp_path)])
        assert exit_code == 0

    def test_missing_root_returns_error(self) -> None:
        exit_code = main(["--root", "/nonexistent/path/to/skills"])
        assert exit_code == 1
