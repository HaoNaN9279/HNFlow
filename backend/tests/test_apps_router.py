"""Tests for the ``/api/apps`` registry + sessions router (N4)."""

from __future__ import annotations

from pathlib import Path

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from app.gateway.deps import get_config
from app.gateway.routers import apps as apps_router
from deerflow.apps.session import reset_session_manager
from deerflow.config.apps_config import AppDefinition, AppsConfig, load_apps_config_from_dict, reset_apps_config


def _client(config: AppsConfig) -> TestClient:
    app = FastAPI()
    app.include_router(apps_router.router)
    app.dependency_overrides[get_config] = lambda: type("C", (), {"apps": config})()
    return TestClient(app)


@pytest.fixture(autouse=True)
def _cleanup():
    reset_apps_config()
    reset_session_manager()
    yield
    reset_apps_config()
    reset_session_manager()


def test_list_apps_reports_registry(tmp_path: Path):
    config = AppsConfig(enabled=True, definitions={"demo": AppDefinition(driver="mock", description="demo", working_dir=str(tmp_path))})
    with _client(config) as client:
        response = client.get("/api/apps")
    assert response.status_code == 200
    body = response.json()
    assert body["enabled"] is True
    assert body["apps"] == [{"name": "demo", "driver": "mock", "description": "demo", "available": True, "error": None}]


def test_list_apps_disabled_is_empty():
    with _client(AppsConfig(enabled=False)) as client:
        response = client.get("/api/apps")
    assert response.status_code == 200
    assert response.json() == {"enabled": False, "apps": []}


def test_list_sessions_reflects_live_launch(tmp_path: Path):
    load_apps_config_from_dict({"enabled": True, "definitions": {"demo": {"driver": "mock", "description": "demo", "working_dir": str(tmp_path)}}})
    reset_session_manager()
    from deerflow.apps.session import get_session_manager

    get_session_manager().launch("demo")

    with _client(AppsConfig(enabled=True)) as client:
        response = client.get("/api/apps/sessions")
    assert response.status_code == 200
    sessions = response.json()["sessions"]
    assert len(sessions) == 1
    assert sessions[0]["app_name"] == "demo"
    assert sessions[0]["driver"] == "mock"
