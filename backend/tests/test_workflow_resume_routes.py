"""Resume-link tests — submit/skip success fires a resume run (T13-3).

Verifies the orchestration between the human-task CRUD routes and the workflow
run lifecycle: a successful submit/skip on a task that carries a
``checkpoint_ref`` creates a *resume* run (``Command(resume=...)``) on the
original thread.  The real interrupt → submit → resume graph flow is owned by
T13-5; these tests mock the repo/run-manager/definition boundaries and the
``start_workflow_run`` service call.

Coverage:
- submit success triggers a resume run (resume == Command(values), thread_id == checkpoint thread)
- no ``checkpoint_ref`` → no resume, submit still 200
- skip triggers a resume run with ``resume == {"__skip": True}``
- a resume failure never changes the submit/skip HTTP result
- ``start_workflow_run`` passes ``human_task_repo`` + ``resume`` to the worker
"""

from __future__ import annotations

import uuid
from collections.abc import Callable
from types import SimpleNamespace
from unittest.mock import AsyncMock, MagicMock, patch

import pytest
from fastapi import FastAPI, Request, Response
from fastapi.testclient import TestClient
from langgraph.checkpoint.memory import InMemorySaver
from langgraph.types import Command
from starlette.middleware.base import BaseHTTPMiddleware
from starlette.types import ASGIApp

from app.gateway.routers import human_task_routes
from app.gateway.services import start_workflow_run
from deerflow.runtime.runs.manager import RunManager
from deerflow.workflow.schema import WorkflowDefinition

# ── Shared test data ──────────────────────────────────────────────────────────

_STUB_USER_ID = "11111111-1111-1111-1111-111111111111"

_BOOL_SPEC = {"ports": [{"name": "approval", "type": "bool", "required": True}]}

_VALID_DEFINITION_DICT = {
    "id": "wf-1",
    "name": "Resume Test Workflow",
    "nodes": [
        {"id": "start", "type": "flow:start", "outputs": [{"name": "input", "type": "data"}]},
        {"id": "end", "type": "flow:end", "inputs": [{"name": "in", "type": "data"}]},
    ],
    "edges": [
        {"source": "start", "source_port": "input", "target": "end", "target_port": "in"},
    ],
}


def _make_stub_user() -> SimpleNamespace:
    return SimpleNamespace(
        id=_STUB_USER_ID,
        system_role="user",
    )


class _ResumeTestAuthMiddleware(BaseHTTPMiddleware):
    """Stamp a fake user onto every request."""

    def __init__(self, app: ASGIApp, user_factory: Callable[[], SimpleNamespace]) -> None:
        super().__init__(app)
        self._user_factory = user_factory

    async def dispatch(self, request: Request, call_next: Callable) -> Response:
        request.state.user = self._user_factory()
        return await call_next(request)


def _make_resume_app(human_task_repo, run_mgr=None, def_repo=None) -> FastAPI:
    """Build a FastAPI test app with stub auth + human-task/resume singletons."""
    app = FastAPI()
    app.add_middleware(_ResumeTestAuthMiddleware, user_factory=_make_stub_user)
    app.state.human_task_repo = human_task_repo
    if run_mgr is not None:
        app.state.run_manager = run_mgr
    if def_repo is not None:
        app.state.workflow_definition_repo = def_repo
    app.include_router(human_task_routes.router)
    return app


def _make_task(**overrides) -> dict:
    task = {
        "id": "ht-abc",
        "user_id": _STUB_USER_ID,
        "status": "pending",
        "output_spec": _BOOL_SPEC,
        "validation_rules": None,
        "submission": None,
        "checkpoint_ref": {"thread_id": "t1", "checkpoint_id": "cp1"},
        "workflow_run_id": "r1",
    }
    task.update(overrides)
    return task


