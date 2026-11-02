"""Tests for N8 resource admission through the ``app:*`` workflow executors."""

from __future__ import annotations

import asyncio
from pathlib import Path

import pytest

from deerflow.apps.registry import AppRegistry
from deerflow.apps.session import AppSessionManager, reset_session_manager
from deerflow.config.apps_config import AppDefinition, AppResourceDemand, AppsConfig, LicenseGroup
from deerflow.resources.governor import ResourceDemand, ResourceGovernor
from deerflow.runtime.context_keys import APP_INSTANCE_REPO_CONTEXT_KEY, APP_RUNTIME_CONTEXT_KEY
from deerflow.workflow.compiler import WorkflowRuntime
from deerflow.workflow.executors import WorkflowExecutionError
from deerflow.workflow.executors.local_app import exec_app_launch, exec_app_script, exec_app_wait


@pytest.fixture(autouse=True)
def _cleanup():
    yield
    reset_session_manager()


def _manager(tmp_path: Path, *, requirements: dict[str, dict], licenses: dict[str, int] | None = None, limits: dict[str, int] | None = None, on_conflict: str = "wait", timeout: float = 0.2) -> AppSessionManager:
    config = AppsConfig(
        enabled=True,
        definitions={name: AppDefinition(driver="mock", working_dir=str(tmp_path), resources=AppResourceDemand(**declared)) for name, declared in requirements.items()},
        licenses={name: LicenseGroup(slots=slots) for name, slots in (licenses or {}).items()},
        resources=limits or {},
    )
    governor = ResourceGovernor(limits or {}, licenses or {}, on_conflict=on_conflict, acquire_timeout_seconds=timeout)
    return AppSessionManager(AppRegistry.from_config(config), governor=governor)


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


def _runtime(manager: AppSessionManager, repo=None) -> WorkflowRuntime:
    context = {APP_RUNTIME_CONTEXT_KEY: manager}
    if repo is not None:
        context[APP_INSTANCE_REPO_CONTEXT_KEY] = repo
    return WorkflowRuntime(context=context, state={})


def test_script_fails_with_actionable_error_when_quota_is_held(tmp_path):
    manager = _manager(tmp_path, requirements={"demo": {"gpu": 1}}, limits={"gpu": 1})
    governor = manager.governor
    assert governor is not None
    rt = _runtime(manager)

    launched = asyncio.run(exec_app_launch(rt, {"app": "demo", "crash_confirm": True}, {}))
    holder = governor.acquire(ResourceDemand(gpu=1))
    try:
        with pytest.raises(WorkflowExecutionError, match="local resource unavailable") as exc:
            asyncio.run(exec_app_script(rt, {"app": "demo", "script": "render", "crash_confirm": True}, {"session": launched["session"]}))
        assert "gpu" in str(exc.value)
    finally:
        governor.release(holder)
    # The failed node released nothing it did not hold: a retry now succeeds.
    asyncio.run(exec_app_script(rt, {"app": "demo", "script": "render", "crash_confirm": True}, {"session": launched["session"]}))
    assert governor.snapshot()["in_use"]["gpu"] == 0


def test_wait_fails_with_actionable_error_when_quota_is_held(tmp_path):
    manager = _manager(tmp_path, requirements={"demo": {"disk_mb": 8}}, limits={"disk_mb": 8})
    governor = manager.governor
    assert governor is not None
    rt = _runtime(manager)
    launched = asyncio.run(exec_app_launch(rt, {"app": "demo", "crash_confirm": True}, {}))

    holder = governor.acquire(ResourceDemand(disk_mb=8))
    try:
        with pytest.raises(WorkflowExecutionError, match="disk_mb"):
            asyncio.run(exec_app_wait(rt, {"app": "demo", "for": "render"}, {"session": launched["session"]}))
    finally:
        governor.release(holder)


def test_license_failure_is_reported_by_launch(tmp_path):
    manager = _manager(tmp_path, requirements={"a": {"license": "render"}, "b": {"license": "render"}}, licenses={"render": 1}, on_conflict="fail")
    rt = _runtime(manager)
    asyncio.run(exec_app_launch(rt, {"app": "a", "crash_confirm": True}, {}))
    with pytest.raises(WorkflowExecutionError, match="license 'render'"):
        asyncio.run(exec_app_launch(rt, {"app": "b", "crash_confirm": True}, {}))


def test_degraded_script_is_recorded_on_the_instance(tmp_path):
    manager = _manager(tmp_path, requirements={"demo": {"gpu": 1}}, limits={"gpu": 1}, on_conflict="degrade")
    governor = manager.governor
    assert governor is not None
    repo = _RecordingRepo()
    rt = _runtime(manager, repo)

    launched = asyncio.run(exec_app_launch(rt, {"app": "demo", "crash_confirm": True}, {}))
    assert "degraded" not in repo.created[0]["resources"]

    holder = governor.acquire(ResourceDemand(gpu=1))
    try:
        asyncio.run(exec_app_script(rt, {"app": "demo", "script": "render", "crash_confirm": True}, {"session": launched["session"]}))
    finally:
        governor.release(holder)

    deltas = repo.operations[-1]["resource_deltas"]
    assert deltas["degraded"] == 1
    assert deltas["scripts_run"] == 1

    # A later, admitted operation does not re-report the degrade.
    asyncio.run(exec_app_script(rt, {"app": "demo", "script": "render", "crash_confirm": True}, {"session": launched["session"]}))
    assert "degraded" not in repo.operations[-1]["resource_deltas"]


def test_degraded_launch_is_recorded(tmp_path):
    manager = _manager(tmp_path, requirements={"a": {"license": "render"}, "b": {"license": "render"}}, licenses={"render": 1}, on_conflict="degrade")
    repo = _RecordingRepo()
    rt = _runtime(manager, repo)

    asyncio.run(exec_app_launch(rt, {"app": "a", "crash_confirm": True}, {}))
    asyncio.run(exec_app_launch(rt, {"app": "b", "crash_confirm": True}, {}))

    assert "degraded" not in repo.created[0]["resources"]
    assert repo.created[1]["resources"]["degraded"] == 1
