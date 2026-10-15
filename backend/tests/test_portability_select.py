"""N11b S2 — the pure backup/restore plan (what to package, how to restore).

Pure: no filesystem, no zip.  ``DataDir`` is imported only as a plain data
carrier (it is itself pure).
"""

from __future__ import annotations

from pathlib import Path

from deerflow.config.paths import SCOPE_PER_USER, DataDir
from deerflow.portability.select import (
    EXCLUDED_DIRS,
    BackupPlan,
    PlannedMember,
    RestorePlan,
    plan_backup,
    plan_restore,
)
from deerflow.portability.spec import (
    KIND_DATABASE,
    KIND_DIRECTORY,
    BackupManifest,
    CompatibilityReport,
    ExcludedEntry,
    ManifestEntry,
    now_iso,
)


def _data_dirs(base: Path, *, include_database: bool = True, include_retrieval: bool = True) -> list[DataDir]:
    dirs = [
        DataDir(name="base", path=base, purpose="root", required=True),
        DataDir(name="users", path=base / "users", purpose="buckets", scope=SCOPE_PER_USER, required=True),
        DataDir(name="skills_view", path=base / "skills_view", purpose="projections", required=True),
        DataDir(name="locks", path=base / "locks", purpose="locks", required=True),
        DataDir(name="undo", path=base / "undo", purpose="undo", required=True),
    ]
    if include_retrieval:
        dirs.append(DataDir(name="retrieval", path=base / ".retrieval", purpose="derived", required=False))
    if include_database:
        dirs.append(DataDir(name="database", path=base / "data", purpose="db dir", required=True))
    dirs.append(DataDir(name="threads", path=base / "threads", purpose="legacy", required=False))
    return dirs


class TestPlanBackup:
    def test_orders_and_names_are_logical(self) -> None:
        plan = plan_backup(_data_dirs(Path("/root")), database_backend="sqlite", database_path="/root/data/deerflow.db")
        assert isinstance(plan, BackupPlan)
        by_name = {m.name: m for m in plan.members}
        assert set(by_name) == {"base", "users", "skills_view", "undo", "threads", "database"}
        assert by_name["users"].archive_path == "dirs/users"
        assert by_name["users"].kind == KIND_DIRECTORY
        assert by_name["base"].shallow is True
        assert by_name["users"].shallow is False
        # archive paths are logical, never absolute host paths
        for member in plan.members:
            assert not member.archive_path.startswith("/")
            assert "root" not in member.archive_path

    def test_locks_and_retrieval_excluded_with_reasons(self) -> None:
        plan = plan_backup(_data_dirs(Path("/root")), database_backend="sqlite", database_path="/root/data/deerflow.db")
        assert set(plan.excluded_names) == {"locks", "retrieval"}
        assert plan.excluded_names == ["locks", "retrieval"]
        assert all(e.reason for e in plan.excluded)
        assert "retrieval" in EXCLUDED_DIRS

    def test_database_member_when_sqlite(self) -> None:
        plan = plan_backup(_data_dirs(Path("/root")), database_backend="sqlite", database_path="/root/data/deerflow.db")
        assert plan.database_included is True
        db = next(m for m in plan.members if m.kind == KIND_DATABASE)
        assert db.name == "database"
        assert db.archive_path == "database/deerflow.db"
        assert db.source_path == "/root/data/deerflow.db"

    def test_postgres_database_excluded_not_packaged(self) -> None:
        plan = plan_backup(_data_dirs(Path("/root")), database_backend="postgres", database_path=None)
        assert plan.database_included is False
        assert not any(m.kind == KIND_DATABASE for m in plan.members)
        # the database directory itself is not packaged as files either
        assert "database" not in {m.name for m in plan.members}

    def test_memory_backend_has_no_database_dir_in_play(self) -> None:
        plan = plan_backup(_data_dirs(Path("/root"), include_database=False), database_backend="memory", database_path=None)
        assert plan.database_included is False
        assert not any(m.kind == KIND_DATABASE for m in plan.members)

    def test_assets_opt_in(self) -> None:
        plan = plan_backup(
            _data_dirs(Path("/root")),
            database_backend="sqlite",
            database_path="/root/data/deerflow.db",
            include_assets=True,
            asset_roots=["/assets/models", "/assets/textures"],
        )
        assets = [m for m in plan.members if m.kind == "asset"]
        assert [m.archive_path for m in assets] == ["assets/0", "assets/1"]
        assert [m.original_path for m in assets] == ["/assets/models", "/assets/textures"]

    def test_assets_off_by_default(self) -> None:
        plan = plan_backup(
            _data_dirs(Path("/root")),
            database_backend="sqlite",
            database_path="/root/data/deerflow.db",
            asset_roots=["/assets/models"],
        )
        assert not any(m.kind == "asset" for m in plan.members)

    def test_to_dict_is_json_safe(self) -> None:
        plan = plan_backup(_data_dirs(Path("/root")), database_backend="sqlite", database_path="/root/data/deerflow.db")
        payload = plan.to_dict()
        assert payload["database_included"] is True
        assert isinstance(payload["members"], list)
        assert {"locks", "retrieval"} == {e["name"] for e in payload["excluded"]}


