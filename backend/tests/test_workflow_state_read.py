"""Workflow state/cost reads must not depend on raw CheckpointTuple fields."""

from __future__ import annotations

from types import SimpleNamespace

import pytest

from app.gateway.routers import workflow_run_routes


class _EventStore:
    def __init__(self, content: dict | None) -> None:
        self.content = content

    async def list_events(self, *_args, **_kwargs):
        if self.content is None:
            return []
        return [{"content": self.content}]


@pytest.mark.asyncio
async def test_state_prefers_run_end_snapshot(monkeypatch: pytest.MonkeyPatch) -> None:
    run_ctx = SimpleNamespace(
        event_store=_EventStore({"wf:start:input": "x", "wf:a:out": 1, "token_usage": {"total_tokens": 3}}),
        checkpointer=None,
    )
    monkeypatch.setattr(workflow_run_routes, "get_run_context", lambda _request: run_ctx)
    request = SimpleNamespace()
    record = SimpleNamespace(thread_id="t", run_id="r", user_id="u")

    values = await workflow_run_routes._workflow_state_values(request, record, "def", SimpleNamespace(id="u"))

    assert values == {"wf:start:input": "x", "wf:a:out": 1}


@pytest.mark.asyncio
async def test_state_reports_missing_checkpointer_when_no_snapshot(monkeypatch: pytest.MonkeyPatch) -> None:
    run_ctx = SimpleNamespace(event_store=_EventStore(None), checkpointer=None)
    monkeypatch.setattr(workflow_run_routes, "get_run_context", lambda _request: run_ctx)
    request = SimpleNamespace()
    record = SimpleNamespace(thread_id="t", run_id="r", user_id="u")

    with pytest.raises(Exception) as exc_info:
        await workflow_run_routes._workflow_state_values(request, record, "def", SimpleNamespace(id="u"))
    assert "503" in str(exc_info.value) or "Checkpointer" in str(exc_info.value)
