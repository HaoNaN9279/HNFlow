"""Route tests for saved workbenches and workbench-launched runs."""

from __future__ import annotations

from unittest.mock import AsyncMock, patch

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from app.gateway.routers import workbench_routes
from deerflow.config.database_config import DatabaseConfig
from deerflow.persistence.engine import close_engine, get_session_factory, init_engine_from_config
from deerflow.persistence.workflow_definitions import WorkflowDefinitionRepository
from deerflow.persistence.workflow_workbenches import WorkflowWorkbenchRepository
from deerflow.runtime.runs.manager import DisconnectMode, RunRecord
from deerflow.runtime.runs.schemas import RunStatus


async def _setup(tmp_path):
    await init_engine_from_config(DatabaseConfig(backend="sqlite", sqlite_dir=str(tmp_path)))
    sf = get_session_factory()
    assert sf is not None
    return sf


def _app(sf) -> FastAPI:
    app = FastAPI()
    app.state.workflow_workbench_repo = WorkflowWorkbenchRepository(sf)
    app.state.workflow_definition_repo = WorkflowDefinitionRepository(sf)
    app.include_router(workbench_routes.router)
    return app


async def _definition(repo: WorkflowDefinitionRepository) -> str:
    record = await repo.create(
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
    return record["id"]


@pytest.mark.asyncio
async def test_workbench_crud_and_member_lifecycle(tmp_path):
    sf = await _setup(tmp_path)
    definition_repo = WorkflowDefinitionRepository(sf)
    definition_id = await _definition(definition_repo)
    client = TestClient(_app(sf))

    created = client.post("/api/workbenches", json={"name": "Project A"})
    assert created.status_code == 200, created.text
    workbench = created.json()
    assert workbench["revision"] == 1

    added = client.post(f"/api/workbenches/{workbench['id']}/members", json={"definition_id": definition_id})
    assert added.status_code == 200, added.text

    loaded = client.get(f"/api/workbenches/{workbench['id']}")
    assert loaded.status_code == 200
    assert loaded.json()["members"][0]["definition_name"] == "Test workflow"

    updated = client.put(
        f"/api/workbenches/{workbench['id']}",
        json={"name": "Project B", "revision": 1},
    )
    assert updated.status_code == 200
    assert updated.json()["revision"] == 2

    stale = client.put(
        f"/api/workbenches/{workbench['id']}",
        json={"name": "Stale", "revision": 1},
    )
    assert stale.status_code == 409

    removed = client.delete(f"/api/workbenches/{workbench['id']}/members/{definition_id}")
    assert removed.status_code == 200
    deleted = client.delete(f"/api/workbenches/{workbench['id']}")
    assert deleted.status_code == 200

    await close_engine()


@pytest.mark.asyncio
async def test_workbench_run_requires_membership_and_forces_background(tmp_path):
    sf = await _setup(tmp_path)
    definition_repo = WorkflowDefinitionRepository(sf)
    definition_id = await _definition(definition_repo)
    client = TestClient(_app(sf))

    workbench = client.post("/api/workbenches", json={"name": "Project A"}).json()

    missing = client.post(
        f"/api/workbenches/{workbench['id']}/runs",
        json={"definition_id": definition_id},
    )
    assert missing.status_code == 404

    client.post(
        f"/api/workbenches/{workbench['id']}/members",
        json={"definition_id": definition_id},
    )

    record = RunRecord(
        run_id="run-1",
        thread_id="wf-run-1",
        assistant_id=definition_id,
        status=RunStatus.running,
        on_disconnect=DisconnectMode.continue_,
        metadata={"workbench_id": workbench["id"]},
        created_at="2026-01-01T00:00:00Z",
        updated_at="2026-01-01T00:00:00Z",
    )

    with patch.object(workbench_routes, "start_workflow_run", new=AsyncMock(return_value=record)) as mock_start:
        response = client.post(
            f"/api/workbenches/{workbench['id']}/runs",
            json={"definition_id": definition_id, "debug_step": True},
        )

    assert response.status_code == 200, response.text
    mock_start.assert_awaited_once()
    await_args = mock_start.await_args
    assert await_args is not None
    kwargs = await_args.kwargs
    assert kwargs["on_disconnect"] == "continue"
    assert kwargs["workbench_id"] == workbench["id"]
    assert kwargs["debug_step"] is True
    assert kwargs["metadata"]["workbench_id"] == workbench["id"]

    await close_engine()