def _make_run_manager_record(definition_id: str = "wf-1", metadata: dict | None = None):
    """A mock run-manager whose ``get`` returns a record carrying ``definition_id``."""
    run_mgr = MagicMock()
    record = SimpleNamespace(kwargs={"definition_id": definition_id}, metadata=metadata or {})
    run_mgr.get = AsyncMock(return_value=record)
    return run_mgr


def _make_definition_repo(definition_dict=None):
    """A mock workflow-definition repo returning a valid definition row."""
    repo = MagicMock()
    repo.get = AsyncMock(return_value={"definition": definition_dict or _VALID_DEFINITION_DICT})
    return repo


# ── 1. submit success triggers resume ─────────────────────────────────────────


def test_submit_success_triggers_resume():
    mock_repo = MagicMock()
    task = _make_task()
    mock_repo.get = AsyncMock(return_value=task)
    mock_repo.submit = AsyncMock(return_value={**task, "status": "submitted"})

    app = _make_resume_app(mock_repo, run_mgr=_make_run_manager_record(), def_repo=_make_definition_repo())
    client = TestClient(app)

    with patch.object(human_task_routes, "start_workflow_run", new=AsyncMock()) as mock_start:
        response = client.post("/api/human-tasks/ht-abc/submit", json={"values": {"approval": True}})

    assert response.status_code == 200
    assert response.json()["status"] == "submitted"
    mock_start.assert_awaited_once()
    kwargs = mock_start.await_args.kwargs
    assert kwargs["thread_id"] == "t1"
    assert kwargs["definition_id"] == "wf-1"
    assert kwargs["params"] == {}
    resume_cmd = kwargs["resume"]
    assert isinstance(resume_cmd, Command)
    assert resume_cmd.resume == {"approval": True}
    # T13-5: the resume run must override context.run_id with the original hung
    # run id so the (run_id, node_id) idempotency key reuses the existing todo.
    assert kwargs["origin_run_id"] == "r1"


def test_workbench_resume_keeps_provenance_and_background_lifecycle():
    mock_repo = MagicMock()
    task = _make_task()
    mock_repo.get = AsyncMock(return_value=task)
    mock_repo.submit = AsyncMock(return_value={**task, "status": "submitted"})

    app = _make_resume_app(
        mock_repo,
        run_mgr=_make_run_manager_record(metadata={"workbench_id": "wb-1"}),
        def_repo=_make_definition_repo(),
    )
    client = TestClient(app)

    with patch.object(human_task_routes, "start_workflow_run", new=AsyncMock()) as mock_start:
        response = client.post("/api/human-tasks/ht-abc/submit", json={"values": {"approval": True}})

    assert response.status_code == 200
    kwargs = mock_start.await_args.kwargs
    assert kwargs["on_disconnect"] == "continue"
    assert kwargs["workbench_id"] == "wb-1"
    assert kwargs["metadata"]["workbench_id"] == "wb-1"


# ── 2. no checkpoint_ref → no resume, submit still 200 ────────────────────────


def test_submit_no_checkpoint_ref_skips_resume():
    mock_repo = MagicMock()
    task = _make_task(checkpoint_ref=None)
    mock_repo.get = AsyncMock(return_value=task)
    mock_repo.submit = AsyncMock(return_value={**task, "status": "submitted"})

    app = _make_resume_app(mock_repo)
    client = TestClient(app)

    with patch.object(human_task_routes, "start_workflow_run", new=AsyncMock()) as mock_start:
        response = client.post("/api/human-tasks/ht-abc/submit", json={"values": {"approval": True}})

    assert response.status_code == 200
    assert response.json()["status"] == "submitted"
    mock_start.assert_not_awaited()


# ── 3. skip triggers resume with {"__skip": True} ─────────────────────────────


