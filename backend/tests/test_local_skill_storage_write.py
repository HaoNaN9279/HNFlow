"""Tests for LocalSkillStorage.write_custom_skill — T7-3 versioned layout."""

from __future__ import annotations

import os
import stat
from unittest.mock import patch

import pytest

from deerflow.config.paths import Paths
from deerflow.skills.storage import get_or_new_skill_storage, reset_skill_storage
from deerflow.skills.storage.user_scoped_skill_storage import UserScopedSkillStorage


@pytest.fixture(autouse=True)
def _reset_storages():
    reset_skill_storage()
    yield
    reset_skill_storage()


@pytest.fixture()
def storage(tmp_path):
    return get_or_new_skill_storage(skills_path=str(tmp_path))


@pytest.fixture()
def user_storage(tmp_path):
    """UserScopedSkillStorage for user 'test-user'."""
    with patch("deerflow.config.paths.get_paths", return_value=Paths(base_dir=tmp_path)):
        with patch("deerflow.config.paths._paths", None):
            s = UserScopedSkillStorage("test-user", host_path=str(tmp_path))
    return s


@pytest.fixture()
def skill_dir(tmp_path, storage):
    """Pre-create the skill directory so symlink tests can plant files inside."""
    d = tmp_path / "custom" / "demo-skill"
    d.mkdir(parents=True, exist_ok=True)
    return d


@pytest.fixture()
def user_skill_dir(tmp_path, user_storage):
    """Pre-create the user-scoped skill directory."""
    d = tmp_path / "users" / "test-user" / "skills" / "custom" / "demo-skill"
    d.mkdir(parents=True, exist_ok=True)
    return d


# ---------------------------------------------------------------------------
# Happy path — basic write (now versioned)
# ---------------------------------------------------------------------------


def test_write_creates_file_in_version_dir(tmp_path, storage):
    """write_custom_skill writes SKILL.md under v0.1.0/ by default.

    Bare content without frontmatter gets a frontmatter block with version added.
    """
    result = storage.write_custom_skill("demo-skill", "SKILL.md", "# hello")
    assert result == "0.1.0"
    written = (tmp_path / "custom" / "demo-skill" / "v0.1.0" / "SKILL.md").read_text()
    assert "# hello" in written
    assert "version: 0.1.0" in written


def test_write_returns_version(tmp_path, storage):
    """write_custom_skill returns the actual version written."""
    result = storage.write_custom_skill("demo-skill", "SKILL.md", "# hello")
    assert result == "0.1.0"


def test_write_creates_subdirectory_in_version_dir(tmp_path, storage):
    storage.write_custom_skill("demo-skill", "SKILL.md", "# hello")
    storage.write_custom_skill("demo-skill", "references/ref.md", "# ref")
    # Support file bumps to a new version (v0.1.1); v0.1.0 stays untouched
    assert not (tmp_path / "custom" / "demo-skill" / "v0.1.0" / "references" / "ref.md").exists()
    assert (tmp_path / "custom" / "demo-skill" / "v0.1.1" / "references" / "ref.md").exists()


def test_write_is_atomic_overwrite_in_same_version(tmp_path, storage):
    storage.write_custom_skill("demo-skill", "SKILL.md", "first")
    # Second write to SKILL.md (no version in frontmatter) should bump
    storage.write_custom_skill("demo-skill", "SKILL.md", "second")
    # v0.1.0 content should contain "first"
    v0_content = (tmp_path / "custom" / "demo-skill" / "v0.1.0" / "SKILL.md").read_text()
    assert "first" in v0_content
    # v0.1.1 contains the new content
    v1_content = (tmp_path / "custom" / "demo-skill" / "v0.1.1" / "SKILL.md").read_text()
    assert "second" in v1_content


