"""N7 service behavior: condition triggers, workflow targets, dedupe, retry/DLQ."""

from __future__ import annotations

from datetime import UTC, datetime, timedelta

import pytest

from app.scheduler.service import ScheduledTaskService
from deerflow.persistence.scheduled_task_runs import ActiveScheduledRunConflict, DuplicateTriggerConflict
from deerflow.runtime import RunStatus
from deerflow.runtime.runs.manager import RunRecord
from deerflow.runtime.runs.schemas import DisconnectMode

NOW = datetime(2026, 10, 14, 12, 0, 0, tzinfo=UTC)


class FakeTaskRepo:
    def __init__(self, rows):
        self.rows = rows
        self.updates = []
        self.rearms = []

    async def get(self, task_id: str, *, user_id: str):
        row = next((item for item in self.rows if item["id"] == task_id and item["user_id"] == user_id), None)
        return dict(row) if row is not None else None

    async def update(self, task_id: str, *, user_id: str, updates):
        self.updates.append((task_id, dict(updates)))
        row = next((item for item in self.rows if item["id"] == task_id), None)
        if row is not None:
            row.update(updates)
        return dict(row) if row is not None else None

    async def update_after_launch(self, *args, **kwargs):
        self.updates.append((args[0] if args else kwargs.get("task_id"), dict(kwargs)))

    async def rearm(self, task_id: str, **kwargs):
        self.rearms.append((task_id, dict(kwargs)))
        row = next((item for item in self.rows if item["id"] == task_id), None)
        if row is not None:
            row.update(kwargs)
        return None

    async def cancel_stuck_once_tasks(self, *, error):
        return 0


class FakeRunRepo:
    def __init__(self, *, create_error: Exception | None = None, raise_times: int | None = None):
        self.created = []
        self.updated = []
        self._create_error = create_error
        self._remaining_raises = raise_times

    async def create(self, **kwargs):
        self.created.append(kwargs)
        if self._create_error is not None:
            if self._remaining_raises is not None:
                if self._remaining_raises > 0:
                    self._remaining_raises -= 1
                    raise self._create_error
            else:
                raise self._create_error
        return {"id": kwargs["run_record_id"]}

    async def update_status(self, run_record_id, **kwargs):
        self.updated.append((run_record_id, dict(kwargs)))

    async def has_active_runs(self, task_id):
        return False

    async def count_active_runs(self):
        return 0


class FakeProbe:
    def __init__(self, snapshot=None, *, error: Exception | None = None):
        self.snapshot = snapshot or {}
        self.error = error
        self.calls = 0

    async def build(self, task, *, now):
        self.calls += 1
        if self.error is not None:
            raise self.error
        return dict(self.snapshot)


def _condition_task(**overrides):
    task = {
        "id": "task-file",
        "user_id": "user-1",
        "thread_id": None,
        "context_mode": "fresh_thread_per_run",
        "assistant_id": "lead_agent",
        "prompt": "Re-import {{payload.path}}",
        "schedule_type": "file",
        "schedule_spec": {"path": "/data", "mode": "modified"},
        "timezone": "UTC",
        "status": "running",
        "target_kind": "agent",
        "max_attempts": 1,
        "attempt": 0,
        "payload_template": {},
        "last_error": None,
    }
    task.update(overrides)
    return task


def _service(task_repo, run_repo, **kwargs):
    async def default_launch(**_kwargs):
        return {"run_id": "run-1", "thread_id": "th"}

    return ScheduledTaskService(
        task_repo=task_repo,
        task_run_repo=run_repo,
        launch_run=kwargs.pop("launch_run", default_launch),
        poll_interval_seconds=5,
        lease_seconds=120,
        max_concurrent_runs=3,
        **kwargs,
    )


# ── condition gate ──────────────────────────────────────────────────────────


