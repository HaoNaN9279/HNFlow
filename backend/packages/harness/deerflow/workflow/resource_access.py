"""Workflow resource access contracts (N13).

The compiler no longer accepts an author-supplied lock name.  Each executor
declares which external resources it reads or writes, and the compiler derives
the lock set from that declaration.  A declaration is deliberately a plain,
deterministic function of the node params and resolved input ports: inferring
arbitrary side effects from a shell command or an LLM turn is not possible, so
unknown executors simply declare nothing.

Only write access takes an exclusive lock.  Read-only nodes do not block other
nodes; this is write/write serialization, not a read/write snapshot protocol.
"""

from __future__ import annotations

import hashlib
import os
from collections.abc import Callable, Iterable
from dataclasses import dataclass
from typing import Any, Literal

ResourceMode = Literal["read", "write"]

#: Default wait for one node's automatic resource locks.  This was previously a
#: per-node author parameter; it is intentionally engine policy now.
RESOURCE_LOCK_TIMEOUT_SECONDS = 60.0


@dataclass(frozen=True)
class ResourceAccess:
    """One declared access to an external resource.

    ``key`` is the stable lock name (already restricted to
    :data:`~deerflow.locks.file_lock.LOCK_NAME_PATTERN`); ``label`` is the
    human-readable resource shown in a lock-timeout error.
    """

    key: str
    label: str
    mode: ResourceMode = "write"


#: Executor hook: ``(runtime, params, inputs) -> iterable of ResourceAccess``.
#: It must be pure and synchronous; it is called immediately before execution,
#: after breakpoint gates have completed.
ResourceAccessor = Callable[[Any, dict[str, Any], dict[str, Any]], Iterable[ResourceAccess]]


def _lock_key(kind: str, *parts: object) -> str:
    """Build a compact, filesystem-safe lock name for a resource identity."""
    digest = hashlib.sha256("\0".join(str(part) for part in parts).encode("utf-8")).hexdigest()
    return f"wf_{kind}_{digest[:32]}"


def _runtime_context(runtime: Any) -> dict[str, Any]:
    context = getattr(runtime, "context", None)
    return context if isinstance(context, dict) else {}


def _thread_scope(runtime: Any) -> tuple[str, str]:
    context = _runtime_context(runtime)
    user_id = str(context.get("user_id") or "default")
    thread_id = str(context.get("thread_id") or "default")
    return user_id, thread_id


def sandbox_write_access(runtime: Any) -> ResourceAccess:
    """Exclusive access to one thread's sandbox workspace.

    Sandbox paths are coarse on purpose.  ``tool:bash`` can touch any file in
    the workspace, so a per-file lock would not exclude it; the sandbox is the
    smallest honest shared resource until a hierarchical/RW lock exists.
    """
    user_id, thread_id = _thread_scope(runtime)
    return ResourceAccess(
        key=_lock_key("sandbox", user_id, thread_id),
        label=f"sandbox:{thread_id}",
        mode="write",
    )


def host_write_access(path: str | os.PathLike[str]) -> ResourceAccess:
    """Exclusive access to a normalized host path."""
    normalized = os.path.normcase(os.path.realpath(os.path.abspath(os.path.expanduser(os.path.expandvars(str(path))))))
    return ResourceAccess(
        key=_lock_key("host", normalized),
        label=f"host:{normalized}",
        mode="write",
    )


def app_write_access(name: str) -> ResourceAccess:
    """Exclusive access to one registered local application."""
    return ResourceAccess(
        key=_lock_key("app", name),
        label=f"app:{name}",
        mode="write",
    )


def knowledge_write_access(collection: str) -> ResourceAccess:
    """Exclusive access to one knowledge-store collection."""
    return ResourceAccess(
        key=_lock_key("knowledge", collection),
        label=f"knowledge:{collection}",
        mode="write",
    )


def write_locks(accesses: Iterable[ResourceAccess]) -> tuple[ResourceAccess, ...]:
    """Deduplicate the write accesses that participate in locking.

    Read access is intentionally excluded: it records intent for future
    read/write locking but never waits on a writer today.
    """
    unique: dict[str, ResourceAccess] = {}
    for access in accesses:
        if access.mode == "write":
            unique.setdefault(access.key, access)
    return tuple(unique.values())
