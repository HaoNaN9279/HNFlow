"""Tests for the local-application workflow executors + registry wiring (N5)."""

from __future__ import annotations

import asyncio
from pathlib import Path

import pytest

from deerflow.apps.drivers.mock import MOCK_ARTIFACT_NAME
from deerflow.apps.registry import AppRegistry
from deerflow.apps.session import AppSessionManager, reset_session_manager
from deerflow.config.apps_config import AppDefinition, AppsConfig
from deerflow.runtime.context_keys import APP_RUNTIME_CONTEXT_KEY
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
