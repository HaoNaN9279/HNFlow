"""Workbench persistence and workflow monitor aggregation tests."""

from __future__ import annotations

from datetime import UTC, datetime
from types import SimpleNamespace
from unittest.mock import AsyncMock, patch

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from app.gateway.routers import workflow_monitor_routes
from deerflow.config.database_config import DatabaseConfig
from deerflow.persistence.engine import close_engine, get_session_factory, init_engine_from_config
from deerflow.persistence.human_tasks.model import HumanTaskRow
from deerflow.persistence.run.model import RunRow
from deerflow.persistence.workflow_definitions.model import WorkflowDefinitionRow
from deerflow.persistence.workflow_workbenches import (
    WorkbenchMemberConflict,
    WorkbenchRevisionConflict,
    WorkflowWorkbenchRepository,
)
from deerflow.persistence.workflow_workbenches.model import WorkflowWorkbenchRow


async def _setup(tmp_path):
    await init_engine_from_config(DatabaseConfig(backend="sqlite", sqlite_dir=str(tmp_path)))
    sf = get_session_factory()
    assert sf is not None
    return sf


async def _definition(sf, definition_id: str = "wf-1") -> None:
    now = datetime.now(UTC)
    async with sf() as session:
        session.add(
            WorkflowDefinitionRow(
                id=definition_id,
                user_id="default",
                name="Test workflow",
                schema_version=1,
                definition={
                    "id": definition_id,
                    "name": "Test workflow",
                    "version": "0.1.0",
                    "metadata": {},
                    "nodes": [
                        {"id": "start", "type": "flow:start", "inputs": [], "outputs": [{"name": "out", "type": "data"}]},
                        {"id": "end", "type": "flow:end", "inputs": [{"name": "in", "type": "data"}], "outputs": []},
                    ],
                    "edges": [{"source": "start", "source_port": "out", "target": "end", "target_port": "in"}],
                },
                def_metadata={},
                version="0.1.0",
                created_at=now,
                updated_at=now,
            )
        )
        await session.commit()


@pytest.mark.asyncio
async def test_workbench_repository_crud_and_members(tmp_path):
    sf = await _setup(tmp_path)
    await _definition(sf)
    repo = WorkflowWorkbenchRepository(sf)

    created = await repo.create(user_id="default", name="Project A")
    assert created["revision"] == 1
    assert created["layout"]["version"] == 1

    member = await repo.add_member(created["id"], user_id="default", definition_id="wf-1")
    assert member["definition_id"] == "wf-1"

    with pytest.raises(WorkbenchMemberConflict):
        await repo.add_member(created["id"], user_id="default", definition_id="wf-1")

    loaded = await repo.get(created["id"], user_id="default")
    assert loaded is not None
    assert loaded["members"][0]["definition_name"] == "Test workflow"
    assert loaded["members"][0]["definition_exists"] is True

    updated = await repo.update(
        created["id"],
        user_id="default",
        updates={"name": "Project B", "layout": {"version": 1, "cards": []}},
        expected_revision=1,
    )
    assert updated is not None
    assert updated["name"] == "Project B"
    assert updated["revision"] == 2

    with pytest.raises(WorkbenchRevisionConflict):
        await repo.update(created["id"], user_id="default", updates={"name": "stale"}, expected_revision=1)

    listed = await repo.list_by_user("default")
    assert listed[0]["member_count"] == 1

    assert await repo.remove_member(created["id"], user_id="default", definition_id="wf-1") is True
    assert (await repo.get(created["id"], user_id="default"))["members"] == []
    assert await repo.delete(created["id"], user_id="default") is True
    assert await repo.get(created["id"], user_id="default") is None

    await close_engine()


def _monitor_app() -> FastAPI:
    app = FastAPI()
    app.include_router(workflow_monitor_routes.router)
    return app


