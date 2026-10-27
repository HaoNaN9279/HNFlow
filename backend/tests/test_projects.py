"""File-backed project and workbench service/API tests."""

from __future__ import annotations

import json
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import AsyncMock, patch

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from app.gateway.routers import project_routes
from deerflow.config.database_config import DatabaseConfig
from deerflow.persistence.engine import close_engine, get_session_factory, init_engine_from_config
from deerflow.persistence.projects import ProjectRepository
from deerflow.persistence.workflow_definitions import WorkflowDefinitionRepository
from deerflow.persistence.workflow_workbenches import WorkflowWorkbenchRepository
from deerflow.projects.service import (
    ProjectConflictError,
    ProjectService,
    WorkbenchConflictError,
    WorkbenchNotFoundError,
)
from deerflow.runtime.runs.manager import DisconnectMode, RunRecord
from deerflow.runtime.runs.schemas import RunStatus
from deerflow.workflow.runtime_context import build_workflow_runtime_context


async def _service(tmp_path: Path) -> tuple[ProjectService, WorkflowDefinitionRepository, WorkflowWorkbenchRepository, object]:
    await init_engine_from_config(DatabaseConfig(backend="sqlite", sqlite_dir=str(tmp_path / "db")))
    sf = get_session_factory()
    assert sf is not None
    definitions = WorkflowDefinitionRepository(sf)
    mirrors = WorkflowWorkbenchRepository(sf)
    await definitions.create(
        definition_id="wf-1",
        user_id="default",
        name="Test workflow",
        schema_version=1,
        definition={
            "id": "wf-1",
            "name": "Test workflow",
            "version": "0.1.0",
            "metadata": {},
            "nodes": [
                {"id": "start", "type": "flow:start", "inputs": [], "outputs": [{"name": "out", "type": "data"}]},
                {"id": "end", "type": "flow:end", "inputs": [{"name": "in", "type": "data"}], "outputs": []},
            ],
            "edges": [{"source": "start", "source_port": "out", "target": "end", "target_port": "in"}],
        },
    )
    service = ProjectService(ProjectRepository(sf), definition_repo=definitions, workbench_repo=mirrors)
    return service, definitions, mirrors, sf


def _app(service: ProjectService, definitions: WorkflowDefinitionRepository) -> FastAPI:
    app = FastAPI()
    app.state.project_service = service
    app.state.workflow_definition_repo = definitions
    app.include_router(project_routes.router)
    return app


@pytest.mark.asyncio
async def test_project_and_workbench_files_are_source_of_truth(tmp_path):
    service, _, mirrors, _ = await _service(tmp_path)
    root = tmp_path / "project"
    project = await service.create_project(root_path=str(root), user_id="default", name="Demo")

    manifest_path = root / ".hnflow" / "project.json"
    assert manifest_path.is_file()
    assert json.loads(manifest_path.read_text(encoding="utf-8"))["project_id"] == project["project_id"]
    assert (root / ".hnflow" / "workbenches").is_dir()

    opened = await service.open_project(root_path=str(root), user_id="default")
    assert opened["project_id"] == project["project_id"]

    with pytest.raises(ProjectConflictError):
        await service.create_project(root_path=str(root), user_id="default", name="Duplicate")

    workbench = await service.create_workbench(project["project_id"], user_id="default", name="Daily")
    workbench_path = root / ".hnflow" / "workbenches" / f"{workbench['id']}.workbench.json"
    assert workbench_path.is_file()
    assert workbench["revision"] == 1

    member = await service.add_member(project["project_id"], workbench["id"], user_id="default", definition_id="wf-1")
    assert member["definition_name"] == "Test workflow"
    assert member["definition_exists"] is True

    loaded = await service.get_workbench(project["project_id"], workbench["id"], user_id="default")
    assert loaded["member_count"] == 1
    assert loaded["revision"] == 2

    mirror = await mirrors.get(workbench["id"], user_id="default")
    assert mirror is not None
    assert mirror["project_id"] == project["project_id"]
    assert [item["definition_id"] for item in mirror["members"]] == ["wf-1"]

    with pytest.raises(WorkbenchConflictError):
        await service.update_workbench(
            project["project_id"],
            workbench["id"],
            user_id="default",
            updates={"name": "Stale"},
            expected_revision=1,
        )

    updated = await service.update_workbench(
        project["project_id"],
        workbench["id"],
        user_id="default",
        updates={"name": "Renamed"},
        expected_revision=2,
    )
    assert updated["name"] == "Renamed"
    assert updated["revision"] == 3
    assert json.loads(workbench_path.read_text(encoding="utf-8"))["name"] == "Renamed"

    assert await service.remove_member(project["project_id"], workbench["id"], "wf-1", user_id="default") is True
    assert (await service.get_workbench(project["project_id"], workbench["id"], user_id="default"))["members"] == []

    await service.add_member(project["project_id"], workbench["id"], user_id="default", definition_id="wf-1")
    assert await service.remove_definition_memberships("wf-1", user_id="default") == 1
    assert (await service.get_workbench(project["project_id"], workbench["id"], user_id="default"))["members"] == []

    assert await service.delete_workbench(project["project_id"], workbench["id"], user_id="default") is True
    assert not workbench_path.exists()
    with pytest.raises(WorkbenchNotFoundError):
        await service.get_workbench(project["project_id"], workbench["id"], user_id="default")

    assert await service.close_project(project["project_id"], user_id="default") is True
    assert manifest_path.is_file()

    await close_engine()


