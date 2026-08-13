"""Tests for HumanTaskRepository — CRUD, isolation, conditional-transition safety."""

from __future__ import annotations

import asyncio

import pytest

from deerflow.config.database_config import DatabaseConfig
from deerflow.persistence.engine import close_engine, get_session_factory, init_engine_from_config
from deerflow.persistence.human_tasks import HumanTaskRepository
from deerflow.persistence.human_tasks.sql import _allowed_sources


async def _make_repo(tmp_path) -> HumanTaskRepository:
    """Init a real SQLite engine and return a HumanTaskRepository over it."""
    await init_engine_from_config(DatabaseConfig(backend="sqlite", sqlite_dir=str(tmp_path)))
    sf = get_session_factory()
    assert sf is not None
    return HumanTaskRepository(sf)


async def _create(
    repo: HumanTaskRepository,
    *,
    user_id: str = "user-1",
    workflow_run_id: str = "wf-run-1",
    node_id: str = "node-1",
    description: str = "Approve the change",
) -> dict:
    return await repo.create(user_id=user_id, workflow_run_id=workflow_run_id, node_id=node_id, description=description)


# ── 纯函数：合法源集推导 ────────────────────────────────────────────────────


def test_allowed_sources_derivation() -> None:
    """_allowed_sources derives legal source statuses from ALLOWED_TRANSITIONS."""
    assert _allowed_sources("submitted") == ["pending", "reopened"]
    assert _allowed_sources("skipped") == ["pending", "reopened"]
    assert _allowed_sources("expired") == ["pending", "reopened"]
    assert _allowed_sources("reopened") == ["pending", "reopened"]
    assert _allowed_sources("pending") == []
    assert _allowed_sources("bogus") == []


# ── CRUD 往返 ────────────────────────────────────────────────────────────────


@pytest.mark.asyncio
async def test_create_get_roundtrip(tmp_path) -> None:
    repo = await _make_repo(tmp_path)
    created = await _create(repo)
    assert created["id"].startswith("ht-")
    assert created["status"] == "pending"
    assert created["description"] == "Approve the change"
    assert created["inputs_snapshot"] == {}
    assert created["output_spec"] == {}
    assert created["validation_rules"] == {}
    assert created["checkpoint_ref"] is None
    assert created["submission"] is None
    assert isinstance(created["created_at"], str)
    assert isinstance(created["updated_at"], str)

    fetched = await repo.get(created["id"], user_id="user-1")
    assert fetched is not None
    assert fetched["id"] == created["id"]
    assert fetched["status"] == "pending"
    await close_engine()


@pytest.mark.asyncio
async def test_get_user_isolation(tmp_path) -> None:
    repo = await _make_repo(tmp_path)
    created = await _create(repo, user_id="user-a")
    assert await repo.get(created["id"], user_id="user-b") is None
    assert await repo.get(created["id"], user_id="user-a") is not None
    await close_engine()


@pytest.mark.asyncio
async def test_list_by_user_scopes_and_orders(tmp_path) -> None:
    repo = await _make_repo(tmp_path)
    ids = []
    for i in range(3):
        created = await _create(repo, user_id="user-a", workflow_run_id=f"wf-run-{i}", node_id=f"node-{i}")
        ids.append(created["id"])
    await _create(repo, user_id="user-b", workflow_run_id="wf-run-b")

    listed_a = await repo.list_by_user("user-a")
    assert [item["id"] for item in listed_a] == list(reversed(ids))
    listed_b = await repo.list_by_user("user-b")
    assert len(listed_b) == 1
    await close_engine()


@pytest.mark.asyncio
async def test_list_by_user_status_filter(tmp_path) -> None:
    repo = await _make_repo(tmp_path)
    a = await _create(repo, node_id="node-a")
    b = await _create(repo, node_id="node-b")
    await repo.submit(a["id"], user_id="user-1", values={"decision": "approve"}, to_status="submitted")

    pending = await repo.list_by_user("user-1", status="pending")
    submitted = await repo.list_by_user("user-1", status="submitted")
    assert [item["id"] for item in pending] == [b["id"]]
    assert [item["id"] for item in submitted] == [a["id"]]
    await close_engine()


