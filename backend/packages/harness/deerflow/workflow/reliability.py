"""Workflow reliability primitives: idempotency keys + bounded node retry (N14 §24.7).

Local professional-software side effects are largely irreversible, so a failed
node must not be silently re-run unless doing so is safe.  This module owns the
two mechanics that make a retry both safe and observable:

- a **stable idempotency key** derived from ``(run, node)`` — deliberately *not*
  per attempt, because the whole point is that a retry presents the **same** key
  so an external system (an HTTP service, a script) can recognise the duplicate
  instead of applying it twice; and
- a **bounded retry policy** parsed from ``params.retry`` and applied by the
  compiler only to *idempotent* nodes (a non-idempotent node declaring a retry is
  a compile-time error — retrying it repeats the side effect).

Pure logic only: no I/O, no sleeping (the compiler owns the backoff).  The
classification reuses the N14 §24.9 stable failure taxonomy (``classify_failure``).
"""

from __future__ import annotations

from dataclasses import dataclass

from deerflow.workflow.failure_taxonomy import FAILURE_CODES, classify_failure
from deerflow.workflow.schema import NodeType

# ── Result / parameter vocabulary ────────────────────────────────────────────

#: Reserved result key carrying the number of *retries* a node performed.
RETRY_RESULT_KEY = "__retry"

#: Environment variable a retried ``tool:bash`` command receives so its script
#: can make a repeated invocation idempotent.
IDEMPOTENCY_ENV = "DEERFLOW_IDEMPOTENCY_KEY"

#: Request header a retried ``tool:http`` request carries.
IDEMPOTENCY_HEADER = "Idempotency-Key"

#: Executor param the compiler injects with the resolved idempotency key; read by
#: the tool executors and never part of the author-facing definition.
IDEMPOTENCY_PARAM = "__idempotency_key"

DEFAULT_MAX_ATTEMPTS = 3
MAX_MAX_ATTEMPTS = 10
DEFAULT_BACKOFF_SECONDS = 0.0
MAX_BACKOFF_SECONDS = 60.0

_ALLOWED_RETRY_KEYS = frozenset({"max_attempts", "backoff_seconds", "retry_on"})


class RetryPolicyError(ValueError):
    """Raised when ``params.retry`` is malformed (surfaced at compile time)."""


@dataclass(frozen=True)
class RetryPolicy:
    """A bounded retry policy parsed from ``params.retry``."""

    max_attempts: int = DEFAULT_MAX_ATTEMPTS
    backoff_seconds: float = DEFAULT_BACKOFF_SECONDS
    retry_on: frozenset[str] | None = None


# ── Parsing ──────────────────────────────────────────────────────────────────


def parse_retry_policy(params: dict | None) -> RetryPolicy | None:
    """Parse ``params.retry`` into a :class:`RetryPolicy`, or ``None`` when absent.

    Malformed shapes raise :class:`RetryPolicyError` so the compiler can turn
    them into a :class:`WorkflowCompileError` (fail loud at definition time).
    """
    raw = (params or {}).get("retry")
    if raw is None:
        return None
    if not isinstance(raw, dict):
        raise RetryPolicyError("params.retry must be an object")

    unknown = set(raw) - _ALLOWED_RETRY_KEYS
    if unknown:
        raise RetryPolicyError(f"params.retry has unknown keys {sorted(unknown)}; allowed: {sorted(_ALLOWED_RETRY_KEYS)}")

    max_attempts = raw.get("max_attempts", DEFAULT_MAX_ATTEMPTS)
    if isinstance(max_attempts, bool) or not isinstance(max_attempts, int):
        raise RetryPolicyError("params.retry.max_attempts must be an integer")
    if not 1 <= max_attempts <= MAX_MAX_ATTEMPTS:
        raise RetryPolicyError(f"params.retry.max_attempts must be between 1 and {MAX_MAX_ATTEMPTS}")

    backoff = raw.get("backoff_seconds", DEFAULT_BACKOFF_SECONDS)
    if isinstance(backoff, bool) or not isinstance(backoff, (int, float)):
        raise RetryPolicyError("params.retry.backoff_seconds must be a number")
    if not 0 <= float(backoff) <= MAX_BACKOFF_SECONDS:
        raise RetryPolicyError(f"params.retry.backoff_seconds must be between 0 and {MAX_BACKOFF_SECONDS}")

    retry_on = raw.get("retry_on")
    codes: frozenset[str] | None = None
    if retry_on is not None:
        if not isinstance(retry_on, (list, tuple)) or not retry_on:
            raise RetryPolicyError("params.retry.retry_on must be a non-empty list of failure codes")
        bad = [c for c in retry_on if not isinstance(c, str) or c not in FAILURE_CODES]
        if bad:
            raise RetryPolicyError(f"params.retry.retry_on has unknown failure codes {bad}; allowed: {sorted(FAILURE_CODES)}")
        codes = frozenset(str(c) for c in retry_on)

    return RetryPolicy(max_attempts=max_attempts, backoff_seconds=float(backoff), retry_on=codes)


def validate_idempotency_param(params: dict | None) -> None:
    """Validate ``params.idempotency`` shape (bool or non-empty string)."""
    raw = (params or {}).get("idempotency")
    if raw is None:
        return
    if isinstance(raw, bool):
        return
    if isinstance(raw, str):
        if raw.strip():
            return
        raise RetryPolicyError("params.idempotency must be a non-empty string (or true)")
    raise RetryPolicyError("params.idempotency must be a boolean or a non-empty string")


# ── Retry decision ───────────────────────────────────────────────────────────


def is_retryable_exception(exc: BaseException) -> bool:
    """Whether *exc* may be retried.

    Control-flow and cancellation signals are never retries: a LangGraph
    ``GraphInterrupt`` is a deliberate suspension (re-running would duplicate the
    human task) and ``asyncio.CancelledError`` / ``KeyboardInterrupt`` /
    ``SystemExit`` derive from ``BaseException``.  Only ordinary ``Exception``
    failures are eligible.
    """
    if not isinstance(exc, Exception):
        return False
    from langgraph.errors import GraphBubbleUp

    return not isinstance(exc, GraphBubbleUp)


def should_retry(
    policy: RetryPolicy,
    *,
    attempt: int,
    exc: BaseException,
    node_type: NodeType | None = None,
) -> bool:
    """Whether another attempt is warranted after *attempt* executions failed.

    ``attempt`` is 1-based (the number of attempts already made).  A policy with
    ``retry_on`` only retries failures whose N14 §24.9 code is in that set.
    """
    if attempt >= policy.max_attempts:
        return False
    if not is_retryable_exception(exc):
        return False
    if policy.retry_on is not None:
        return classify_failure(exc, node_type=node_type) in policy.retry_on
    return True


# ── Idempotency keys ─────────────────────────────────────────────────────────


def idempotency_key(run_id: str, node_id: str) -> str:
    """Stable ``(run, node)`` idempotency key — the same across every retry."""
    return f"{run_id or 'run'}:{node_id}"


def resolve_idempotency_key(params: dict | None, *, run_id: str, node_id: str) -> str | None:
    """Resolve the effective idempotency key for a node, or ``None``.

    ``params.idempotency`` is ``True`` (derive a stable key), a non-empty string
    (use it verbatim), ``False``/absent (no key).
    """
    raw = (params or {}).get("idempotency")
    if raw is None or raw is False:
        return None
    if raw is True:
        return idempotency_key(run_id, node_id)
    if isinstance(raw, str) and raw.strip():
        return raw
    return None
