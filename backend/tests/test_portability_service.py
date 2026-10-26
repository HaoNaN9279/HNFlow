"""N11b S5 — export / inspect / import orchestration against real temp files."""

from __future__ import annotations

import sqlite3
from pathlib import Path
from types import SimpleNamespace

import pytest

from deerflow.config.paths import Paths
from deerflow.portability import service as service_module
from deerflow.portability.archive import BackupFormatError
from deerflow.portability.service import export_backup, import_backup, inspect_backup


def _fake_config(base_dir: Path, *, backend: str = "sqlite", db_dir: Path | None = None, asset_roots: list[str] | None = None):
    if backend == "sqlite":
        db_path = (db_dir or (base_dir / "data")) / "deerflow.db"
        database = SimpleNamespace(backend="sqlite", sqlite_path=str(db_path))
    elif backend == "postgres":
        database = SimpleNamespace(backend="postgres", postgres_url="postgresql://x/y")
    else:
        database = SimpleNamespace(backend="memory")
    return SimpleNamespace(
        memory=SimpleNamespace(enabled=True),
        database=database,
        assets=SimpleNamespace(roots=asset_roots or []),
    )


def _seed_base(home: Path) -> None:
    home.mkdir(parents=True, exist_ok=True)
    (home / "memory.json").write_text('{"version": 2}', encoding="utf-8")
    (home / "USER.md").write_text("profile", encoding="utf-8")
    (home / "users" / "u1").mkdir(parents=True, exist_ok=True)
    (home / "users" / "u1" / "data.txt").write_text("hello", encoding="utf-8")
    (home / "locks").mkdir(parents=True, exist_ok=True)
    (home / "locks" / "resource.lock").write_text("", encoding="utf-8")


def _seed_db(path: Path) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    conn = sqlite3.connect(str(path))
    try:
        conn.execute("CREATE TABLE workflow_definitions (id TEXT PRIMARY KEY, name TEXT)")
        conn.execute("INSERT INTO workflow_definitions VALUES ('d1', 'demo')")
        conn.commit()
    finally:
        conn.close()


@pytest.fixture(autouse=True)
def _reset_paths(monkeypatch):
    import deerflow.config.paths as paths_module

    monkeypatch.setattr(paths_module, "_paths", None)
    # Keep the manifest's informational versions deterministic and hermetic.
    monkeypatch.setattr(service_module, "current_config_version", lambda config: 40)
    monkeypatch.setattr(service_module, "current_schema_head", lambda: "0019_x")


def _point_home(monkeypatch, home: Path) -> None:
    import deerflow.config.paths as paths_module

    monkeypatch.setattr(paths_module, "_paths", Paths(base_dir=home))


class TestExport:
    def test_export_packages_directories_and_database(self, tmp_path, monkeypatch) -> None:
        home = tmp_path / "home"
        _seed_base(home)
        _seed_db(home / "data" / "deerflow.db")
        _point_home(monkeypatch, home)
        config = _fake_config(home)

        result = export_backup(config, tmp_path / "backup.zip")

        assert result["ok"] is True
        assert result["database_included"] is True
        manifest = result["manifest"]
        names = {entry["name"] for entry in manifest["entries"]}
        assert {"base", "users", "database"} <= names
        assert set(result["excluded"]) == {"locks", "retrieval", "capability-groups", "tools"}
        db_entry = next(e for e in manifest["entries"] if e["kind"] == "database")
        assert db_entry["sha256"]  # snapshot digest recorded
        assert (tmp_path / "backup.zip").is_file()

    def test_export_postgres_records_database_not_included(self, tmp_path, monkeypatch) -> None:
        home = tmp_path / "home"
        _seed_base(home)
        _point_home(monkeypatch, home)
        config = _fake_config(home, backend="postgres")

        result = export_backup(config, tmp_path / "backup.zip")
        assert result["database_included"] is False
        assert "database" in result["excluded"]

    def test_export_assets_opt_in(self, tmp_path, monkeypatch) -> None:
        home = tmp_path / "home"
        _seed_base(home)
        assets = tmp_path / "assets"
        (assets / "models").mkdir(parents=True)
        (assets / "models" / "m.blend").write_text("model", encoding="utf-8")
        _point_home(monkeypatch, home)
        config = _fake_config(home, backend="memory", asset_roots=[str(assets / "models")])

        result = export_backup(config, tmp_path / "backup.zip", include_assets=True)
        manifest = result["manifest"]
        assert manifest["assets_included"] is True
        assert manifest["assets_roots"] == [str(assets / "models")]
        assert any(e["kind"] == "asset" for e in manifest["entries"])