@pytest.mark.asyncio
async def test_project_routes_crud_and_revision_conflict(tmp_path):
    service, definitions, _, _ = await _service(tmp_path)
    client = TestClient(_app(service, definitions))
    root = tmp_path / "project"

    created = client.post("/api/projects", json={"root_path": str(root), "name": "Demo"})
    assert created.status_code == 200, created.text
    project = created.json()
    project_id = project["project_id"]

    listed = client.get("/api/projects")
    assert listed.status_code == 200
    assert [item["project_id"] for item in listed.json()] == [project_id]

    workbench = client.post(f"/api/projects/{project_id}/workbenches", json={"name": "Daily"})
    assert workbench.status_code == 200, workbench.text
    workbench_id = workbench.json()["id"]

    added = client.post(
        f"/api/projects/{project_id}/workbenches/{workbench_id}/members",
        json={"definition_id": "wf-1"},
    )
    assert added.status_code == 200, added.text
    assert added.json()["definition_name"] == "Test workflow"

    loaded = client.get(f"/api/projects/{project_id}/workbenches/{workbench_id}")
    assert loaded.status_code == 200
    assert loaded.json()["member_count"] == 1

    updated = client.put(
        f"/api/projects/{project_id}/workbenches/{workbench_id}",
        json={"name": "Renamed", "revision": 2},
    )
    assert updated.status_code == 200, updated.text
    assert updated.json()["revision"] == 3

    stale = client.put(
        f"/api/projects/{project_id}/workbenches/{workbench_id}",
        json={"name": "Stale", "revision": 2},
    )
    assert stale.status_code == 409

    removed = client.delete(f"/api/projects/{project_id}/workbenches/{workbench_id}/members/wf-1")
    assert removed.status_code == 200

    deleted = client.delete(f"/api/projects/{project_id}/workbenches/{workbench_id}")
    assert deleted.status_code == 200

    closed = client.delete(f"/api/projects/{project_id}")
    assert closed.status_code == 200
    assert (root / ".hnflow" / "project.json").is_file()

    await close_engine()


@pytest.mark.asyncio
async def test_workbench_run_carries_project_snapshot(tmp_path):
    service, definitions, _, _ = await _service(tmp_path)
    client = TestClient(_app(service, definitions))
    root = tmp_path / "project"
    project = client.post("/api/projects", json={"root_path": str(root), "name": "Demo"}).json()
    workbench = client.post(f"/api/projects/{project['project_id']}/workbenches", json={"name": "Daily"}).json()
    client.post(
        f"/api/projects/{project['project_id']}/workbenches/{workbench['id']}/members",
        json={"definition_id": "wf-1"},
    )

    record = RunRecord(
        run_id="run-1",
        thread_id="wf-run-1",
        assistant_id="wf-1",
        status=RunStatus.running,
        on_disconnect=DisconnectMode.continue_,
        metadata={},
        created_at="2026-01-01T00:00:00Z",
        updated_at="2026-01-01T00:00:00Z",
    )
    with patch.object(project_routes, "start_workflow_run", new=AsyncMock(return_value=record)) as mock_start:
        response = client.post(
            f"/api/projects/{project['project_id']}/workbenches/{workbench['id']}/runs",
            json={"definition_id": "wf-1", "debug_step": True},
        )

    assert response.status_code == 200, response.text
    kwargs = mock_start.await_args.kwargs
    assert kwargs["workbench_id"] == workbench["id"]
    assert kwargs["debug_step"] is True
    assert kwargs["metadata"]["project_id"] == project["project_id"]
    assert kwargs["metadata"]["project"]["project_id"] == project["project_id"]
    assert kwargs["metadata"]["workbench"]["id"] == workbench["id"]
    assert kwargs["metadata"]["workbench"]["project_id"] == project["project_id"]
    assert kwargs["metadata"]["project_stack"]["core"]["name"] == "core"
    assert kwargs["metadata"]["project_stack"]["groups"] == []

    await close_engine()


def test_runtime_context_exposes_project_and_workbench():
    record = SimpleNamespace(
        thread_id="thread-1",
        run_id="run-1",
        user_id="default",
        metadata={
            "project": {"project_id": "proj-1", "root_path": "D:/work/demo"},
            "workbench": {"id": "wb-1", "project_id": "proj-1"},
            "vibestack_repository": "D:/work/VibeStack",
            "project_stack": {"schema_version": 1, "core": {"name": "core", "version": "0.1.0"}, "groups": []},
            "capability_group_snapshot": [{"guid": "a" * 32, "version": "0.1.0", "content_hash": "hash"}],
            "vibestack_mcp": [{"name": "vibe_core_excel", "transport": "stdio", "command": ["npx", "excel-mcp"]}],
            "vibestack_fingerprint": "fp-1",
        },
    )
    run_ctx = SimpleNamespace(app_config=None, checkpointer=None, spec_repo=None, app_instance_repo=None, agent_adapter=None)
    context = build_workflow_runtime_context(record=record, run_ctx=run_ctx)
    assert context["project"]["project_id"] == "proj-1"
    assert context["workbench"]["id"] == "wb-1"
    assert context["vibestack_repository"] == "D:/work/VibeStack"
    assert context["capability_group_active"]["core"] == "0.1.0"
    assert context["capability_group_snapshot"][0]["content_hash"] == "hash"
    assert context["vibestack_mcp"][0]["name"] == "vibe_core_excel"
    assert context["vibestack_fingerprint"] == "fp-1"
