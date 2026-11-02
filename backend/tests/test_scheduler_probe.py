"""Snapshot tests for the N7 condition-driven trigger probe."""

from __future__ import annotations

import os
import time
from datetime import UTC, datetime, timedelta
from pathlib import Path

import pytest

from app.scheduler.probe import TriggerProbe, list_matching_files
from deerflow.config.database_config import DatabaseConfig
from deerflow.persistence.app_instances import AppInstanceRepository
from deerflow.persistence.engine import close_engine, get_session_factory, init_engine_from_config
from deerflow.persistence.run.model import RunRow

NOW = datetime.now(UTC)


# ── file lister ─────────────────────────────────────────────────────────────


def test_list_matching_files_supports_single_file_and_glob(tmp_path: Path) -> None:
    (tmp_path / "a.fbx").write_text("a")
    (tmp_path / "b.txt").write_text("b")
    nested = tmp_path / "sub"
    nested.mkdir()
    (nested / "c.fbx").write_text("c")

    all_files = list_matching_files(tmp_path, None, last_run_at=None)
    assert {Path(entry["path"]).name for entry in all_files} == {"a.fbx", "b.txt", "c.fbx"}

    fbx_only = list_matching_files(tmp_path, "**/*.fbx", last_run_at=None)
    assert {Path(entry["path"]).name for entry in fbx_only} == {"a.fbx", "c.fbx"}

    single = list_matching_files(tmp_path / "a.fbx", None, last_run_at=None)
    assert [entry["path"] for entry in single] == [str(tmp_path / "a.fbx")]


def test_list_matching_files_marks_created_relative_to_last_run(tmp_path: Path) -> None:
    target = tmp_path / "old.fbx"
    target.write_text("old")
    old_mtime = time.time() - 3600
    os.utime(target, (old_mtime, old_mtime))

    before = list_matching_files(tmp_path, None, last_run_at=datetime.now(UTC) - timedelta(hours=2))
    assert before[0]["created"] is True

    # A cutoff in the future means the file predates the trigger's last run.
    # (Kept away from "now" on purpose: filesystem timestamp resolution and the
    # platform's ctime semantics make a sub-second comparison flaky.)
    after = list_matching_files(tmp_path, None, last_run_at=datetime.now(UTC) + timedelta(hours=1))
    assert after[0]["created"] is False

    fresh = list_matching_files(tmp_path, None, last_run_at=None)
    assert fresh[0]["created"] is True


def test_list_matching_files_is_newest_first_and_bounded(tmp_path: Path) -> None:
    for index in range(3):
        path = tmp_path / f"f{index}.txt"
        path.write_text("x")
        stamp = time.time() - 100 * (3 - index)
        os.utime(path, (stamp, stamp))

    entries = list_matching_files(tmp_path, None, last_run_at=None, limit=2)
    assert len(entries) == 2
    assert Path(entries[0]["path"]).name == "f2.txt"
    assert entries[0]["mtime"] > entries[1]["mtime"]


def test_list_matching_files_missing_path_is_empty(tmp_path: Path) -> None:
    assert list_matching_files(tmp_path / "nope", None, last_run_at=None) == []


@pytest.mark.asyncio
async def test_probe_file_snapshot_uses_lister(tmp_path: Path) -> None:
    (tmp_path / "a.fbx").write_text("a")
    probe = TriggerProbe()
    snapshot = await probe.build({"schedule_type": "file", "schedule_spec": {"path": str(tmp_path)}}, now=NOW)
    assert [Path(entry["path"]).name for entry in snapshot["files"]] == ["a.fbx"]


@pytest.mark.asyncio
async def test_probe_file_snapshot_survives_lister_failure() -> None:
    def boom(*args, **kwargs):
        raise OSError("permission denied")

    probe = TriggerProbe(file_lister=boom)
    assert await probe.build({"schedule_type": "file", "schedule_spec": {"path": "/nope"}}, now=NOW) == {}


# ── event snapshot ──────────────────────────────────────────────────────────


