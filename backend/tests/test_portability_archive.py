"""N11b S3 — the safe zip archive (write / read manifest / extract)."""

from __future__ import annotations

import stat
import zipfile
from pathlib import Path

import pytest

from deerflow.portability.archive import (
    BackupFormatError,
    extract_routes,
    list_members,
    read_manifest,
    write_archive,
)
from deerflow.portability.select import PlannedMember
from deerflow.portability.spec import KIND_DATABASE, KIND_DIRECTORY, BackupManifest, now_iso


def _base_manifest(**overrides) -> BackupManifest:
    base = dict(created_at=now_iso(), database_backend="sqlite", database_included=True)
    base.update(overrides)
    return BackupManifest(**base)


def _make_tree(root: Path) -> None:
    root.mkdir(parents=True, exist_ok=True)
    (root / "memory.json").write_text('{"version": 2}', encoding="utf-8")
    (root / "USER.md").write_text("hi", encoding="utf-8")
    users = root / "users"
    (users / "u1").mkdir(parents=True, exist_ok=True)
    (users / "u1" / "data.txt").write_text("hello", encoding="utf-8")


class TestWriteArchive:
    def test_round_trip_and_shallow_base(self, tmp_path: Path) -> None:
        home = tmp_path / "home"
        _make_tree(home)
        members = [
            PlannedMember(name="base", kind=KIND_DIRECTORY, source_path=str(home), archive_path="dirs/base", shallow=True),
            PlannedMember(name="users", kind=KIND_DIRECTORY, source_path=str(home / "users"), archive_path="dirs/users"),
        ]
        dest = tmp_path / "backup.zip"
        manifest = write_archive(dest, base_manifest=_base_manifest(), members=members)

        assert dest.is_file()
        names = list_members(dest)
        assert "manifest.json" in names
        assert "dirs/base/memory.json" in names
        assert "dirs/base/USER.md" in names
        assert "dirs/users/u1/data.txt" in names
        # shallow base must not duplicate the users subtree
        assert not any(n.startswith("dirs/base/users/") for n in names)

        entries = {e.name: e for e in manifest.entries}
        assert entries["users"].entry_count == 1
        assert entries["users"].total_bytes == len("hello")
        assert entries["base"].entry_count == 2  # memory.json + USER.md, no subdirs

        parsed = read_manifest(dest)
        assert parsed == manifest

    def test_database_member_is_a_single_file(self, tmp_path: Path) -> None:
        db = tmp_path / "data" / "deerflow.db"
        db.parent.mkdir(parents=True)
        db.write_bytes(b"SQLite format 3\x00")
        member = PlannedMember(name="database", kind=KIND_DATABASE, source_path=str(db), archive_path="database/deerflow.db")
        dest = tmp_path / "backup.zip"
        manifest = write_archive(dest, base_manifest=_base_manifest(), members=[member])
        assert "database/deerflow.db" in list_members(dest)
        entry = manifest.database_entry
        assert entry is not None
        assert entry.entry_count == 1
        assert entry.total_bytes == len(b"SQLite format 3\x00")

    def test_missing_database_file_raises(self, tmp_path: Path) -> None:
        member = PlannedMember(name="database", kind=KIND_DATABASE, source_path=str(tmp_path / "nope.db"), archive_path="database/deerflow.db")
        with pytest.raises(BackupFormatError):
            write_archive(tmp_path / "backup.zip", base_manifest=_base_manifest(), members=[member])

    def test_missing_directory_member_is_skipped(self, tmp_path: Path) -> None:
        member = PlannedMember(name="threads", kind=KIND_DIRECTORY, source_path=str(tmp_path / "gone"), archive_path="dirs/threads")
        manifest = write_archive(tmp_path / "backup.zip", base_manifest=_base_manifest(), members=[member])
        assert manifest.entries == []


class TestReadManifest:
    def test_missing_manifest_raises(self, tmp_path: Path) -> None:
        dest = tmp_path / "junk.zip"
        with zipfile.ZipFile(dest, "w") as zf:
            zf.writestr("random.txt", "hi")
        with pytest.raises(BackupFormatError):
            read_manifest(dest)

    def test_not_a_zip_raises(self, tmp_path: Path) -> None:
        dest = tmp_path / "notzip.zip"
        dest.write_text("not a zip", encoding="utf-8")
        with pytest.raises(BackupFormatError):
            read_manifest(dest)

    def test_corrupt_manifest_raises(self, tmp_path: Path) -> None:
        dest = tmp_path / "bad.zip"
        with zipfile.ZipFile(dest, "w") as zf:
            zf.writestr("manifest.json", "{not json")
        with pytest.raises(BackupFormatError):
            read_manifest(dest)


