"""Tests for deerflow.skills.versions — semver parse, compare, and dir-name helpers."""

from __future__ import annotations

import pytest

from deerflow.skills.versions import (
    bump_patch,
    compare_versions,
    dir_name_to_version,
    is_version_dir_name,
    parse_version,
    select_current_version,
    sort_versions,
    version_to_dir_name,
)

# ── parse_version ───────────────────────────────────────────────────────────


class TestParseVersion:
    def test_bare_semver(self):
        assert parse_version("0.1.0") == "0.1.0"

    def test_semver_with_numbers(self):
        assert parse_version("1.2.3") == "1.2.3"

    def test_large_version(self):
        assert parse_version("10.0.0") == "10.0.0"

    def test_with_pre_release(self):
        assert parse_version("2.0.0-rc.1") == "2.0.0-rc.1"

    def test_v_prefix_normalised(self):
        assert parse_version("v0.1.0") == "0.1.0"

    def test_v_prefix_with_pre_release(self):
        assert parse_version("v2.0.0-rc.1") == "2.0.0-rc.1"

    def test_uppercase_v_prefix(self):
        assert parse_version("V1.0.0") == "1.0.0"

    def test_strips_whitespace(self):
        assert parse_version("  1.0.0  ") == "1.0.0"

    def test_pre_release_with_dots(self):
        assert parse_version("1.0.0-alpha.1") == "1.0.0-alpha.1"

    def test_pre_release_with_hyphens(self):
        assert parse_version("1.0.0-alpha-beta.3") == "1.0.0-alpha-beta.3"

    def test_zero_patch(self):
        assert parse_version("0.0.0") == "0.0.0"


class TestParseVersionInvalid:
    def test_empty_string(self):
        with pytest.raises(ValueError):
            parse_version("")

    def test_whitespace_only(self):
        with pytest.raises(ValueError):
            parse_version("   ")

    def test_not_a_string(self):
        with pytest.raises(ValueError):
            parse_version(None)  # type: ignore[arg-type]

    def test_missing_patch(self):
        with pytest.raises(ValueError):
            parse_version("v1.2")

    def test_bare_missing_patch(self):
        with pytest.raises(ValueError):
            parse_version("1.2")

    def test_four_segment(self):
        with pytest.raises(ValueError):
            parse_version("1.2.3.4")

    def test_five_segment(self):
        with pytest.raises(ValueError):
            parse_version("1.2.3.4.5")

    def test_garbage_string(self):
        with pytest.raises(ValueError):
            parse_version("abc")

    def test_empty_pre_release(self):
        with pytest.raises(ValueError):
            parse_version("1.2.3-")

    def test_v_prefix_four_segment(self):
        with pytest.raises(ValueError):
            parse_version("v1.2.3.4")

    def test_v_prefix_missing_patch(self):
        with pytest.raises(ValueError):
            parse_version("v1.2")

    def test_bare_v_only(self):
        with pytest.raises(ValueError):
            parse_version("v")

    def test_bare_V_only(self):
        with pytest.raises(ValueError):
            parse_version("V")

    def test_pre_release_with_empty_segment(self):
        # "1.2.3-rc." has a trailing dot with no identifier
        with pytest.raises(ValueError):
            parse_version("1.2.3-rc.")

    def test_leading_zero_is_ok(self):
        # Semver 2.0 forbids leading zeros in numeric identifiers,
        # but this module only enforces three-segment + pre-release shape.
        assert parse_version("01.02.03") == "01.02.03"


# ── version_to_dir_name ─────────────────────────────────────────────────────


class TestVersionToDirName:
    def test_simple(self):
        assert version_to_dir_name("0.1.0") == "v0.1.0"

    def test_with_pre_release(self):
        assert version_to_dir_name("2.0.0-rc.1") == "v2.0.0-rc.1"

    def test_already_has_v_prefix(self):
        # The input is a bare semver — passing "v0.1.0" should still work
        # because parse_version strips the v, then we re-add it.
        assert version_to_dir_name("v0.1.0") == "v0.1.0"

    def test_invalid_raises(self):
        with pytest.raises(ValueError):
            version_to_dir_name("1.2")


# ── dir_name_to_version ─────────────────────────────────────────────────────


class TestDirNameToVersion:
    def test_simple(self):
        assert dir_name_to_version("v0.1.0") == "0.1.0"

    def test_with_pre_release(self):
        assert dir_name_to_version("v2.0.0-rc.1") == "2.0.0-rc.1"

    def test_missing_v_prefix(self):
        with pytest.raises(ValueError):
            dir_name_to_version("0.1.0")

    def test_bare_v(self):
        with pytest.raises(ValueError):
            dir_name_to_version("v")

    def test_non_string(self):
        with pytest.raises(ValueError):
            dir_name_to_version(None)  # type: ignore[arg-type]

    def test_whitespace_only(self):
        with pytest.raises(ValueError):
            dir_name_to_version("   ")

    def test_invalid_version_after_v(self):
        with pytest.raises(ValueError):
            dir_name_to_version("v1.2")


class TestRoundTrip:
    """version_to_dir_name then dir_name_to_version should be identity."""

    def test_round_trip_bare(self):
        v = "0.1.0"
        assert dir_name_to_version(version_to_dir_name(v)) == v

    def test_round_trip_pre_release(self):
        v = "1.0.0-alpha.1"
        assert dir_name_to_version(version_to_dir_name(v)) == v


# ── is_version_dir_name ─────────────────────────────────────────────────────