@pytest.mark.asyncio
async def test_not_due_condition_releases_the_claim_and_launches_nothing():
    task_repo = FakeTaskRepo([_condition_task()])
    run_repo = FakeRunRepo()
    probe = FakeProbe({"files": []})
    service = _service(task_repo, run_repo, trigger_probe=probe)

    result = await service.dispatch_task(task_repo.rows[0], now=NOW, trigger="scheduled")

    assert result["outcome"] == "not_due"
    assert run_repo.created == []
    assert task_repo.rearms == [("task-file", {"status": "enabled", "attempt": 0, "next_run_at": None, "last_error": None})]


@pytest.mark.asyncio
async def test_due_condition_dispatches_with_payload_key_and_attempt_ordinal():
    task_repo = FakeTaskRepo([_condition_task(payload_template={"prompt": "Re-import {{payload.path}}"})])
    run_repo = FakeRunRepo()
    launched = {}

    async def fake_launch(**kwargs):
        launched.update(kwargs)
        return {"run_id": "run-1", "thread_id": kwargs["thread_id"]}

    probe = FakeProbe({"files": [{"path": "/data/a.fbx", "mtime": NOW.isoformat(), "created": False}]})
    service = _service(task_repo, run_repo, trigger_probe=probe, launch_run=fake_launch)

    result = await service.dispatch_task(task_repo.rows[0], now=NOW, trigger="scheduled")

    assert result["outcome"] == "launched"
    assert launched["prompt"] == "Re-import /data/a.fbx"
    assert run_repo.created[0]["dedupe_key"] == f"/data/a.fbx:{NOW.isoformat()}"
    assert run_repo.created[0]["attempt"] == 1
    assert launched["metadata"]["scheduled_dedupe_key"] == f"/data/a.fbx:{NOW.isoformat()}"


@pytest.mark.asyncio
async def test_force_bypasses_the_condition_gate_for_manual_triggers():
    task_repo = FakeTaskRepo([_condition_task(prompt="literal prompt")])
    run_repo = FakeRunRepo()
    probe = FakeProbe({"files": []})
    service = _service(task_repo, run_repo, trigger_probe=probe)

    result = await service.dispatch_task(task_repo.rows[0], now=NOW, trigger="manual", force=True)

    assert result["outcome"] == "launched"
    assert run_repo.created[0]["dedupe_key"] is None
    assert run_repo.created[0]["trigger"] == "manual"


@pytest.mark.asyncio
async def test_duplicate_trigger_records_a_skip_without_a_second_row():
    task_repo = FakeTaskRepo([_condition_task()])
    run_repo = FakeRunRepo(create_error=DuplicateTriggerConflict("task-file", "fbx:1"))
    probe = FakeProbe({"files": [{"path": "/data/a.fbx", "mtime": NOW.isoformat(), "created": False}]})
    service = _service(task_repo, run_repo, trigger_probe=probe)

    result = await service.dispatch_task(task_repo.rows[0], now=NOW, trigger="scheduled")

    assert result["outcome"] == "skipped"
    assert len(run_repo.created) == 1
    assert task_repo.rearms[0][1]["last_error"].startswith("skipped: this trigger occurrence")


@pytest.mark.asyncio
async def test_duplicate_trigger_on_manual_trigger_returns_conflict():
    task_repo = FakeTaskRepo([_condition_task()])
    run_repo = FakeRunRepo(create_error=DuplicateTriggerConflict("task-file", "fbx:1"))
    probe = FakeProbe({"files": [{"path": "/data/a.fbx", "mtime": NOW.isoformat(), "created": False}]})
    service = _service(task_repo, run_repo, trigger_probe=probe)

    result = await service.dispatch_task(task_repo.rows[0], now=NOW, trigger="manual")

    assert result["outcome"] == "conflict"
    assert task_repo.rearms == []


@pytest.mark.asyncio
async def test_active_run_conflict_still_uses_the_skip_tombstone_path():
    task_repo = FakeTaskRepo([_condition_task()])
    run_repo = FakeRunRepo(create_error=ActiveScheduledRunConflict("task-file"), raise_times=1)
    probe = FakeProbe({"files": [{"path": "/data/a.fbx", "mtime": NOW.isoformat(), "created": False}]})
    service = _service(task_repo, run_repo, trigger_probe=probe)

    result = await service.dispatch_task(task_repo.rows[0], now=NOW, trigger="scheduled")
    assert result["outcome"] == "skipped"
    # The overlap path stamps a skipped tombstone (a real second create call).
    assert len(run_repo.created) == 2


