"""Node-level context policy for AI workflow nodes — pure functions (N14 §24.3).

The three-layer assembler (``workflow/prompts.py``) decides *what text* builds an
AI node's prompt; this module decides *how much of it fits* and reports the
result.  §24.3 asks for a declarative, per-node way to control "load what, load
how much, in what order" so cost and quality stop being uncontrolled.

Two deliberate boundaries keep this honest and offline:

* **Token counts are estimates, not exact counts.**  ``estimate_tokens`` is the
  same CJK-aware character estimate the memory subsystem uses for
  ``memory.token_counting: char`` — deterministic, network-free, and never a
  BPE download.  It is a budget yardstick, not a billing figure.
* **Only the *augmentation* buckets are budgeted.**  ``examples`` (declarative
  few-shot) and ``context`` (retrieved/upstream values mounted by port name) are
  droppable.  The ``identity`` / ``capability`` / ``task`` / ``schema`` buckets
  are the node's instruction scaffold: truncating them would silently change
  what the node was asked to do, so an over-budget scaffold is *reported*
  (``over_budget``) and left intact rather than mangled.

The bucket order is fixed (``BUCKET_ORDER``) so the assembled prompt is stable
across runs — a moving prefix defeats provider prompt-cache reuse.
"""

from __future__ import annotations

from collections.abc import Mapping, Sequence
from dataclasses import dataclass, field
from typing import Any

#: Reserved result key the executor returns and the compiler lifts onto the
#: ``wf:<node_id>:__context_usage`` channel (declared when a node declares a
#: ``context_policy``).  Mirrors ``__workflow_token_usage`` / ``__schema_repairs``.
CONTEXT_USAGE_RESULT_KEY = "__context_usage"

#: Fixed prompt assembly order (N14 §24.3 "确定性排序").  ``examples``/``context``
#: slot between the task layer and the structured-output schema instruction.
BUCKET_ORDER: tuple[str, ...] = ("identity", "capability", "task", "examples", "context", "schema")

#: Buckets the budget may drop/truncate, in **priority order** (kept first).
#: ``examples`` outranks ``context``: a declared few-shot set is part of the
#: node's intended behaviour, whereas mounted context is bulk input.
TRUNCATABLE_BUCKETS: tuple[str, ...] = ("examples", "context")

#: The only accepted ``budget`` key today.  Per-bucket ceilings are a later
#: increment; accepting an unknown key silently would hide a typo.
_BUDGET_KEYS = frozenset({"total_tokens"})

_POLICY_KEYS = frozenset({"examples", "include", "budget"})

_TRUNCATION_MARKER = "\n... [truncated]"


class ContextPolicyError(ValueError):
    """A ``params.context_policy`` shape is malformed (compile-time surfaceable)."""


@dataclass(frozen=True)
class ContextPolicy:
    """A node's declarative context policy (normalized from ``params``)."""

    examples: tuple[str, ...] = ()
    include: tuple[str, ...] = ()
    budget: int | None = None

    @property
    def is_empty(self) -> bool:
        return not self.examples and not self.include and self.budget is None


@dataclass(frozen=True)
class ContextBudgetResult:
    """Outcome of applying a budget to the assembled buckets."""

    buckets: dict[str, str] = field(default_factory=dict)
    estimated: dict[str, int] = field(default_factory=dict)
    dropped: tuple[str, ...] = ()
    truncated: tuple[str, ...] = ()
    over_budget: bool = False
    budget: int | None = None

    @property
    def total_estimated(self) -> int:
        return sum(self.estimated.values())

    def to_payload(self) -> dict[str, Any]:
        """The JSON-safe shape lifted onto the ``__context_usage`` channel."""
        return {
            "budget": self.budget,
            "estimated_tokens": {name: self.estimated[name] for name in BUCKET_ORDER if name in self.estimated},
            "total_estimated": self.total_estimated,
            "dropped": list(self.dropped),
            "truncated": list(self.truncated),
            "over_budget": self.over_budget,
        }


def _is_cjk(ch: str) -> bool:
    """Whether *ch* is a CJK/fullwidth character (roughly: ~1 token per 2 chars)."""
    code = ord(ch)
    return (
        0x3000 <= code <= 0x303F  # CJK punctuation
        or 0x3040 <= code <= 0x30FF  # kana
        or 0x3400 <= code <= 0x4DBF  # CJK extension A
        or 0x4E00 <= code <= 0x9FFF  # CJK unified ideographs
        or 0xAC00 <= code <= 0xD7AF  # Hangul syllables
        or 0xF900 <= code <= 0xFAFF  # CJK compatibility ideographs
        or 0xFF00 <= code <= 0xFFEF  # fullwidth forms
    )


def estimate_tokens(text: str) -> int:
    """Deterministic, offline CJK-aware token *estimate* for *text*.

    Roughly 4 ASCII characters or 2 CJK characters per token, rounded up so any
    non-empty string costs at least one token.  Monotone in ``len(text)``, which
    is what ``_truncate_to_tokens``'s binary search relies on.  This is a budget
    yardstick, not an exact tokenizer count.
    """
    if not text:
        return 0
    cjk = sum(1 for ch in text if _is_cjk(ch))
    ascii_like = len(text) - cjk
    return (ascii_like + 3) // 4 + (cjk + 1) // 2


def _stringify(value: Any) -> str:
    return value if isinstance(value, str) else str(value)


