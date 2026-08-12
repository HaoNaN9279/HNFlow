"""Skill versioning — semver parse, compare, and directory-name helpers.

The T7 layout stores each version of a skill under a version directory::

    <root>/{public,custom}/<name>/v<semver>/SKILL.md
    <root>/{public,custom}/<name>/v<semver>/references/...
    <root>/{public,custom}/<name>/v<semver>/assets/...

This module provides the semver foundation layer: strict parsing, comparison
(via ``packaging.version.Version``), directory-name normalisation, and a
lightweight bump helper.  All functions are pure — no filesystem IO.

.. note::

    ``packaging.version.Version`` treats ``1.2.3.4`` as a legacy version.
    We enforce strict three-segment semver at parse time so the comparison
    layer never receives non-conforming strings.
"""

from __future__ import annotations

import re
from collections.abc import Iterable

from packaging.version import Version

# Strict semver: MAJOR.MINOR.PATCH with optional pre-release.
# Pre-release identifiers are alphanumeric + hyphen (dot-separated).
# The regex deliberately rejects four-segment "legacy" versions and
# trailing-hyphen-with-no-identifiers.
#
# Capture groups: (1) major.minor.patch, (2) full pre-release including '-'
_SEMVER_RE = re.compile(r"^(\d+\.\d+\.\d+)(-[0-9A-Za-z-]+(\.[0-9A-Za-z-]+)*)?$")


def parse_version(value: str) -> str:
    """Parse and normalise a semver string.

    Accepts an optional leading ``v`` or ``V`` prefix.  Returns the bare
    ``MAJOR.MINOR.PATCH[-PRERELEASE]`` form after validation.

    Raises :exc:`ValueError` when *value* is not a valid three-segment
    semver or when the pre-release suffix is empty (e.g. ``"1.2.3-"``).
    """
    if not isinstance(value, str) or not value.strip():
        raise ValueError(f"Version string must be non-empty, got {value!r}")

    stripped = value.strip()

    # Strip optional leading v/V
    if stripped and stripped[0] in ("v", "V"):
        stripped = stripped[1:]

    # Guard against the prefix-only case: "v" / "V" alone
    if not stripped:
        raise ValueError(f"Version string must be non-empty, got {value!r}")

    if not _SEMVER_RE.match(stripped):
        raise ValueError(f"Invalid semver: {value!r}. Expected MAJOR.MINOR.PATCH with optional pre-release (e.g. 1.2.3 or 1.2.3-rc.1). Four-segment and other non-conforming versions are rejected.")

    return stripped


def version_to_dir_name(version: str) -> str:
    """Convert a bare semver to its version directory name.

    ``"0.1.0"`` → ``"v0.1.0"``

    The *version* is parsed and validated first; invalid input raises
    :exc:`ValueError`.
    """
    parsed = parse_version(version)
    return f"v{parsed}"


def dir_name_to_version(dir_name: str) -> str:
    """Convert a version directory name back to a bare semver.

    ``"v0.1.0"`` → ``"0.1.0"``

    The directory name must start with ``"v"`` and contain a valid semver
    after the prefix.  Raises :exc:`ValueError` on invalid input.
    """
    if not isinstance(dir_name, str) or not dir_name.strip():
        raise ValueError(f"Directory name must be non-empty, got {dir_name!r}")

    stripped = dir_name.strip()
    if not stripped.startswith("v"):
        raise ValueError(f"Version directory must start with 'v', got {dir_name!r}")

    # Delegate to parse_version — it will strip the leading v and validate
    return parse_version(stripped)


def is_version_dir_name(name: str) -> bool:
    """Return ``True`` when *name* is a version directory name.

    A version directory name begins with ``"v"`` followed by a valid
    semver (e.g. ``"v0.1.0"``).  Plain file names like ``"SKILL.md"``,
    support directories (``"references"``, ``"assets"``), and the bare
    prefix ``"v"`` all return ``False``.

    This is used by ``_iter_skill_files`` to distinguish version directories
    from legacy-layout entries and non-version support files.
    """
    if not isinstance(name, str) or not name.startswith("v"):
        return False

    # "v" alone is not a version directory
    body = name[1:]
    if not body:
        return False

    return _SEMVER_RE.match(body) is not None


def compare_versions(a: str, b: str) -> int:
    """Compare two semver strings.

    Returns -1 when *a* < *b*, 0 when equal, 1 when *a* > *b*.

    Uses :class:`packaging.version.Version` for comparison, which
    correctly handles pre-release ordering (``"1.0.0-rc1" < "1.0.0"``).

    Both inputs are parsed and validated first; invalid input raises
    :exc:`ValueError`.
    """
    va = Version(parse_version(a))
    vb = Version(parse_version(b))

    if va < vb:
        return -1
    if va > vb:
        return 1
    return 0


def sort_versions(versions: Iterable[str]) -> list[str]:
    """Sort an iterable of semver strings in ascending order.

    Uses :class:`packaging.version.Version` under the hood so pre-release
    versions sort before their corresponding release.

    Every version is parsed and validated; invalid input raises
    :exc:`ValueError`.
    """
    return sorted(versions, key=lambda v: Version(parse_version(v)))


def select_current_version(versions: Iterable[str]) -> str | None:
    """Return the highest version from *versions*, or ``None`` when empty.

    Uses :func:`sort_versions` and takes the last (highest) element.

    This is the "current" selection logic used by T7-3: when multiple
    versions of a skill exist, the highest one is the active version.
    """
    sorted_versions = sort_versions(versions)
    if not sorted_versions:
        return None
    return sorted_versions[-1]


def bump_patch(version: str) -> str:
    """Increment the patch component of a semver.

    ``"0.1.0"`` → ``"0.1.1"``
    ``"1.2.9"`` → ``"1.2.10"``

    If the version carries a pre-release suffix it is dropped — only the
    ``MAJOR.MINOR.PATCH`` core is bumped::

        ``"0.1.0-rc1"`` → ``"0.1.1"``

    This is a simplified helper for creating the next patch revision of a
    skill.  Complex pre-release workflows (e.g. bumping ``-rc1`` → ``-rc2``)
    are out of scope — callers that need them should build on the parse /
    compare primitives above.

    Raises :exc:`ValueError` when *version* is not a valid semver.
    """
    parsed = parse_version(version)

    # Split off any pre-release suffix
    core = parsed.split("-", 1)[0]
    major, minor, patch = core.split(".")
    bumped = f"{major}.{minor}.{int(patch) + 1}"

    return bumped