# ── submit：成功 / 非法转移 / 并发 ───────────────────────────────────────────


@pytest.mark.asyncio
async def test_submit_success(tmp_path) -> None:
    repo = await _make_repo(tmp_path)
    created = await _create(repo)
    await asyncio.sleep(0.01)
    result = await repo.submit(created["id"], user_id="user-1", values={"decision": "approve"}, to_status="submitted")
    assert result is not None
    assert result["status"] == "submitted"
    assert result["submission"] == {"decision": "approve"}
    assert result["updated_at"] != created["updated_at"]
    await close_engine()


@pytest.mark.asyncio
async def test_submit_invalid_transition_rejected(tmp_path) -> None:
    repo = await _make_repo(tmp_path)
    created = await _create(repo)
    submitted = await repo.submit(created["id"], user_id="user-1", values={"x": 1}, to_status="submitted")
    assert submitted is not None
    # submitted is terminal — a further submit or skip is rejected.
    assert await repo.submit(created["id"], user_id="user-1", values={"x": 2}, to_status="submitted") is None
    assert await repo.skip(created["id"], user_id="user-1") is None
    await close_engine()


@pytest.mark.asyncio
async def test_submit_double_submit_second_rejected(tmp_path) -> None:
    """Two sequential submits on one task: the second loses the conditional UPDATE."""
    repo = await _make_repo(tmp_path)
    created = await _create(repo)
    first = await repo.submit(created["id"], user_id="user-1", values={"x": 1}, to_status="submitted")
    assert first is not None
    assert first["status"] == "submitted"

    second = await repo.submit(created["id"], user_id="user-1", values={"x": 2}, to_status="submitted")
    assert second is None

    # First writer's submission value is preserved.
    fetched = await repo.get(created["id"], user_id="user-1")
    assert fetched is not None
    assert fetched["submission"] == {"x": 1}
    await close_engine()


# ── reopen ────────────────────────────────────────────────────────────────────


@pytest.mark.asyncio
async def test_reopen_from_pending(tmp_path) -> None:
    """A pending task can be reopened (a failed submission is rejected back)."""
    repo = await _make_repo(tmp_path)
    created = await _create(repo)
    result = await repo.reopen(created["id"], user_id="user-1")
    assert result is not None
    assert result["status"] == "reopened"
    # Terminal statuses cannot be reopened.
    other = await _create(repo)
    await repo.submit(other["id"], user_id="user-1", values={"x": 1}, to_status="submitted")
    assert await repo.reopen(other["id"], user_id="user-1") is None
    await close_engine()


@pytest.mark.asyncio
async def test_reopened_task_can_be_resubmitted(tmp_path) -> None:
    """A task in reopened state is a legal source for submit."""
    repo = await _make_repo(tmp_path)
    created = await _create(repo)
    reopened = await repo.reopen(created["id"], user_id="user-1")
    assert reopened is not None

    result = await repo.submit(created["id"], user_id="user-1", values={"decision": "approve"}, to_status="submitted")
    assert result is not None
    assert result["status"] == "submitted"
    assert result["submission"] == {"decision": "approve"}
    await close_engine()


# ── skip / mark_expired ──────────────────────────────────────────────────────


@pytest.mark.asyncio
async def test_skip_success_and_invalid_transition(tmp_path) -> None:
    repo = await _make_repo(tmp_path)
    created = await _create(repo)
    result = await repo.skip(created["id"], user_id="user-1")
    assert result is not None
    assert result["status"] == "skipped"
    # skipped is terminal.
    assert await repo.skip(created["id"], user_id="user-1") is None
    # user isolation on transition.
    other = await _create(repo, user_id="user-b")
    assert await repo.skip(other["id"], user_id="user-a") is None
    await close_engine()


@pytest.mark.asyncio
async def test_mark_expired_success_and_invalid_transition(tmp_path) -> None:
    repo = await _make_repo(tmp_path)
    created = await _create(repo)
    result = await repo.mark_expired(created["id"], user_id="user-1")
    assert result is not None
    assert result["status"] == "expired"
    # expired is terminal.
    assert await repo.mark_expired(created["id"], user_id="user-1") is None
    assert await repo.submit(created["id"], user_id="user-1", values={"x": 1}, to_status="submitted") is None
    await close_engine()


