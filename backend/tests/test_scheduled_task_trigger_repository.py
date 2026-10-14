"""Repository-level tests for N7 triggers: conditional claims, dedupe, retry re-arm."""

from __future__ import annotations

from datetime import UTC, datetime, timedelta

import pytest

from deerflow.config.database_config import DatabaseConfig
from deerflow.persistence.engine import close_engine, get_session_factory, init_engine_from_config
from deerflow.persistence.scheduled_task_runs import (
    ActiveScheduledRunConflict,
    DuplicateTriggerConflict,
    ScheduledTaskRunRepository,
)
from deerflow.persistence.scheduled_tasks import ScheduledTaskRepository


async def _repos(tmp_path):
    await init_engine_from_config(DatabaseConfig(backend="sqlite", sqlite_dir=str(tmp_path)))
    sf = get_session_factory()
    assert sf is not None
    return ScheduledTaskRepository(sf), ScheduledTaskRunRepository(sf)


async def _create_task(repo, task_id: str, *, schedule_type: str, next_run_at, schedule_spec=None, **kwargs):
    return await repo.create(
        task_id=task_id,
        user_id="user-1",
        thread_id="thread-1",
        context_mode="reuse_thread",
        assistant_id="lead_agent",
        title=task_id,
        prompt="Prompt",
        schedule_type=schedule_type,
        schedule_spec=schedule_spec if schedule_spec is not None else ({"cron": "0 9 * * *"} if schedule_type == "cron" else {"path": "/data"}),
        timezone="UTC",
        next_run_at=next_run_at,
        **kwargs,
    )


# ── conditional claims ──────────────────────────────────────────────────────


@pytest.mark.asyncio
async def test_claim_due_tasks_claims_condition_driven_rows_without_next_run_at(tmp_path):
    task_repo, _ = await _repos(tmp_path)
    await _create_task(task_repo, "file-1", schedule_type="file", next_run_at=None)

    claimed = await task_repo.claim_due_tasks(now=datetime.now(UTC), lease_owner="w1", lease_seconds=60, limit=10)
    assert [task["id"] for task in claimed] == ["file-1"]
    assert claimed[0]["target_kind"] == "agent"
    assert claimed[0]["max_attempts"] == 1
    await close_engine()


@pytest.mark.asyncio
async def test_claim_orders_time_based_before_condition_driven(tmp_path):
    """A steady stream of conditional rows must not starve scheduled deadlines."""
    task_repo, _ = await _repos(tmp_path)
    now = datetime.now(UTC)
    await _create_task(task_repo, "cond-1", schedule_type="idle", next_run_at=None, schedule_spec={"idle_seconds": 60})
    await _create_task(task_repo, "time-1", schedule_type="cron", next_run_at=now - timedelta(minutes=5))

    claimed = await task_repo.claim_due_tasks(now=now, lease_owner="w1", lease_seconds=60, limit=10)
    assert [task["id"] for task in claimed] == ["time-1", "cond-1"]

    # Budget is shared: a limit of 1 spends it on the deadline, not the condition.
    await task_repo.rearm("cond-1", status="enabled", attempt=0, next_run_at=None, last_error=None)
    await task_repo.rearm("time-1", status="enabled", attempt=0, next_run_at=now - timedelta(minutes=4), last_error=None)
    claimed_one = await task_repo.claim_due_tasks(now=now, lease_owner="w2", lease_seconds=60, limit=1)
    assert [task["id"] for task in claimed_one] == ["time-1"]
    await close_engine()


@pytest.mark.asyncio
async def test_dead_lettered_task_is_not_claimable(tmp_path):
    task_repo, _ = await _repos(tmp_path)
    now = datetime.now(UTC)
    await _create_task(task_repo, "dl-1", schedule_type="cron", next_run_at=now - timedelta(minutes=1))
    await task_repo.rearm("dl-1", status="dead_lettered", attempt=3, next_run_at=now - timedelta(minutes=1), last_error="boom")

    assert await task_repo.claim_due_tasks(now=now, lease_owner="w1", lease_seconds=60, limit=10) == []
    await close_engine()


