"""Tool-level permission adjudication (N14 §24.12 least privilege).

The §5.5 contract lets a capability package *declare* a minimal-purpose subset of
``{fs, net, exec, secrets}``; until now that was a declaration nothing enforced
(``skills/contract.py`` said so in as many words).  This module is the runtime
half: an AI node whose capability groups declare permissions only receives tools
that stay inside that declaration, and a tool that would reach outside is
**denied with a reason** rather than silently handed to the model.

Three deliberate properties, because this is a security-relevant restriction:

* **Opt-in, exactly like ``require_pass`` / ``extends``.**  A group that declares
  no permissions is not restricted — a package that never asked for least
  privilege must not silently lose its tools.
* **Fail-closed on an unknown requirement.**  Inside an opted-in group a tool
  whose requirement this module cannot state is denied, never assumed harmless;
  the denial names the tool and the knob (``tool-permissions``) that can declare
  it.  The alternative — treating "I don't know" as "fine" — is how a declaration
  stops being a boundary.
* **Declared, not inferred.**  The table below is the single source of truth for
  the known tool families; a per-tool ``tool-permissions`` override covers
  everything else (MCP servers, community tools, future providers).

The mapping is by tool name because that is what a capability group's
``allowed-tools`` lists; a caller that knows the provider can pass it to make the
match exact.
"""

from __future__ import annotations

from collections.abc import Iterable, Mapping
from dataclasses import dataclass

from deerflow.skills.contract import CAPABILITY_PERMISSIONS

#: Permission a tool needs, keyed by an exact tool name.
_EXACT_REQUIREMENTS: dict[str, frozenset[str]] = {
    # Sandbox filesystem + shell (``sandbox`` provider / built-in tool family).
    "bash": frozenset({"fs", "exec"}),
    "read_file": frozenset({"fs"}),
    "write_file": frozenset({"fs"}),
    "str_replace": frozenset({"fs"}),
    "ls": frozenset({"fs"}),
    "glob": frozenset({"fs"}),
    "grep": frozenset({"fs"}),
    # Local professional software (``app`` provider): runs host processes.
    "check_app_presence": frozenset({"fs"}),
}

#: Permission a tool needs, keyed by name prefix (covers a family).
_PREFIX_REQUIREMENTS: tuple[tuple[str, frozenset[str]], ...] = (
    # Remote content + browsing.
    ("web_", frozenset({"net"})),
    ("browser_", frozenset({"net"})),
    ("image_search", frozenset({"net"})),
    ("search_", frozenset({"net"})),
    ("fetch_", frozenset({"net"})),
    # Local application driving: host-side execution.
    ("app_", frozenset({"exec"})),
)

#: Tools that never need a permission: they describe the run instead of acting
#: on the world (``present_files`` ships a path to the user, ``view_image`` reads
#: an already-uploaded file's bytes back).
_PERMISSION_FREE: frozenset[str] = frozenset({"present_files", "view_image", "ask_clarification"})


@dataclass(frozen=True)
class PermissionDecision:
    """Whether one tool stays inside a group's declared permissions."""

    tool: str
    allowed: bool
    required: frozenset[str]
    missing: frozenset[str]
    #: False when the tool's requirement could not be stated at all.
    known: bool
    reason: str = ""


def required_permissions(tool_name: str, *, provider: str | None = None) -> frozenset[str] | None:
    """Permissions *tool_name* needs, or ``None`` when that cannot be stated.

    ``provider`` is accepted so a caller that knows where the tool comes from can
    be matched exactly; the table is name-based because ``allowed-tools`` names
    tools, not providers.
    """
    name = (tool_name or "").strip()
    if not name:
        return frozenset()
    if provider == "app" or name.startswith(("app_", "app:")):
        return frozenset({"exec"}) | _EXACT_REQUIREMENTS.get(name, frozenset())
    if name in _PERMISSION_FREE:
        return frozenset()
    exact = _EXACT_REQUIREMENTS.get(name)
    if exact is not None:
        return exact
    for prefix, requirements in _PREFIX_REQUIREMENTS:
        if name.startswith(prefix):
            return requirements
    return None


def adjudicate(
    declared: Iterable[str],
    tool_name: str,
    *,
    provider: str | None = None,
    overrides: Mapping[str, Iterable[str]] | None = None,
) -> PermissionDecision:
    """Decide whether *tool_name* is inside the *declared* permissions.

    An empty declaration allows everything (no enforcement — the package never
    asked for least privilege).  ``overrides`` maps a tool name to the
    permissions it needs, for tools the table does not know.
    """
    declared_set = {permission.strip().lower() for permission in declared if permission and permission.strip()}
    if not declared_set:
        return PermissionDecision(tool=tool_name, allowed=True, required=frozenset(), missing=frozenset(), known=True, reason="no permissions declared (unrestricted)")

    override = None
    if overrides is not None:
        raw = overrides.get(tool_name)
        if raw is not None:
            override = frozenset(permission for permission in raw if permission)
    required = override if override is not None else required_permissions(tool_name, provider=provider)

    if required is None:
        return PermissionDecision(
            tool=tool_name,
            allowed=False,
            required=frozenset(),
            missing=frozenset(),
            known=False,
            reason=f"tool '{tool_name}' has no known permission requirement and the declared permissions ({sorted(declared_set)}) cannot be checked against it; declare it in 'tool-permissions' or drop it from 'allowed-tools'",
        )
    missing = required - declared_set
    if missing:
        return PermissionDecision(
            tool=tool_name,
            allowed=False,
            required=required,
            missing=missing,
            known=True,
            reason=f"tool '{tool_name}' needs {sorted(required)} but the capability groups declare only {sorted(declared_set)} (missing: {sorted(missing)})",
        )
    return PermissionDecision(tool=tool_name, allowed=True, required=required, missing=frozenset(), known=True)


def adjudicate_tools(
    declared: Iterable[str],
    tool_names: Iterable[str],
    *,
    providers: Mapping[str, str] | None = None,
    overrides: Mapping[str, Iterable[str]] | None = None,
) -> tuple[list[str], list[PermissionDecision]]:
    """Split *tool_names* into the allowed ones and the denials.

    Order is preserved so a caller can keep the sorted, prompt-cache-stable
    tool order it already had.
    """
    declared_set = list(declared)
    allowed: list[str] = []
    denials: list[PermissionDecision] = []
    for name in tool_names:
        decision = adjudicate(declared_set, name, provider=(providers or {}).get(name), overrides=overrides)
        if decision.allowed:
            allowed.append(name)
        else:
            denials.append(decision)
    return allowed, denials


def summarize_denials(denials: Iterable[PermissionDecision]) -> str:
    """One-line reason per denial, for logs and node errors."""
    return "; ".join(decision.reason for decision in denials)


def unknown_declared_permissions(declared: Iterable[str]) -> list[str]:
    """Declared permissions outside the §5.5 vocabulary (`contract.CAPABILITY_PERMISSIONS`)."""
    return sorted({permission for permission in declared if permission and permission not in CAPABILITY_PERMISSIONS})


__all__ = [
    "PermissionDecision",
    "adjudicate",
    "adjudicate_tools",
    "required_permissions",
    "summarize_denials",
    "unknown_declared_permissions",
]