class TestInspect:
    def test_inspect_reports_compatibility(self, tmp_path, monkeypatch) -> None:
        home = tmp_path / "home"
        _seed_base(home)
        _seed_db(home / "data" / "deerflow.db")
        _point_home(monkeypatch, home)
        config = _fake_config(home)
        export_backup(config, tmp_path / "backup.zip")

        result = inspect_backup(config, tmp_path / "backup.zip")
        assert result["ok"] is True
        assert result["manifest"]["config_version"] == 40

    def test_inspect_bad_archive_raises(self, tmp_path, monkeypatch) -> None:
        _point_home(monkeypatch, tmp_path / "home")
        bad = tmp_path / "bad.zip"
        bad.write_text("nope", encoding="utf-8")
        with pytest.raises(BackupFormatError):
            inspect_backup(_fake_config(tmp_path / "home"), bad)


class TestImport:
    def _export(self, tmp_path, monkeypatch) -> Path:
        home = tmp_path / "src-home"
        _seed_base(home)
        _seed_db(tmp_path / "src-data" / "deerflow.db")
        _point_home(monkeypatch, home)
        archive = tmp_path / "backup.zip"
        export_backup(_fake_config(home, db_dir=tmp_path / "src-data"), archive)
        return archive

    def test_import_round_trip_to_new_home(self, tmp_path, monkeypatch) -> None:
        archive = self._export(tmp_path, monkeypatch)

        dest_home = tmp_path / "dst-home"
        _point_home(monkeypatch, dest_home)
        dest_config = _fake_config(dest_home, db_dir=tmp_path / "dst-data")

        result = import_backup(dest_config, archive)
        assert result["ok"] is True
        assert (dest_home / "memory.json").read_text(encoding="utf-8") == '{"version": 2}'
        assert (dest_home / "users" / "u1" / "data.txt").read_text(encoding="utf-8") == "hello"
        assert (tmp_path / "dst-data" / "deerflow.db").is_file()
        conn = sqlite3.connect(str(tmp_path / "dst-data" / "deerflow.db"))
        try:
            assert conn.execute("SELECT name FROM workflow_definitions").fetchone() == ("demo",)
        finally:
            conn.close()

    def test_import_into_non_empty_target_refused_without_force(self, tmp_path, monkeypatch) -> None:
        archive = self._export(tmp_path, monkeypatch)
        dest_home = tmp_path / "dst-home"
        _seed_base(dest_home)  # already has data
        _point_home(monkeypatch, dest_home)
        dest_config = _fake_config(dest_home, db_dir=tmp_path / "dst-data")

        result = import_backup(dest_config, archive)
        assert result["ok"] is False
        assert any("force" in r.lower() for r in result["refusals"])

    def test_import_force_overwrites(self, tmp_path, monkeypatch) -> None:
        archive = self._export(tmp_path, monkeypatch)
        dest_home = tmp_path / "dst-home"
        _seed_base(dest_home)
        _point_home(monkeypatch, dest_home)
        dest_config = _fake_config(dest_home, db_dir=tmp_path / "dst-data")

        result = import_backup(dest_config, archive, force=True)
        assert result["ok"] is True

    def test_import_dry_run_writes_nothing(self, tmp_path, monkeypatch) -> None:
        archive = self._export(tmp_path, monkeypatch)
        dest_home = tmp_path / "dst-home"
        _point_home(monkeypatch, dest_home)
        dest_config = _fake_config(dest_home, db_dir=tmp_path / "dst-data")

        result = import_backup(dest_config, archive, dry_run=True)
        assert result["ok"] is True
        assert not (dest_home / "memory.json").exists()

    def test_import_assets_skipped_without_destination(self, tmp_path, monkeypatch) -> None:
        home = tmp_path / "src-home"
        _seed_base(home)
        assets = tmp_path / "assets"
        (assets / "models").mkdir(parents=True)
        (assets / "models" / "m.blend").write_text("model", encoding="utf-8")
        _point_home(monkeypatch, home)
        archive = tmp_path / "backup.zip"
        export_backup(_fake_config(home, backend="memory", asset_roots=[str(assets / "models")]), archive, include_assets=True)

        dest_home = tmp_path / "dst-home"
        _point_home(monkeypatch, dest_home)
        result = import_backup(_fake_config(dest_home, backend="memory"), archive)
        assert result["ok"] is True
        assert any(a["kind"] == "asset" and a["action"] == "skip" for a in result["actions"])

    def test_import_assets_with_destination(self, tmp_path, monkeypatch) -> None:
        home = tmp_path / "src-home"
        _seed_base(home)
        assets = tmp_path / "assets"
        (assets / "models").mkdir(parents=True)
        (assets / "models" / "m.blend").write_text("model", encoding="utf-8")
        _point_home(monkeypatch, home)
        archive = tmp_path / "backup.zip"
        export_backup(_fake_config(home, backend="memory", asset_roots=[str(assets / "models")]), archive, include_assets=True)

        dest_home = tmp_path / "dst-home"
        dest_assets = tmp_path / "restored-assets"
        _point_home(monkeypatch, dest_home)
        result = import_backup(_fake_config(dest_home, backend="memory"), archive, assets_dest=str(dest_assets))
        assert result["ok"] is True
        assert (dest_assets / "0" / "m.blend").read_text(encoding="utf-8") == "model"