@pytest.mark.asyncio
async def test_rearm_requeues_dead_lettered_task_without_touching_run_bookkeeping(tmp_path):
    task_repo, _ = await _repos(tmp_path)
    now = datetime.now(UTC)
    await _create_task(task_repo, "dl-2", schedule_type="cron", next_run_at=now - timedelta(minutes=1))
    await task_repo.update_after_launch(
        "dl-2",
        status="enabled",
        next_run_at=now - timedelta(minutes=1),
        last_run_at=now,
        last_run_id="run-1",
        last_thread_id="thread-1",
        last_error="boom",
        increment_run_count=True,
    )
    await task_repo.rearm("dl-2", status="dead_lettered", attempt=3, next_run_at=now, last_error="boom")

    requeued = await task_repo.rearm("dl-2", status="enabled", attempt=0, next_run_at=now - timedelta(seconds=1), last_error=None)
    assert requeued is None
    task = await task_repo.get("dl-2", user_id="user-1")
    assert task is not None
    assert task["status"] == "enabled"
    assert task["attempt"] == 0
    assert task["last_error"] is None
    # The failed run's identity survives a requeue; only retry state is reset.
    assert task["last_run_id"] == "run-1"
    assert task["run_count"] == 1
    assert [t["id"] for t in await task_repo.claim_due_tasks(now=now, lease_owner="w1", lease_seconds=60, limit=10)] == ["dl-2"]
    await close_engine()


# ── trigger dedupe ──────────────────────────────────────────────────────────


@pytest.mark.asyncio
async def test_duplicate_dedupe_key_is_rejected_per_task(tmp_path):
    _, run_repo = await _repos(tmp_path)
    now = datetime.now(UTC)
    await run_repo.create(run_record_id="r1", task_id="t1", thread_id="th1", scheduled_for=now, trigger="scheduled", status="running", dedupe_key="fbx:100")

    with pytest.raises(DuplicateTriggerConflict):
        await run_repo.create(run_record_id="r2", task_id="t1", thread_id="th2", scheduled_for=now, trigger="scheduled", status="running", dedupe_key="fbx:100")
    await close_engine()


@pytest.mark.asyncio
async def test_duplicate_dedupe_key_detected_against_terminal_row(tmp_path):
    """A recorded trigger stays recorded even after its run row is terminal."""
    _, run_repo = await _repos(tmp_path)
    now = datetime.now(UTC)
    await run_repo.create(run_record_id="r1", task_id="t1", thread_id="th1", scheduled_for=now, trigger="scheduled", status="running", dedupe_key="s:stopped")
    await run_repo.update_status("r1", status="success", finished_at=now)

    with pytest.raises(DuplicateTriggerConflict):
        await run_repo.create(run_record_id="r2", task_id="t1", thread_id="th2", scheduled_for=now, trigger="scheduled", status="skipped", dedupe_key="s:stopped")
    await close_engine()


@pytest.mark.asyncio
async def test_dedupe_key_is_scoped_to_task_and_null_keys_repeat(tmp_path):
    _, run_repo = await _repos(tmp_path)
    now = datetime.now(UTC)
    await run_repo.create(run_record_id="r1", task_id="t1", thread_id="th1", scheduled_for=now, trigger="scheduled", status="running", dedupe_key="fbx:100")
    # Same key on another task is a different occurrence.
    await run_repo.create(run_record_id="r2", task_id="t2", thread_id="th2", scheduled_for=now, trigger="scheduled", status="running", dedupe_key="fbx:100")
    # NULL dedupe keys (once/cron) never conflict with each other.
    await run_repo.create(run_record_id="r3", task_id="t3", thread_id="th3", scheduled_for=now, trigger="scheduled", status="running")
    await run_repo.create(run_record_id="r4", task_id="t3", thread_id="th3", scheduled_for=now, trigger="manual", status="skipped")
    await close_engine()


@pytest.mark.asyncio
async def test_active_conflict_still_raises_when_no_dedupe_key_is_set(tmp_path):
    _, run_repo = await _repos(tmp_path)
    now = datetime.now(UTC)
    await run_repo.create(run_record_id="r1", task_id="t1", thread_id="th1", scheduled_for=now, trigger="scheduled", status="queued")

    with pytest.raises(ActiveScheduledRunConflict):
        await run_repo.create(run_record_id="r2", task_id="t1", thread_id="th2", scheduled_for=now, trigger="scheduled", status="queued")
    await close_engine()


@pytest.mark.asyncio
async def test_run_row_records_attempt_ordinal(tmp_path):
    _, run_repo = await _repos(tmp_path)
    now = datetime.now(UTC)
    await run_repo.create(run_record_id="r1", task_id="t1", thread_id="th1", scheduled_for=now, trigger="scheduled", status="running", attempt=2)
    rows = await run_repo.list_by_task("t1")
    assert rows[0]["attempt"] == 2
    await run_repo.update_status("r1", status="failed", attempt=3, error="boom")
    assert (await run_repo.list_by_task("t1"))[0]["attempt"] == 3
    await close_engine()
