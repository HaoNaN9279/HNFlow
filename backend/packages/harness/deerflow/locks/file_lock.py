"""Cross-process reentrant file locks (N8, plan §19).

Local professional software runs on the *host* and is frequently single-instance
(GPU, license slot, project file).  Coordination therefore has to survive more
than one thread — it has to survive more than one *process*: two Gateway workers,
a CLI run next to the Gateway, a user's own tool holding the same project.

This module provides the one primitive the rest of the local-execution layer
reuses (application mutual exclusion, license groups, and the later
human/AI shared workspace):

- **Reentrant**: the same thread may acquire the same name again; the inner
  ``with`` does not touch the OS lock again.
- **Cross-process**: the outermost acquisition takes an OS-level exclusive
  lock on ``{base_dir}/locks/<name>.lock`` (``fcntl.flock`` on POSIX,
  ``msvcrt.locking`` on Windows).
- **Ordered**: :func:`acquire_many` sorts and de-duplicates names, so two call
  sites can never take the same set in opposite orders and deadlock.
- **Bounded**: an optional ``timeout`` turns contention into
  :class:`LockTimeoutError` instead of blocking forever.

It is deliberately *not* the skill-projection lock: that one is private to
``skills/projection.py`` and changing it would risk a skill-projection
regression.  The two share semantics, pinned by tests.
"""

from __future__ import annotations

import errno
import logging
import os
import re
import threading
import time
from collections.abc import Iterable, Iterator
from contextlib import ExitStack, contextmanager
from pathlib import Path
from typing import IO

logger = logging.getLogger(__name__)

try:  # POSIX
    import fcntl
except ImportError:  # pragma: no cover - Windows
    fcntl = None  # type: ignore[assignment]
    import msvcrt

#: Lock names are operands of a filesystem path, so the grammar is deliberately
#: narrow: no separators, no dots-only, no traversal.
LOCK_NAME_PATTERN = re.compile(r"^[A-Za-z0-9_][A-Za-z0-9_.-]{0,63}$")

_DEFAULT_TIMEOUT_SECONDS = 60.0
_POLL_INTERVAL_SECONDS = 0.02


class LockError(RuntimeError):
    """Base error for the file-lock layer."""


class LockNameError(LockError, ValueError):
    """Raised when a lock name cannot be turned into a safe file name."""


class LockTimeoutError(LockError):
    """Raised when a lock could not be acquired before its deadline."""


class _LockState:
    """Per-name in-process state: one RLock, a depth counter, and the OS handle."""

    __slots__ = ("rlock", "depth", "handle")

    rlock: threading.RLock
    depth: int
    handle: IO[str] | None

    def __init__(self) -> None:
        self.rlock = threading.RLock()
        self.depth = 0
        self.handle = None


_states_guard = threading.Lock()
_states: dict[str, _LockState] = {}


def _validate_name(name: str) -> str:
    if not isinstance(name, str) or not LOCK_NAME_PATTERN.match(name):
        raise LockNameError(f"invalid lock name {name!r}; expected {LOCK_NAME_PATTERN.pattern!r}")
    return name


def _lock_dir(base_dir: str | Path | None) -> Path:
    if base_dir is None:
        from deerflow.config.paths import get_paths

        return get_paths().base_dir / "locks"
    return Path(base_dir) / "locks"


def _lock_path(name: str, base_dir: str | Path | None) -> Path:
    return _lock_dir(base_dir) / f"{name}.lock"


def _state_for(path: Path) -> _LockState:
    key = str(path)
    with _states_guard:
        state = _states.get(key)
        if state is None:
            state = _LockState()
            _states[key] = state
        return state


# ── OS-level locking ─────────────────────────────────────────────────────────