@pytest.mark.asyncio
async def test_probe_failure_is_recorded_as_a_task_failure():
    task_repo = FakeTaskRepo([_condition_task()])
    run_repo = FakeRunRepo()
    service = _service(task_repo, run_repo, trigger_probe=FakeProbe(error=OSError("stat failed")))

    result = await service.dispatch_task(task_repo.rows[0], now=NOW, trigger="scheduled")

    assert result["outcome"] == "failed"
    assert "stat failed" in result["error"]
    assert run_repo.created == []
    assert task_repo.updates[0][1]["last_error"] == "stat failed"


# ── workflow target ─────────────────────────────────────────────────────────


@pytest.mark.asyncio
async def test_workflow_target_renders_params_and_calls_the_launcher():
    task = _condition_task(
        target_kind="workflow",
        target_definition_id="wf-1",
        payload_template={"input_path": "{{payload.path}}", "count": "{{payload.count}}", "at": "{{now}}"},
    )
    task_repo = FakeTaskRepo([task])
    run_repo = FakeRunRepo()
    calls = {}

    async def fake_workflow(**kwargs):
        calls.update(kwargs)
        return {"run_id": "run-wf", "thread_id": kwargs["thread_id"]}

    probe = FakeProbe({"files": [{"path": "/data/a.fbx", "mtime": NOW.isoformat(), "created": False, "count": 2}]})
    service = _service(task_repo, run_repo, trigger_probe=probe, launch_workflow=fake_workflow)

    result = await service.dispatch_task(task_repo.rows[0], now=NOW, trigger="scheduled")

    assert result["outcome"] == "launched"
    assert calls["definition_id"] == "wf-1"
    assert calls["params"] == {"input_path": "/data/a.fbx", "count": 1, "at": NOW.isoformat()}
    assert calls["metadata"]["scheduled_task_id"] == "task-file"


@pytest.mark.asyncio
async def test_workflow_target_without_a_launcher_fails_loudly():
    task_repo = FakeTaskRepo([_condition_task(target_kind="workflow", target_definition_id="wf-1")])
    run_repo = FakeRunRepo()
    probe = FakeProbe({"files": [{"path": "/data/a.fbx", "mtime": NOW.isoformat(), "created": False}]})
    service = _service(task_repo, run_repo, trigger_probe=probe)

    result = await service.dispatch_task(task_repo.rows[0], now=NOW, trigger="scheduled")

    assert result["outcome"] == "failed"
    assert "workflow launcher" in result["error"]


# ── retry / DLQ ─────────────────────────────────────────────────────────────


@pytest.mark.asyncio
async def test_launch_failure_retries_with_backoff_when_attempts_remain():
    task_repo = FakeTaskRepo([_condition_task(max_attempts=3, target_kind="workflow", target_definition_id=None)])
    run_repo = FakeRunRepo()
    probe = FakeProbe({"files": [{"path": "/data/a.fbx", "mtime": NOW.isoformat(), "created": False}]})
    service = _service(task_repo, run_repo, trigger_probe=probe, retry_backoff_seconds=60)

    result = await service.dispatch_task(task_repo.rows[0], now=NOW, trigger="scheduled")

    assert result["outcome"] == "failed"
    task_id, kwargs = task_repo.rearms[0]
    assert (task_id, kwargs["status"], kwargs["attempt"]) == ("task-file", "enabled", 1)
    assert kwargs["next_run_at"] == NOW + timedelta(seconds=60)


@pytest.mark.asyncio
async def test_launch_failure_dead_letters_when_attempts_are_exhausted():
    task_repo = FakeTaskRepo([_condition_task(max_attempts=2, attempt=1, target_kind="workflow", target_definition_id=None)])
    run_repo = FakeRunRepo()
    probe = FakeProbe({"files": [{"path": "/data/a.fbx", "mtime": NOW.isoformat(), "created": False}]})
    service = _service(task_repo, run_repo, trigger_probe=probe)

    await service.dispatch_task(task_repo.rows[0], now=NOW, trigger="scheduled")

    assert task_repo.rearms[0][1]["status"] == "dead_lettered"
    assert task_repo.rearms[0][1]["attempt"] == 2


