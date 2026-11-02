"""Tests for the ``app`` tool-gateway provider (N5)."""

from __future__ import annotations

import asyncio
import json
from pathlib import Path

import pytest

from deerflow.apps.session import reset_session_manager
from deerflow.config.apps_config import AppDefinition, AppsConfig, load_apps_config_from_dict, reset_apps_config
from deerflow.workflow.tool_gateway import PROVIDER_APP, build_default_tool_gateway


@pytest.fixture(autouse=True)
def _cleanup():
    yield
    reset_apps_config()
    reset_session_manager()


def test_app_provider_exposes_one_tool_per_available_app(tmp_path: Path):
    config = AppsConfig(enabled=True, definitions={"demo": AppDefinition(driver="mock", description="demo app", working_dir=str(tmp_path))})
    gateway = build_default_tool_gateway(app_config=config)

    assert "app" in [provider.name for provider in gateway.providers]
    tool = gateway.resolve("app_demo")
    assert tool is not None
    assert tool.name == "app_demo"
    assert PROVIDER_APP == "app"


def test_app_tool_invocation_runs_script_and_collects(tmp_path: Path):
    load_apps_config_from_dict(
        {
            "enabled": True,
            "definitions": {"demo": {"driver": "mock", "description": "demo app", "working_dir": str(tmp_path)}},
        }
    )
    reset_session_manager()
    config = AppsConfig(enabled=True, definitions={"demo": AppDefinition(driver="mock", description="demo app", working_dir=str(tmp_path))})
    gateway = build_default_tool_gateway(app_config=config)
    tool = gateway.resolve("app_demo")
    assert tool is not None

    payload = asyncio.run(tool.ainvoke({"script": "render", "args": ["--x"]}))
    data = json.loads(payload)
    assert data["app"] == "demo"
    assert data["status"] == "completed"
    assert "render" in data["stdout"]
    assert len(data["artifacts"]) == 1


def test_disabled_apps_expose_no_tools():
    gateway = build_default_tool_gateway(app_config=AppsConfig(enabled=False))
    assert gateway.resolve("app_demo") is None


def test_app_tool_writes_through_instance_repo(tmp_path: Path):
    load_apps_config_from_dict(
        {
            "enabled": True,
            "definitions": {"demo": {"driver": "mock", "description": "demo app", "working_dir": str(tmp_path)}},
        }
    )
    reset_session_manager()

    class _Repo:
        def __init__(self):
            self.created: list[dict] = []
            self.operations: list[dict] = []

        async def create(self, **kwargs):
            self.created.append(kwargs)
            return {"id": kwargs["session_id"]}

        async def record_operation(self, session_id, **kwargs):
            self.operations.append({"session_id": session_id, **kwargs})
            return {"id": session_id}

    repo = _Repo()
    config = AppsConfig(enabled=True, definitions={"demo": AppDefinition(driver="mock", description="demo app", working_dir=str(tmp_path))})
    gateway = build_default_tool_gateway(app_config=config, instance_repo=repo, user_id="user-7")
    tool = gateway.resolve("app_demo")
    assert tool is not None

    asyncio.run(tool.ainvoke({"script": "render", "args": []}))
    assert repo.created[0]["user_id"] == "user-7"
    assert repo.created[0]["app_name"] == "demo"
    deltas = [op["resource_deltas"] for op in repo.operations]
    assert {"scripts_run": 1} in deltas
    assert {"artifacts": 1} in deltas
