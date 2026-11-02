"""Tests for the N10 action-preview and run-undo routes (+ the undo tool).

The routes are exercised through a real FastAPI app with stub auth, mirroring
``test_workflow_resume_routes``: the preview route drives the real registry
previewers (so the response shape is the real one), and the undo routes drive the
real service over a recording repository.
"""

from __future__ import annotations

from collections.abc import Callable
from pathlib import Path
from types import SimpleNamespace
from typing import Any

import pytest
from fastapi import FastAPI
from starlette.middleware.base import BaseHTTPMiddleware
from starlette.requests import Request
from starlette.responses import Response
from starlette.testclient import TestClient
from starlette.types import ASGIApp

from deerflow.assets.ref import make_ref
from deerflow.config.assets_config import load_assets_config_from_dict, reset_assets_config
from deerflow.workflow.undo import UndoStatus

_STUB_USER_ID = "default"

_VALID_DEFINITION_DICT = {
    "id": "wf-1",
    "name": "Undo Test Workflow",
    "nodes": [
        {"id": "start", "type": "flow:start", "outputs": [{"name": "input", "type": "data"}]},
        {
            "id": "a1",
            "type": "data:asset",
            "params": {},
            "inputs": [{"name": "in", "type": "data"}],
            "outputs": [{"name": "out", "type": "data"}],
        },
        {"id": "w1", "type": "flow:wait", "params": {"seconds": 0}, "inputs": [{"name": "in", "type": "data"}], "outputs": [{"name": "out", "type": "data"}]},
        {"id": "end", "type": "flow:end", "inputs": [{"name": "in", "type": "data"}]},
    ],
    "edges": [
        {"source": "start", "source_port": "input", "target": "a1", "target_port": "in"},
        {"source": "a1", "source_port": "out", "target": "w1", "target_port": "in"},
        {"source": "w1", "source_port": "out", "target": "end", "target_port": "in"},
    ],
}


def _make_stub_user() -> SimpleNamespace:
    return SimpleNamespace(id=_STUB_USER_ID, system_role="user")


class _StubAuthMiddleware(BaseHTTPMiddleware):
    def __init__(self, app: ASGIApp, user_factory: Callable[[], SimpleNamespace]) -> None:
        super().__init__(app)
        self._user_factory = user_factory

    async def dispatch(self, request: Request, call_next: Callable) -> Response:
        request.state.user = self._user_factory()
        return await call_next(request)


class _RecordingUndoRepo:
    """Recording undo repository double (rows are dicts, as the real repo returns)."""

    def __init__(self, rows: list[dict[str, Any]] | None = None) -> None:
        self.rows = list(rows or [])
        self.marks: list[dict[str, Any]] = []

    async def list_by_run(self, run_id: str, *, user_id: str | None = None) -> list[dict[str, Any]]:
        return [row for row in self.rows if row["run_id"] == run_id]

    async def mark(self, record_id: str, *, user_id: str, to_status: str, detail: str | None = None) -> dict[str, Any] | None:
        self.marks.append({"record_id": record_id, "to_status": to_status, "detail": detail})
        return {"id": record_id, "status": to_status}


def _row(*, node_id: str = "a1", run_id: str = "r1", targets: list[dict[str, Any]] | None = None, backups: list[str | None] | None = None, kind: str = "file_backup") -> dict[str, Any]:
    return {
        "id": f"undo-{node_id}",
        "user_id": _STUB_USER_ID,
        "run_id": run_id,
        "node_id": node_id,
        "kind": kind,
        "status": UndoStatus.RECORDED.value,
        "targets": targets or [],
        "backup_paths": backups if backups is not None else [],
        "session_id": None,
        "app_steps": None,
        "detail": "",
    }


def _make_app(*, undo_repo: Any = None, definition: dict[str, Any] | None = None, run_record: Any = None) -> FastAPI:
    from app.gateway.routers import workflow_run_routes

    app = FastAPI()
    app.add_middleware(_StubAuthMiddleware, user_factory=_make_stub_user)
    app.state.workflow_undo_repo = undo_repo
    app.state.workflow_definition_repo = _DefinitionRepo(definition or _VALID_DEFINITION_DICT)
    app.state.run_manager = _RunManager(run_record)
    app.include_router(workflow_run_routes.router)
    return app


class _DefinitionRepo:
    def __init__(self, definition: dict[str, Any]) -> None:
        self._definition = definition

    async def get(self, definition_id: str, *, user_id: str | None = None) -> dict[str, Any] | None:
        return {"definition": self._definition} if definition_id == self._definition["id"] else None