@pytest.mark.asyncio
async def test_monitor_returns_active_and_waiting_human_runs(tmp_path):
    sf = await _setup(tmp_path)
    await _definition(sf)
    now = datetime.now(UTC)
    async with sf() as session:
        session.add(WorkflowWorkbenchRow(id="wb-1", user_id="default", name="Project A", description="", layout={}, settings={}, revision=1, created_at=now, updated_at=now))
        session.add(
            RunRow(
                run_id="run-live",
                thread_id="t-live",
                assistant_id="wf-1",
                user_id="default",
                workbench_id="wb-1",
                status="running",
                operation_kind="run",
                metadata_json={"workbench_id": "wb-1"},
                kwargs_json={},
                created_at=now,
                updated_at=now,
            )
        )
        session.add(
            RunRow(
                run_id="run-wait",
                thread_id="t-wait",
                assistant_id="wf-1",
                user_id="default",
                workbench_id="wb-1",
                status="interrupted",
                operation_kind="run",
                metadata_json={"workbench_id": "wb-1"},
                kwargs_json={},
                created_at=now,
                updated_at=now,
            )
        )
        session.add(HumanTaskRow(id="ht-1", user_id="default", workflow_run_id="run-wait", node_id="review", status="pending", kind="review", description="", inputs_snapshot={}, output_spec={}, validation_rules={}))
        await session.commit()

    event_store = SimpleNamespace(
        list_events=AsyncMock(
            return_value=[
                {"event_type": "wf:node:started", "content": {"node_id": "start", "step": 1}},
                {"event_type": "wf:node:completed", "content": {"node_id": "start", "step": 1}},
                {"event_type": "wf:node:started", "content": {"node_id": "end", "step": 2}},
            ]
        )
    )

    async def _user(_request):
        return "default"

    with (
        patch.object(workflow_monitor_routes, "get_current_user", new=_user),
        patch.object(
            workflow_monitor_routes,
            "get_run_context",
            return_value=SimpleNamespace(event_store=event_store),
        ),
    ):
        client = TestClient(_monitor_app())
        response = client.get("/api/workflow-monitor/runs?status=active")

    assert response.status_code == 200, response.text
    body = response.json()["runs"]
    by_id = {run["run_id"]: run for run in body}
    assert set(by_id) == {"run-live", "run-wait"}
    assert by_id["run-live"]["workbench_name"] == "Project A"
    assert by_id["run-live"]["current_node"] == "end"
    assert by_id["run-live"]["completed_nodes"] == 1
    assert by_id["run-live"]["total_nodes"] == 2
    assert by_id["run-wait"]["display_state"] == "waiting_human"
    assert by_id["run-wait"]["pending_human_task_kinds"] == ["review"]

    await close_engine()


@pytest.mark.asyncio
async def test_monitor_filters_by_workbench(tmp_path):
    sf = await _setup(tmp_path)
    await _definition(sf)
    now = datetime.now(UTC)
    async with sf() as session:
        session.add(
            RunRow(run_id="run-a", thread_id="t-a", assistant_id="wf-1", user_id="default", workbench_id="wb-a", status="running", operation_kind="run", metadata_json={"workbench_id": "wb-a"}, kwargs_json={}, created_at=now, updated_at=now)
        )
        session.add(
            RunRow(run_id="run-b", thread_id="t-b", assistant_id="wf-1", user_id="default", workbench_id="wb-b", status="running", operation_kind="run", metadata_json={"workbench_id": "wb-b"}, kwargs_json={}, created_at=now, updated_at=now)
        )
        await session.commit()

    event_store = SimpleNamespace(list_events=AsyncMock(return_value=[]))

    async def _user(_request):
        return "default"

    with (
        patch.object(workflow_monitor_routes, "get_current_user", new=_user),
        patch.object(
            workflow_monitor_routes,
            "get_run_context",
            return_value=SimpleNamespace(event_store=event_store),
        ),
    ):
        client = TestClient(_monitor_app())
        response = client.get("/api/workflow-monitor/runs?status=active&workbench_id=wb-a")

    assert response.status_code == 200, response.text
    assert [run["run_id"] for run in response.json()["runs"]] == ["run-a"]

    await close_engine()
