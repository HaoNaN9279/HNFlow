"""Route-layer tests for ``POST /api/workflows/{id}/runs/{run_id}/continue``.

The endpoint admits a *continue* workflow run for a completed / interrupted
run's ``ai:llm_agent`` node in its own session (W2B ``continue_workflow_node``)
and returns the new run's ``RunResponse``.

Coverage:
- 200: continue succeeds → new RunResponse with the admitted run id
- 404: original run not found (``WorkflowRunNotFoundError``)
- 422: empty / missing ``node_id`` / ``prompt`` (pydantic), and
  definition-inherit failures (``ValueError``)
- 503: workflow dispatch unavailable (``WorkflowDispatchUnavailableError``)
- 401: no authenticated user on the request
"""

from __future__ import annotations

import uuid
from unittest.mock import AsyncMock, MagicMock, patch

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient
from langgraph.checkpoint.memory import InMemorySaver

from app.gateway.auth.models import User
from app.gateway.authz import AuthContext, Permissions
from deerflow.runtime.runs.manager import RunManager
from deerflow.runtime.runs.worker import RunContext
from deerflow.workflow.dispatch import (
    WorkflowDispatchUnavailableError,
    WorkflowRunNotFoundError,
)

_VALID_DEFINITION_DICT = {
    "id": "wf-test-def",
    "name": "Test Workflow",
    "nodes": [
        {"id": "start", "type": "flow:start", "outputs": [{"name": "input", "type": "data"}]},
        {"id": "ai_step", "type": "ai:llm_agent", "inputs": [{"name": "in", "type": "data"}], "outputs": [{"name": "out", "type": "data"}]},
        {"id": "end", "type": "flow:end", "inputs": [{"name": "in", "type": "data"}]},
    ],
    "edges": [
        {"source": "start", "source_port": "input", "target": "ai_step", "target_port": "in"},
        {"source": "ai_step", "source_port": "out", "target": "end", "target_port": "in"},
    ],
}

_STUB_PERMISSIONS: list[str] = [
    Permissions.THREADS_READ,
    Permissions.THREADS_WRITE,
    Permissions.THREADS_DELETE,
    Permissions.RUNS_CREATE,
    Permissions.RUNS_READ,
    Permissions.RUNS_CANCEL,
]


def _make_stub_user() -> User:
    return User(
        email="test@example.com",
        password_hash="x",
        system_role="user",
        id=uuid.UUID("11111111-1111-1111-1111-111111111111"),
    )


def _make_authed_app():
    """Build a FastAPI test app with stub auth + mock singletons on app.state."""
    from app.gateway.routers import workflow_run_routes

    app = FastAPI()

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
            request.state.auth_source = "session"
            request.state.auth = AuthContext(user=request.state.user, permissions=list(_STUB_PERMISSIONS))
            await self.app(scope, receive, send)

    app.add_middleware(_AuthMiddleware)

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


def _make_no_auth_app():
    """Build the same app without auth middleware (401 tests)."""
    from app.gateway.routers import workflow_run_routes

    app = FastAPI()

    mock_bridge = MagicMock()
    run_mgr = RunManager()
    checkpointer = InMemorySaver()
    thread_store = AsyncMock()
    thread_store.check_access = AsyncMock(return_value=True)
    run_ctx = RunContext(checkpointer=checkpointer, thread_store=thread_store)
    mock_event_store = AsyncMock()
    mock_event_store.put = AsyncMock()
    mock_event_store.put_batch = AsyncMock()

    app.state.stream_bridge = mock_bridge
    app.state.run_manager = run_mgr
    app.state.run_context = run_ctx
    app.state.thread_store = thread_store
    app.state.workflow_definition_repo = AsyncMock()
    app.state.checkpointer = checkpointer
    app.state.run_event_store = mock_event_store
    app.state.run_events_config = None

    app.include_router(workflow_run_routes.router)
    return app