@pytest.mark.asyncio
async def test_manual_trigger_failure_never_consumes_retry_budget():
    task_repo = FakeTaskRepo([_condition_task(max_attempts=3, target_kind="workflow", target_definition_id=None)])
    run_repo = FakeRunRepo()
    probe = FakeProbe({"files": [{"path": "/data/a.fbx", "mtime": NOW.isoformat(), "created": False}]})
    service = _service(task_repo, run_repo, trigger_probe=probe)

    await service.dispatch_task(task_repo.rows[0], now=NOW, trigger="manual")

    assert task_repo.rearms == []
    # Legacy bookkeeping: a manual failure leaves the existing status alone.
    assert task_repo.updates[-1][1]["status"] == "running"


@pytest.mark.asyncio
async def test_completion_failure_retries_then_dead_letters():
    row = _condition_task(schedule_type="cron", schedule_spec={"cron": "0 9 * * *"}, max_attempts=3, attempt=1)
    task_repo = FakeTaskRepo([row])
    run_repo = FakeRunRepo()
    service = _service(task_repo, run_repo)

    record = RunRecord(
        run_id="run-1",
        thread_id="th",
        assistant_id="lead_agent",
        status=RunStatus.error,
        on_disconnect=DisconnectMode.continue_,
        metadata={"scheduled_task_id": "task-file", "scheduled_task_run_id": "tr-1", "scheduled_trigger": "scheduled"},
        user_id="user-1",
        error="boom",
    )
    await service.handle_run_completion(record)

    assert task_repo.rearms[0][1]["status"] == "enabled"
    assert task_repo.rearms[0][1]["attempt"] == 2
    assert task_repo.rearms[0][1]["next_run_at"] > datetime.now(UTC)

    # Next failure exhausts the budget.
    task_repo.rearms.clear()
    task_repo.rows[0]["attempt"] = 2
    await service.handle_run_completion(record)
    assert task_repo.rearms[0][1]["status"] == "dead_lettered"
    assert task_repo.rearms[0][1]["attempt"] == 3


@pytest.mark.asyncio
async def test_completion_failure_without_opt_in_keeps_legacy_status():
    row = _condition_task(schedule_type="cron", schedule_spec={"cron": "0 9 * * *"})
    task_repo = FakeTaskRepo([row])
    run_repo = FakeRunRepo()
    service = _service(task_repo, run_repo)

    record = RunRecord(
        run_id="run-1",
        thread_id="th",
        assistant_id="lead_agent",
        status=RunStatus.error,
        on_disconnect=DisconnectMode.continue_,
        metadata={"scheduled_task_id": "task-file", "scheduled_task_run_id": "tr-1", "scheduled_trigger": "scheduled"},
        user_id="user-1",
        error="boom",
    )
    await service.handle_run_completion(record)

    assert task_repo.rearms == []
    assert task_repo.updates[-1][1] == {"last_error": "boom"}


@pytest.mark.asyncio
async def test_completion_success_resets_the_failure_streak():
    row = _condition_task(schedule_type="cron", schedule_spec={"cron": "0 9 * * *"}, attempt=2, max_attempts=3)
    task_repo = FakeTaskRepo([row])
    service = _service(task_repo, FakeRunRepo())

    record = RunRecord(
        run_id="run-1",
        thread_id="th",
        assistant_id="lead_agent",
        status=RunStatus.success,
        on_disconnect=DisconnectMode.continue_,
        metadata={"scheduled_task_id": "task-file", "scheduled_task_run_id": "tr-1", "scheduled_trigger": "scheduled"},
        user_id="user-1",
    )
    await service.handle_run_completion(record)

    assert task_repo.updates[-1][1] == {"last_error": None, "attempt": 0}