# ── delete + 隔离 ────────────────────────────────────────────────────────────


@pytest.mark.asyncio
async def test_delete_and_user_isolation(tmp_path) -> None:
    repo = await _make_repo(tmp_path)
    created = await _create(repo, user_id="user-a")
    assert await repo.delete(created["id"], user_id="user-b") is False
    assert await repo.get(created["id"], user_id="user-a") is not None
    assert await repo.delete(created["id"], user_id="user-a") is True
    assert await repo.get(created["id"], user_id="user-a") is None
    await close_engine()


# ── find_by_run_and_node ─────────────────────────────────────────────────────


@pytest.mark.asyncio
async def test_find_by_run_and_node_returns_none_when_absent(tmp_path) -> None:
    repo = await _make_repo(tmp_path)
    assert await repo.find_by_run_and_node(run_id="missing-run", node_id="node-1") is None
    await close_engine()


@pytest.mark.asyncio
async def test_find_by_run_and_node_returns_latest(tmp_path) -> None:
    repo = await _make_repo(tmp_path)
    await _create(repo, workflow_run_id="run-x", node_id="node-a")
    await asyncio.sleep(0.01)
    second = await _create(repo, workflow_run_id="run-x", node_id="node-a")
    await _create(repo, workflow_run_id="run-x", node_id="node-b")

    found = await repo.find_by_run_and_node(run_id="run-x", node_id="node-a")
    assert found is not None
    assert found["id"] == second["id"]
    await close_engine()


@pytest.mark.asyncio
async def test_find_by_run_and_node_scoped_to_run(tmp_path) -> None:
    """A task with the same node_id but a different run is not returned."""
    repo = await _make_repo(tmp_path)
    await _create(repo, workflow_run_id="run-1", node_id="node-a")
    assert await repo.find_by_run_and_node(run_id="run-2", node_id="node-a") is None
    await close_engine()


# ── delete_pending_by_run（补偿）────────────────────────────────────────────


@pytest.mark.asyncio
async def test_delete_pending_by_run_only_pending_unrefed(tmp_path) -> None:
    """Only pending rows with checkpoint_ref IS NULL are deleted."""
    repo = await _make_repo(tmp_path)
    pending = await _create(repo, workflow_run_id="run-del", node_id="node-1")
    submitted = await _create(repo, workflow_run_id="run-del", node_id="node-2")
    await repo.submit(submitted["id"], user_id="user-1", values={"x": 1}, to_status="submitted")

    deleted = await repo.delete_pending_by_run(run_id="run-del")
    assert deleted == 1
    assert await repo.get(pending["id"], user_id="user-1") is None
    assert await repo.get(submitted["id"], user_id="user-1") is not None
    await close_engine()


@pytest.mark.asyncio
async def test_delete_pending_by_run_skips_backfilled(tmp_path) -> None:
    """A pending row whose checkpoint_ref was backfilled (did hang) is not deleted."""
    repo = await _make_repo(tmp_path)
    backfilled = await _create(repo, workflow_run_id="run-bf", node_id="node-1")
    await repo.update_checkpoint_ref_by_run(run_id="run-bf", checkpoint_ref={"thread_id": "t", "checkpoint_id": "cp-1"})

    deleted = await repo.delete_pending_by_run(run_id="run-bf")
    assert deleted == 0
    assert await repo.get(backfilled["id"], user_id="user-1") is not None
    await close_engine()


@pytest.mark.asyncio
async def test_delete_pending_by_run_scoped_to_run(tmp_path) -> None:
    """A pending task in another run is not deleted."""
    repo = await _make_repo(tmp_path)
    other = await _create(repo, workflow_run_id="run-other", node_id="node-1")

    deleted = await repo.delete_pending_by_run(run_id="run-target")
    assert deleted == 0
    assert await repo.get(other["id"], user_id="user-1") is not None
    await close_engine()
