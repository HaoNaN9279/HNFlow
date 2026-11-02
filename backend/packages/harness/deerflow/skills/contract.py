"""Capability-package contract vocabulary + validation (N14 §5.5).

§5.5 wants a capability package to *declare* a small contract — minimal
permissions, a tool-schema version, a tool-description token budget — and have
it checked.  The frontmatter parser (``skills.parser``) already reads and
normalizes these fields fail-soft; this module is the pure vocabulary and a
belated validation for a :class:`~deerflow.skills.types.Skill` built
programmatically (not through the parser).
"""

from __future__ import annotations

from deerflow.skills.types import Skill

#: The closed set of declared permissions a capability package may request.
#: Runtime adjudication lives in ``deerflow.skills.permission_policy`` (N14
#: §24.12): an AI node whose capability groups declare permissions only receives
#: tools that stay inside the declaration.
CAPABILITY_PERMISSIONS: frozenset[str] = frozenset({"fs", "net", "exec", "secrets"})


def validate_capability_contract(skill: Skill) -> list[str]:
    """Return human-readable problems with *skill*'s §5.5 contract (empty = OK).

    The parser already drops unknown permissions, a non-positive budget, and an
    empty schema version, so a parsed skill is normally clean; this catches a
    :class:`Skill` constructed directly (tests, programmatic installs).
    """
    problems: list[str] = []
    for permission in skill.permissions:
        if permission not in CAPABILITY_PERMISSIONS:
            problems.append(f"unknown permission {permission!r}; allowed: {sorted(CAPABILITY_PERMISSIONS)}")
    for tool_name, permissions in (skill.tool_permissions or {}).items():
        for permission in permissions:
            if permission not in CAPABILITY_PERMISSIONS:
                problems.append(f"unknown permission {permission!r} for tool {tool_name!r}; allowed: {sorted(CAPABILITY_PERMISSIONS)}")
    if skill.context_budget is not None and skill.context_budget <= 0:
        problems.append(f"context_budget must be positive, got {skill.context_budget}")
    if skill.tool_schema_version is not None and not skill.tool_schema_version.strip():
        problems.append("tool_schema_version must be a non-empty string when present")
    return problems