class _RunManager:
    def __init__(self, record: Any) -> None:
        self._record = record

    async def get(self, run_id: str, *, user_id: str | None = None) -> Any:
        if self._record is None or self._record.run_id != run_id:
            return None
        return self._record


@pytest.fixture(autouse=True)
def _reset_assets() -> Any:
    reset_assets_config()
    yield
    reset_assets_config()


# ── preview route ─────────────────────────────────────────────────────────────


def test_preview_returns_null_for_a_node_with_nothing_to_preview() -> None:
    with TestClient(_make_app()) as client:
        response = client.post("/api/workflows/wf-1/preview", json={"node_id": "w1"})

    assert response.status_code == 200
    body = response.json()
    assert body["preview"] is None
    assert "nothing to preview" in body["reason"]


def test_preview_describes_an_import(tmp_path: Path) -> None:
    load_assets_config_from_dict({"roots": [str(tmp_path)]})
    source = tmp_path / "chair.fbx"
    source.write_bytes(b"payload")

    with TestClient(_make_app()) as client:
        response = client.post(
            "/api/workflows/wf-1/preview",
            json={"node_id": "a1", "params": {"operation": "import", "path": str(source)}},
        )

    assert response.status_code == 200
    preview = response.json()["preview"]
    assert preview["action"] == "import_asset"
    assert preview["node_id"] == "a1"
    assert preview["recovery"] == "backup"
    assert preview["sources"][0]["observed"] is True
    assert preview["targets"][0]["ref"]["path"] == "/mnt/user-data/workspace/chair.fbx"


def test_preview_merges_body_params_over_the_node() -> None:
    with TestClient(_make_app()) as client:
        response = client.post("/api/workflows/wf-1/preview", json={"node_id": "a1", "params": {"operation": "inspect", "path": "/tmp/x"}})

    assert response.status_code == 200
    assert response.json()["preview"] is None  # inspect is read-only


def test_preview_unknown_node_is_404() -> None:
    with TestClient(_make_app()) as client:
        response = client.post("/api/workflows/wf-1/preview", json={"node_id": "nope"})

    assert response.status_code == 404


def test_preview_unknown_definition_is_404() -> None:
    with TestClient(_make_app()) as client:
        response = client.post("/api/workflows/wf-other/preview", json={"node_id": "a1"})

    assert response.status_code == 404


def test_preview_reports_an_unpreviewable_input_as_422() -> None:
    with TestClient(_make_app()) as client:
        response = client.post("/api/workflows/wf-1/preview", json={"node_id": "a1", "params": {"operation": "convert", "converter": "missing", "path": "/mnt/user-data/workspace/a.fbx"}})

    assert response.status_code == 422
    assert "cannot preview node a1" in response.json()["detail"]


# ── undo routes ───────────────────────────────────────────────────────────────


def _run_record() -> SimpleNamespace:
    return SimpleNamespace(run_id="r1", thread_id="t1", status=SimpleNamespace(value="success"))


def test_undo_requires_a_sql_backend() -> None:
    with TestClient(_make_app(undo_repo=None, run_record=_run_record())) as client:
        response = client.get("/api/workflows/wf-1/runs/r1/undo")

    assert response.status_code == 503
    assert "SQL database" in response.json()["detail"]


def test_undo_unknown_run_is_404() -> None:
    repo = _RecordingUndoRepo([_row()])
    with TestClient(_make_app(undo_repo=repo, run_record=_run_record())) as client:
        response = client.get("/api/workflows/wf-1/runs/r-other/undo")

    assert response.status_code == 404


def test_list_undo_reports_records_and_plan(tmp_path: Path) -> None:
    host = tmp_path / "out.obj"
    host.write_bytes(b"new")
    backup = tmp_path / "backup.obj"
    backup.write_bytes(b"old")
    repo = _RecordingUndoRepo(
        [
            _row(node_id="a1", targets=[make_ref(str(host), scope="host").to_port()], backups=[str(backup)]),
            _row(node_id="a2", kind="app_undo"),
            {
                **_row(node_id="a3"),
                "status": UndoStatus.UNDONE.value,
            },
        ]
    )

    with TestClient(_make_app(undo_repo=repo, run_record=_run_record())) as client:
        response = client.get("/api/workflows/wf-1/runs/r1/undo")

    assert response.status_code == 200
    body = response.json()
    assert len(body["records"]) == 3
    # Only the reversible records are planned, newest first (the undone one drops out).
    assert [record["node_id"] for record in body["planned"]] == ["a2", "a1"]


