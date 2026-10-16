"""Capability-package composition: ``extends`` / ``overlay`` (N14 §5.5).

§5.5 lists "组合机制（extends/overlay）" as part of the capability-package
system: a package should be able to build on another's declaration instead of
copy-pasting it.  This module is the resolution layer — it follows
``extends`` across a catalog and produces the package's **effective**
declaration.

Merge rules (deliberately small and predictable):

* ``allowed-tools`` — **union** of every base's list plus the package's own.
  An undeclared list inherits (nothing to add). A package that wants to
  *narrow* rather than extend declares ``overlay: true`` and its own list
  **replaces** the bases' — that is the whole point of the second knob, and it
  is why ``overlay`` without ``extends`` is rejected (it would silently do
  nothing).
* ``permissions`` / ``required-secrets`` / ``requirements`` — union (these are
  additive capability needs; a package cannot un-need what its base needs).
  ``tool_permissions`` (N14 §24.12) is unioned **per tool name** for the same
  reason: dropping either side would ship a narrower requirement than an author
  declared, which is what an enforcement gate must not do.
* ``tool-schema-version`` / ``context-budget`` — scalars: the package's own
  value wins, otherwise the last base that declared one.

Broken composition is **loud** (:class:`CompositionError`): an unknown base, a
self-extension, a cycle, or a depth overrun. Silently ignoring any of them
would ship a package with fewer tools than its author declared — the worst
possible failure mode for a capability boundary.
"""

from __future__ import annotations

from collections.abc import Iterable, Mapping
from dataclasses import dataclass, field
from typing import Any

#: Hard bound on the ``extends`` chain (a cycle is reported separately).
COMPOSITION_MAX_DEPTH = 16


class CompositionError(ValueError):
    """Raised for a package whose ``extends`` graph cannot be resolved."""


@dataclass(frozen=True)
class ResolvedDeclaration:
    """A capability group's effective declaration after following ``extends``."""

    allowed_tools: tuple[str, ...] | None = None
    permissions: tuple[str, ...] = ()
    #: Per-tool permission requirements (N14 §24.12), unioned per tool name.
    #: Excluded from ``__hash__`` for the same reason as ``Skill.tool_permissions``.
    tool_permissions: dict[str, tuple[str, ...]] = field(default_factory=dict, hash=False, compare=True)
    required_secrets: tuple[Any, ...] = ()
    requirements: tuple[Any, ...] = ()
    tool_schema_version: str | None = None
    context_budget: int | None = None
    #: Every package this declaration was built from, bases first, own name last.
    lineage: tuple[str, ...] = ()


def _name_of(skill: Any) -> str:
    return str(getattr(skill, "name", "") or "")


def _merges_allowed_tools(base: ResolvedDeclaration, own_tools: tuple[str, ...] | None, *, overlay: bool) -> tuple[str, ...] | None:
    if overlay:
        # ``overlay`` replaces: an undeclared list means "no tools", which is a
        # legal (if severe) narrowing and must not quietly fall back to the base.
        return None if own_tools is None else tuple(dict.fromkeys(own_tools))
    if own_tools is None:
        return base.allowed_tools
    if base.allowed_tools is None:
        return tuple(dict.fromkeys(own_tools))
    return tuple(dict.fromkeys((*base.allowed_tools, *own_tools)))


def _merge_tool_permissions(base: Mapping[str, tuple[str, ...]], own: Mapping[str, tuple[str, ...]]) -> dict[str, tuple[str, ...]]:
    """Per-tool union of ``tool-permissions`` across a composition chain.

    A base and a derived package may both describe a tool; the union is the only
    safe merge (dropping either side would ship a *narrower* requirement than an
    author declared, which is exactly what an enforcement gate must not do).
    """
    merged: dict[str, tuple[str, ...]] = {name: tuple(values) for name, values in (base or {}).items()}
    for name, values in (own or {}).items():
        merged[name] = _dedupe((*merged.get(name, ()), *tuple(values or ())))
    return merged


def _dedupe(items: Iterable[Any], key: Any = None) -> tuple[Any, ...]:
    out: list[Any] = []
    seen: set[Any] = set()
    for item in items:
        marker = key(item) if key is not None else item
        if marker in seen:
            continue
        seen.add(marker)
        out.append(item)
    return tuple(out)


def resolve_declaration(
    skill: Any,
    by_name: Mapping[str, Any],
) -> ResolvedDeclaration:
    """Resolve *skill*'s effective declaration by following ``extends``.

    Raises :class:`CompositionError` for a base that is not in *by_name*, a
    self-extension, a cycle, or a chain longer than
    :data:`COMPOSITION_MAX_DEPTH`.
    """
    return _resolve(_name_of(skill), by_name, stack=(), depth=0)