def test_write_makes_written_path_sandbox_readable(tmp_path, storage):
    skill_dir = tmp_path / "custom" / "demo-skill"
    skill_dir.mkdir(parents=True)
    skill_dir.chmod(0o700)

    storage.write_custom_skill("demo-skill", "SKILL.md", "# hello")

    version_dir = skill_dir / "v0.1.0"
    assert stat.S_IMODE(version_dir.stat().st_mode) & 0o055 == 0o055


# ---------------------------------------------------------------------------
# T7-3: Versioned write — immutable bump
# ---------------------------------------------------------------------------


def _skill_content(name: str, description: str = "Demo skill", version: str | None = None) -> str:
    lines = [
        "---",
        f"name: {name}",
        f"description: {description}",
    ]
    if version is not None:
        lines.append(f"version: {version}")
    lines.append("---")
    lines.append(f"\n# {name}\n")
    return "\n".join(lines)


def test_write_with_explicit_version_creates_version_dir(tmp_path, storage):
    """write_custom_skill with explicit version creates that version dir."""
    content = _skill_content("demo-skill", version="1.2.3")
    result = storage.write_custom_skill("demo-skill", "SKILL.md", content, version="1.2.3")
    assert result == "1.2.3"
    assert (tmp_path / "custom" / "demo-skill" / "v1.2.3" / "SKILL.md").exists()


def test_write_with_explicit_version_conflict_bumps(tmp_path, storage):
    """Writing to an existing version directory auto-bumps."""
    content = _skill_content("demo-skill", version="0.1.0")
    # First write creates v0.1.0
    storage.write_custom_skill("demo-skill", "SKILL.md", content, version="0.1.0")
    # Second write to same version should bump to v0.1.1
    result = storage.write_custom_skill("demo-skill", "SKILL.md", content, version="0.1.0")
    assert result == "0.1.1"
    assert (tmp_path / "custom" / "demo-skill" / "v0.1.0" / "SKILL.md").exists()
    assert (tmp_path / "custom" / "demo-skill" / "v0.1.1" / "SKILL.md").exists()


def test_write_skips_over_multiple_existing_versions(tmp_path, storage):
    """Bump skips over multiple existing versions."""
    # Create v0.1.0, v0.1.1, v0.1.2
    for i in range(3):
        v = f"0.1.{i}"
        content = f"---\nname: demo-skill\nversion: {v}\n---\n\n# v{i}"
        storage.write_custom_skill("demo-skill", "SKILL.md", content, version=v)
    # Now try to write v0.1.0 → should bump to v0.1.3
    result = storage.write_custom_skill("demo-skill", "SKILL.md", _skill_content("demo-skill"), version="0.1.0")
    assert result == "0.1.3"
    assert (tmp_path / "custom" / "demo-skill" / "v0.1.3" / "SKILL.md").exists()


def test_write_rewrites_frontmatter_version(tmp_path, storage):
    """When writing SKILL.md, the frontmatter version is rewritten to actual."""
    content = _skill_content("demo-skill", version="1.2.3")
    result = storage.write_custom_skill("demo-skill", "SKILL.md", content, version="1.2.3")
    written = (tmp_path / "custom" / "demo-skill" / "v1.2.3" / "SKILL.md").read_text()
    assert f"version: {result}" in written


def test_write_adds_version_to_frontmatter_without_one(tmp_path, storage):
    """When frontmatter has no version, it's added during write."""
    content = "---\nname: demo-skill\ndescription: A demo\n---\n\n# Demo"
    result = storage.write_custom_skill("demo-skill", "SKILL.md", content)
    written = (tmp_path / "custom" / "demo-skill" / "v0.1.0" / "SKILL.md").read_text()
    assert f"version: {result}" in written
    assert "name: demo-skill" in written


def test_write_extracts_version_from_frontmatter(tmp_path, storage):
    """When no explicit version given, frontmatter version is used."""
    content = _skill_content("demo-skill", version="2.0.0")
    result = storage.write_custom_skill("demo-skill", "SKILL.md", content)
    assert result == "2.0.0"
    assert (tmp_path / "custom" / "demo-skill" / "v2.0.0" / "SKILL.md").exists()


