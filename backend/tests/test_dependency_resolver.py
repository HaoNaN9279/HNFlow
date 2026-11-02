"""Tests for the dependency resolution engine (T8-3b)."""

from pathlib import Path

from deerflow.skills.dependency_resolver import (
    build_skill_registry,
    resolve_dependencies,
    validate_dependency_versions,
)
from deerflow.skills.types import DependencySpec, Skill, SkillCategory

# ── Helpers ───────────────────────────────────────────────────────────────────


def _skill(
    name: str,
    skill_id: str | None = None,
    version: str = "0.1.0",
    deps: tuple[DependencySpec, ...] | None = None,
) -> Skill:
    """Create a minimal Skill for dependency tests."""
    base = Path("/mnt/skills/public") / name
    return Skill(
        name=name,
        description=f"Description of {name}",
        license=None,
        skill_dir=base,
        skill_file=base / "SKILL.md",
        relative_path=Path(name),
        category=SkillCategory.PUBLIC,
        enabled=True,
        version=version,
        skill_id=skill_id,
        dependencies=deps,
    )


def _dep(guid: str, version: str) -> DependencySpec:
    return DependencySpec(guid=guid, version=version)


# ═══════════════════════════════════════════════════════════════════════════════
# build_skill_registry
# ═══════════════════════════════════════════════════════════════════════════════


def test_registry_includes_skills_with_id():
    s1 = _skill("alpha", skill_id="g1")
    s2 = _skill("beta", skill_id="g2")
    s3 = _skill("gamma", skill_id=None)
    reg = build_skill_registry([s1, s2, s3])
    assert reg == {"g1": s1, "g2": s2}


def test_registry_empty_list():
    assert build_skill_registry([]) == {}


def test_registry_skips_none_id():
    s = _skill("no-id", skill_id=None)
    assert build_skill_registry([s]) == {}


def test_registry_empty_string_id_not_included():
    """Empty string skill_id is falsy and should be excluded."""
    s = _skill("bad", skill_id="")
    reg = build_skill_registry([s])
    assert s.skill_id == ""  # precondition
    assert reg == {}


# ═══════════════════════════════════════════════════════════════════════════════
# validate_dependency_versions — exact
# ═══════════════════════════════════════════════════════════════════════════════


def test_exact_match_present():
    assert validate_dependency_versions("0.1.0", ["0.1.0"]) is True


def test_exact_match_absent():
    assert validate_dependency_versions("0.1.0", ["0.2.0"]) is False


def test_exact_match_multiple():
    assert validate_dependency_versions("0.1.0", ["0.3.0", "0.1.0", "0.2.0"]) is True


def test_exact_match_empty_installed():
    assert validate_dependency_versions("0.1.0", []) is False


# ═══════════════════════════════════════════════════════════════════════════════
# validate_dependency_versions — >=
# ═══════════════════════════════════════════════════════════════════════════════


def test_ge_satisfied():
    assert validate_dependency_versions(">=0.1.0", ["0.2.0"]) is True


def test_ge_satisfied_equal():
    assert validate_dependency_versions(">=0.1.0", ["0.1.0"]) is True


def test_ge_not_satisfied():
    assert validate_dependency_versions(">=0.2.0", ["0.1.0"]) is False


def test_ge_multiple():
    assert validate_dependency_versions(">=0.2.0", ["0.1.0", "0.3.0"]) is True


# ═══════════════════════════════════════════════════════════════════════════════
# validate_dependency_versions — ^ (caret)
# ═══════════════════════════════════════════════════════════════════════════════


def test_caret_x_gt_0_satisfied():
    """^1.2.0: >= 1.2.0 and < 2.0.0"""
    assert validate_dependency_versions("^1.2.0", ["1.2.0"]) is True
    assert validate_dependency_versions("^1.2.0", ["1.5.0"]) is True


def test_caret_x_gt_0_unsatisfied_below():
    assert validate_dependency_versions("^1.2.0", ["1.1.0"]) is False


def test_caret_x_gt_0_unsatisfied_above():
    """2.0.0 is not < 2.0.0"""
    assert validate_dependency_versions("^1.2.0", ["2.0.0"]) is False


