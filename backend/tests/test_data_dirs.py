"""N11 S5 — the single-machine data-directory layout.

``data_dirs()`` is the specification, ``check_data_dirs()`` observes without
touching anything, and ``ensure_data_dirs()`` creates only what is required.
"""

from __future__ import annotations

import os
from pathlib import Path

import pytest

from deerflow.config.paths import (
    SCOPE_GLOBAL,
    SCOPE_PER_USER,
    DataDir,
    Paths,
    missing_required_data_dirs,
)


@pytest.fixture
def paths(tmp_path: Path) -> Paths:
    return Paths(base_dir=tmp_path / "deer-flow")


class TestDataDirModel:
    def test_rejects_unknown_scope(self) -> None:
        with pytest.raises(ValueError):
            DataDir(name="x", path=Path("/x"), scope="everyone")

    def test_dict_shape(self) -> None:
        entry = DataDir(name="locks", path=Path("/base/locks"), purpose="locks", required=False)
        assert entry.to_dict() == {"name": "locks", "path": str(Path("/base/locks")), "purpose": "locks", "scope": SCOPE_GLOBAL, "required": False}


class TestDataDirs:
    def test_lists_the_layout_in_a_stable_order(self, paths: Paths) -> None:
        names = [entry.name for entry in paths.data_dirs()]
        assert names == ["base", "users", "skills_view", "integrations", "locks", "undo", "retrieval", "threads"]

    def test_every_path_lives_under_the_base_dir(self, paths: Paths) -> None:
        for entry in paths.data_dirs():
            assert paths.base_dir in entry.path.parents or entry.path == paths.base_dir

    def test_no_placeholder_paths(self, paths: Paths) -> None:
        """Per-user directories are described, not templated into the listing."""
        for entry in paths.data_dirs():
            assert "<" not in str(entry.path)
            assert "{" not in str(entry.path)

    def test_users_entry_is_marked_per_user(self, paths: Paths) -> None:
        users = next(entry for entry in paths.data_dirs() if entry.name == "users")
        assert users.scope == SCOPE_PER_USER
        assert users.purpose and "threads" in users.purpose

    def test_derived_index_is_not_required(self, paths: Paths) -> None:
        retrieval = next(entry for entry in paths.data_dirs() if entry.name == "retrieval")
        assert retrieval.required is False

    def test_memory_disabled_drops_the_derived_index(self, paths: Paths) -> None:
        names = [entry.name for entry in paths.data_dirs(memory_enabled=False)]
        assert "retrieval" not in names

    def test_database_directory_is_reported_when_configured(self, paths: Paths, tmp_path: Path) -> None:
        database_dir = tmp_path / "db"
        entry = next(item for item in paths.data_dirs(database_dir=database_dir) if item.name == "database")
        assert entry.path == database_dir
        assert entry.required is True
        assert "deerflow.db" in entry.purpose

    def test_no_database_entry_without_a_file_database(self, paths: Paths) -> None:
        assert all(entry.name != "database" for entry in paths.data_dirs())

    def test_legacy_threads_root_is_optional(self, paths: Paths) -> None:
        threads = next(entry for entry in paths.data_dirs() if entry.name == "threads")
        assert threads.required is False
        assert "Legacy" in threads.purpose


class TestCheckDataDirs:
    def test_reports_missing_directories_without_creating_them(self, paths: Paths) -> None:
        statuses = paths.check_data_dirs()
        assert {status.name for status in statuses} == {entry.name for entry in paths.data_dirs()}
        assert all(status.exists is False for status in statuses)
        assert all(status.writable is None for status in statuses)
        # The check must not have created anything.
        assert not paths.base_dir.exists()

    def test_reports_existing_writable_directories(self, paths: Paths) -> None:
        paths.ensure_data_dirs()
        statuses = {status.name: status for status in paths.check_data_dirs()}
        assert statuses["base"].exists is True
        assert statuses["base"].writable is True
        assert statuses["base"].ok is True
        assert statuses["base"].problem == ""

    def test_optional_missing_directory_is_not_a_problem(self, paths: Paths) -> None:
        paths.ensure_data_dirs()
        retrieval = next(status for status in paths.check_data_dirs() if status.name == "retrieval")
        assert retrieval.exists is False
        assert missing_required_data_dirs(paths.check_data_dirs()) == []

    def test_readonly_directory_is_reported(  # noqa: ARG002 - fixture used for its tmp base
        self, paths: Paths, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        """Writability is judged by the OS, and the answer is surfaced verbatim."""
        paths.ensure_data_dirs()
        real_access = os.access

        def fake_access(path: object, mode: int) -> bool:
            if mode == os.W_OK:
                return False
            return real_access(path, mode)  # type: ignore[arg-type]

        monkeypatch.setattr(os, "access", fake_access)
        statuses = paths.check_data_dirs()
        existing = [status for status in statuses if status.exists]
        assert existing, "ensure_data_dirs should have created the required directories"
        assert all(status.writable is False for status in existing)
        assert all(status.problem == "not writable" for status in existing)
        missing = missing_required_data_dirs(statuses)
        assert {status.name for status in missing} >= {"base", "users", "locks", "undo"}

    def test_dict_shape(self, paths: Paths) -> None:
        payload = paths.check_data_dirs()[0].to_dict()
        assert payload["name"] == "base"
        assert payload["exists"] is False
        assert payload["writable"] is None
        assert payload["ok"] is False
        assert payload["problem"] == "does not exist"


class TestEnsureDataDirs:
    def test_creates_the_required_directories(self, paths: Paths) -> None:
        created = paths.ensure_data_dirs()
        for entry in paths.data_dirs():
            if entry.required:
                assert entry.path.is_dir(), entry.name
        assert paths.base_dir in created

    def test_does_not_create_optional_directories(self, paths: Paths) -> None:
        paths.ensure_data_dirs()
        assert not (paths.base_dir / ".retrieval").exists()
        assert not (paths.base_dir / "threads").exists()

    def test_is_idempotent(self, paths: Paths) -> None:
        first = paths.ensure_data_dirs()
        second = paths.ensure_data_dirs()
        assert first == second
        assert all(path.is_dir() for path in second)

    def test_creates_the_database_directory_when_given(self, paths: Paths, tmp_path: Path) -> None:
        database_dir = tmp_path / "db"
        paths.ensure_data_dirs(database_dir=database_dir)
        assert database_dir.is_dir()

    def test_creates_a_nested_base_dir(self, tmp_path: Path) -> None:
        nested = Paths(base_dir=tmp_path / "a" / "b" / "c")
        nested.ensure_data_dirs()
        assert nested.base_dir.is_dir()