def test_write_support_file_copies_current_tree_to_new_version(tmp_path, storage):
    """Support file write always bumps to a new version and copies the current tree."""
    # Create v0.1.0 with SKILL.md
    storage.write_custom_skill("demo-skill", "SKILL.md", _skill_content("demo-skill"))
    # Write a support file — bumps to v0.1.1, copies tree from v0.1.0
    result1 = storage.write_custom_skill("demo-skill", "references/ref.md", "# ref1")
    assert result1 == "0.1.1"
    # v0.1.0 stays untouched (no ref.md)
    assert not (tmp_path / "custom" / "demo-skill" / "v0.1.0" / "references" / "ref.md").exists()
    # v0.1.1 has the ref.md AND the SKILL.md copied from v0.1.0
    ref_path = tmp_path / "custom" / "demo-skill" / "v0.1.1" / "references" / "ref.md"
    assert ref_path.exists()
    assert (tmp_path / "custom" / "demo-skill" / "v0.1.1" / "SKILL.md").exists()

    # Update SKILL.md → bumps to v0.1.2
    storage.write_custom_skill("demo-skill", "SKILL.md", _skill_content("demo-skill", "v2"))

    # Write a second support file — bumps to v0.1.3 (current is v0.1.2)
    result2 = storage.write_custom_skill("demo-skill", "references/ref.md", "# ref2")
    assert result2 == "0.1.3"
    assert (tmp_path / "custom" / "demo-skill" / "v0.1.3" / "SKILL.md").exists()
    assert (tmp_path / "custom" / "demo-skill" / "v0.1.3" / "references" / "ref.md").read_text() == "# ref2"

    # Explicit version on support file still works
    result3 = storage.write_custom_skill("demo-skill", "references/ref.md", "# ref3", version="1.0.0")
    assert result3 == "1.0.0"
    assert (tmp_path / "custom" / "demo-skill" / "v1.0.0" / "references" / "ref.md").read_text() == "# ref3"


def test_support_file_never_mutates_published_version(tmp_path, storage):
    """A support file write must NOT modify the existing current version."""
    storage.write_custom_skill("demo-skill", "SKILL.md", _skill_content("demo-skill"))
    storage.write_custom_skill("demo-skill", "references/ref.md", "# ref")
    # v0.1.0 must be pristine — no ref.md inside
    v0_dir = tmp_path / "custom" / "demo-skill" / "v0.1.0"
    assert (v0_dir / "SKILL.md").exists()
    assert not (v0_dir / "references").exists()
    # ref.md lands in v0.1.1
    assert (tmp_path / "custom" / "demo-skill" / "v0.1.1" / "references" / "ref.md").read_text() == "# ref"


def test_support_file_tree_copy_includes_skill_md(tmp_path, storage):
    """Tree copy from current version to new version includes SKILL.md."""
    storage.write_custom_skill("demo-skill", "SKILL.md", _skill_content("demo-skill"))
    storage.write_custom_skill("demo-skill", "references/ref.md", "# ref")
    # v0.1.1 must contain both SKILL.md (copied) and ref.md (new)
    v1_dir = tmp_path / "custom" / "demo-skill" / "v0.1.1"
    assert (v1_dir / "SKILL.md").exists()
    assert (v1_dir / "references" / "ref.md").exists()


def test_consecutive_support_file_writes_each_bump(tmp_path, storage):
    """Two consecutive support file writes each produce a new version."""
    storage.write_custom_skill("demo-skill", "SKILL.md", _skill_content("demo-skill"))
    # First support file → v0.1.1
    r1 = storage.write_custom_skill("demo-skill", "references/a.md", "# a")
    assert r1 == "0.1.1"
    # Second support file → v0.1.2
    r2 = storage.write_custom_skill("demo-skill", "scripts/b.sh", "#!/bin/sh")
    assert r2 == "0.1.2"
    # All versions exist and v0.1.0 is untouched
    assert (tmp_path / "custom" / "demo-skill" / "v0.1.0" / "SKILL.md").exists()
    assert (tmp_path / "custom" / "demo-skill" / "v0.1.1" / "references" / "a.md").exists()
    assert (tmp_path / "custom" / "demo-skill" / "v0.1.2" / "scripts" / "b.sh").exists()
    # Each newer version has the full tree
    assert (tmp_path / "custom" / "demo-skill" / "v0.1.2" / "SKILL.md").exists()
    assert (tmp_path / "custom" / "demo-skill" / "v0.1.2" / "references" / "a.md").exists()