@pytest.mark.asyncio
async def test_list_terminal_since_filters_by_app_status_and_time(tmp_path: Path) -> None:
    await init_engine_from_config(DatabaseConfig(backend="sqlite", sqlite_dir=str(tmp_path)))
    sf = get_session_factory()
    assert sf is not None
    repo = AppInstanceRepository(sf)
    await repo.create(session_id="s1", user_id="default", app_name="unity", driver="cli", status="crashed")
    await repo.create(session_id="s2", user_id="default", app_name="unity", driver="cli", status="ready")
    await repo.create(session_id="s3", user_id="default", app_name="blender", driver="cli", status="stopped")

    rows = await repo.list_terminal_since("default", app_name="unity", since=None)
    assert [row["id"] for row in rows] == ["s1"]

    # A future cutoff excludes the recorded transition.
    assert await repo.list_terminal_since("default", app_name="unity", since=datetime.now(UTC) + timedelta(minutes=1)) == []
    # Sanity: the recorded row is visible with a past cutoff.
    assert [row["id"] for row in await repo.list_terminal_since("default", app_name="unity", since=datetime.now(UTC) - timedelta(minutes=1))] == ["s1"]
    await close_engine()


@pytest.mark.asyncio
async def test_probe_event_snapshot_maps_rows(tmp_path: Path) -> None:
    await init_engine_from_config(DatabaseConfig(backend="sqlite", sqlite_dir=str(tmp_path)))
    sf = get_session_factory()
    assert sf is not None
    repo = AppInstanceRepository(sf)
    await repo.create(session_id="s1", user_id="default", app_name="unity", driver="cli", status="stopped")

    probe = TriggerProbe(session_factory=sf, instance_repo=repo)
    snapshot = await probe.build(
        {"schedule_type": "event", "schedule_spec": {"app": "unity"}, "user_id": "default", "last_run_at": None},
        now=NOW,
    )
    assert snapshot["events"][0]["session_id"] == "s1"
    assert snapshot["events"][0]["app"] == "unity"
    assert snapshot["events"][0]["status"] == "stopped"
    await close_engine()


@pytest.mark.asyncio
async def test_probe_event_snapshot_is_empty_without_a_repo() -> None:
    probe = TriggerProbe()
    snapshot = await probe.build({"schedule_type": "event", "schedule_spec": {"app": "unity"}}, now=NOW)
    assert snapshot == {"events": []}


# ── idle snapshot ───────────────────────────────────────────────────────────


@pytest.mark.asyncio
async def test_probe_idle_snapshot_reports_activity_and_active_runs(tmp_path: Path) -> None:
    await init_engine_from_config(DatabaseConfig(backend="sqlite", sqlite_dir=str(tmp_path)))
    sf = get_session_factory()
    assert sf is not None
    idle_probe = TriggerProbe(session_factory=sf)
    assert await idle_probe.build({"schedule_type": "idle", "schedule_spec": {"idle_seconds": 60}}, now=NOW) == {
        "active_runs": 0,
        "last_activity_at": None,
    }

    async with sf() as session:
        session.add(RunRow(run_id="r1", thread_id="t1", user_id="default", status="running"))
        await session.commit()

    snapshot = await idle_probe.build({"schedule_type": "idle", "schedule_spec": {"idle_seconds": 60}}, now=NOW)
    assert snapshot["active_runs"] == 1
    assert snapshot["last_activity_at"] is not None
    await close_engine()


@pytest.mark.asyncio
async def test_probe_idle_snapshot_without_session_factory_is_idle() -> None:
    probe = TriggerProbe()
    assert await probe.build({"schedule_type": "idle", "schedule_spec": {"idle_seconds": 60}}, now=NOW) == {
        "active_runs": 0,
        "last_activity_at": None,
    }


@pytest.mark.asyncio
async def test_probe_ignores_time_based_tasks() -> None:
    probe = TriggerProbe()
    assert await probe.build({"schedule_type": "cron", "schedule_spec": {"cron": "0 9 * * *"}}, now=NOW) == {}
