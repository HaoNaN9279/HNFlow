"""Tests for the N8 resource surface on the apps router + tool gateway path."""

from __future__ import annotations

import asyncio
import json
from pathlib import Path

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from app.gateway.deps import get_config
from app.gateway.routers import apps as apps_router
from deerflow.apps.registry import AppRegistry
from deerflow.apps.session import AppSessionManager, reset_session_manager
from deerflow.config.apps_config import AppDefinition, AppResourceDemand, AppsConfig, LicenseGroup
from deerflow.resources.governor import ResourceDemand, ResourceGovernor
from deerflow.runtime.context_keys import APP_RUNTIME_CONTEXT_KEY
from deerflow.workflow.compiler import WorkflowRuntime
from deerflow.workflow.tool_gateway import _app_tools


@pytest.fixture(autouse=True)
def _cleanup():
    reset_session_manager()
    yield
    reset_session_manager()


def _apps_config(tmp_path: Path, **overrides) -> AppsConfig:
    base = {
        "enabled": True,
        "definitions": {
            "blender": AppDefinition(driver="mock", description="B", working_dir=str(tmp_path), resources=AppResourceDemand(gpu=1, memory_mb=2048, license="render")),
        },
        "licenses": {"render": LicenseGroup(slots=1)},
        "resources": {"gpu": 1, "memory_mb": 4096},
    }
    base.update(overrides)
    return AppsConfig(**base)


def _client(config: AppsConfig) -> TestClient:
    app = FastAPI()
    app.include_router(apps_router.router)
    app.dependency_overrides[get_config] = lambda: type("C", (), {"apps": config})()
    return TestClient(app)


def _governed_manager(config: AppsConfig) -> AppSessionManager:
    return AppSessionManager(AppRegistry.from_config(config), governor=ResourceGovernor.from_apps_config(config))


def test_registry_list_reports_declared_resources(tmp_path):
    client = _client(_apps_config(tmp_path))
    response = client.get("/api/apps")
    assert response.status_code == 200
    entry = response.json()["apps"][0]
    assert entry["resources"] == {"gpu": 1, "cpu": 0, "memory_mb": 2048, "disk_mb": 0}
    assert entry["license"] == "render"


def test_resources_endpoint_is_stable_without_configured_caps(tmp_path, monkeypatch):
    """A configuration with no caps: a fixed shape, not a 500."""
    from deerflow.apps import session as session_module

    config = AppsConfig(enabled=True, definitions={"blender": AppDefinition(driver="mock", working_dir=str(tmp_path))})
    monkeypatch.setattr(session_module, "_default_manager", _governed_manager(config))

    response = _client(config).get("/api/apps/resources")
    assert response.status_code == 200
    body = response.json()
    assert body["enabled"] is False
    assert body["limits"] == {}
    assert body["licenses"] == {}


def test_resources_endpoint_reports_state_from_the_process_manager(tmp_path, monkeypatch):
    from deerflow.apps import session as session_module

    config = _apps_config(tmp_path, on_conflict="fail")
    manager = _governed_manager(config)
    monkeypatch.setattr(session_module, "_default_manager", manager)

    governor = manager.governor
    assert governor is not None
    holder = governor.acquire(ResourceDemand(gpu=1, license="render"))

    body = _client(config).get("/api/apps/resources").json()
    assert body["enabled"] is True
    assert body["limits"] == {"gpu": 1, "cpu": None, "memory_mb": 4096, "disk_mb": None}
    assert body["in_use"]["gpu"] == 1
    assert body["licenses"]["render"] == {"slots": 1, "in_use": 1, "waiting": 0}
    assert body["on_conflict"] == "fail"
    assert body["acquire_timeout_seconds"] == 60.0

    governor.release(holder)
    assert _client(config).get("/api/apps/resources").json()["in_use"]["gpu"] == 0


def test_tool_gateway_app_path_is_governed(tmp_path, monkeypatch):
    """The tool-gateway app tool goes through the same governed manager."""
    from deerflow.apps import session as session_module

    config = _apps_config(
        tmp_path,
        resources={"gpu": 1},
        on_conflict="fail",
        definitions={"blender": AppDefinition(driver="mock", description="B", working_dir=str(tmp_path), resources=AppResourceDemand(gpu=1))},
    )
    manager = _governed_manager(config)
    monkeypatch.setattr(session_module, "_default_manager", manager)
    governor = manager.governor
    assert governor is not None

    tool = _app_tools(app_config=config, user_id="default")["app_blender"]

    holder = governor.acquire(ResourceDemand(gpu=1))
    payload = json.loads(asyncio.run(tool.ainvoke({"script": "render"})))
    assert payload["status"] == "resource_unavailable"
    assert "gpu" in payload["error"]
    governor.release(holder)

    payload = json.loads(asyncio.run(tool.ainvoke({"script": "render"})))
    assert payload["status"] == "completed"
    assert governor.snapshot()["in_use"]["gpu"] == 0


def test_runtime_context_manager_carries_the_governor(tmp_path):
    """Executors resolve the manager from runtime context; its governor is shared."""
    config = _apps_config(
        tmp_path,
        resources={"gpu": 1},
        definitions={"blender": AppDefinition(driver="mock", working_dir=str(tmp_path), resources=AppResourceDemand(gpu=1))},
    )
    manager = _governed_manager(config)
    runtime = WorkflowRuntime(context={APP_RUNTIME_CONTEXT_KEY: manager}, state={})
    resolved = runtime.context[APP_RUNTIME_CONTEXT_KEY]
    assert resolved.governor is manager.governor
    assert resolved.governor is not None