class TestContinueWorkflowRunRoute:
    @pytest.fixture()
    def client(self) -> TestClient:
        app = _make_authed_app()
        return TestClient(app)

    def test_continue_returns_new_run_response(self, client: TestClient) -> None:
        import deerflow.workflow.dispatch as dispatch_mod
        from deerflow.runtime.runs.schemas import RunStatus

        async def _seed(_run_mgr: RunManager) -> None:
            record = await _run_mgr.create_or_reject(
                "wf-orig",
                "wf-test-def",
                kwargs={"params": {"input": "hello"}, "definition_id": "wf-test-def"},
            )
            await _run_mgr.set_status(record.run_id, RunStatus.success)
            return record

        with patch("app.gateway.deps.get_app_config", return_value=MagicMock()):
            import asyncio

            seed = asyncio.run(_seed(client.app.state.run_manager))
            with patch.object(
                dispatch_mod,
                "continue_workflow_node",
                new=AsyncMock(
                    return_value={
                        "run_id": seed.run_id,
                        "thread_id": "wf-run-new",
                        "status": "pending",
                        "continue_node_id": "ai_step",
                        "origin_run_id": seed.run_id,
                    }
                ),
            ) as mock_continue:
                resp = client.post(
                    f"/api/workflows/wf-test-def/runs/{seed.run_id}/continue",
                    json={"node_id": "ai_step", "prompt": "继续干活"},
                )

        assert resp.status_code == 200, f"Got {resp.status_code}: {resp.text}"
        data = resp.json()
        assert data["run_id"] == seed.run_id
        assert data["thread_id"] == seed.thread_id
        # The response reflects the admitted run record's real status.
        assert data["status"] == "success"

        args, kwargs = mock_continue.await_args
        assert args[0] == seed.run_id
        assert args[1] == "ai_step"
        assert args[2] == "继续干活"
        assert kwargs["params"] is None
        assert kwargs["runtime"].context["user_id"] == str(_make_stub_user().id)

    def test_continue_forwards_params_override(self, client: TestClient) -> None:
        import deerflow.workflow.dispatch as dispatch_mod
        from deerflow.runtime.runs.schemas import RunStatus

        with patch("app.gateway.deps.get_app_config", return_value=MagicMock()):
            import asyncio

            seed = asyncio.run(
                client.app.state.run_manager.create_or_reject(
                    "wf-orig-2",
                    "wf-test-def",
                    kwargs={"params": {"input": "hello"}, "definition_id": "wf-test-def"},
                )
            )
            asyncio.run(client.app.state.run_manager.set_status(seed.run_id, RunStatus.success))
            with patch.object(
                dispatch_mod,
                "continue_workflow_node",
                new=AsyncMock(
                    return_value={
                        "run_id": seed.run_id,
                        "thread_id": seed.thread_id,
                        "status": "pending",
                        "continue_node_id": "ai_step",
                        "origin_run_id": seed.run_id,
                    }
                ),
            ) as mock_continue:
                resp = client.post(
                    f"/api/workflows/wf-test-def/runs/{seed.run_id}/continue",
                    json={"node_id": "ai_step", "prompt": "p", "params": {"input": "fresh"}},
                )

        assert resp.status_code == 200, f"Got {resp.status_code}: {resp.text}"
        assert mock_continue.await_args.kwargs["params"] == {"input": "fresh"}

    def test_continue_missing_run_returns_404(self, client: TestClient) -> None:
        import deerflow.workflow.dispatch as dispatch_mod

        with patch("app.gateway.deps.get_app_config", return_value=MagicMock()):
            with patch.object(
                dispatch_mod,
                "continue_workflow_node",
                new=AsyncMock(side_effect=WorkflowRunNotFoundError("run 'nope' not found or not accessible")),
            ):
                resp = client.post(
                    "/api/workflows/wf-test-def/runs/nope/continue",
                    json={"node_id": "ai_step", "prompt": "p"},
                )

        assert resp.status_code == 404, f"Got {resp.status_code}: {resp.text}"
        assert "nope" in resp.json()["detail"]

    def test_continue_dispatch_unavailable_returns_503(self, client: TestClient) -> None:
        import deerflow.workflow.dispatch as dispatch_mod

        with patch("app.gateway.deps.get_app_config", return_value=MagicMock()):
            with patch.object(
                dispatch_mod,
                "continue_workflow_node",
                new=AsyncMock(side_effect=WorkflowDispatchUnavailableError("no runtime bundle")),
            ):
                resp = client.post(
                    "/api/workflows/wf-test-def/runs/run-1/continue",
                    json={"node_id": "ai_step", "prompt": "p"},
                )

        assert resp.status_code == 503, f"Got {resp.status_code}: {resp.text}"
        assert "no runtime bundle" in resp.json()["detail"]

    def test_continue_definition_inherit_failure_returns_422(self, client: TestClient) -> None:
        import deerflow.workflow.dispatch as dispatch_mod

        with patch("app.gateway.deps.get_app_config", return_value=MagicMock()):
            with patch.object(
                dispatch_mod,
                "continue_workflow_node",
                new=AsyncMock(side_effect=ValueError("run 'bare' has no definition reference — pass definition_id explicitly")),
            ):
                resp = client.post(
                    "/api/workflows/wf-test-def/runs/bare/continue",
                    json={"node_id": "ai_step", "prompt": "p"},
                )

        assert resp.status_code == 422, f"Got {resp.status_code}: {resp.text}"
        assert "definition_id" in resp.json()["detail"]

    def test_continue_missing_node_id_returns_422(self, client: TestClient) -> None:
        with patch("app.gateway.deps.get_app_config", return_value=MagicMock()):
            resp = client.post(
                "/api/workflows/wf-test-def/runs/run-1/continue",
                json={"prompt": "p"},
            )

        assert resp.status_code == 422, f"Got {resp.status_code}: {resp.text}"

    def test_continue_empty_prompt_returns_422(self, client: TestClient) -> None:
        with patch("app.gateway.deps.get_app_config", return_value=MagicMock()):
            resp = client.post(
                "/api/workflows/wf-test-def/runs/run-1/continue",
                json={"node_id": "ai_step", "prompt": ""},
            )

        assert resp.status_code == 422, f"Got {resp.status_code}: {resp.text}"

    def test_continue_without_user_returns_401(self) -> None:
        app = _make_no_auth_app()
        client = TestClient(app)
        with patch("app.gateway.deps.get_app_config", return_value=MagicMock()):
            resp = client.post(
                "/api/workflows/wf-test-def/runs/run-1/continue",
                json={"node_id": "ai_step", "prompt": "p"},
            )
        assert resp.status_code == 401, f"Got {resp.status_code}: {resp.text}"
