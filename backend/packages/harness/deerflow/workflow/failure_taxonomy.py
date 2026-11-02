"""Stable failure taxonomy for workflow runs (N14 §24.9).

Python exception class names are not a stable aggregation key — a provider
rename or a wrapper layer changes them.  This module maps a failure to one of a
small, fixed set of codes so a node failure can be counted and alerted on
across runs.

The mapping is **best-effort and deterministic**: it never guesses, falling back
to ``unknown`` when nothing matches.  ``budget`` is reserved — a budget cap is
surfaced through ``stop_reason`` rather than raised, so it is not reachable from
a node failure today.
"""

from __future__ import annotations

import asyncio

from deerflow.workflow.schema import NodeType

#: The closed vocabulary of failure codes.
FAILURE_CODES: frozenset[str] = frozenset(
    {
        "timeout",
        "rate_limit",
        "model",
        "validation",
        "tool",
        "budget",
        "resource",
        "conflict",
        "config",
        "unknown",
    }
)

_TOOL_NODE_TYPES: frozenset[NodeType] = frozenset({NodeType.TOOL_BASH, NodeType.TOOL_HTTP})

_RATE_LIMIT_HINTS = ("ratelimit", "rate limit", "toomanyrequests", "429", "quota exceeded")
_RESOURCE_HINTS = ("resourceunavailable", "resource unavailable")


def classify_failure(exc: BaseException, *, node_type: NodeType | None = None) -> str:
    """Map *exc* to a stable :data:`FAILURE_CODES` value."""
    if isinstance(exc, (asyncio.TimeoutError, TimeoutError)):
        return "timeout"

    # Deferred imports: these modules pull in the compiler / registry, which
    # would form an import cycle if resolved at module scope here.
    from deerflow.locks.file_lock import LockError
    from deerflow.workflow.compiler import WorkflowCompileError
    from deerflow.workflow.conflict import WorkflowConflictError
    from deerflow.workflow.registry import WorkflowExecutionError
    from deerflow.workflow.structured_output import StructuredOutputError

    if isinstance(exc, WorkflowCompileError):
        return "config"
    if isinstance(exc, StructuredOutputError):
        return "validation"
    if isinstance(exc, WorkflowConflictError):
        return "conflict"
    if isinstance(exc, LockError):
        return "resource"

    name = type(exc).__name__.lower()
    text = str(exc).lower()
    if any(hint in name for hint in _RATE_LIMIT_HINTS) or any(hint in text for hint in _RATE_LIMIT_HINTS):
        return "rate_limit"
    if any(hint in name for hint in _RESOURCE_HINTS) or any(hint in text for hint in _RESOURCE_HINTS):
        return "resource"

    if isinstance(exc, WorkflowExecutionError):
        # A generic execution error from a tool node is the tool's failure;
        # elsewhere the code stays honest and unclassified.
        return "tool" if node_type in _TOOL_NODE_TYPES else "unknown"
    return "unknown"
