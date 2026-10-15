"""N11b S5 — the ``python -m deerflow.portability`` CLI surface and exit codes."""

from __future__ import annotations

import json
import sqlite3
from pathlib import Path
from types import SimpleNamespace

import pytest

from deerflow.config.paths import Paths
from deerflow.portability import __main__ as cli
from deerflow.portability import service as service_module
from deerflow.portability.service import export_backup


def _config(home: Path, *, backend: str = "sqlite", asset_roots: list[str] | None = None):
    if backend == "sqlite":
        database = SimpleNamespace(backend="sqlite", sqlite_path=str(home / "data" / "deerflow.db"))
    else:
        database = SimpleNamespace(backend=backend)
    return SimpleNamespace(memory=SimpleNamespace(enabled=True), database=database, assets=SimpleNamespace(roots=asset_roots or []))


def _seed(home: Path) -> None:
    home.mkdir(parents=True, exist_ok=True)
    (home / "memory.json").write_text("{}", encoding="utf-8")
    (home / "users" / "u1").mkdir(parents=True, exist_ok=True)
    (home / "users" / "u1" / "x.txt").write_text("hi", encoding="utf-8")
    db = home / "data" / "deerflow.db"
    db.parent.mkdir(parents=True, exist_ok=True)
    conn = sqlite3.connect(str(db))
    try:
        conn.execute("CREATE TABLE t (id INTEGER)")
        conn.commit()
    finally:
        conn.close()


@pytest.fixture(autouse=True)
def _isolate(monkeypatch):
    import deerflow.config.paths as paths_module

    monkeypatch.setattr(paths_module, "_paths", None)
    monkeypatch.setattr(service_module, "current_config_version", lambda config: 40)
    monkeypatch.setattr(service_module, "current_schema_head", lambda: "0019_x")


def _point_home(monkeypatch, home: Path) -> None:
    import deerflow.config.paths as paths_module

    monkeypatch.setattr(paths_module, "_paths", Paths(base_dir=home))


def _make_archive(tmp_path, monkeypatch) -> Path:
    home = tmp_path / "src-home"
    _seed(home)
    _point_home(monkeypatch, home)
    archive = tmp_path / "backup.zip"
    export_backup(_config(home), archive)
    return archive


class TestExportCli:
    def test_export_exit_zero_and_text(self, tmp_path, monkeypatch, capsys) -> None:
        home = tmp_path / "home"
        _seed(home)
        _point_home(monkeypatch, home)
        monkeypatch.setattr(cli, "_get_config", lambda: _config(home))

        code = cli.main(["export", "--output", str(tmp_path / "out.zip")])

        assert code == 0
        out = capsys.readouterr().out
        assert "exported backup" in out
        assert (tmp_path / "out.zip").is_file()

    def test_export_json(self, tmp_path, monkeypatch, capsys) -> None:
        home = tmp_path / "home"
        _seed(home)
        _point_home(monkeypatch, home)
        monkeypatch.setattr(cli, "_get_config", lambda: _config(home))

        code = cli.main(["export", "--output", str(tmp_path / "out.zip"), "--json"])

        assert code == 0
        payload = json.loads(capsys.readouterr().out)
        assert payload["ok"] is True
        assert payload["database_included"] is True


class TestInspectCli:
    def test_inspect_exit_zero(self, tmp_path, monkeypatch, capsys) -> None:
        archive = _make_archive(tmp_path, monkeypatch)
        monkeypatch.setattr(cli, "_get_config", lambda: _config(tmp_path / "src-home"))

        code = cli.main(["inspect", "--input", str(archive)])

        assert code == 0
        assert "compatible: True" in capsys.readouterr().out

    def test_inspect_bad_archive_exit_two(self, tmp_path, monkeypatch, capsys) -> None:
        monkeypatch.setattr(cli, "_get_config", lambda: _config(tmp_path / "home"))
        bad = tmp_path / "bad.zip"
        bad.write_text("nope", encoding="utf-8")

        code = cli.main(["inspect", "--input", str(bad)])

        assert code == 2
        assert "failed" in capsys.readouterr().err


class TestImportCli:
    def test_import_refused_on_non_empty_target_exit_one(self, tmp_path, monkeypatch, capsys) -> None:
        archive = _make_archive(tmp_path, monkeypatch)
        dest_home = tmp_path / "dst-home"
        _seed(dest_home)
        _point_home(monkeypatch, dest_home)
        monkeypatch.setattr(cli, "_get_config", lambda: _config(dest_home))

        code = cli.main(["import", "--input", str(archive)])

        assert code == 1
        assert "refused" in capsys.readouterr().out

    def test_import_force_succeeds(self, tmp_path, monkeypatch, capsys) -> None:
        archive = _make_archive(tmp_path, monkeypatch)
        dest_home = tmp_path / "dst-home"
        _seed(dest_home)
        _point_home(monkeypatch, dest_home)
        monkeypatch.setattr(cli, "_get_config", lambda: _config(dest_home))

        code = cli.main(["import", "--input", str(archive), "--force"])

        assert code == 0
        assert "restored" in capsys.readouterr().out

    def test_import_dry_run_json(self, tmp_path, monkeypatch, capsys) -> None:
        archive = _make_archive(tmp_path, monkeypatch)
        dest_home = tmp_path / "dst-home"
        _point_home(monkeypatch, dest_home)
        monkeypatch.setattr(cli, "_get_config", lambda: _config(dest_home))

        code = cli.main(["import", "--input", str(archive), "--dry-run", "--json"])

        assert code == 0
        payload = json.loads(capsys.readouterr().out)
        assert payload["ok"] is True
        assert payload["dry_run"] is True