class TestIsVersionDirName:
    def test_valid_version_dir(self):
        assert is_version_dir_name("v0.1.0") is True

    def test_valid_with_pre_release(self):
        assert is_version_dir_name("v2.0.0-rc.1") is True

    def test_skill_md(self):
        assert is_version_dir_name("SKILL.md") is False

    def test_references_dir(self):
        assert is_version_dir_name("references") is False

    def test_assets_dir(self):
        assert is_version_dir_name("assets") is False

    def test_regular_file(self):
        assert is_version_dir_name("README.md") is False

    def test_bare_v(self):
        assert is_version_dir_name("v") is False

    def test_v_missing_patch(self):
        assert is_version_dir_name("v1.2") is False

    def test_no_v_prefix_valid_semver(self):
        # "0.1.0" is a valid semver but not a version directory name
        assert is_version_dir_name("0.1.0") is False

    def test_empty_string(self):
        assert is_version_dir_name("") is False

    def test_non_string(self):
        assert is_version_dir_name(None) is False  # type: ignore[arg-type]

    def test_v_four_segment(self):
        assert is_version_dir_name("v1.2.3.4") is False


# ── compare_versions ────────────────────────────────────────────────────────


class TestCompareVersions:
    def test_equal(self):
        assert compare_versions("1.0.0", "1.0.0") == 0

    def test_greater_major(self):
        assert compare_versions("2.0.0", "1.0.0") == 1

    def test_lesser_major(self):
        assert compare_versions("1.0.0", "2.0.0") == -1

    def test_greater_minor(self):
        assert compare_versions("1.2.0", "1.1.0") == 1

    def test_greater_patch(self):
        assert compare_versions("1.0.2", "1.0.1") == 1

    def test_pre_release_less_than_release(self):
        # 1.0.0-rc1 < 1.0.0
        assert compare_versions("1.0.0-rc1", "1.0.0") == -1

    def test_release_greater_than_pre_release(self):
        assert compare_versions("1.0.0", "1.0.0-rc1") == 1

    def test_symmetric(self):
        # compare_versions(a, b) == -compare_versions(b, a) for unequal
        a, b = "1.0.0", "2.0.0"
        assert compare_versions(a, b) == -compare_versions(b, a)

    def test_symmetric_pre_release(self):
        a, b = "1.0.0-rc1", "1.0.0"
        assert compare_versions(a, b) == -compare_versions(b, a)

    def test_invalid_input_raises(self):
        with pytest.raises(ValueError):
            compare_versions("1.2", "1.2.3")

    def test_both_invalid_raises_on_first(self):
        with pytest.raises(ValueError):
            compare_versions("1.2", "abc")


# ── sort_versions ───────────────────────────────────────────────────────────


class TestSortVersions:
    def test_sorts_ascending(self):
        versions = ["1.0.1", "1.0.0", "2.0.0", "1.1.0"]
        result = sort_versions(versions)
        assert result == ["1.0.0", "1.0.1", "1.1.0", "2.0.0"]

    def test_pre_release_before_release(self):
        versions = ["1.0.0", "1.0.0-rc1", "1.0.0-rc2"]
        result = sort_versions(versions)
        assert result == ["1.0.0-rc1", "1.0.0-rc2", "1.0.0"]

    def test_empty_list(self):
        assert sort_versions([]) == []

    def test_single_element(self):
        assert sort_versions(["1.0.0"]) == ["1.0.0"]

    def test_already_sorted(self):
        versions = ["0.1.0", "0.2.0", "1.0.0"]
        assert sort_versions(versions) == versions

    def test_reverse_order(self):
        versions = ["3.0.0", "2.0.0", "1.0.0"]
        assert sort_versions(versions) == ["1.0.0", "2.0.0", "3.0.0"]

    def test_preserves_input_iterable(self):
        # Should work with any iterable, not just lists
        result = sort_versions(iter(["2.0.0", "1.0.0"]))
        assert result == ["1.0.0", "2.0.0"]

    def test_invalid_raises(self):
        with pytest.raises(ValueError):
            sort_versions(["1.0.0", "invalid"])


# ── select_current_version ──────────────────────────────────────────────────


class TestSelectCurrentVersion:
    def test_returns_highest(self):
        versions = ["1.0.1", "1.0.0", "2.0.0", "1.1.0"]
        assert select_current_version(versions) == "2.0.0"

    def test_pre_release_beats_nothing(self):
        # When only pre-release versions exist, the highest pre-release wins
        versions = ["1.0.0-rc1", "1.0.0-rc2"]
        assert select_current_version(versions) == "1.0.0-rc2"

    def test_release_beats_pre_release(self):
        # 1.0.0 > 1.0.0-rc2
        versions = ["1.0.0-rc1", "1.0.0-rc2", "1.0.0"]
        assert select_current_version(versions) == "1.0.0"

    def test_empty_returns_none(self):
        assert select_current_version([]) is None

    def test_single_element(self):
        assert select_current_version(["0.1.0"]) == "0.1.0"

    def test_invalid_raises(self):
        with pytest.raises(ValueError):
            select_current_version(["1.0.0", "oops"])


# ── bump_patch ──────────────────────────────────────────────────────────────


class TestBumpPatch:
    def test_bump_simple(self):
        assert bump_patch("0.1.0") == "0.1.1"

    def test_bump_rolls_digit(self):
        assert bump_patch("1.2.9") == "1.2.10"

    def test_bump_large_patch(self):
        assert bump_patch("0.0.99") == "0.0.100"

    def test_bump_drops_pre_release(self):
        assert bump_patch("0.1.0-rc1") == "0.1.1"

    def test_bump_drops_complex_pre_release(self):
        assert bump_patch("2.0.0-alpha.3") == "2.0.1"

    def test_invalid_raises(self):
        with pytest.raises(ValueError):
            bump_patch("1.2")

    def test_v_prefix_accepted(self):
        assert bump_patch("v0.1.0") == "0.1.1"
