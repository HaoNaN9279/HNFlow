"""Run-level budget enforcement (N14 §24.10).

§24.10 wants budgets at node / run / workflow levels with an over-budget policy.
The node level is already covered by §24.5 autonomy (``params.autonomy.budgets``
→ a ``TokenBudgetConfig`` cap on the sub-agent); this module adds the **run /
workflow** level: a workflow definition declares
``metadata.budget = {max_total_tokens, on_exceed}`` and the compiler aggregates
every node's reserved ``wf:<node>:__token_usage`` channel after each node to
enforce it.

Pure decision logic + a small state aggregator; the compiler owns placement.
``on_exceed`` is ``warn`` (log + continue) or ``abort`` (fail the node so the
run stops with an actionable error).  There is deliberately no ``degrade``: the
tokens are already spent, so "degrading" cannot un-spend them — only the next
step can be curtailed, and that is what ``abort`` does.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any

ON_EXCEED_WARN = "warn"
ON_EXCEED_ABORT = "abort"

_ON_EXCEED_VALUES = frozenset({ON_EXCEED_WARN, ON_EXCEED_ABORT})
_ALLOWED_KEYS = frozenset({"max_total_tokens", "on_exceed"})

#: Reserved per-node usage channel suffix (see ``workflow/executors/ai.py``).
USAGE_CHANNEL_SUFFIX = ":__token_usage"

_USAGE_FIELDS = ("input_tokens", "output_tokens", "total_tokens", "cache_read_tokens")


class BudgetError(ValueError):
    """Raised for a malformed ``metadata.budget`` (surfaced at compile time)."""


@dataclass(frozen=True)
class RunBudget:
    max_total_tokens: int
    on_exceed: str = ON_EXCEED_WARN


@dataclass(frozen=True)
class BudgetDecision:
    exceeded: bool
    observed: int
    limit: int
    action: str


def parse_run_budget(metadata: dict[str, Any] | None) -> RunBudget | None:
    """Parse ``metadata.budget`` into a :class:`RunBudget`, or ``None`` when absent."""
    raw = (metadata or {}).get("budget")
    if raw is None:
        return None
    if not isinstance(raw, dict):
        raise BudgetError("metadata.budget must be an object")
    unknown = set(raw) - _ALLOWED_KEYS
    if unknown:
        raise BudgetError(f"metadata.budget has unknown keys {sorted(unknown)}; allowed: {sorted(_ALLOWED_KEYS)}")

    max_total = raw.get("max_total_tokens")
    if isinstance(max_total, bool) or not isinstance(max_total, int) or max_total <= 0:
        raise BudgetError("metadata.budget.max_total_tokens must be a positive integer")

    on_exceed = raw.get("on_exceed", ON_EXCEED_WARN)
    if on_exceed not in _ON_EXCEED_VALUES:
        raise BudgetError(f"metadata.budget.on_exceed must be one of {sorted(_ON_EXCEED_VALUES)}, got {on_exceed!r}")

    return RunBudget(max_total_tokens=max_total, on_exceed=on_exceed)


def usage_total(usage: dict[str, Any] | None) -> int:
    """Total tokens of one node usage record (``total_tokens``, else input+output)."""
    if not isinstance(usage, dict):
        return 0

    def _int(key: str) -> int | None:
        try:
            return int(usage.get(key) or 0)
        except (TypeError, ValueError):
            return None

    if usage.get("total_tokens") is not None:
        total = _int("total_tokens")
        if total is not None:
            return total
    return (_int("input_tokens") or 0) + (_int("output_tokens") or 0)


def aggregate_token_usage(state: dict[str, Any]) -> dict[str, int]:
    """Sum every node's reserved ``wf:<node>:__token_usage`` channel in *state*."""
    totals = dict.fromkeys(_USAGE_FIELDS, 0)
    for key, value in state.items():
        if not isinstance(key, str) or not key.startswith("wf:") or not key.endswith(USAGE_CHANNEL_SUFFIX):
            continue
        if not isinstance(value, dict):
            continue
        for field in _USAGE_FIELDS:
            try:
                totals[field] += int(value.get(field) or 0)
            except (TypeError, ValueError):
                continue
    return totals


def evaluate_budget(observed_total: int, budget: RunBudget) -> BudgetDecision:
    """Decide whether *observed_total* exceeds *budget* and what to do."""
    exceeded = observed_total > budget.max_total_tokens
    return BudgetDecision(exceeded=exceeded, observed=observed_total, limit=budget.max_total_tokens, action=budget.on_exceed if exceeded else ON_EXCEED_WARN)
