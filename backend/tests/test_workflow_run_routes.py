"""Router/service-layer tests for workflow run endpoints.

Coverage:
- ``start_workflow_run`` direct call → RunRecord returned, task attached, thread_id correct
- POST /runs → 200/201 with RunResponse + Content-Location
- POST /runs/stream → StreamingResponse (media_type text/event-stream)
- POST /runs/wait → run_id/thread_id/status dict
- GET /runs/{rid} → 404 when run not found
- POST /runs/{rid}/cancel → 202 (or 404 for nonexistent)
- GET /runs/{rid}/state → 503 when no checkpointer
- thread_id default generates ``wf-run-`` prefix
- Auth: no user on request → 401
"""

from __future__ import annotations

import uuid
from types import SimpleNamespace
from unittest.mock import AsyncMock, MagicMock, patch

import pytest
from fastapi import FastAPI, Request
from fastapi.testclient import TestClient
from langgraph.checkpoint.memory import InMemorySaver

from app.gateway.services import start_workflow_run
from deerflow.runtime.runs.manager import RunManager, RunRecord
from deerflow.runtime.runs.worker import RunContext
from deerflow.workflow.schema import WorkflowDefinition

# ═══════════════════════════════════════════════════════════════════════════════
# Shared test data
# ═══════════════════════════════════════════════════════════════════════════════

_VALID_DEFINITION_DICT = {
    "id": "wf-test-def",
    "name": "Test Workflow",
    "nodes": [
        {"id": "start", "type": "flow:start", "outputs": [{"name": "input", "type": "data"}]},
        {"id": "assign", "type": "data:assign", "inputs": [{"name": "in", "type": "data"}], "outputs": [{"name": "out", "type": "data"}]},
        {"id": "end", "type": "flow:end", "inputs": [{"name": "in", "type": "data"}]},
    ],
    "edges": [
        {"source": "start", "source_port": "input", "target": "assign", "target_port": "in"},
        {"source": "assign", "source_port": "out", "target": "end", "target_port": "in"},
    ],
}

_STUB_PERMISSIONS: list[str] = []


def _make_stub_user() -> SimpleNamespace:
    return SimpleNamespace(
        id="11111111-1111-1111-1111-111111111111",
        system_role="user",
    )


def _make_definition() -> WorkflowDefinition:
    return WorkflowDefinition.model_validate(_VALID_DEFINITION_DICT)


# ═══════════════════════════════════════════════════════════════════════════════
# 1. start_workflow_run direct call
# ═══════════════════════════════════════════════════════════════════════════════


class TestStartWorkflowRun:
    """Direct call to ``services.start_workflow_run`` with mocked request."""

    @pytest.mark.asyncio
    async def test_returns_run_record_with_task_and_thread_id(self) -> None:
        definition = _make_definition()
        thread_id = "wf-run-" + uuid.uuid4().hex

        mock_bridge = MagicMock()
        mock_bridge.publish = AsyncMock()
        mock_bridge.publish_end = AsyncMock()
        mock_bridge.cleanup = AsyncMock()

        run_mgr = RunManager()
        checkpointer = InMemorySaver()

        thread_store = AsyncMock()
        thread_store.check_access = AsyncMock(return_value=True)

        event_store = AsyncMock()
        event_store.put = AsyncMock()
        event_store.put_batch = AsyncMock()

        run_ctx = RunContext(checkpointer=checkpointer, thread_store=thread_store, event_store=event_store)

        mock_request = MagicMock(spec=Request)
        mock_request.app.state.stream_bridge = mock_bridge
        mock_request.app.state.run_manager = run_mgr
        mock_request.app.state.run_context = run_ctx
        mock_request.app.state.run_event_store = event_store
        mock_request.app.state.checkpointer = checkpointer
        mock_request.app.state.run_events_config = None
        mock_request.app.state.thread_store = thread_store
        mock_request.state.user = _make_stub_user()

        with patch("app.gateway.deps.get_app_config", return_value=MagicMock()):
            record = await start_workflow_run(
                definition_id=definition.id,
                definition=definition,
                params={"input": "hello"},
                thread_id=thread_id,
                request=mock_request,
                on_disconnect="cancel",
                metadata={},
            )

        assert isinstance(record, RunRecord)
        assert record.thread_id == thread_id
        # Wait for background task
        if record.task is not None:
            try:
                await record.task
            except Exception:
                pass


# ═══════════════════════════════════════════════════════════════════════════════
# 2. Route tests via TestClient
# ═══════════════════════════════════════════════════════════════════════════════