class TestExtractRoutes:
    def _archive(self, tmp_path: Path) -> Path:
        home = tmp_path / "home"
        _make_tree(home)
        db = tmp_path / "data" / "deerflow.db"
        db.parent.mkdir(parents=True)
        db.write_bytes(b"db")
        dest = tmp_path / "backup.zip"
        write_archive(
            dest,
            base_manifest=_base_manifest(),
            members=[
                PlannedMember(name="base", kind=KIND_DIRECTORY, source_path=str(home), archive_path="dirs/base", shallow=True),
                PlannedMember(name="users", kind=KIND_DIRECTORY, source_path=str(home / "users"), archive_path="dirs/users"),
                PlannedMember(name="database", kind=KIND_DATABASE, source_path=str(db), archive_path="database/deerflow.db"),
            ],
        )
        return dest

    def test_extracts_files_by_route(self, tmp_path: Path) -> None:
        archive = self._archive(tmp_path)
        out = tmp_path / "restore"
        result = extract_routes(
            archive,
            [
                ("dirs/base", str(out / "home")),
                ("dirs/users", str(out / "home" / "users")),
                ("database/deerflow.db", str(out / "data" / "deerflow.db")),
            ],
        )
        assert result.files == 4  # memory.json, USER.md, data.txt, deerflow.db
        assert (out / "home" / "memory.json").read_text(encoding="utf-8") == '{"version": 2}'
        assert (out / "home" / "users" / "u1" / "data.txt").read_text(encoding="utf-8") == "hello"
        assert (out / "data" / "deerflow.db").read_bytes() == b"db"

    def test_dry_run_writes_nothing(self, tmp_path: Path) -> None:
        archive = self._archive(tmp_path)
        out = tmp_path / "restore"
        result = extract_routes(archive, [("dirs/users", str(out / "users"))], dry_run=True)
        assert result.files == 1
        assert not out.exists()

    def test_unrouted_members_are_skipped(self, tmp_path: Path) -> None:
        archive = self._archive(tmp_path)
        out = tmp_path / "restore"
        result = extract_routes(archive, [("dirs/base", str(out))])
        assert "dirs/users/u1/data.txt" in result.skipped
        assert "database/deerflow.db" in result.skipped

    def test_path_traversal_member_refused(self, tmp_path: Path) -> None:
        dest = tmp_path / "evil.zip"
        with zipfile.ZipFile(dest, "w") as zf:
            zf.writestr("../evil.txt", "pwned")
        with pytest.raises(BackupFormatError):
            extract_routes(dest, [("dirs", str(tmp_path / "out"))])

    def test_absolute_member_refused(self, tmp_path: Path) -> None:
        dest = tmp_path / "abs.zip"
        with zipfile.ZipFile(dest, "w") as zf:
            zf.writestr("/etc/passwd", "pwned")
        with pytest.raises(BackupFormatError):
            extract_routes(dest, [("dirs", str(tmp_path / "out"))])

    def test_symlink_member_refused(self, tmp_path: Path) -> None:
        dest = tmp_path / "symlink.zip"
        info = zipfile.ZipInfo("dirs/users/link")
        info.external_attr = (stat.S_IFLNK | 0o777) << 16
        with zipfile.ZipFile(dest, "w") as zf:
            zf.writestr(info, "target")
        with pytest.raises(BackupFormatError, match="symlink"):
            extract_routes(dest, [("dirs/users", str(tmp_path / "out"))])

    def test_longest_route_wins(self, tmp_path: Path) -> None:
        archive = self._archive(tmp_path)
        out = tmp_path / "restore"
        # A broad "database" route must not shadow the file route.
        extract_routes(
            archive,
            [
                ("database", str(out / "broad")),
                ("database/deerflow.db", str(out / "exact.db")),
            ],
        )
        assert (out / "exact.db").read_bytes() == b"db"
        assert not (out / "broad").exists()