def _resolve(name: str, by_name: Mapping[str, Any], *, stack: tuple[str, ...], depth: int) -> ResolvedDeclaration:
    if depth > COMPOSITION_MAX_DEPTH:
        raise CompositionError(f"capability composition is deeper than {COMPOSITION_MAX_DEPTH}: {' -> '.join((*stack, name))}")
    if name in stack:
        raise CompositionError(f"capability composition cycle: {' -> '.join((*stack, name))}")

    skill = by_name.get(name)
    if skill is None:
        raise CompositionError(f"unknown capability group {name!r} (not in the catalog)")

    bases = tuple(getattr(skill, "extends", ()) or ())
    if name in bases:
        raise CompositionError(f"capability group {name!r} extends itself")

    merged = ResolvedDeclaration()
    lineage: list[str] = []
    for base_name in bases:
        base = _resolve(str(base_name), by_name, stack=(*stack, name), depth=depth + 1)
        lineage.extend(base.lineage)
        # Bases union their allowed-tools with each other; ``overlay`` only ever
        # replaces the *accumulated* base list with the package's own.
        if merged.allowed_tools is None:
            merged_allowed = base.allowed_tools
        elif base.allowed_tools is None:
            merged_allowed = merged.allowed_tools
        else:
            merged_allowed = tuple(dict.fromkeys((*merged.allowed_tools, *base.allowed_tools)))
        merged = ResolvedDeclaration(
            allowed_tools=merged_allowed,
            permissions=_dedupe((*merged.permissions, *base.permissions)),
            tool_permissions=_merge_tool_permissions(merged.tool_permissions, getattr(base, "tool_permissions", {}) or {}),
            required_secrets=_dedupe((*merged.required_secrets, *base.required_secrets), key=lambda entry: getattr(entry, "name", entry)),
            requirements=_dedupe((*merged.requirements, *base.requirements), key=repr),
            # Later bases win, and the package's own value wins over all of them.
            tool_schema_version=base.tool_schema_version or merged.tool_schema_version,
            context_budget=base.context_budget if base.context_budget is not None else merged.context_budget,
        )

    overlay = bool(getattr(skill, "overlay", False))
    lineage.append(name)
    return ResolvedDeclaration(
        allowed_tools=_merges_allowed_tools(merged, getattr(skill, "allowed_tools", None), overlay=overlay),
        permissions=_dedupe((*merged.permissions, *(getattr(skill, "permissions", ()) or ()))),
        tool_permissions=_merge_tool_permissions(merged.tool_permissions, getattr(skill, "tool_permissions", {}) or {}),
        required_secrets=_dedupe((*merged.required_secrets, *(getattr(skill, "required_secrets", ()) or ())), key=lambda entry: getattr(entry, "name", entry)),
        requirements=_dedupe((*merged.requirements, *(getattr(skill, "requirements", ()) or ())), key=lambda entry: repr(entry)),
        tool_schema_version=getattr(skill, "tool_schema_version", None) or merged.tool_schema_version,
        context_budget=getattr(skill, "context_budget", None) if getattr(skill, "context_budget", None) is not None else merged.context_budget,
        lineage=tuple(lineage),
    )


def resolve_allowed_tools(names: Iterable[str], by_name: Mapping[str, Any]) -> set[str] | None:
    """Union the effective ``allowed-tools`` of every named group.

    ``None`` means "legacy allow-all" and is returned only when **no** named
    group (nor any package it extends) declares allowed-tools — the same rule
    ``skills.tool_policy.allowed_tool_names_for_skills`` applies, so a group
    that inherits its tools through ``extends`` restricts exactly as if it had
    declared them itself.

    Raises :class:`CompositionError` when any group's composition is broken;
    callers that must not fail a run decide how to degrade.
    """
    declared = False
    allowed: set[str] = set()
    for name in names:
        skill = by_name.get(name)
        if skill is None:
            continue
        declaration = resolve_declaration(skill, by_name)
        if declaration.allowed_tools is None:
            continue
        declared = True
        allowed.update(declaration.allowed_tools)
    return allowed if declared else None


def resolve_group_closure(names: Iterable[str], by_name: Mapping[str, Any]) -> list[str]:
    """Every group reachable from *names* via ``extends`` (own names included).

    Order-stable and deduplicated; unresolvable bases are skipped (the caller
    is resolving an authoring-time reference, and a not-yet-installed base must
    not make the closure read fail). Use :func:`validate_composition` when the
    goal is to *report* broken composition instead.
    """
    out: list[str] = []
    seen: set[str] = set()
    frontier = [str(name) for name in names]
    while frontier:
        name = frontier.pop(0)
        if name in seen:
            continue
        seen.add(name)
        out.append(name)
        skill = by_name.get(name)
        if skill is None:
            continue
        frontier.extend(str(base) for base in (getattr(skill, "extends", ()) or ()))
    return out


def validate_composition(skills: Iterable[Any]) -> list[str]:
    """Report composition problems for a catalog (empty list = clean).

    A pure checker for tooling/CI: it never raises, so a caller can show every
    problem at once.  ``overlay`` without ``extends`` is reported here rather
    than at resolution time because it is a *declaration* mistake that both the
    parser and the resolver would otherwise see as a no-op.
    """
    by_name = {_name_of(skill): skill for skill in skills if _name_of(skill)}
    problems: list[str] = []
    for name, skill in by_name.items():
        if getattr(skill, "overlay", False) and not (getattr(skill, "extends", ()) or ()):
            problems.append(f"{name}: overlay requires extends (overlay alone does nothing)")
        unknown = [str(base) for base in (getattr(skill, "extends", ()) or ()) if str(base) not in by_name]
        for base in unknown:
            problems.append(f"{name}: extends unknown capability group {base!r}")
        if unknown:
            # The chain cannot be walked, so a cycle/depth report would be noise
            # on top of the missing base the caller has to fix first.
            continue
        try:
            resolve_declaration(skill, by_name)
        except CompositionError as exc:
            problems.append(f"{name}: {exc}")
    return problems


__all__ = [
    "COMPOSITION_MAX_DEPTH",
    "CompositionError",
    "ResolvedDeclaration",
    "resolve_allowed_tools",
    "resolve_declaration",
    "resolve_group_closure",
    "validate_composition",
]