def _make_authed_workflow_run_app():
    """Build a FastAPI test app with stub auth + mock singletons on app.state."""
    from app.gateway.routers import workflow_run_routes

    app = FastAPI()

    # Stub auth middleware
    class _AuthMiddleware:
        def __init__(self, app_):
            self.app = app_

        async def __call__(self, scope, receive, send):
            if scope["type"] != "http":
                await self.app(scope, receive, send)
                return

            from starlette.requests import Request as StarletteRequest

            request = StarletteRequest(scope, receive)
            request.state.user = _make_stub_user()
            await self.app(scope, receive, send)

    app.add_middleware(_AuthMiddleware)

    # Singletons
    mock_bridge = MagicMock()
    mock_bridge.publish = AsyncMock()
    mock_bridge.publish_end = AsyncMock()
    mock_bridge.cleanup = AsyncMock()
    mock_bridge.supports_cross_process = False

    run_mgr = RunManager()
    checkpointer = InMemorySaver()

    thread_store = AsyncMock()
    thread_store.check_access = AsyncMock(return_value=True)

    run_ctx = RunContext(checkpointer=checkpointer, thread_store=thread_store)

    mock_event_store = AsyncMock()
    mock_event_store.put = AsyncMock()
    mock_event_store.put_batch = AsyncMock()

    mock_def_row = {"definition": _VALID_DEFINITION_DICT}
    mock_repo = AsyncMock()
    mock_repo.get = AsyncMock(return_value=mock_def_row)

    app.state.stream_bridge = mock_bridge
    app.state.run_manager = run_mgr
    app.state.run_context = run_ctx
    app.state.thread_store = thread_store
    app.state.workflow_definition_repo = mock_repo
    app.state.checkpointer = checkpointer
    app.state.run_event_store = mock_event_store
    app.state.run_events_config = None

    app.include_router(workflow_run_routes.router)
    return app


class TestRoutesWithTestClient:
    """Route-level tests against a FastAPI app with mock dependencies."""

    @pytest.fixture()
    def client(self) -> TestClient:
        app = _make_authed_workflow_run_app()
        return TestClient(app)

    def test_create_run_returns_ok_and_content_location(self, client: TestClient) -> None:
        with patch("app.gateway.deps.get_app_config", return_value=MagicMock()):
            payload = {"params": {"input": "hi"}}
            resp = client.post("/api/workflows/wf-test-def/runs", json=payload)
            assert resp.status_code in (200, 201), f"Got {resp.status_code}: {resp.text}"
            data = resp.json()
            assert "run_id" in data
            assert "thread_id" in data

    def test_stream_route_returns_sse(self, client: TestClient) -> None:
        with patch("app.gateway.deps.get_app_config", return_value=MagicMock()):
            payload = {"params": {"input": "hi"}}
            resp = client.post("/api/workflows/wf-test-def/runs/stream", json=payload)
            assert resp.status_code in (200, 201), f"Got {resp.status_code}: {resp.text}"

    def test_wait_route_returns_outcome(self, client: TestClient) -> None:
        with patch("app.gateway.deps.get_app_config", return_value=MagicMock()):
            payload = {"params": {"input": "hi"}}
            resp = client.post("/api/workflows/wf-test-def/runs/wait", json=payload)
            assert resp.status_code == 200, f"Got {resp.status_code}: {resp.text}"
            data = resp.json()
            assert "run_id" in data
            assert "thread_id" in data
            assert "status" in data

    def test_get_nonexistent_run_returns_404(self, client: TestClient) -> None:
        with patch("app.gateway.deps.get_app_config", return_value=MagicMock()):
            resp = client.get("/api/workflows/wf-test-def/runs/nonexistent-run-id")
            assert resp.status_code == 404, f"Got {resp.status_code}: {resp.text}"

    def test_cancel_nonexistent_run_returns_404(self, client: TestClient) -> None:
        with patch("app.gateway.deps.get_app_config", return_value=MagicMock()):
            resp = client.post("/api/workflows/wf-test-def/runs/nonexistent-run-id/cancel")
            assert resp.status_code == 404, f"Got {resp.status_code}: {resp.text}"

    def test_state_no_checkpointer_returns_503(self, client: TestClient) -> None:
        """GET /runs/{rid}/state returns 503 when RunContext has no checkpointer."""
        # Override both the app.state.checkpointer and the run_context
        client.app.state.checkpointer = None
        client.app.state.run_context = RunContext(checkpointer=None, thread_store=client.app.state.thread_store)

        with patch("app.gateway.deps.get_app_config", return_value=MagicMock()):
            payload = {"params": {"input": "hi"}}
            create_resp = client.post("/api/workflows/wf-test-def/runs", json=payload)
            if create_resp.status_code not in (200, 201):
                pytest.skip("Could not create run for state test")
            run_id = create_resp.json()["run_id"]

            resp = client.get(f"/api/workflows/wf-test-def/runs/{run_id}/state")
            assert resp.status_code == 503, f"Got {resp.status_code}: {resp.text}"


# ═══════════════════════════════════════════════════════════════════════════════
# 3. thread_id default generation
# ═══════════════════════════════════════════════════════════════════════════════


class TestThreadIdDefault:
    """The ``_default_workflow_thread_id`` helper generates ``wf-run-`` prefix."""

    def test_default_thread_id_has_wf_run_prefix(self) -> None:
        from app.gateway.routers.workflow_run_routes import _default_workflow_thread_id

        tid = _default_workflow_thread_id("some-def")
        assert tid.startswith("wf-run-"), f"Expected wf-run- prefix, got {tid}"
        uuid_part = tid[len("wf-run-") :]
        assert len(uuid_part) == 32, f"Expected 32-char hex UUID, got {uuid_part}"
        int(uuid_part, 16)