def _try_os_lock(handle) -> bool:
    """Attempt a non-blocking exclusive lock; ``False`` when already held."""
    if fcntl is not None:
        try:
            fcntl.flock(handle.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
        except OSError as exc:
            if exc.errno in (errno.EACCES, errno.EAGAIN):
                return False
            raise
        return True

    # Windows: msvcrt locks a byte range from the current position.
    handle.seek(0)
    try:
        msvcrt.locking(handle.fileno(), msvcrt.LK_NBLCK, 1)
    except OSError:
        return False
    return True


def _release_os_lock(handle) -> None:
    try:
        if fcntl is not None:
            fcntl.flock(handle.fileno(), fcntl.LOCK_UN)
        else:  # pragma: no cover - Windows
            handle.seek(0)
            msvcrt.locking(handle.fileno(), msvcrt.LK_UNLCK, 1)
    except OSError:  # pragma: no cover - defensive teardown
        logger.debug("file lock: OS unlock failed", exc_info=True)


def _open_lock_file(path: Path) -> IO[str]:
    path.parent.mkdir(parents=True, exist_ok=True)
    handle = path.open("a+", encoding="utf-8")
    if fcntl is None:  # pragma: no cover - Windows
        # msvcrt needs a byte to exist before the range can be locked.
        handle.seek(0, os.SEEK_END)
        if handle.tell() == 0:
            handle.write("\n")
            handle.flush()
    return handle


def _acquire_os_lock(path: Path, *, deadline: float | None) -> IO[str]:
    handle = _open_lock_file(path)
    try:
        while True:
            if _try_os_lock(handle):
                return handle
            if deadline is not None and time.monotonic() >= deadline:
                raise LockTimeoutError(f"timed out acquiring lock {path.stem!r} (held by another process)")
            time.sleep(_POLL_INTERVAL_SECONDS)
    except BaseException:
        handle.close()
        raise


# ── public API ───────────────────────────────────────────────────────────────


@contextmanager
def resource_lock(name: str, *, base_dir: str | Path | None = None, timeout: float | None = None) -> Iterator[None]:
    """Hold an exclusive, reentrant, cross-process lock called *name*.

    ``timeout`` bounds the wait (defaults to
    :data:`_DEFAULT_TIMEOUT_SECONDS`; ``None`` waits forever only when the
    caller passes it explicitly).
    """
    _validate_name(name)
    path = _lock_path(name, base_dir)
    state = _state_for(path)
    effective_timeout = _DEFAULT_TIMEOUT_SECONDS if timeout is None else timeout
    deadline = None if effective_timeout is None else time.monotonic() + max(0.0, float(effective_timeout))

    if not state.rlock.acquire(timeout=effective_timeout):
        raise LockTimeoutError(f"timed out acquiring lock {name!r} (held in this process)")
    try:
        if state.depth == 0:
            state.handle = _acquire_os_lock(path, deadline=deadline)
        state.depth += 1
        try:
            yield
        finally:
            state.depth -= 1
            if state.depth == 0:
                handle = state.handle
                state.handle = None
                if handle is not None:
                    _release_os_lock(handle)
                    handle.close()
    finally:
        state.rlock.release()


@contextmanager
def acquire_many(names: Iterable[str], *, base_dir: str | Path | None = None, timeout: float | None = None) -> Iterator[None]:
    """Hold several locks at once in a canonical (sorted) order.

    Sorting is the deadlock-avoidance contract: any two call sites that need an
    overlapping set acquire it in the same order, so neither can hold the first
    while waiting for the second.
    """
    ordered = sorted({_validate_name(name) for name in names})
    with ExitStack() as stack:
        for name in ordered:
            stack.enter_context(resource_lock(name, base_dir=base_dir, timeout=timeout))
        yield


def reset_file_locks_for_tests() -> None:
    """Drop the in-process lock table (tests only; never use with holders)."""
    with _states_guard:
        _states.clear()


__all__ = [
    "LOCK_NAME_PATTERN",
    "LockError",
    "LockNameError",
    "LockTimeoutError",
    "acquire_many",
    "reset_file_locks_for_tests",
    "resource_lock",
]
