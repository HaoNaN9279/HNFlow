"""Tests for AppInstanceRepository — CRUD, isolation, transitions, maintenance."""

from __future__ import annotations

import time

import pytest

from deerflow.config.database_config import DatabaseConfig
from deerflow.persistence.app_instances import AppInstanceRepository
from deerflow.persistence.app_instances.sql import ACTIVE_STATUSES, LIVE_STATUSES
from deerflow.persistence.engine import close_engine, get_session_factory, init_engine_from_config


async def _make_repo(tmp_path) -> AppInstanceRepository:
    await init_engine_from_config(DatabaseConfig(backend="sqlite", sqlite_dir=str(tmp_path)))
    sf = get_session_factory()
    assert sf is not None
    return AppInstanceRepository(sf)


async def _create(
    repo: AppInstanceRepository,
    *,
    session_id: str = "app-1",
    user_id: str = "user-1",
    app_name: str = "blender",
    driver: str = "cli",
    status: str = "ready",
) -> dict:
    return await repo.create(session_id=session_id, user_id=user_id, app_name=app_name, driver=driver, status=status)


@pytest.mark.asyncio
async def test_create_get_roundtrip(tmp_path) -> None:
    repo = await _make_repo(tmp_path)
    created = await _create(repo)
    assert created["id"] == "app-1"
    assert created["app_name"] == "blender"
    assert created["driver"] == "cli"
    assert created["status"] == "ready"
    assert created["pid"] is None
    assert created["handle"] == {}
    assert created["resources"] == {}
    assert created["exclusive"] is True
    assert created["archived_at"] is None
    # datetimes are coerced to ISO strings for the API surface
    assert isinstance(created["created_at"], str)
    assert isinstance(created["last_active"], str)
    assert isinstance(created["updated_at"], str)

    fetched = await repo.get("app-1", user_id="user-1")
    assert fetched is not None
    assert fetched["id"] == "app-1"
    await close_engine()


@pytest.mark.asyncio
async def test_get_user_isolation(tmp_path) -> None:
    repo = await _make_repo(tmp_path)
    await _create(repo, user_id="user-a")
    assert await repo.get("app-1", user_id="user-b") is None
    assert await repo.get("app-1", user_id="user-a") is not None
    await close_engine()


@pytest.mark.asyncio
async def test_create_replaces_existing_session_id(tmp_path) -> None:
    repo = await _make_repo(tmp_path)
    await _create(repo, session_id="app-x", status="stopped")
    replaced = await _create(repo, session_id="app-x", status="ready")
    assert replaced["status"] == "ready"
    assert len(await repo.list_by_user("user-1")) == 1
    await close_engine()


@pytest.mark.asyncio
async def test_list_by_user_filters(tmp_path) -> None:
    repo = await _make_repo(tmp_path)
    await _create(repo, session_id="app-ready", status="ready")
    await _create(repo, session_id="app-arch", status="archived")
    await _create(repo, session_id="app-orph", status="orphaned")

    all_rows = await repo.list_by_user("user-1")
    assert {r["id"] for r in all_rows} == {"app-ready", "app-arch", "app-orph"}

    ready = await repo.list_by_user("user-1", status="ready")
    assert [r["id"] for r in ready] == ["app-ready"]

    no_arch = await repo.list_by_user("user-1", include_archived=False)
    assert {r["id"] for r in no_arch} == {"app-ready", "app-orph"}

    no_orph = await repo.list_by_user("user-1", include_orphaned=False)
    assert {r["id"] for r in no_orph} == {"app-ready", "app-arch"}

    await close_engine()


@pytest.mark.asyncio
async def test_record_operation_accumulates_resources(tmp_path) -> None:
    repo = await _make_repo(tmp_path)
    await _create(repo)

    updated = await repo.record_operation("app-1", user_id="user-1", status="busy", resource_deltas={"scripts_run": 1, "busy_seconds": 2.5})
    assert updated is not None
    assert updated["status"] == "busy"
    assert updated["resources"] == {"scripts_run": 1, "busy_seconds": 2.5}

    updated = await repo.record_operation("app-1", user_id="user-1", resource_deltas={"scripts_run": 2})
    assert updated is not None
    assert updated["resources"]["scripts_run"] == 3
    # last_error is non-numeric → replaced, not summed
    updated = await repo.record_operation("app-1", user_id="user-1", resource_deltas={"last_error": "boom"})
    assert updated is not None
    assert updated["resources"]["last_error"] == "boom"
    assert updated["resources"]["scripts_run"] == 3

    assert await repo.record_operation("missing", user_id="user-1") is None
    assert await repo.record_operation("app-1", user_id="other") is None
    await close_engine()


@pytest.mark.asyncio
async def test_set_status_conditional(tmp_path) -> None:
    repo = await _make_repo(tmp_path)
    await _create(repo, status="ready")

    ok = await repo.set_status("app-1", user_id="user-1", to_status="stopped", allowed_from=ACTIVE_STATUSES)
    assert ok is not None
    assert ok["status"] == "stopped"

    # From a terminal status the same transition is rejected.
    again = await repo.set_status("app-1", user_id="user-1", to_status="stopped", allowed_from=ACTIVE_STATUSES)
    assert again is None
    # Empty allowed_from never matches.
    assert await repo.set_status("app-1", user_id="user-1", to_status="ready", allowed_from=()) is None
    await close_engine()


