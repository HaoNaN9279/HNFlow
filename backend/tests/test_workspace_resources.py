"""Workspace resource service: CRUD, journal, and conversation-scoped undo."""

from __future__ import annotations

import json

import pytest

from deerflow.config.database_config import DatabaseConfig
from deerflow.persistence.engine import close_engine, get_session_factory, init_engine_from_config
from deerflow.workspace import ChangeContext, WorkspaceResourceService


def _definition(workflow_id: str = "wf-test") -> dict:
    return {
        "id": workflow_id,
        "name": "Test workflow",
        "version": "0.1.0",
        "nodes": [
            {"id": "start", "type": "flow:start", "inputs": [], "outputs": [{"name": "out", "type": "data"}]},
            {"id": "end", "type": "flow:end", "inputs": [{"name": "in", "type": "data"}], "outputs": []},
        ],
        "edges": [{"source": "start", "source_port": "out", "target": "end", "target_port": "in"}],
    }


async def _service(tmp_path) -> WorkspaceResourceService:
    await init_engine_from_config(DatabaseConfig(backend="sqlite", sqlite_dir=str(tmp_path)))
    session_factory = get_session_factory()
    assert session_factory is not None
    return WorkspaceResourceService(session_factory, user_id="user-1")


@pytest.mark.asyncio
async def test_catalog_and_workflow_crud_are_user_scoped(tmp_path) -> None:
    service = await _service(tmp_path)
    try:
        folder = await service.create_folder(name="Demos")
        created = await service.create_workflow(name="Demo", definition=_definition(), folder_id=folder["id"])
        catalog = await service.catalog(section="workflows", parent_id=folder["id"])
        assert [item["id"] for item in catalog["items"]] == [created["id"]]

        updated = await service.update_workflow(
            definition_id=created["id"],
            name="Renamed",
            operations=[{"op": "set_metadata", "patch": {"canvas": {"x": 1}}}],
            expected_updated_at=created["updated_at"],
        )
        assert updated["name"] == "Renamed"
        assert updated["definition"]["metadata"]["canvas"] == {"x": 1}

        detail = await service.get(kind="workflow", resource_id=created["id"])
        assert detail["resource"]["folder_id"] == folder["id"]
    finally:
        await close_engine()


@pytest.mark.asyncio
async def test_undo_is_all_or_nothing_when_resource_changed_outside_agent(tmp_path) -> None:
    service = await _service(tmp_path)
    try:
        ctx = ChangeContext(user_id="user-1", thread_id="thread-1", run_id="run-1")
        created = await service.create_workflow(name="Demo", definition=_definition(), change=ctx)
        updated = await service.update_workflow(
            definition_id=created["id"],
            name="Agent edit",
            expected_updated_at=created["updated_at"],
            change=ctx,
        )
        import asyncio

        await asyncio.sleep(0.01)
        await service.update_workflow(
            definition_id=created["id"],
            name="Manual edit",
            expected_updated_at=updated["updated_at"],
        )
        with pytest.raises(Exception):
            await service.undo(thread_id="thread-1")
        detail = await service.get(kind="workflow", resource_id=created["id"])
        assert detail["resource"]["name"] == "Manual edit"
    finally:
        await close_engine()


@pytest.mark.asyncio
async def test_change_history_is_thread_scoped(tmp_path) -> None:
    service = await _service(tmp_path)
    try:
        ctx1 = ChangeContext(user_id="user-1", thread_id="thread-1", run_id="run-1")
        ctx2 = ChangeContext(user_id="user-1", thread_id="thread-2", run_id="run-2")
        await service.create_workflow(name="One", definition=_definition("wf-one"), change=ctx1)
        await service.create_workflow(name="Two", definition=_definition("wf-two"), change=ctx2)
        history = await service.list_changes(thread_id="thread-1")
        assert [item["name"] for item in history["changes"]] == ["One"]
        assert history["undoable"]["count"] == 1
    finally:
        await close_engine()


@pytest.mark.asyncio
async def test_workspace_tools_create_and_undo_round_trip(tmp_path) -> None:
    from types import SimpleNamespace

    from deerflow.tools.builtins.workspace_tools import workflow_manage, workspace_undo

    service = await _service(tmp_path)
    try:
        runtime = SimpleNamespace(
            context={"thread_id": "thread-tools", "run_id": "run-tools", "user_id": "user-1"},
            tool_call_id="call-1",
        )
        created = json.loads(
            workflow_manage.func(
                action="create",
                name="Tool workflow",
                definition=_definition("wf-tool"),
                runtime=runtime,
            )
        )
        assert created["ok"] is True
        assert created["result"]["id"] == "wf-tool"

        listed = json.loads(workspace_undo.func(action="list", runtime=runtime))
        assert listed["ok"] is True
        assert listed["result"]["undoable"]["count"] == 1

        undone = json.loads(workspace_undo.func(action="undo", runtime=runtime))
        assert undone["ok"] is True
        assert undone["result"]["count"] == 1
        with pytest.raises(Exception):
            await service.get(kind="workflow", resource_id="wf-tool")
    finally:
        await close_engine()


@pytest.mark.asyncio
async def test_undo_group_applies_create_and_update_in_reverse(tmp_path) -> None:
    service = await _service(tmp_path)
    try:
        ctx = ChangeContext(user_id="user-1", thread_id="thread-1", run_id="run-1")
        created = await service.create_workflow(name="Demo", definition=_definition(), change=ctx)
        await service.update_workflow(
            definition_id=created["id"],
            name="Renamed",
            expected_updated_at=created["updated_at"],
            change=ctx,
        )

        result = await service.undo(thread_id="thread-1")

        assert result["count"] == 2
        with pytest.raises(Exception):
            await service.get(kind="workflow", resource_id=created["id"])
    finally:
        await close_engine()