def _render_example(item: Any) -> str:
    """Render one ``examples`` entry to text (deterministic; insertion order kept)."""
    if isinstance(item, str):
        return item
    if isinstance(item, Mapping):
        return "\n".join(f"{key}: {_stringify(value)}" for key, value in item.items())
    raise ContextPolicyError(f"context_policy.examples entries must be strings or objects, got {type(item).__name__}")


def parse_context_policy(params: Mapping[str, Any]) -> ContextPolicy | None:
    """Normalize ``params.context_policy`` into a :class:`ContextPolicy`.

    Returns ``None`` when the node declares no policy, so an untouched node
    behaves exactly as before.  Raises :class:`ContextPolicyError` on any
    malformed shape — the compiler turns that into a ``WorkflowCompileError``,
    and the executor into a node failure, so a bad policy never silently no-ops.
    """
    raw = params.get("context_policy")
    if raw is None:
        return None
    if not isinstance(raw, Mapping):
        raise ContextPolicyError("context_policy must be an object")
    unknown = set(raw) - _POLICY_KEYS
    if unknown:
        raise ContextPolicyError(f"context_policy has unknown keys {sorted(unknown)} (allowed: {sorted(_POLICY_KEYS)})")

    examples: list[str] = []
    raw_examples = raw.get("examples")
    if raw_examples is not None:
        if not isinstance(raw_examples, Sequence) or isinstance(raw_examples, (str, bytes)):
            raise ContextPolicyError("context_policy.examples must be a list")
        examples = [_render_example(item) for item in raw_examples]

    include: list[str] = []
    raw_include = raw.get("include")
    if raw_include is not None:
        if not isinstance(raw_include, Sequence) or isinstance(raw_include, (str, bytes)):
            raise ContextPolicyError("context_policy.include must be a list of input port names")
        for name in raw_include:
            if not isinstance(name, str) or not name:
                raise ContextPolicyError("context_policy.include entries must be non-empty strings")
            include.append(name)

    budget: int | None = None
    raw_budget = raw.get("budget")
    if raw_budget is not None:
        if not isinstance(raw_budget, Mapping):
            raise ContextPolicyError("context_policy.budget must be an object")
        unknown_budget = set(raw_budget) - _BUDGET_KEYS
        if unknown_budget:
            raise ContextPolicyError(f"context_policy.budget has unknown keys {sorted(unknown_budget)} (allowed: {sorted(_BUDGET_KEYS)})")
        total = raw_budget.get("total_tokens")
        if total is not None:
            if not isinstance(total, int) or isinstance(total, bool) or total <= 0:
                raise ContextPolicyError("context_policy.budget.total_tokens must be a positive integer")
            budget = total

    return ContextPolicy(examples=tuple(examples), include=tuple(include), budget=budget)


def _truncate_to_tokens(text: str, max_tokens: int) -> str:
    """Deterministically clip *text* so its estimate fits *max_tokens*.

    Keeps a head slice plus a visible marker; returns ``""`` when nothing
    meaningful survives (the caller then drops the bucket outright).
    """
    marker_cost = estimate_tokens(_TRUNCATION_MARKER)
    room = max_tokens - marker_cost
    if room <= 0:
        return ""
    if estimate_tokens(text) <= room:
        return text
    lo, hi = 0, len(text)
    while lo < hi:
        mid = (lo + hi + 1) // 2
        if estimate_tokens(text[:mid]) <= room:
            lo = mid
        else:
            hi = mid - 1
    if lo == 0:
        return ""
    return text[:lo] + _TRUNCATION_MARKER


def apply_context_budget(sections: Mapping[str, str], budget: int | None) -> ContextBudgetResult:
    """Apply *budget* to the assembled *sections* and return what is kept.

    Pure and deterministic.  The non-truncatable scaffold (``identity`` /
    ``capability`` / ``task`` / ``schema``) is always kept; the truncatable
    buckets are filled greedily in priority order (``examples`` before
    ``context``), so a tight budget drops context first.  A scaffold that alone
    exceeds the budget is reported via ``over_budget`` and left untouched.
    """
    ordered = {name: sections[name] for name in BUCKET_ORDER if sections.get(name)}
    estimated = {name: estimate_tokens(text) for name, text in ordered.items()}

    if budget is None:
        return ContextBudgetResult(buckets=dict(ordered), estimated=estimated, budget=None)

    scaffold_tokens = sum(estimated[name] for name in ordered if name not in TRUNCATABLE_BUCKETS)
    if scaffold_tokens > budget:
        # Never mangle the instruction: report and keep everything.
        return ContextBudgetResult(buckets=dict(ordered), estimated=estimated, over_budget=True, budget=budget)

    remaining = budget - scaffold_tokens
    kept: dict[str, str] = {name: text for name, text in ordered.items() if name not in TRUNCATABLE_BUCKETS}
    dropped: list[str] = []
    truncated: list[str] = []
    for name in TRUNCATABLE_BUCKETS:
        text = ordered.get(name)
        if not text:
            continue
        if estimated[name] <= remaining:
            kept[name] = text
            remaining -= estimated[name]
            continue
        clipped = _truncate_to_tokens(text, remaining)
        if clipped:
            kept[name] = clipped
            truncated.append(name)
            remaining = 0
        else:
            dropped.append(name)

    ordered_kept = {name: kept[name] for name in BUCKET_ORDER if name in kept}
    return ContextBudgetResult(
        buckets=ordered_kept,
        estimated={name: estimate_tokens(text) for name, text in ordered_kept.items()},
        dropped=tuple(dropped),
        truncated=tuple(truncated),
        over_budget=False,
        budget=budget,
    )
