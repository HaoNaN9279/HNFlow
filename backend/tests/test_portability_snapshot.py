"""N11b S4 — consistent SQLite snapshots."""

from __future__ import annotations

import sqlite3
from pathlib import Path

import pytest

from deerflow.portability.archive import BackupFormatError
from deerflow.portability.snapshot import is_sqlite_file, sha256_file, snapshot_sqlite, sqlite_sidecars


def _make_db(path: Path, rows: list[tuple[int, str]]) -> None:
    conn = sqlite3.connect(str(path))
    try:
        conn.execute("CREATE TABLE t (id INTEGER PRIMARY KEY, name TEXT)")
        conn.executemany("INSERT INTO t (id, name) VALUES (?, ?)", rows)
        conn.commit()
    finally:
        conn.close()


class TestSnapshotSqlite:
    def test_snapshot_is_a_readable_copy(self, tmp_path: Path) -> None:
        src = tmp_path / "deerflow.db"
        _make_db(src, [(1, "a"), (2, "b")])
        dest = tmp_path / "out" / "snapshot.db"

        digest = snapshot_sqlite(src, dest)

        assert digest == sha256_file(dest)
        conn = sqlite3.connect(str(dest))
        try:
            rows = conn.execute("SELECT id, name FROM t ORDER BY id").fetchall()
        finally:
            conn.close()
        assert rows == [(1, "a"), (2, "b")]

    def test_snapshot_excludes_uncommitted_work(self, tmp_path: Path) -> None:
        src = tmp_path / "deerflow.db"
        _make_db(src, [(1, "committed")])

        writer = sqlite3.connect(str(src))
        try:
            writer.execute("INSERT INTO t (id, name) VALUES (2, 'uncommitted')")
            # no commit -- the snapshot must not see this row
            dest = tmp_path / "snapshot.db"
            snapshot_sqlite(src, dest)
        finally:
            writer.rollback()
            writer.close()

        conn = sqlite3.connect(str(dest))
        try:
            rows = conn.execute("SELECT id, name FROM t ORDER BY id").fetchall()
        finally:
            conn.close()
        assert rows == [(1, "committed")]

    def test_non_sqlite_source_refused(self, tmp_path: Path) -> None:
        bogus = tmp_path / "not.db"
        bogus.write_text("hello", encoding="utf-8")
        with pytest.raises(BackupFormatError):
            snapshot_sqlite(bogus, tmp_path / "out.db")

    def test_missing_source_refused(self, tmp_path: Path) -> None:
        with pytest.raises(BackupFormatError):
            snapshot_sqlite(tmp_path / "missing.db", tmp_path / "out.db")

    def test_digest_is_stable(self, tmp_path: Path) -> None:
        """Two snapshots of the same committed source are byte-identical.

        The backup output is not expected to equal the raw source file (it is a
        freshly written database, without the source's freelist/WAL), but it must
        be deterministic so a manifest digest is meaningful.
        """
        src = tmp_path / "deerflow.db"
        _make_db(src, [(1, "x")])
        first = snapshot_sqlite(src, tmp_path / "a.db")
        second = snapshot_sqlite(src, tmp_path / "b.db")
        assert first == second
        assert first == sha256_file(tmp_path / "a.db")


class TestHelpers:
    def test_is_sqlite_file(self, tmp_path: Path) -> None:
        db = tmp_path / "deerflow.db"
        _make_db(db, [])
        assert is_sqlite_file(db) is True
        text = tmp_path / "x.txt"
        text.write_text("nope", encoding="utf-8")
        assert is_sqlite_file(text) is False
        assert is_sqlite_file(tmp_path / "absent.db") is False

    def test_sidecars_lists_existing_only(self, tmp_path: Path) -> None:
        db = tmp_path / "deerflow.db"
        db.write_bytes(b"SQLite format 3\x00")
        (tmp_path / "deerflow.db-wal").write_bytes(b"wal")
        sidecars = sqlite_sidecars(db)
        assert db in sidecars
        assert (tmp_path / "deerflow.db-wal") in sidecars
        assert (tmp_path / "deerflow.db-shm") not in sidecars