@pytest.mark.asyncio
async def test_archive_rejects_live_and_archives_terminal(tmp_path) -> None:
    repo = await _make_repo(tmp_path)
    await _create(repo, session_id="app-live", status="ready")
    await _create(repo, session_id="app-stop", status="stopped")

    assert await repo.archive("app-live", user_id="user-1") is None

    archived = await repo.archive("app-stop", user_id="user-1")
    assert archived is not None
    assert archived["status"] == "archived"
    assert archived["archived_at"] is not None
    await close_engine()


@pytest.mark.asyncio
async def test_delete(tmp_path) -> None:
    repo = await _make_repo(tmp_path)
    await _create(repo)
    assert await repo.delete("app-1", user_id="other") is False
    assert await repo.delete("app-1", user_id="user-1") is True
    assert await repo.get("app-1", user_id="user-1") is None
    await close_engine()


@pytest.mark.asyncio
async def test_mark_orphaned(tmp_path) -> None:
    repo = await _make_repo(tmp_path)
    await _create(repo, session_id="app-ready", status="ready")
    await _create(repo, session_id="app-busy", status="busy")
    await _create(repo, session_id="app-crashed", status="crashed")
    await _create(repo, session_id="app-stopped", status="stopped")
    await _create(repo, session_id="app-arch", status="archived")

    count = await repo.mark_orphaned()
    assert count == 3

    by_id = {r["id"]: r["status"] for r in await repo.list_by_user("user-1")}
    assert by_id == {
        "app-ready": "orphaned",
        "app-busy": "orphaned",
        "app-crashed": "orphaned",
        "app-stopped": "stopped",
        "app-arch": "archived",
    }
    # Idempotent: nothing left in an active status.
    assert await repo.mark_orphaned() == 0
    await close_engine()


@pytest.mark.asyncio
async def test_mark_orphaned_scoped_to_user(tmp_path) -> None:
    repo = await _make_repo(tmp_path)
    await _create(repo, session_id="app-a", user_id="user-a", status="ready")
    await _create(repo, session_id="app-b", user_id="user-b", status="ready")

    assert await repo.mark_orphaned(user_id="user-a") == 1
    assert (await repo.get("app-a", user_id="user-a"))["status"] == "orphaned"  # type: ignore[index]
    assert (await repo.get("app-b", user_id="user-b"))["status"] == "ready"  # type: ignore[index]
    await close_engine()


@pytest.mark.asyncio
async def test_cleanup_removes_old_terminal_rows_only(tmp_path) -> None:
    repo = await _make_repo(tmp_path)
    old = time.time() - 40 * 86400
    await _create(repo, session_id="app-old-arch", status="archived")
    await repo.record_operation("app-old-arch", user_id="user-1", last_active=old)
    await _create(repo, session_id="app-fresh-stop", status="stopped")
    await _create(repo, session_id="app-live", status="ready")
    await repo.record_operation("app-live", user_id="user-1", last_active=old)

    removed = await repo.cleanup(older_than_days=30)
    assert removed == 1

    remaining = {r["id"] for r in await repo.list_by_user("user-1")}
    assert remaining == {"app-fresh-stop", "app-live"}
    await close_engine()


@pytest.mark.asyncio
async def test_cleanup_rejects_negative_window(tmp_path) -> None:
    repo = await _make_repo(tmp_path)
    with pytest.raises(ValueError):
        await repo.cleanup(older_than_days=-1)
    await close_engine()


@pytest.mark.asyncio
async def test_count_by_status(tmp_path) -> None:
    repo = await _make_repo(tmp_path)
    await _create(repo, session_id="app-1", status="ready")
    await _create(repo, session_id="app-2", status="ready")
    await _create(repo, session_id="app-3", status="stopped")
    counts = await repo.count_by_status()
    assert counts == {"ready": 2, "stopped": 1}
    await close_engine()


def test_status_constants_disjoint_from_terminal() -> None:
    assert set(ACTIVE_STATUSES).issuperset(LIVE_STATUSES)
    assert not set(ACTIVE_STATUSES) & {"stopped", "orphaned", "archived"}


@pytest.mark.asyncio
async def test_records_survive_engine_restart(tmp_path) -> None:
    """A record written before a process restart is readable and can be reaped."""
    repo = await _make_repo(tmp_path)
    await _create(repo, session_id="app-survivor", status="busy")
    await repo.record_operation("app-survivor", user_id="user-1", resource_deltas={"scripts_run": 3})
    await close_engine()

    # New process: fresh engine over the same SQLite file.
    repo2 = await _make_repo(tmp_path)
    row = await repo2.get("app-survivor", user_id="user-1")
    assert row is not None
    assert row["status"] == "busy"
    assert row["resources"]["scripts_run"] == 3

    assert await repo2.mark_orphaned() == 1
    assert (await repo2.get("app-survivor", user_id="user-1"))["status"] == "orphaned"  # type: ignore[index]
    await close_engine()
