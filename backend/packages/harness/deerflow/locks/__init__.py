"""Host-side coordination primitives (N8): cross-process file locks."""

from deerflow.locks.file_lock import (
    LOCK_NAME_PATTERN,
    LockError,
    LockNameError,
    LockTimeoutError,
    acquire_many,
    resource_lock,
)

__all__ = [
    "LOCK_NAME_PATTERN",
    "LockError",
    "LockNameError",
    "LockTimeoutError",
    "acquire_many",
    "resource_lock",
]
