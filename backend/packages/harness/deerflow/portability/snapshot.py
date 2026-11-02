"""Consistent SQLite snapshots for backup (N11b, I/O).

A backup must not copy a database file directly: with WAL enabled (the engine's
default) the live ``.db`` is not the whole story — recent commits sit in
``-wal`` — and a plain copy can capture a torn state.  SQLite's online backup
API solves both: it reads the source under the same isolation a client sees and
writes a single consistent destination file, safe to run while the Gateway is
serving.

Only SQLite has this story.  Postgres is exported with ``pg_dump`` by the
operator (see :mod:`deerflow.portability.select`), and a memory backend has no
file at all — so this module is deliberately SQLite-only.
"""

from __future__ import annotations

import hashlib
import sqlite3
from pathlib import Path

from deerflow.portability.archive import BackupFormatError

#: Bytes at the head of every SQLite database file.
_SQLITE_MAGIC = b"SQLite format 3\x00"


def is_sqlite_file(path: str | Path) -> bool:
    """Whether ``path`` starts with the SQLite file header (cheap, no open)."""
    file_path = Path(path)
    if not file_path.is_file():
        return False
    with open(file_path, "rb") as handle:
        return handle.read(len(_SQLITE_MAGIC)) == _SQLITE_MAGIC


def sha256_file(path: str | Path, *, chunk_size: int = 1 << 20) -> str:
    """Streamed SHA-256 of a file (never loads it whole into memory)."""
    digest = hashlib.sha256()
    with open(path, "rb") as handle:
        while True:
            chunk = handle.read(chunk_size)
            if not chunk:
                break
            digest.update(chunk)
    return digest.hexdigest()


def sqlite_sidecars(path: str | Path) -> list[Path]:
    """The files a SQLite database may own (``.db`` plus WAL/SHM), that exist."""
    base = Path(path)
    candidates = [base, Path(f"{base}-wal"), Path(f"{base}-shm")]
    return [candidate for candidate in candidates if candidate.exists()]


def snapshot_sqlite(src_path: str | Path, dest_path: str | Path) -> str:
    """Write a consistent copy of the SQLite database at ``src_path`` to ``dest_path``.

    Uses the online backup API against a **read-only** source connection, so a
    live, WAL-mode database is captured without blocking writers and without
    including uncommitted work.  Returns the destination's SHA-256.

    Raises :class:`BackupFormatError` when the source is missing or is not a
    SQLite database — a clear failure beats archiving a non-database file.
    """
    source = Path(src_path)
    if not is_sqlite_file(source):
        raise BackupFormatError(f"not a SQLite database: {source}")

    destination = Path(dest_path)
    destination.parent.mkdir(parents=True, exist_ok=True)

    src_conn = sqlite3.connect(f"file:{source.as_posix()}?mode=ro", uri=True)
    try:
        dest_conn = sqlite3.connect(str(destination))
        try:
            src_conn.backup(dest_conn)
            dest_conn.commit()
        finally:
            dest_conn.close()
    finally:
        src_conn.close()

    return sha256_file(destination)


__all__ = [
    "is_sqlite_file",
    "sha256_file",
    "sqlite_sidecars",
    "snapshot_sqlite",
]