class TestPlannedMember:
    def test_is_frozen_value_object(self) -> None:
        member = PlannedMember(name="users", kind=KIND_DIRECTORY, source_path="/root/users", archive_path="dirs/users")
        assert member.scope == "global"
        assert member.required is True
        assert member.shallow is False


def _manifest(**overrides) -> BackupManifest:
    entries = [
        ManifestEntry(name="base", kind=KIND_DIRECTORY, archive_path="dirs/base"),
        ManifestEntry(name="users", kind=KIND_DIRECTORY, archive_path="dirs/users", scope="per-user"),
        ManifestEntry(name="database", kind=KIND_DATABASE, archive_path="database/deerflow.db", sha256="a" * 64),
    ]
    base = dict(created_at=now_iso(), entries=entries, database_included=True, database_backend="sqlite")
    base.update(overrides)
    return BackupManifest(**base)


DIR_PATHS = {"base": "/new/root", "users": "/new/root/users", "skills_view": "/new/root/skills_view", "undo": "/new/root/undo"}


class TestPlanRestoreEmptyTarget:
    def test_actions_map_by_logical_name(self) -> None:
        plan = plan_restore(
            _manifest(),
            dir_paths=DIR_PATHS,
            database_path="/new/data/deerflow.db",
            target_exists=False,
            force=False,
            assets_dest=None,
            compatibility=CompatibilityReport(compatible=True),
        )
        assert isinstance(plan, RestorePlan)
        assert plan.ok is True
        targets = {a.name: a.target_path for a in plan.actions}
        assert targets["base"] == "/new/root"
        assert targets["users"] == "/new/root/users"
        assert targets["database"] == "/new/data/deerflow.db"
        assert all(a.action == "extract" for a in plan.actions)

    def test_non_empty_target_refuses_without_force(self) -> None:
        plan = plan_restore(
            _manifest(),
            dir_paths=DIR_PATHS,
            database_path="/new/data/deerflow.db",
            target_exists=True,
            force=False,
            assets_dest=None,
            compatibility=CompatibilityReport(compatible=True),
        )
        assert plan.ok is False
        assert any("force" in r.lower() for r in plan.refusals)

    def test_force_allows_overwrite(self) -> None:
        plan = plan_restore(
            _manifest(),
            dir_paths=DIR_PATHS,
            database_path="/new/data/deerflow.db",
            target_exists=True,
            force=True,
            assets_dest=None,
            compatibility=CompatibilityReport(compatible=True),
        )
        assert plan.ok is True

    def test_incompatible_manifest_refused(self) -> None:
        plan = plan_restore(
            _manifest(),
            dir_paths=DIR_PATHS,
            database_path="/new/data/deerflow.db",
            target_exists=False,
            force=True,
            assets_dest=None,
            compatibility=CompatibilityReport(compatible=False, reason="format too new"),
        )
        assert plan.ok is False
        assert any("format too new" in r for r in plan.refusals)

    def test_unknown_required_directory_refused(self) -> None:
        plan = plan_restore(
            _manifest(entries=[ManifestEntry(name="mystery", kind=KIND_DIRECTORY, archive_path="dirs/mystery", required=True)]),
            dir_paths=DIR_PATHS,
            database_path="/new/data/deerflow.db",
            target_exists=False,
            force=False,
            assets_dest=None,
            compatibility=CompatibilityReport(compatible=True),
        )
        assert plan.ok is False
        assert any("mystery" in r for r in plan.refusals)

    def test_database_skipped_when_no_file_backend(self) -> None:
        plan = plan_restore(
            _manifest(),
            dir_paths=DIR_PATHS,
            database_path=None,  # memory/postgres build keeps no file
            target_exists=False,
            force=False,
            assets_dest=None,
            compatibility=CompatibilityReport(compatible=True),
        )
        db_action = next(a for a in plan.actions if a.name == "database")
        assert db_action.action == "skip"
        assert "database" in db_action.reason.lower()

    def test_assets_skipped_without_destination(self) -> None:
        manifest = _manifest(
            assets_included=True,
            assets_roots=["/assets/models"],
            entries=[
                ManifestEntry(name="base", kind=KIND_DIRECTORY, archive_path="dirs/base"),
                ManifestEntry(name="asset-0", kind="asset", archive_path="assets/0", original_path="/assets/models"),
            ],
        )
        plan = plan_restore(
            manifest,
            dir_paths=DIR_PATHS,
            database_path=None,
            target_exists=False,
            force=False,
            assets_dest=None,
            compatibility=CompatibilityReport(compatible=True),
        )
        asset_action = next(a for a in plan.actions if a.kind == "asset")
        assert asset_action.action == "skip"
        assert "assets-dest" in asset_action.reason

    def test_assets_extracted_when_destination_given(self) -> None:
        manifest = _manifest(
            assets_included=True,
            entries=[ManifestEntry(name="asset-0", kind="asset", archive_path="assets/0", original_path="/assets/models")],
        )
        plan = plan_restore(
            manifest,
            dir_paths=DIR_PATHS,
            database_path=None,
            target_exists=False,
            force=False,
            assets_dest="/restore/assets",
            compatibility=CompatibilityReport(compatible=True),
        )
        asset_action = next(a for a in plan.actions if a.kind == "asset")
        assert asset_action.action == "extract"
        assert asset_action.target_path == str(Path("/restore/assets/0"))

    def test_warnings_carried_through(self) -> None:
        plan = plan_restore(
            _manifest(),
            dir_paths=DIR_PATHS,
            database_path="/new/data/deerflow.db",
            target_exists=False,
            force=False,
            assets_dest=None,
            compatibility=CompatibilityReport(compatible=True, warnings=("config_version drift",)),
        )
        assert "config_version drift" in plan.warnings

    def test_to_dict_shape(self) -> None:
        plan = plan_restore(
            _manifest(),
            dir_paths=DIR_PATHS,
            database_path="/new/data/deerflow.db",
            target_exists=False,
            force=False,
            assets_dest=None,
            compatibility=CompatibilityReport(compatible=True),
        )
        payload = plan.to_dict()
        assert payload["ok"] is True
        assert isinstance(payload["actions"], list)
        assert payload["actions"][0]["action"] == "extract"


def test_excluded_entry_is_spec_model() -> None:
    plan = plan_backup(_data_dirs(Path("/root")), database_backend="sqlite", database_path="/root/data/deerflow.db")
    assert all(isinstance(e, ExcludedEntry) for e in plan.excluded)
