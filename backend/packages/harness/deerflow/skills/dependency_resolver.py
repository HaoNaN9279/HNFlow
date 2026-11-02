"""Pure-function dependency validation engine for T8 (capability-group deps).

Provides three public functions with no app-layer or IO dependencies:

- ``validate_dependency_versions`` — check whether one of a set of installed
  versions satisfies a semver range constraint.
- ``resolve_dependencies`` — validate a skill's declared ``dependencies``
  against a registry: existence, version-range, and cycle detection.
- ``build_skill_registry`` — build a ``{skill_id: Skill}`` lookup map.
"""

from __future__ import annotations

from deerflow.skills.types import Skill
from deerflow.skills.versions import compare_versions, parse_version

# ── Public API ────────────────────────────────────────────────────────────────


def validate_dependency_versions(version_range: str, installed_versions: list[str]) -> bool:
    """Return ``True`` when at least one installed version satisfies *version_range*.

    Supported range forms (fail-closed: invalid input returns ``False``):

    - Exact: ``"0.1.0"`` — that version must be present.
    - ``>=X.Y.Z`` — an installed version must be >= *X.Y.Z*.
    - ``^X.Y.Z`` (compatible, npm-style):

      * X > 0 → >= X.Y.Z, < (X+1).0.0
      * X = 0 → >= 0.Y.Z, < 0.(Y+1).0

    - ``~X.Y.Z`` (patch, npm-style) → >= X.Y.Z, < X.(Y+1).0

    Pre-release suffixes on the range are ignored when computing the
    ``^`` / ``~`` upper bound (only the MAJOR.MINOR.PATCH core is used).
    """
    if not version_range or not version_range.strip():
        return False

    vr = version_range.strip()

    try:
        if vr.startswith(">="):
            return _check_ge(vr[2:].strip(), installed_versions)
        if vr.startswith("^"):
            return _check_caret(vr[1:].strip(), installed_versions)
        if vr.startswith("~"):
            return _check_tilde(vr[1:].strip(), installed_versions)
        # Exact
        return _check_exact(vr, installed_versions)
    except ValueError:
        return False


def resolve_dependencies(skill: Skill, registry: dict[str, Skill]) -> list[str]:
    """Validate all dependencies declared by *skill* against *registry*.

    Returns a (possibly empty) list of error strings.  An empty list means
    all checks pass — every dependency exists, every version constraint is
    satisfied, and there are no dependency cycles reachable from *skill*.

    Error format:

    - ``"dependency {guid}@[{version}] not found in registry"``
    - ``"dependency {guid}@[{version}] unsatisfied: installed {version}"``
    - ``"dependency cycle: A -> B -> A"``
    """
    errors: list[str] = []

    deps = skill.dependencies
    if not deps:
        return errors

    for dep in deps:
        target = registry.get(dep.guid)
        if target is None:
            errors.append(f"dependency {dep.guid}@[{dep.version}] not found in registry")
            continue

        if not validate_dependency_versions(dep.version, [target.version]):
            errors.append(f"dependency {dep.guid}@[{dep.version}] unsatisfied: installed {target.version}")

    errors.extend(_detect_cycles(skill, registry))
    return errors


def build_skill_registry(skills: list[Skill]) -> dict[str, Skill]:
    """Build a ``{skill_id: Skill}`` lookup from *skills*.

    Skills without a ``skill_id`` are silently excluded (they cannot be
    depended upon).
    """
    return {s.skill_id: s for s in skills if s.skill_id}


# ── Range helpers ─────────────────────────────────────────────────────────────


def _check_exact(version: str, installed: list[str]) -> bool:
    parsed = parse_version(version)
    for iv in installed:
        if compare_versions(parse_version(iv), parsed) == 0:
            return True
    return False


def _check_ge(min_version: str, installed: list[str]) -> bool:
    parsed_min = parse_version(min_version)
    for iv in installed:
        if compare_versions(parse_version(iv), parsed_min) >= 0:
            return True
    return False


def _check_caret(min_version: str, installed: list[str]) -> bool:
    """``^X.Y.Z``: >= min, < next major (or next minor when X=0)."""
    parsed_min = parse_version(min_version)
    upper = _caret_upper(parsed_min)
    return _check_bounded(parsed_min, upper, installed)


def _check_tilde(min_version: str, installed: list[str]) -> bool:
    """``~X.Y.Z``: >= min, < X.(Y+1).0."""
    parsed_min = parse_version(min_version)
    core = parsed_min.split("-", 1)[0]
    major, minor, _patch = core.split(".")
    upper = f"{major}.{int(minor) + 1}.0"
    return _check_bounded(parsed_min, upper, installed)


def _check_bounded(lower: str, upper: str, installed: list[str]) -> bool:
    for iv in installed:
        piv = parse_version(iv)
        if compare_versions(piv, lower) >= 0 and compare_versions(piv, upper) < 0:
            return True
    return False


def _caret_upper(parsed_min: str) -> str:
    """Compute exclusive upper bound for a ``^`` range.

    X > 0 → (X+1).0.0; X = 0 → 0.(Y+1).0.
    """
    core = parsed_min.split("-", 1)[0]
    major, minor, _patch = core.split(".")
    if int(major) > 0:
        return f"{int(major) + 1}.0.0"
    return f"0.{int(minor) + 1}.0"


# ── Cycle detection ───────────────────────────────────────────────────────────


def _detect_cycles(skill: Skill, registry: dict[str, Skill]) -> list[str]:
    """DFS from *skill* through *registry*, recording complete cycle paths."""
    errors: list[str] = []
    completed: set[str] = set()
    path: list[str] = []

    if not skill.skill_id:
        return errors

    def dfs(current_id: str) -> None:
        if current_id in completed:
            return
        if current_id in path:
            cycle_start = path.index(current_id)
            cycle = " -> ".join(path[cycle_start:] + [current_id])
            errors.append(f"dependency cycle: {cycle}")
            return

        s = registry.get(current_id)
        if s is None or not s.dependencies:
            completed.add(current_id)
            return

        path.append(current_id)
        for dep in s.dependencies:
            if dep.guid in registry:
                dfs(dep.guid)
        path.pop()
        completed.add(current_id)

    dfs(skill.skill_id)
    return errors
