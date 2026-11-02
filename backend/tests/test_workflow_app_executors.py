"""Tests for the local-application workflow executors + registry wiring (N5)."""

from __future__ import annotations

import asyncio
from pathlib import Path

import pytest

from deerflow.apps.drivers.mock import MOCK_ARTIFACT_NAME
from deerflow.apps.registry import AppRegistry
from deerflow.apps.session import AppSessionManager, reset_session_manager
from deerflow.config.apps_config import AppDefinition, AppsConfig
from deerflow.runtime.context_keys import APP_INSTANCE_REPO_CONTEXT_KEY, APP_RUNTIME_CONTEXT_KEY
from deerflow.workflow.compiler import WorkflowRuntime
from deerflow.workflow.danger import dangerous_node_types
from deerflow.workflow.executors import build_default_registry
from deerflow.workflow.executors.local_app import exec_app_collect, exec_app_launch, exec_app_script, exec_app_wait
from deerflow.workflow.registry import crash_confirm_required
from deerflow.workflow.schema import NodeType


def _manager(tmp_path: Path) -> AppSessionManager:
    config = AppsConfig(enabled=True, definitions={"demo": AppDefinition(driver="mock", description="demo", working_dir=str(tmp_path))})
    return AppSessionManager(AppRegistry.from_config(config))


def _runtime(manager: AppSessionManager) -> WorkflowRuntime:
    return WorkflowRuntime(context={APP_RUNTIME_CONTEXT_KEY: manager}, state={})


@pytest.fixture(autouse=True)
def _cleanup():
    yield
    reset_session_manager()


def test_app_node_types_registered():
    registry = build_default_registry()
    for node_type in (NodeType.APP_LAUNCH, NodeType.APP_SCRIPT, NodeType.APP_WAIT, NodeType.APP_COLLECT):
        assert node_type in registry


def test_app_launch_and_script_are_dangerous_and_crash_confirm():
    assert NodeType.APP_LAUNCH in dangerous_node_types()
    assert NodeType.APP_SCRIPT in dangerous_node_types()
    assert NodeType.APP_WAIT not in dangerous_node_types()
    assert NodeType.APP_COLLECT not in dangerous_node_types()

    assert crash_confirm_required(NodeType.APP_LAUNCH) is True
    assert crash_confirm_required(NodeType.APP_SCRIPT) is True
    assert crash_confirm_required(NodeType.APP_WAIT) is False


def test_launch_requires_crash_confirm(tmp_path):
    manager = _manager(tmp_path)
    rt = _runtime(manager)
    with pytest.raises(Exception, match="crash_confirm"):
        asyncio.run(exec_app_launch(rt, {"app": "demo"}, {}))


def test_launch_and_script_and_collect_roundtrip(tmp_path):
    manager = _manager(tmp_path)
    rt = _runtime(manager)

    launched = asyncio.run(exec_app_launch(rt, {"app": "demo", "crash_confirm": True}, {}))
    session = launched["session"]
    assert session["app_name"] == "demo"
    assert session["status"] == "ready"

    scripted = asyncio.run(exec_app_script(rt, {"app": "demo", "script": "render", "args": ["--x"], "crash_confirm": True}, {"session": session}))
    assert scripted["out"]["status"] == "completed"
    assert scripted["out"]["exit_code"] == 0
    assert "render" in scripted["out"]["stdout"]

    collected = asyncio.run(exec_app_collect(rt, {"app": "demo"}, {"session": scripted["session"]}))
    assert Path(collected["out"]).name == MOCK_ARTIFACT_NAME
    assert collected["artifacts"] == [collected["out"]]


def test_wait_is_immediate_for_mock(tmp_path):
    manager = _manager(tmp_path)
    rt = _runtime(manager)
    launched = asyncio.run(exec_app_launch(rt, {"app": "demo", "crash_confirm": True}, {}))
    waited = asyncio.run(exec_app_wait(rt, {"app": "demo", "for": "render"}, {"session": launched["session"]}))
    assert waited["out"]["status"] == "done"


def test_script_without_session_errors(tmp_path):
    manager = _manager(tmp_path)
    rt = _runtime(manager)
    with pytest.raises(Exception, match="app:script"):
        asyncio.run(exec_app_script(rt, {"app": "demo", "script": "x", "crash_confirm": True}, {}))


def test_launch_rejects_bad_mode(tmp_path):
    manager = _manager(tmp_path)
    rt = _runtime(manager)
    with pytest.raises(Exception, match="mode"):
        asyncio.run(exec_app_launch(rt, {"app": "demo", "mode": "explode", "crash_confirm": True}, {}))


# ── N6: best-effort instance persistence ─────────────────────────────────────


class _RecordingRepo:
    def __init__(self) -> None:
        self.created: list[dict] = []
        self.operations: list[dict] = []

    async def create(self, **kwargs):
        self.created.append(kwargs)
        return {"id": kwargs["session_id"]}

    async def record_operation(self, session_id, **kwargs):
        self.operations.append({"session_id": session_id, **kwargs})
        return {"id": session_id}

    async def set_status(self, session_id, **kwargs):
        return {"id": session_id}


def _runtime_with_repo(manager: AppSessionManager, repo) -> WorkflowRuntime:
    return WorkflowRuntime(context={APP_RUNTIME_CONTEXT_KEY: manager, APP_INSTANCE_REPO_CONTEXT_KEY: repo}, state={})


def test_executors_write_through_instance_records(tmp_path):
    manager = _manager(tmp_path)
    repo = _RecordingRepo()
    rt = _runtime_with_repo(manager, repo)

    launched = asyncio.run(exec_app_launch(rt, {"app": "demo", "crash_confirm": True}, {}))
    assert repo.created[0]["app_name"] == "demo"
    assert repo.created[0]["user_id"] == "default"
    assert repo.created[0]["session_id"] == launched["session"]["session_id"]

    asyncio.run(exec_app_script(rt, {"app": "demo", "script": "render", "crash_confirm": True}, {"session": launched["session"]}))
    script_op = repo.operations[-1]
    assert script_op["resource_deltas"]["scripts_run"] == 1
    assert "busy_seconds" in script_op["resource_deltas"]
    assert "last_error" not in script_op["resource_deltas"]

    asyncio.run(exec_app_wait(rt, {"app": "demo", "for": "render"}, {"session": launched["session"]}))
    assert repo.operations[-1]["resource_deltas"]["waits"] == 1

    asyncio.run(exec_app_collect(rt, {"app": "demo"}, {"session": launched["session"]}))
    assert repo.operations[-1]["resource_deltas"]["artifacts"] == 1


def test_failing_repo_does_not_break_execution(tmp_path):
    manager = _manager(tmp_path)

    class _Boom:
        async def create(self, **kwargs):
            raise RuntimeError("db down")

        async def record_operation(self, session_id, **kwargs):
            raise RuntimeError("db down")

    rt = _runtime_with_repo(manager, _Boom())
    launched = asyncio.run(exec_app_launch(rt, {"app": "demo", "crash_confirm": True}, {}))
    assert launched["session"]["status"] == "ready"
    scripted = asyncio.run(exec_app_script(rt, {"app": "demo", "script": "render", "crash_confirm": True}, {"session": launched["session"]}))
    assert scripted["out"]["status"] == "completed"
