"""Workflow idempotency primitives (N14 §24.7).

Local professional-software side effects are largely irreversible, so external
systems need a stable key to recognise a repeated invocation.  The engine owns
that key: the compiler injects it for every node, and it is never an
author-facing parameter.

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


# ── Idempotency keys ─────────────────────────────────────────────────────────


def idempotency_key(run_id: str, node_id: str) -> str:
    """Stable ``(run, node)`` idempotency key."""
    return f"{run_id or 'run'}:{node_id}"