def test_undo_dry_run_changes_nothing(tmp_path: Path) -> None:
    host = tmp_path / "out.obj"
    host.write_bytes(b"new")
    backup = tmp_path / "backup.obj"
    backup.write_bytes(b"old")
    repo = _RecordingUndoRepo([_row(node_id="a1", targets=[make_ref(str(host), scope="host").to_port()], backups=[str(backup)])])

    with TestClient(_make_app(undo_repo=repo, run_record=_run_record())) as client:
        response = client.post("/api/workflows/wf-1/runs/r1/undo", json={"dry_run": True})

    assert response.status_code == 200
    assert response.json()["outcomes"][0]["status"] == "undone"
    assert host.read_bytes() == b"new"  # untouched
    assert repo.marks == []  # nothing was transitioned


def test_undo_restores_a_host_file(tmp_path: Path) -> None:
    host = tmp_path / "out.obj"
    host.write_bytes(b"new")
    backup = tmp_path / "backup.obj"
    backup.write_bytes(b"old")
    repo = _RecordingUndoRepo([_row(node_id="a1", targets=[make_ref(str(host), scope="host").to_port()], backups=[str(backup)])])

    with TestClient(_make_app(undo_repo=repo, run_record=_run_record())) as client:
        response = client.post("/api/workflows/wf-1/runs/r1/undo", json={})

    assert response.status_code == 200
    assert response.json()["outcomes"][0]["detail"].startswith("restored 1 file")
    assert host.read_bytes() == b"old"
    assert repo.marks[0]["to_status"] == UndoStatus.UNDONE.value


def test_undo_removes_a_file_that_did_not_exist_before(tmp_path: Path) -> None:
    host = tmp_path / "created.obj"
    host.write_bytes(b"created by the run")
    repo = _RecordingUndoRepo([_row(node_id="a1", targets=[make_ref(str(host), scope="host").to_port()], backups=[None])])

    with TestClient(_make_app(undo_repo=repo, run_record=_run_record())) as client:
        response = client.post("/api/workflows/wf-1/runs/r1/undo", json={})

    assert response.status_code == 200
    assert not host.exists()


def test_undo_without_records_is_a_no_op() -> None:
    repo = _RecordingUndoRepo([])

    with TestClient(_make_app(undo_repo=repo, run_record=_run_record())) as client:
        response = client.post("/api/workflows/wf-1/runs/r1/undo", json={})

    assert response.status_code == 200
    assert response.json()["planned"] == 0
    assert response.json()["outcomes"] == []


# ── dialogue-side tool ────────────────────────────────────────────────────────


def _tool_runtime(bundle: dict[str, Any]) -> Any:
    from deerflow.runtime.context_keys import WORKFLOW_RUNTIME_CONTEXT_KEY

    return SimpleNamespace(tool_call_id="call-1", context={WORKFLOW_RUNTIME_CONTEXT_KEY: bundle, "user_id": _STUB_USER_ID})


def _tool_impl() -> Callable[..., Any]:
    """The decorated tool, called the way other tool tests call theirs."""
    from deerflow.tools.builtins import workflow_runtime_tools as wrt

    return wrt.undo_workflow_run.func


def test_undo_tool_reports_a_summary(tmp_path: Path) -> None:
    host = tmp_path / "out.obj"
    host.write_bytes(b"new")
    backup = tmp_path / "backup.obj"
    backup.write_bytes(b"old")
    repo = _RecordingUndoRepo([_row(node_id="a1", targets=[make_ref(str(host), scope="host").to_port()], backups=[str(backup)])])
    run_manager = _RunManager(_run_record())

    command = _tool_impl()("r1", runtime=_tool_runtime({"run_manager": run_manager, "workflow_undo_repo": repo}))

    update = command.update
    payload = update["messages"][0].content
    assert "undone" in payload
    assert host.read_bytes() == b"old"


def test_undo_tool_without_a_repo_reports_an_error() -> None:
    command = _tool_impl()("r1", runtime=_tool_runtime({"run_manager": _RunManager(_run_record())}))

    content = command.update["messages"][0].content
    assert "workflow_undo_repo" in content


def test_undo_tool_unknown_run_reports_an_error() -> None:
    command = _tool_impl()("r-nope", runtime=_tool_runtime({"run_manager": _RunManager(_run_record()), "workflow_undo_repo": _RecordingUndoRepo([])}))

    content = command.update["messages"][0].content
    assert "not found" in content
