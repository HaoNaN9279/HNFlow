"""Workflow idempotency primitives (N14 §24.7).

Local professional-software side effects are largely irreversible, so external
systems need a stable key to recognise a repeated invocation.  This module owns
that key contract; retry policy and execution remain outside the workflow engine.

Pure logic only: no I/O, no sleeping.
"""

from __future__ import annotations

# ── Result / parameter vocabulary ────────────────────────────────────────────

#: Environment variable a repeated ``tool:bash`` command receives so its script
#: can make the invocation idempotent.
IDEMPOTENCY_ENV = "DEERFLOW_IDEMPOTENCY_KEY"

#: Request header a repeated ``tool:http`` request carries.
IDEMPOTENCY_HEADER = "Idempotency-Key"

#: Executor param the compiler injects with the resolved idempotency key; read by
#: the tool executors and never part of the author-facing definition.
IDEMPOTENCY_PARAM = "__idempotency_key"


class IdempotencyParamError(ValueError):
    """Raised when ``params.idempotency`` is malformed (surfaced at compile time)."""


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
        raise IdempotencyParamError("params.idempotency must be a non-empty string (or true)")
    raise IdempotencyParamError("params.idempotency must be a boolean or a non-empty string")


# ── Idempotency keys ─────────────────────────────────────────────────────────


def idempotency_key(run_id: str, node_id: str) -> str:
    """Stable ``(run, node)`` idempotency key."""
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