# ---------------------------------------------------------------------------
# T7-3: Versioned read
# ---------------------------------------------------------------------------


def test_read_current_version(tmp_path, storage):
    """read_custom_skill without version returns current (highest)."""
    storage.write_custom_skill("demo-skill", "SKILL.md", _skill_content("demo-skill", version="0.1.0"))
    content = storage.read_custom_skill("demo-skill")
    assert "demo-skill" in content


def test_read_specific_version(tmp_path, storage):
    """read_custom_skill with explicit version returns that version."""
    storage.write_custom_skill("demo-skill", "SKILL.md", _skill_content("demo-skill"), version="0.1.0")
    content = storage.read_custom_skill("demo-skill", version="0.1.0")
    assert "demo-skill" in content


def test_read_nonexistent_version_raises(tmp_path, storage):
    """Reading a version that doesn't exist raises FileNotFoundError."""
    storage.write_custom_skill("demo-skill", "SKILL.md", _skill_content("demo-skill"))
    with pytest.raises(FileNotFoundError, match="version 99.0.0"):
        storage.read_custom_skill("demo-skill", version="99.0.0")


def test_read_returns_highest_version_as_current(tmp_path, storage):
    """When multiple versions exist, read_custom_skill returns highest."""
    storage.write_custom_skill("demo-skill", "SKILL.md", _skill_content("demo-skill"), version="0.1.0")
    storage.write_custom_skill("demo-skill", "SKILL.md", _skill_content("demo-skill", "v2"), version="0.2.0")
    content = storage.read_custom_skill("demo-skill")
    assert "v2" in content


# ---------------------------------------------------------------------------
# T7-3: list_skill_versions / resolve_current_version
# ---------------------------------------------------------------------------


def test_list_skill_versions_empty(tmp_path, storage):
    assert storage.list_skill_versions("nonexistent") == []


def test_list_skill_versions_sorted(tmp_path, storage):
    storage.write_custom_skill("demo-skill", "SKILL.md", _skill_content("demo-skill"), version="0.1.0")
    storage.write_custom_skill("demo-skill", "SKILL.md", _skill_content("demo-skill", "v2"), version="0.2.0")
    storage.write_custom_skill("demo-skill", "SKILL.md", _skill_content("demo-skill"), version="1.0.0")
    versions = storage.list_skill_versions("demo-skill")
    # All three write with explicit version=<N>, so no bumping occurs
    assert versions == ["0.1.0", "0.2.0", "1.0.0"]


def test_resolve_current_version_returns_highest(tmp_path, storage):
    storage.write_custom_skill("demo-skill", "SKILL.md", _skill_content("demo-skill"), version="0.1.0")
    storage.write_custom_skill("demo-skill", "SKILL.md", _skill_content("demo-skill", "v2"), version="0.2.0")
    assert storage.resolve_current_version("demo-skill") == "0.2.0"


def test_resolve_current_version_none_for_missing(tmp_path, storage):
    assert storage.resolve_current_version("nonexistent") is None


# ---------------------------------------------------------------------------
# T7-3: Legacy layout compatibility
# ---------------------------------------------------------------------------