def test_caret_x_eq_0_satisfied():
    """^0.1.0: >= 0.1.0 and < 0.2.0"""
    assert validate_dependency_versions("^0.1.0", ["0.1.5"]) is True
    assert validate_dependency_versions("^0.1.0", ["0.1.9"]) is True


def test_caret_x_eq_0_unsatisfied():
    assert validate_dependency_versions("^0.1.0", ["0.2.0"]) is False
    assert validate_dependency_versions("^0.1.0", ["0.0.9"]) is False


def test_caret_x_eq_0_boundary():
    """^0.1.0: 0.2.0 is at upper bound (exclusive), not allowed"""
    assert validate_dependency_versions("^0.1.0", ["0.2.0"]) is False


# ═══════════════════════════════════════════════════════════════════════════════
# validate_dependency_versions — ~ (tilde)
# ═══════════════════════════════════════════════════════════════════════════════


def test_tilde_satisfied():
    """~0.1.0: >= 0.1.0 and < 0.2.0"""
    assert validate_dependency_versions("~0.1.0", ["0.1.0"]) is True
    assert validate_dependency_versions("~0.1.0", ["0.1.5"]) is True


def test_tilde_unsatisfied():
    assert validate_dependency_versions("~0.1.0", ["0.2.0"]) is False
    assert validate_dependency_versions("~0.1.0", ["0.0.9"]) is False


def test_tilde_with_major():
    """~1.2.0: >= 1.2.0 and < 1.3.0"""
    assert validate_dependency_versions("~1.2.0", ["1.2.0"]) is True
    assert validate_dependency_versions("~1.2.0", ["1.2.9"]) is True
    assert validate_dependency_versions("~1.2.0", ["1.3.0"]) is False


# ═══════════════════════════════════════════════════════════════════════════════
# validate_dependency_versions — illegal / edge cases
# ═══════════════════════════════════════════════════════════════════════════════


def test_illegal_range_false():
    """Non-semver strings fail-closed."""
    assert validate_dependency_versions("not-a-version", ["0.1.0"]) is False


def test_empty_range_false():
    assert validate_dependency_versions("", ["0.1.0"]) is False


def test_whitespace_range_false():
    assert validate_dependency_versions("   ", ["0.1.0"]) is False


def test_none_installed():
    """Empty installed_versions should always fail."""
    assert validate_dependency_versions(">=0.1.0", []) is False


# ═══════════════════════════════════════════════════════════════════════════════
# resolve_dependencies — existence
# ═══════════════════════════════════════════════════════════════════════════════


def test_resolve_no_dependencies():
    s = _skill("no-deps", skill_id="g1")
    reg = build_skill_registry([s])
    assert resolve_dependencies(s, reg) == []


def test_resolve_missing_guid():
    s = _skill("consumer", skill_id="c1", deps=(_dep("missing-guid", ">=0.1.0"),))
    reg: dict[str, Skill] = {}
    errors = resolve_dependencies(s, reg)
    assert len(errors) == 1
    assert "not found in registry" in errors[0]
    assert "missing-guid" in errors[0]


def test_resolve_existing_guid_satisfied():
    dep_spec = _dep("g2", ">=0.1.0")
    provider = _skill("provider", skill_id="g2", version="0.2.0")
    consumer = _skill("consumer", skill_id="c1", deps=(dep_spec,))
    reg = build_skill_registry([consumer, provider])
    errors = resolve_dependencies(consumer, reg)
    assert errors == []


# ═══════════════════════════════════════════════════════════════════════════════
# resolve_dependencies — version unsatisfied
# ═══════════════════════════════════════════════════════════════════════════════


def test_resolve_version_unsatisfied():
    """>=0.2.0 requires 0.2.0+, but installed is 0.1.0."""
    dep_spec = _dep("g2", ">=0.2.0")
    provider = _skill("provider", skill_id="g2", version="0.1.0")
    consumer = _skill("consumer", skill_id="c1", deps=(dep_spec,))
    reg = build_skill_registry([consumer, provider])
    errors = resolve_dependencies(consumer, reg)
    assert len(errors) == 1
    assert "unsatisfied" in errors[0]
    assert "0.1.0" in errors[0]