def test_skip_triggers_resume_with_skip_value():
    mock_repo = MagicMock()
    task = _make_task()
    mock_repo.get = AsyncMock(return_value=task)
    mock_repo.skip = AsyncMock(return_value={**task, "status": "skipped"})

    app = _make_resume_app(mock_repo, run_mgr=_make_run_manager_record(), def_repo=_make_definition_repo())
    client = TestClient(app)

    with patch.object(human_task_routes, "start_workflow_run", new=AsyncMock()) as mock_start:
        response = client.post("/api/human-tasks/ht-abc/skip")

    assert response.status_code == 200
    assert response.json()["status"] == "skipped"
    mock_start.assert_awaited_once()
    kwargs = mock_start.await_args.kwargs
    assert kwargs["thread_id"] == "t1"
    resume_cmd = kwargs["resume"]
    assert isinstance(resume_cmd, Command)
    assert resume_cmd.resume == {"__skip": True}
    # T13-5: skip resume also overrides context.run_id with the original run id.
    assert kwargs["origin_run_id"] == "r1"


# ── 4. resume failure never breaks submit/skip ────────────────────────────────


def test_resume_failure_does_not_break_submit():
    mock_repo = MagicMock()
    task = _make_task()
    mock_repo.get = AsyncMock(return_value=task)
    mock_repo.submit = AsyncMock(return_value={**task, "status": "submitted"})

    app = _make_resume_app(mock_repo, run_mgr=_make_run_manager_record(), def_repo=_make_definition_repo())
    client = TestClient(app)

    with patch.object(human_task_routes, "start_workflow_run", new=AsyncMock(side_effect=RuntimeError("boom"))):
        response = client.post("/api/human-tasks/ht-abc/submit", json={"values": {"approval": True}})

    assert response.status_code == 200
    assert response.json()["status"] == "submitted"


def test_resume_failure_does_not_break_skip():
    mock_repo = MagicMock()
    task = _make_task()
    mock_repo.get = AsyncMock(return_value=task)
    mock_repo.skip = AsyncMock(return_value={**task, "status": "skipped"})

    app = _make_resume_app(mock_repo, run_mgr=_make_run_manager_record(), def_repo=_make_definition_repo())
    client = TestClient(app)

    with patch.object(human_task_routes, "start_workflow_run", new=AsyncMock(side_effect=RuntimeError("boom"))):
        response = client.post("/api/human-tasks/ht-abc/skip")

    assert response.status_code == 200
    assert response.json()["status"] == "skipped"


# ── 5. start_workflow_run injects human_task_repo + resume into the worker ────


class TestStartWorkflowRunInjection:
    """Service-layer: ``start_workflow_run`` forwards ``human_task_repo`` + ``resume``."""

    @pytest.mark.asyncio
    async def test_passes_human_task_repo_and_resume_to_worker(self) -> None:
        definition = WorkflowDefinition.model_validate(_VALID_DEFINITION_DICT)
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

        human_task_repo = MagicMock()

        mock_request = MagicMock(spec=Request)
        mock_request.app.state.stream_bridge = mock_bridge
        mock_request.app.state.run_manager = run_mgr
        mock_request.app.state.run_event_store = event_store
        mock_request.app.state.checkpointer = checkpointer
        mock_request.app.state.run_events_config = None
        mock_request.app.state.thread_store = thread_store
        mock_request.app.state.human_task_repo = human_task_repo
        mock_request.state.user = _make_stub_user()

        resume_cmd = Command(resume={"approval": True})

        with patch("app.gateway.deps.get_app_config", return_value=MagicMock()), patch("app.gateway.services.run_workflow", new=AsyncMock()) as mock_run:
            record = await start_workflow_run(
                definition_id=definition.id,
                definition=definition,
                params={},
                thread_id=thread_id,
                request=mock_request,
                resume=resume_cmd,
            )

            # The worker runs as a background task — await it while the
            # ``run_workflow`` patch is still active so the mock is exercised.
            if record.task is not None:
                try:
                    await record.task
                except Exception:
                    pass

        mock_run.assert_awaited_once()
        kwargs = mock_run.await_args.kwargs
        assert kwargs["human_task_repo"] is human_task_repo
        assert kwargs["resume"] is resume_cmd