def test_legacy_layout_reads_as_v0_1_0(tmp_path, storage):
    """A skill with SKILL.md directly under <name>/ (no version dir) is read as v0.1.0."""
    skill_dir = tmp_path / "custom" / "legacy-skill"
    skill_dir.mkdir(parents=True)
    (skill_dir / "SKILL.md").write_text(_skill_content("legacy-skill"), encoding="utf-8")

    assert storage.custom_skill_exists("legacy-skill")
    content = storage.read_custom_skill("legacy-skill")
    assert "legacy-skill" in content
    assert storage.resolve_current_version("legacy-skill") == "0.1.0"
    assert storage.list_skill_versions("legacy-skill") == []


def test_legacy_layout_list_versions_empty(tmp_path, storage):
    """Legacy skills have no version directories, so list_skill_versions returns []."""
    skill_dir = tmp_path / "custom" / "legacy-skill"
    skill_dir.mkdir(parents=True)
    (skill_dir / "SKILL.md").write_text(_skill_content("legacy-skill"), encoding="utf-8")
    assert storage.list_skill_versions("legacy-skill") == []


def test_legacy_layout_resolve_current_returns_default(tmp_path, storage):
    """Legacy layouts resolve to "0.1.0"."""
    skill_dir = tmp_path / "custom" / "legacy-skill"
    skill_dir.mkdir(parents=True)
    (skill_dir / "SKILL.md").write_text(_skill_content("legacy-skill"), encoding="utf-8")
    assert storage.resolve_current_version("legacy-skill") == "0.1.0"


def test_legacy_custom_skill_dir_returns_base_dir(tmp_path, storage):
    """get_custom_skill_dir for legacy skill returns base dir, not version dir."""
    skill_dir = tmp_path / "custom" / "legacy-skill"
    skill_dir.mkdir(parents=True)
    (skill_dir / "SKILL.md").write_text(_skill_content("legacy-skill"), encoding="utf-8")
    result = storage.get_custom_skill_dir("legacy-skill")
    assert result == skill_dir


def test_legacy_custom_skill_file_points_to_skill_md(tmp_path, storage):
    skill_dir = tmp_path / "custom" / "legacy-skill"
    skill_dir.mkdir(parents=True)
    (skill_dir / "SKILL.md").write_text(_skill_content("legacy-skill"), encoding="utf-8")
    assert storage.get_custom_skill_file("legacy-skill") == skill_dir / "SKILL.md"


# ---------------------------------------------------------------------------
# T7-3: _iter_skill_files / load_skills with versions
# ---------------------------------------------------------------------------


def test_load_skills_sees_current_version_only(tmp_path, storage):
    """Only the current (highest) version is registered."""
    # Create two versions
    storage.write_custom_skill("demo-skill", "SKILL.md", _skill_content("demo-skill"), version="0.1.0")
    storage.write_custom_skill("demo-skill", "SKILL.md", _skill_content("demo-skill", "v2"), version="0.2.0")

    skills = storage.load_skills(enabled_only=False)
    demo_skills = [s for s in skills if s.name == "demo-skill"]
    assert len(demo_skills) == 1
    assert demo_skills[0].version == "0.2.0"


def test_load_skills_sees_legacy_skill(tmp_path, storage):
    skill_dir = tmp_path / "custom" / "legacy-skill"
    skill_dir.mkdir(parents=True)
    (skill_dir / "SKILL.md").write_text(_skill_content("legacy-skill"), encoding="utf-8")

    skills = storage.load_skills(enabled_only=False)
    names = {s.name for s in skills}
    assert "legacy-skill" in names
    legacy = [s for s in skills if s.name == "legacy-skill"]
    assert legacy[0].version == "0.1.0"


# ---------------------------------------------------------------------------
# Empty / blank path
# ---------------------------------------------------------------------------


def test_rejects_empty_string(storage):
    with pytest.raises(ValueError, match="empty"):
        storage.write_custom_skill("demo-skill", "", "x")


# ---------------------------------------------------------------------------
# Absolute paths
# ---------------------------------------------------------------------------


def test_rejects_absolute_unix_path(storage):
    with pytest.raises(ValueError, match="skill directory"):
        storage.write_custom_skill("demo-skill", "/etc/passwd", "x")


