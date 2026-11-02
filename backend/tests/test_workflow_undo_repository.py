"""Tests for WorkflowUndoRepository — CRUD, run scoping, conditional transitions."""

from __future__ import annotations

import time

import pytest

from deerflow.config.database_config import DatabaseConfig
from deerflow.persistence.engine import close_engine, get_session_factory, init_engine_from_config
from deerflow.persistence.workflow_undo import WorkflowUndoRepository
from deerflow.persistence.workflow_undo.sql import _allowed_sources
from deerflow.workflow.undo import UndoKind, UndoStatus


async def _make_repo(tmp_path) -> WorkflowUndoRepository:
    await init_engine_from_config(DatabaseConfig(backend="sqlite", sqlite_dir=str(tmp_path)))
    sf = get_session_factory()
    assert sf is not None
    return WorkflowUndoRepository(sf)


async def _create(repo: WorkflowUndoRepository, *, node_id: str = "a1", run_id: str = "run-1", user_id: str = "user-1", **kwargs) -> dict:
    return await repo.create(
        user_id=user_id,
        run_id=run_id,
        node_id=node_id,
        kind=kwargs.pop("kind", UndoKind.FILE_BACKUP.value),
        targets=kwargs.pop("targets", [{"path": "/mnt/user-data/workspace/a.txt", "scope": "workspace"}]),
        backup_paths=kwargs.pop("backup_paths", ["/tmp/undo/a.txt"]),
        **kwargs,
    )


# ── pure: legal source statuses ───────────────────────────────────────────────


def test_allowed_sources_derivation() -> None:
    assert _allowed_sources("undone") == ["recorded"]
    assert _allowed_sources("failed") == ["recorded"]
    assert _allowed_sources("skipped") == ["recorded"]
    assert _allowed_sources("recorded") == []  # recorded is a source, never a target
    assert _allowed_sources("bogus") == []


# ── create / read ─────────────────────────────────────────────────────────────


@pytest.mark.asyncio
async def test_create_and_get(tmp_path) -> None:
    repo = await _make_repo(tmp_path)
    try:
        row = await _create(repo, detail="before import")

        assert row["id"].startswith("undo-")
        assert row["status"] == UndoStatus.RECORDED.value
        assert row["kind"] == "file_backup"
        assert row["backup_paths"] == ["/tmp/undo/a.txt"]
        assert row["created_at"] is not None

        fetched = await repo.get(row["id"], user_id="user-1")
        assert fetched is not None
        assert fetched["node_id"] == "a1"
    finally:
        await close_engine()


@pytest.mark.asyncio
async def test_get_is_user_scoped(tmp_path) -> None:
    repo = await _make_repo(tmp_path)
    try:
        row = await _create(repo)

        assert await repo.get(row["id"], user_id="someone-else") is None
    finally:
        await close_engine()


@pytest.mark.asyncio
async def test_app_undo_fields_are_stored(tmp_path) -> None:
    repo = await _make_repo(tmp_path)
    try:
        row = await _create(repo, kind=UndoKind.APP_UNDO.value, session_id="sess-1", app_steps=3, targets=[], backup_paths=[])

        assert row["kind"] == "app_undo"
        assert row["session_id"] == "sess-1"
        assert row["app_steps"] == 3
    finally:
        await close_engine()


# ── list_by_run ───────────────────────────────────────────────────────────────


@pytest.mark.asyncio
async def test_list_by_run_is_oldest_first(tmp_path) -> None:
    repo = await _make_repo(tmp_path)
    try:
        await _create(repo, node_id="a1")
        time.sleep(0.005)  # distinct created_at — ids are random, so a tie has no defined order
        await _create(repo, node_id="a2")
        time.sleep(0.005)
        await _create(repo, node_id="a3")

        rows = await repo.list_by_run("run-1", user_id="user-1")

        assert [r["node_id"] for r in rows] == ["a1", "a2", "a3"]
        timestamps = [r["created_at"] for r in rows]
        assert timestamps == sorted(timestamps), "the ordering must be chronological"
    finally:
        await close_engine()


@pytest.mark.asyncio
async def test_list_by_run_excludes_other_runs_and_users(tmp_path) -> None:
    repo = await _make_repo(tmp_path)
    try:
        await _create(repo, node_id="a1", run_id="run-1")
        await _create(repo, node_id="a2", run_id="run-2")
        await _create(repo, node_id="a3", run_id="run-1", user_id="user-2")

        mine = await repo.list_by_run("run-1", user_id="user-1")
        everything = await repo.list_by_run("run-1")

        assert [r["node_id"] for r in mine] == ["a1"]
        assert {r["node_id"] for r in everything} == {"a1", "a3"}
    finally:
        await close_engine()


# ── conditional transitions ───────────────────────────────────────────────────


@pytest.mark.asyncio
async def test_mark_undone(tmp_path) -> None:
    repo = await _make_repo(tmp_path)
    try:
        row = await _create(repo)

        updated = await repo.mark(row["id"], user_id="user-1", to_status=UndoStatus.UNDONE.value, detail="rolled back")

        assert updated is not None
        assert updated["status"] == "undone"
        assert updated["detail"] == "rolled back"
    finally:
        await close_engine()


@pytest.mark.asyncio
async def test_mark_is_not_repeatable(tmp_path) -> None:
    """Two concurrent undo requests must not both apply the same compensation."""
    repo = await _make_repo(tmp_path)
    try:
        row = await _create(repo)
        assert await repo.mark(row["id"], user_id="user-1", to_status=UndoStatus.UNDONE.value) is not None

        assert await repo.mark(row["id"], user_id="user-1", to_status=UndoStatus.UNDONE.value) is None
    finally:
        await close_engine()


@pytest.mark.asyncio
async def test_mark_rejects_an_unknown_target_status(tmp_path) -> None:
    repo = await _make_repo(tmp_path)
    try:
        row = await _create(repo)

        assert await repo.mark(row["id"], user_id="user-1", to_status="recorded") is None
        assert await repo.mark(row["id"], user_id="user-1", to_status="teleported") is None
    finally:
        await close_engine()


@pytest.mark.asyncio
async def test_mark_is_user_scoped(tmp_path) -> None:
    repo = await _make_repo(tmp_path)
    try:
        row = await _create(repo)

        assert await repo.mark(row["id"], user_id="someone-else", to_status=UndoStatus.UNDONE.value) is None
        assert (await repo.get(row["id"], user_id="user-1"))["status"] == "recorded"
    finally:
        await close_engine()


@pytest.mark.asyncio
async def test_failed_record_is_terminal(tmp_path) -> None:
    repo = await _make_repo(tmp_path)
    try:
        row = await _create(repo)
        await repo.mark(row["id"], user_id="user-1", to_status=UndoStatus.FAILED.value, detail="backup gone")

        assert await repo.mark(row["id"], user_id="user-1", to_status=UndoStatus.UNDONE.value) is None
    finally:
        await close_engine()
