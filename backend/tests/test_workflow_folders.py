"""Workflow folder tree and folder assignment route tests."""

from __future__ import annotations

from unittest.mock import AsyncMock, MagicMock

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from app.gateway.routers import workflow_folder_routes, workflow_routes
from deerflow.config.database_config import DatabaseConfig
from deerflow.persistence.engine import close_engine, get_session_factory, init_engine_from_config
from deerflow.persistence.workflow_definitions import WorkflowDefinitionRepository
from deerflow.persistence.workflow_folders import (
    FolderCycleError,
    FolderNotEmptyError,
    WorkflowFolderRepository,
)


async def _setup(tmp_path):
    await init_engine_from_config(DatabaseConfig(backend="sqlite", sqlite_dir=str(tmp_path)))
    sf = get_session_factory()
    assert sf is not None
    return sf


def _app(sf) -> FastAPI:
    app = FastAPI()
    app.state.workflow_folder_repo = WorkflowFolderRepository(sf)
    app.state.workflow_definition_repo = WorkflowDefinitionRepository(sf)
    repo_mock = MagicMock()
    repo_mock.check_access = AsyncMock(return_value=True)
    app.state.thread_store = repo_mock
    app.include_router(workflow_folder_routes.router)
    app.include_router(workflow_routes.router)
    return app


@pytest.mark.asyncio
async def test_folder_tree_supports_arbitrary_depth_and_rejects_cycles(tmp_path):
    sf = await _setup(tmp_path)
    repo = WorkflowFolderRepository(sf)

    root = await repo.create(user_id="default", name="Root")
    child = await repo.create(user_id="default", name="Child", parent_id=root["id"])
    grandchild = await repo.create(user_id="default", name="Grandchild", parent_id=child["id"])

    listed = await repo.list_by_user("default")
    by_id = {folder["id"]: folder for folder in listed}
    assert set(by_id) == {root["id"], child["id"], grandchild["id"]}
    assert by_id[child["id"]]["parent_id"] == root["id"]
    assert by_id[grandchild["id"]]["parent_id"] == child["id"]

    with pytest.raises(FolderCycleError):
        await repo.update(root["id"], user_id="default", parent_id=grandchild["id"], parent_id_set=True)

    moved = await repo.update(grandchild["id"], user_id="default", parent_id=None, parent_id_set=True)
    assert moved is not None
    assert moved["parent_id"] is None

    await close_engine()


@pytest.mark.asyncio
async def test_non_empty_folder_cannot_be_deleted(tmp_path):
    sf = await _setup(tmp_path)
    repo = WorkflowFolderRepository(sf)
    folder = await repo.create(user_id="default", name="Parent")
    child = await repo.create(user_id="default", name="Child", parent_id=folder["id"])

    with pytest.raises(FolderNotEmptyError):
        await repo.delete(folder["id"], user_id="default")

    assert await repo.delete(child["id"], user_id="default") is True
    assert await repo.delete(folder["id"], user_id="default") is True
    await close_engine()


@pytest.mark.asyncio
async def test_workflow_create_and_move_use_folder_id(tmp_path):
    sf = await _setup(tmp_path)
    folder_repo = WorkflowFolderRepository(sf)
    folder = await folder_repo.create(user_id="default", name="Assets")
    nested = await folder_repo.create(user_id="default", name="Nested", parent_id=folder["id"])
    client = TestClient(_app(sf))

    definition = {
        "id": "wf-test",
        "name": "Test",
        "version": "0.1.0",
        "metadata": {},
        "nodes": [
            {"id": "start", "type": "flow:start", "inputs": [], "outputs": [{"name": "out", "type": "data"}]},
            {"id": "end", "type": "flow:end", "inputs": [{"name": "in", "type": "data"}], "outputs": []},
        ],
        "edges": [{"source": "start", "source_port": "out", "target": "end", "target_port": "in"}],
    }
    created = client.post(
        "/api/workflows",
        json={"name": "In folder", "definition": definition, "folder_id": nested["id"]},
    )
    assert created.status_code in (200, 201), created.text
    workflow_id = created.json()["id"]
    assert created.json()["folder_id"] == nested["id"]

    moved = client.put(f"/api/workflows/{workflow_id}", json={"folder_id": folder["id"]})
    assert moved.status_code == 200, moved.text
    assert moved.json()["folder_id"] == folder["id"]

    root = client.put(f"/api/workflows/{workflow_id}", json={"folder_id": None})
    assert root.status_code == 200, root.text
    assert root.json()["folder_id"] is None

    await close_engine()
