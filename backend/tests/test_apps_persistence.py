"""Tests for the best-effort app-instance persistence bridge (N6)."""

from __future__ import annotations

import pytest

from deerflow.apps.persistence import AppInstanceStore, record_launch, record_operation, record_status
from deerflow.apps.session import AppSession


def _session(**overrides) -> AppSession:
    base = dict(
        session_id="app-1",
        app_name="blender",
        driver="cli",
        status="ready",
        pid=1234,
        endpoint=None,
        handle={"k": "v"},
        exclusive=False,
        created_at=111.0,
        last_active=222.0,
    )
    base.update(overrides)
    return AppSession(**base)  # type: ignore[arg-type]


class _RecordingRepo:
    def __init__(self) -> None:
        self.calls: list[tuple[str, dict]] = []

    async def create(self, **kwargs):
        self.calls.append(("create", kwargs))
        return {"id": kwargs["session_id"]}

    async def record_operation(self, session_id, **kwargs):
        self.calls.append(("record_operation", {"session_id": session_id, **kwargs}))
        return {"id": session_id}

    async def set_status(self, session_id, **kwargs):
        self.calls.append(("set_status", {"session_id": session_id, **kwargs}))
        return {"id": session_id}


class _FailingRepo:
    async def create(self, **kwargs):
        raise RuntimeError("db down")

    async def record_operation(self, session_id, **kwargs):
        raise RuntimeError("db down")

    async def set_status(self, session_id, **kwargs):
        raise RuntimeError("db down")


def test_recording_repo_satisfies_protocol():
    assert isinstance(_RecordingRepo(), AppInstanceStore)


@pytest.mark.asyncio
async def test_record_launch_maps_session_fields():
    repo = _RecordingRepo()
    await record_launch(repo, _session(), user_id="user-1")
    kind, kwargs = repo.calls[0]
    assert kind == "create"
    assert kwargs["session_id"] == "app-1"
    assert kwargs["user_id"] == "user-1"
    assert kwargs["app_name"] == "blender"
    assert kwargs["driver"] == "cli"
    assert kwargs["status"] == "ready"
    assert kwargs["pid"] == 1234
    assert kwargs["handle"] == {"k": "v"}
    assert kwargs["exclusive"] is False
    assert kwargs["created_at"] == 111.0


@pytest.mark.asyncio
async def test_record_operation_passes_deltas_and_status():
    repo = _RecordingRepo()
    await record_operation(repo, _session(status="busy"), user_id="user-1", status="busy", resource_deltas={"scripts_run": 1})
    kind, kwargs = repo.calls[0]
    assert kind == "record_operation"
    assert kwargs["session_id"] == "app-1"
    assert kwargs["status"] == "busy"
    assert kwargs["resource_deltas"] == {"scripts_run": 1}
    assert kwargs["last_active"] == 222.0


@pytest.mark.asyncio
async def test_record_status_transition():
    repo = _RecordingRepo()
    await record_status(repo, session_id="app-1", user_id="user-1", to_status="stopped", allowed_from=("ready",))
    kind, kwargs = repo.calls[0]
    assert kind == "set_status"
    assert kwargs == {"session_id": "app-1", "user_id": "user-1", "to_status": "stopped", "allowed_from": ("ready",)}


@pytest.mark.asyncio
async def test_repo_none_is_noop():
    # Must not raise.
    await record_launch(None, _session(), user_id="user-1")
    await record_operation(None, _session(), user_id="user-1")
    await record_status(None, session_id="app-1", user_id="user-1", to_status="stopped", allowed_from=("ready",))


@pytest.mark.asyncio
async def test_failing_repo_is_swallowed():
    repo = _FailingRepo()
    # Best-effort: a persistence failure must never propagate to the live op.
    await record_launch(repo, _session(), user_id="user-1")
    await record_operation(repo, _session(), user_id="user-1")
    await record_status(repo, session_id="app-1", user_id="user-1", to_status="stopped", allowed_from=("ready",))
