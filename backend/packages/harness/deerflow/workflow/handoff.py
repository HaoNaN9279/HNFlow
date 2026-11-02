"""Controlled dynamic handoff — §24.6a's third collaboration primitive.

A supervisor that decides *at run time* which specialist should act next cannot
express that with static conditional edges alone: the set of experts is known
(the definition), but the pick is not.  This module is the pure decision layer
for that — a whitelist of `value → expert node` candidates plus a run budget —
so the judgement stays offline-testable and the compiler/executor only supply
state I/O (the same split as `scheduler/triggers.py::is_trigger_due`,
`apps/presence.py::decide_access`, `workflow/preview.py::make_preview`).

Two deliberate differences from `flow:switch`, which also routes on a value:

* **The whitelist names nodes, not ports.**  `params.candidates` is a list of
  `{value, node}` entries; each `node` must be a node id in the same definition
  ("registered experts").  The compiler creates the routing edges from that
  list, so there is exactly one source of truth for where a handoff can go.
* **An unlisted selection fails.**  A switch falls through to its default edge
  when nothing matches; a handoff raises, because silently running a branch the
  supervisor did not ask for is precisely the failure this primitive exists to
  prevent.  A "we are done" outcome belongs in a `flow:if` *before* the handoff
  — explicit composition rather than an implicit default target.

`params.max_handoffs` bounds how many times one handoff node may route within a
run.  The counter lives on the reserved channel
``wf:<node_id>:__handoffs`` (engine bookkeeping, never a declared port).
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any

#: Input port carrying the supervisor's selection.
DECISION_PORT = "decision"
#: Output port carrying the resolved expert node id (observability + reuse).
TARGET_PORT = "target"
#: Reserved state-channel suffix holding this node's handoff count.
HANDOFF_COUNT_CHANNEL = "__handoffs"

DEFAULT_MAX_HANDOFFS = 8
MAX_HANDOFFS_CEILING = 50


class HandoffError(ValueError):
    """Malformed handoff declaration or an invalid runtime selection."""


@dataclass(frozen=True)
class HandoffCandidate:
    """One whitelisted `value → node` route."""

    value: str
    node: str


@dataclass(frozen=True)
class HandoffSpec:
    """A parsed, validated handoff declaration."""

    candidates: tuple[HandoffCandidate, ...]
    max_handoffs: int

    def values(self) -> tuple[str, ...]:
        """Every accepted selection value, in declaration order."""
        return tuple(candidate.value for candidate in self.candidates)

    def targets(self) -> tuple[str, ...]:
        """Every distinct expert node, in declaration order (edge dedup)."""
        seen: list[str] = []
        for candidate in self.candidates:
            if candidate.node not in seen:
                seen.append(candidate.node)
        return tuple(seen)


def parse_handoff(params: dict[str, Any] | None) -> HandoffSpec:
    """Parse ``params.candidates`` / ``params.max_handoffs`` (fail-loud).

    Bad shapes raise :class:`HandoffError` rather than being coerced: a handoff
    whose whitelist silently lost an entry would route a supervisor's choice
    somewhere the author never listed, and one that lost the whole list would
    look like "no experts" instead of a broken definition.
    """
    raw = (params or {}).get("candidates")
    if not isinstance(raw, list) or not raw:
        raise HandoffError("handoff requires a non-empty 'candidates' list of {value, node} entries")

    candidates: list[HandoffCandidate] = []
    seen_values: set[str] = set()
    for index, entry in enumerate(raw):
        if not isinstance(entry, dict):
            raise HandoffError(f"handoff candidate {index} must be a mapping with 'value' and 'node'")
        value = entry.get("value")
        node = entry.get("node")
        if not isinstance(value, str) or not value:
            raise HandoffError(f"handoff candidate {index} needs a non-empty string 'value'")
        if not isinstance(node, str) or not node:
            raise HandoffError(f"handoff candidate {index} needs a non-empty string 'node'")
        if value in seen_values:
            raise HandoffError(f"handoff candidate value '{value}' is declared twice")
        seen_values.add(value)
        candidates.append(HandoffCandidate(value=value, node=node))

    max_handoffs = (params or {}).get("max_handoffs", DEFAULT_MAX_HANDOFFS)
    if isinstance(max_handoffs, bool) or not isinstance(max_handoffs, int):
        raise HandoffError(f"handoff 'max_handoffs' must be an integer (got {max_handoffs!r})")
    if not 1 <= max_handoffs <= MAX_HANDOFFS_CEILING:
        raise HandoffError(f"handoff 'max_handoffs' must be between 1 and {MAX_HANDOFFS_CEILING} (got {max_handoffs})")

    return HandoffSpec(candidates=tuple(candidates), max_handoffs=max_handoffs)


def resolve_handoff_target(spec: HandoffSpec, decision: Any) -> str:
    """Map a supervisor's selection onto its whitelisted expert node.

    Raises :class:`HandoffError` for an unknown or missing selection — the
    allowed values are named so the failure is actionable (both for the run log
    and for the model that picked).
    """
    allowed = ", ".join(repr(value) for value in spec.values())
    if not isinstance(decision, str) or not decision:
        raise HandoffError(f"handoff needs a non-empty string selection; allowed values: {allowed}")
    for candidate in spec.candidates:
        if candidate.value == decision:
            return candidate.node
    raise HandoffError(f"handoff selection {decision!r} is not a registered expert; allowed values: {allowed}")


def handoff_count_key(node_id: str) -> str:
    """State key of the reserved handoff counter for *node_id*."""
    return f"wf:{node_id}:{HANDOFF_COUNT_CHANNEL}"


__all__ = [
    "DECISION_PORT",
    "TARGET_PORT",
    "HANDOFF_COUNT_CHANNEL",
    "DEFAULT_MAX_HANDOFFS",
    "MAX_HANDOFFS_CEILING",
    "HandoffError",
    "HandoffCandidate",
    "HandoffSpec",
    "parse_handoff",
    "resolve_handoff_target",
    "handoff_count_key",
]
