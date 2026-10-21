"""Async bridge for the automatic workflow resource locks (N13).

The underlying lock is a reentrant, cross-process file lock whose in-process
reentrancy is a ``threading.RLock``: acquire and release must happen on the same
thread, and a blocking acquire must not run on the event loop.  A dedicated
holder thread therefore owns the lock for the whole node execution; the event
loop only waits for a handshake event.
"""

from __future__ import annotations

import asyncio
import threading
from collections.abc import AsyncIterator, Iterable
from contextlib import asynccontextmanager

from deerflow.locks.file_lock import LockError, acquire_many, resource_lock
from deerflow.workflow.resource_access import (
    RESOURCE_LOCK_TIMEOUT_SECONDS,
    ResourceAccess,
    write_locks,
)


class ResourceLockError(RuntimeError):
    """A node's automatic resource lock could not be acquired."""


@asynccontextmanager
async def hold_resource_locks(
    accesses: Iterable[ResourceAccess],
    *,
    timeout: float | None = None,
) -> AsyncIterator[None]:
    """Hold the exclusive locks for *accesses* for the duration of the block.

    Read-only accesses are ignored.  Multiple write resources are acquired in
    sorted order by :func:`acquire_many`, so overlapping lock sets cannot
    deadlock.  The locks are released on success, failure, and cancellation.
    """
    locks = write_locks(accesses)
    if not locks:
        yield
        return

    labels = {access.key: access.label for access in locks}
    names = tuple(sorted(labels))
    effective_timeout = RESOURCE_LOCK_TIMEOUT_SECONDS if timeout is None else timeout

    acquired = threading.Event()
    release = threading.Event()
    errors: list[BaseException] = []

    def _holder() -> None:
        try:
            holder = resource_lock(names[0], timeout=effective_timeout) if len(names) == 1 else acquire_many(names, timeout=effective_timeout)
            with holder:
                acquired.set()
                release.wait()
        except BaseException as exc:  # noqa: BLE001 - surfaced to the awaiting node
            errors.append(exc)
            acquired.set()

    holder_thread = threading.Thread(
        target=_holder,
        name=f"wf-resource-lock-{names[0]}",
        daemon=True,
    )
    holder_thread.start()
    try:
        await asyncio.to_thread(acquired.wait)
        if errors:
            failure = errors[0]
            if isinstance(failure, LockError):
                raise ResourceLockError(f"resource lock(s) {list(labels.values())} unavailable: {failure}") from failure
            raise ResourceLockError(f"resource lock(s) {list(labels.values())} failed: {failure}") from failure
        yield
    finally:
        # Release the holder's ``with`` block even when the caller is cancelled
        # while waiting.  The daemon thread exits on its own; joining it while
        # it is still trying to acquire would block the event loop again.
        release.set()