def test_rejects_absolute_path_with_skill_prefix(tmp_path, storage):
    """Absolute path within skill dir: containment check passes (not a security issue).

    Python's Path(base) / "/abs/path" ignores base and returns /abs/path directly.
    If that absolute path resolves within skill_dir, the write succeeds.
    This is not an escape — the file lands in the correct location.
    """
    absolute = str(tmp_path / "custom" / "demo-skill" / "v0.1.0" / "SKILL.md")
    storage.write_custom_skill("demo-skill", absolute, "# ok")
    assert (tmp_path / "custom" / "demo-skill" / "v0.1.0" / "SKILL.md").read_text() == "# ok"


# ---------------------------------------------------------------------------
# Parent-directory traversal
# ---------------------------------------------------------------------------


def test_rejects_dotdot_escape(storage):
    with pytest.raises(ValueError, match="skill directory"):
        storage.write_custom_skill("demo-skill", "../../escaped.txt", "x")


def test_rejects_dotdot_sibling(storage):
    with pytest.raises(ValueError, match="skill directory"):
        storage.write_custom_skill("demo-skill", "../sibling/x.txt", "x")


def test_rejects_dotdot_in_subpath(storage):
    with pytest.raises(ValueError, match="skill directory"):
        storage.write_custom_skill("demo-skill", "sub/../../escape.txt", "x")


def test_rejects_dotdot_only(storage):
    with pytest.raises(ValueError, match="skill directory"):
        storage.write_custom_skill("demo-skill", "..", "x")


# ---------------------------------------------------------------------------
# Symlink escape
# ---------------------------------------------------------------------------


def test_rejects_symlink_pointing_outside(tmp_path, storage, skill_dir):
    if os.name == "nt":
        pytest.skip("os.symlink requires admin privileges on Windows")
    outside = tmp_path / "outside.txt"
    link = skill_dir / "escape_link.txt"
    os.symlink(outside, link)
    with pytest.raises(ValueError, match="skill directory"):
        storage.write_custom_skill("demo-skill", "escape_link.txt", "x")


def test_rejects_symlink_dir_pointing_outside(tmp_path, storage, skill_dir):
    if os.name == "nt":
        pytest.skip("os.symlink requires admin privileges on Windows")
    outside_dir = tmp_path / "outside_dir"
    outside_dir.mkdir()
    link_dir = skill_dir / "linked_dir"
    os.symlink(outside_dir, link_dir)
    with pytest.raises(ValueError, match="skill directory"):
        storage.write_custom_skill("demo-skill", "linked_dir/file.txt", "x")


def test_allows_symlink_within_skill_dir(tmp_path, storage, skill_dir):
    if os.name == "nt":
        pytest.skip("os.symlink requires admin privileges on Windows")
    """A symlink that resolves inside the skill directory is allowed.

    Because target is resolved before writing, the write goes to the real file
    the symlink points to (both the link and the real file end up with the new
    content).
    """
    real_file = skill_dir / "real.md"
    real_file.write_text("real")
    link = skill_dir / "alias.md"
    os.symlink(real_file, link)
    # Should not raise
    storage.write_custom_skill("demo-skill", "alias.md", "updated")
    # resolve() writes through to the real target file
    assert real_file.read_text() == "updated"
    assert (skill_dir / "alias.md").read_text() == "updated"


# ---------------------------------------------------------------------------
# Invalid skill-name traversal
# ---------------------------------------------------------------------------


@pytest.mark.parametrize(
    "name,method_name",
    [
        ("../../escaped", "get_custom_skill_dir"),
        ("../../escaped", "get_custom_skill_file"),
        ("../../escaped", "get_skill_history_file"),
        ("../../escaped", "custom_skill_exists"),
        ("../../escaped", "public_skill_exists"),
    ],
)
def test_rejects_invalid_skill_name_in_path_helpers(storage, name, method_name):
    method = getattr(storage, method_name)
    with pytest.raises(ValueError, match="hyphen-case"):
        method(name)


