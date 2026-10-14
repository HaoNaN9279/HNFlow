"""Router-level tests for N7 scheduled-task triggers (new types, targets, requeue)."""

from __future__ import annotations

from datetime import UTC, datetime, timedelta
from types import SimpleNamespace
from unittest.mock import AsyncMock

import pytest
from fastapi import HTTPException

from app.gateway.routers import scheduled_tasks


class _Repo:
    def __init__(self) -> None:
        self.created = []
        self.rearms = []
        self.items = {}

    async def create(self, **kwargs):
        item = {
            "id": kwargs["task_id"],
            "user_id": kwargs["user_id"],
            "thread_id": kwargs["thread_id"],
            "context_mode": kwargs["context_mode"],
            "title": kwargs["title"],
            "prompt": kwargs["prompt"],
            "schedule_type": kwargs["schedule_type"],
            "schedule_spec": kwargs["schedule_spec"],
            "timezone": kwargs["timezone"],
            "next_run_at": kwargs["next_run_at"],
            "target_kind": kwargs.get("target_kind", "agent"),
            "target_definition_id": kwargs.get("target_definition_id"),
            "payload_template": kwargs.get("payload_template") or {},
            "max_attempts": kwargs.get("max_attempts", 1),
            "attempt": 0,
            "status": "enabled",
        }
        self.items[item["id"]] = item
        self.created.append(item)
        return item

    async def get(self, task_id: str, *, user_id: str):
        item = self.items.get(task_id)
        if item is None or item["user_id"] != user_id:
            return None
        return item

    async def update(self, task_id: str, *, user_id: str, updates):
        item = await self.get(task_id, user_id=user_id)
        if item is None:
            return None
        item.update(updates)
        return item

    async def rearm(self, task_id: str, **kwargs):
        self.rearms.append((task_id, dict(kwargs)))
        item = self.items.get(task_id)
        if item is not None:
            item.update(kwargs)

    async def list_by_user(self, user_id: str):
        return []


class _DefinitionRepo:
    def __init__(self, known: set[str]) -> None:
        self.known = known

    async def get(self, definition_id: str, *, user_id: str):
        return {"id": definition_id, "definition": {}} if definition_id in self.known else None


class _Config:
    def __init__(self, min_once_delay_seconds: int = 60) -> None:
        self.scheduler = SimpleNamespace(min_once_delay_seconds=min_once_delay_seconds)


@pytest.fixture
def wired(monkeypatch):
    repo = _Repo()
    definition_repo = _DefinitionRepo({"wf-1"})
    user = SimpleNamespace(id="user-1")
    monkeypatch.setattr(scheduled_tasks, "get_scheduled_task_repo", lambda _request: repo)
    monkeypatch.setattr(scheduled_tasks, "get_workflow_definition_repo", lambda _request: definition_repo)
    monkeypatch.setattr(scheduled_tasks, "get_config", lambda: _Config())
    monkeypatch.setattr(scheduled_tasks, "get_thread_store", lambda _request: SimpleNamespace(check_access=AsyncMock(return_value=True)))
    monkeypatch.setattr(scheduled_tasks, "get_optional_user_from_request", AsyncMock(return_value=user))
    return SimpleNamespace(repo=repo, definition_repo=definition_repo, request=SimpleNamespace())


def _create_body(**overrides):
    body = {
        "title": "Watch output",
        "prompt": "Re-import {{payload.path}}",
        "schedule_type": "file",
        "schedule_spec": {"path": "/data/out"},
        "timezone": "UTC",
    }
    body.update(overrides)
    return scheduled_tasks.ScheduledTaskCreateRequest(**body)


# ── create ──────────────────────────────────────────────────────────────────


@pytest.mark.asyncio
async def test_create_condition_driven_task_persists_target_and_retry_fields(wired):
    body = _create_body(
        target_kind="workflow",
        target_definition_id="wf-1",
        payload_template={"input_path": "{{payload.path}}"},
        max_attempts=3,
    )

    created = await scheduled_tasks.create_scheduled_task.__wrapped__(wired.request, body)

    assert created["schedule_type"] == "file"
    assert created["next_run_at"] is None  # condition-driven: no future timestamp
    assert created["target_kind"] == "workflow"
    assert created["target_definition_id"] == "wf-1"
    assert created["payload_template"] == {"input_path": "{{payload.path}}"}
    assert created["max_attempts"] == 3


@pytest.mark.asyncio
async def test_create_rejects_unknown_schedule_type(wired):
    with pytest.raises(HTTPException) as excinfo:
        await scheduled_tasks.create_scheduled_task.__wrapped__(wired.request, _create_body(schedule_type="webhook"))
    assert excinfo.value.status_code == 422
    assert "Unsupported schedule_type" in str(excinfo.value.detail)


@pytest.mark.asyncio
async def test_create_rejects_malformed_condition_spec(wired):
    with pytest.raises(HTTPException) as excinfo:
        await scheduled_tasks.create_scheduled_task.__wrapped__(wired.request, _create_body(schedule_spec={"mode": "modified"}))
    assert excinfo.value.status_code == 422
    assert "requires schedule_spec.path" in str(excinfo.value.detail)


@pytest.mark.asyncio
async def test_create_workflow_target_requires_a_definition_id(wired):
    with pytest.raises(HTTPException) as excinfo:
        await scheduled_tasks.create_scheduled_task.__wrapped__(wired.request, _create_body(target_kind="workflow"))
    assert excinfo.value.status_code == 422
    assert "target_definition_id" in str(excinfo.value.detail)