# ═══════════════════════════════════════════════════════════════════════════════
# resolve_dependencies — cycle detection
# ═══════════════════════════════════════════════════════════════════════════════


def test_direct_cycle():
    """A → B → A"""
    a = _skill("a", skill_id="a", version="0.1.0", deps=(_dep("b", ">=0.1.0"),))
    b = _skill("b", skill_id="b", version="0.1.0", deps=(_dep("a", ">=0.1.0"),))
    reg = build_skill_registry([a, b])
    errors = resolve_dependencies(a, reg)
    cycle_errors = [e for e in errors if "dependency cycle" in e]
    assert len(cycle_errors) >= 1
    # Must include the full path: a -> b -> a
    assert any("a -> b -> a" in e for e in cycle_errors)


def test_indirect_cycle():
    """A → B → C → A"""
    a = _skill("a", skill_id="a", version="0.1.0", deps=(_dep("b", ">=0.1.0"),))
    b = _skill("b", skill_id="b", version="0.1.0", deps=(_dep("c", ">=0.1.0"),))
    c = _skill("c", skill_id="c", version="0.1.0", deps=(_dep("a", ">=0.1.0"),))
    reg = build_skill_registry([a, b, c])
    errors = resolve_dependencies(a, reg)
    cycle_errors = [e for e in errors if "dependency cycle" in e]
    assert len(cycle_errors) >= 1
    assert any("a -> b -> c -> a" in e for e in cycle_errors)


def test_no_cycle_with_transitive_deps():
    """A → B → C (no cycles, all satisfied)"""
    a = _skill("a", skill_id="a", version="0.1.0", deps=(_dep("b", ">=0.1.0"),))
    b = _skill("b", skill_id="b", version="0.2.0", deps=(_dep("c", ">=0.1.0"),))
    c = _skill("c", skill_id="c", version="0.1.0")
    reg = build_skill_registry([a, b, c])
    errors = resolve_dependencies(a, reg)
    assert errors == []


def test_self_cycle():
    """A depends on itself."""
    a = _skill("a", skill_id="a", version="0.1.0", deps=(_dep("a", ">=0.1.0"),))
    reg = build_skill_registry([a])
    errors = resolve_dependencies(a, reg)
    cycle_errors = [e for e in errors if "dependency cycle" in e]
    assert len(cycle_errors) >= 1
    assert any("a -> a" in e for e in cycle_errors)


# ═══════════════════════════════════════════════════════════════════════════════
# resolve_dependencies — combined errors
# ═══════════════════════════════════════════════════════════════════════════════


def test_resolve_missing_and_unsatisfied_together():
    """Both missing and unsatisfied deps should both be reported."""
    # dep g2 exists but version unsatisfied; dep g3 missing entirely
    consumer = _skill(
        "consumer",
        skill_id="c1",
        deps=(_dep("g2", ">=0.3.0"), _dep("g3", "0.1.0")),
    )
    provider_g2 = _skill("g2", skill_id="g2", version="0.1.0")
    reg = build_skill_registry([consumer, provider_g2])
    errors = resolve_dependencies(consumer, reg)
    assert len(errors) >= 2  # missing + unsatisfied; cycles also checked
    has_missing = any("not found" in e for e in errors)
    has_unsatisfied = any("unsatisfied" in e for e in errors)
    assert has_missing
    assert has_unsatisfied


def test_resolve_cycle_and_unsatisfied():
    """Cycle and unsatisfied version both reported."""
    a = _skill("a", skill_id="a", version="0.1.0", deps=(_dep("b", ">=0.2.0"),))
    b = _skill("b", skill_id="b", version="0.1.0", deps=(_dep("a", ">=0.1.0"),))
    reg = build_skill_registry([a, b])
    errors = resolve_dependencies(a, reg)
    # Should have both unsatisfied (b version <0.2.0) and cycle (a->b->a)
    has_unsatisfied = any("unsatisfied" in e for e in errors)
    has_cycle = any("dependency cycle" in e for e in errors)
    assert has_unsatisfied
    assert has_cycle