# ---------------------------------------------------------------------------
# UserScopedSkillStorage write tests — versioned
# ---------------------------------------------------------------------------


def test_user_scoped_write_creates_file_in_version_dir(tmp_path, user_storage):
    user_storage.write_custom_skill("demo-skill", "SKILL.md", "# hello")
    user_file = tmp_path / "users" / "test-user" / "skills" / "custom" / "demo-skill" / "v0.1.0" / "SKILL.md"
    written = user_file.read_text()
    assert "# hello" in written
    assert "version: 0.1.0" in written
    # Does not create in global custom
    assert not (tmp_path / "custom" / "demo-skill" / "SKILL.md").exists()


def test_user_scoped_write_returns_version(tmp_path, user_storage):
    result = user_storage.write_custom_skill("demo-skill", "SKILL.md", _skill_content("demo-skill"))
    assert result == "0.1.0"


def test_user_scoped_write_creates_subdirectory(tmp_path, user_storage):
    user_storage.write_custom_skill("demo-skill", "SKILL.md", _skill_content("demo-skill"))
    user_storage.write_custom_skill("demo-skill", "references/ref.md", "# ref")
    # Support file bumps to a new version; v0.1.0 stays untouched
    assert not (tmp_path / "users" / "test-user" / "skills" / "custom" / "demo-skill" / "v0.1.0" / "references" / "ref.md").exists()
    assert (tmp_path / "users" / "test-user" / "skills" / "custom" / "demo-skill" / "v0.1.1" / "references" / "ref.md").exists()


def test_user_scoped_write_is_atomic_overwrite(tmp_path, user_storage):
    user_storage.write_custom_skill("demo-skill", "SKILL.md", _skill_content("demo-skill"))
    user_storage.write_custom_skill("demo-skill", "SKILL.md", _skill_content("demo-skill", "v2"))
    # First version preserved
    assert (tmp_path / "users" / "test-user" / "skills" / "custom" / "demo-skill" / "v0.1.0" / "SKILL.md").exists()
    # Second version created (bump); frontmatter has version: 0.1.1 inserted
    v2_content = (tmp_path / "users" / "test-user" / "skills" / "custom" / "demo-skill" / "v0.1.1" / "SKILL.md").read_text()
    assert "v2" in v2_content
    assert "version: 0.1.1" in v2_content


def test_user_scoped_rejects_empty_string(user_storage):
    with pytest.raises(ValueError, match="empty"):
        user_storage.write_custom_skill("demo-skill", "", "x")


def test_user_scoped_rejects_dotdot_escape(user_storage):
    with pytest.raises(ValueError, match="skill directory"):
        user_storage.write_custom_skill("demo-skill", "../../escaped.txt", "x")


def test_user_scoped_rejects_invalid_skill_name(user_storage):
    with pytest.raises(ValueError, match="hyphen-case"):
        user_storage.get_custom_skill_dir("../../escaped")


def test_user_scoped_list_and_resolve_versions(tmp_path, user_storage):
    user_storage.write_custom_skill("demo-skill", "SKILL.md", _skill_content("demo-skill"), version="0.1.0")
    user_storage.write_custom_skill("demo-skill", "SKILL.md", _skill_content("demo-skill", "v2"), version="0.2.0")
    assert user_storage.list_skill_versions("demo-skill") == ["0.1.0", "0.2.0"]
    assert user_storage.resolve_current_version("demo-skill") == "0.2.0"


def test_user_scoped_write_with_explicit_version(tmp_path, user_storage):
    result = user_storage.write_custom_skill("demo-skill", "SKILL.md", _skill_content("demo-skill"), version="1.2.3")
    assert result == "1.2.3"
    version_file = tmp_path / "users" / "test-user" / "skills" / "custom" / "demo-skill" / "v1.2.3" / "SKILL.md"
    assert version_file.exists()