@pytest.mark.asyncio
async def test_create_workflow_target_rejects_unknown_definition(wired):
    with pytest.raises(HTTPException) as excinfo:
        await scheduled_tasks.create_scheduled_task.__wrapped__(wired.request, _create_body(target_kind="workflow", target_definition_id="missing"))
    assert excinfo.value.status_code == 404
    assert wired.repo.created == []


@pytest.mark.asyncio
async def test_create_rejects_out_of_range_max_attempts(wired):
    with pytest.raises(HTTPException) as excinfo:
        await scheduled_tasks.create_scheduled_task.__wrapped__(wired.request, _create_body(max_attempts=0))
    assert excinfo.value.status_code == 422


@pytest.mark.asyncio
async def test_create_agent_target_keeps_legacy_shape(wired):
    created = await scheduled_tasks.create_scheduled_task.__wrapped__(wired.request, _create_body())
    assert created["target_kind"] == "agent"
    assert created["payload_template"] == {}
    assert created["max_attempts"] == 1


# ── update ──────────────────────────────────────────────────────────────────


@pytest.mark.asyncio
async def test_update_validates_target_pair_and_persists_payload_template(wired):
    created = await scheduled_tasks.create_scheduled_task.__wrapped__(wired.request, _create_body())
    body = scheduled_tasks.ScheduledTaskUpdateRequest(payload_template={"prompt": "{{payload.path}}"}, target_kind="workflow", target_definition_id="wf-1")

    updated = await scheduled_tasks.update_scheduled_task.__wrapped__(created["id"], wired.request, body)

    assert updated["target_kind"] == "workflow"
    assert updated["payload_template"] == {"prompt": "{{payload.path}}"}


@pytest.mark.asyncio
async def test_update_rejects_unknown_workflow_definition(wired):
    created = await scheduled_tasks.create_scheduled_task.__wrapped__(wired.request, _create_body())
    body = scheduled_tasks.ScheduledTaskUpdateRequest(target_kind="workflow", target_definition_id="missing")

    with pytest.raises(HTTPException) as excinfo:
        await scheduled_tasks.update_scheduled_task.__wrapped__(created["id"], wired.request, body)
    assert excinfo.value.status_code == 404


@pytest.mark.asyncio
async def test_update_validates_condition_spec(wired):
    created = await scheduled_tasks.create_scheduled_task.__wrapped__(wired.request, _create_body())
    body = scheduled_tasks.ScheduledTaskUpdateRequest(schedule_spec={"idle_seconds": 0})

    with pytest.raises(HTTPException) as excinfo:
        await scheduled_tasks.update_scheduled_task.__wrapped__(created["id"], wired.request, body)
    assert excinfo.value.status_code == 422


# ── requeue (DLQ drain) ─────────────────────────────────────────────────────


@pytest.mark.asyncio
async def test_requeue_dead_lettered_cron_task_resets_the_streak(wired):
    row = {
        "id": "task-1",
        "user_id": "user-1",
        "schedule_type": "cron",
        "schedule_spec": {"cron": "0 9 * * *"},
        "timezone": "UTC",
        "status": "dead_lettered",
        "attempt": 3,
        "last_error": "boom",
    }
    wired.repo.items["task-1"] = row

    result = await scheduled_tasks.requeue_scheduled_task.__wrapped__("task-1", wired.request)

    assert result["status"] == "enabled"
    assert result["attempt"] == 0
    assert result["last_error"] is None
    assert result["next_run_at"] is not None


@pytest.mark.asyncio
async def test_requeue_once_task_arms_at_the_minimum_delay(wired):
    wired.repo.items["task-2"] = {
        "id": "task-2",
        "user_id": "user-1",
        "schedule_type": "once",
        "schedule_spec": {"run_at": "2020-01-01T00:00:00+00:00"},
        "timezone": "UTC",
        "status": "dead_lettered",
        "attempt": 2,
        "last_error": "boom",
    }

    result = await scheduled_tasks.requeue_scheduled_task.__wrapped__("task-2", wired.request)

    assert result["next_run_at"] > datetime.now(UTC) + timedelta(seconds=30)


@pytest.mark.asyncio
async def test_requeue_condition_task_rearms_immediately(wired):
    wired.repo.items["task-3"] = {
        "id": "task-3",
        "user_id": "user-1",
        "schedule_type": "file",
        "schedule_spec": {"path": "/data"},
        "timezone": "UTC",
        "status": "dead_lettered",
        "attempt": 1,
        "last_error": "boom",
    }

    result = await scheduled_tasks.requeue_scheduled_task.__wrapped__("task-3", wired.request)

    assert result["next_run_at"] is None


@pytest.mark.asyncio
async def test_requeue_rejects_non_dead_lettered_tasks(wired):
    wired.repo.items["task-4"] = {"id": "task-4", "user_id": "user-1", "status": "enabled"}

    with pytest.raises(HTTPException) as excinfo:
        await scheduled_tasks.requeue_scheduled_task.__wrapped__("task-4", wired.request)
    assert excinfo.value.status_code == 409
    assert wired.repo.rearms == []


@pytest.mark.asyncio
async def test_requeue_missing_task_is_404(wired):
    with pytest.raises(HTTPException) as excinfo:
        await scheduled_tasks.requeue_scheduled_task.__wrapped__("nope", wired.request)
    assert excinfo.value.status_code == 404
