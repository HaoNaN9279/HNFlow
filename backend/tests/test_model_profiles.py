"""Model-profile repository and HTTP CRUD/reference tests."""

from __future__ import annotations

from typing import Any
from unittest.mock import AsyncMock, MagicMock

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from app.gateway.deps import get_config
from app.gateway.routers import model_profile_routes, workflow_routes
from deerflow.config.database_config import DatabaseConfig
from deerflow.persistence.engine import close_engine, get_session_factory, init_engine_from_config
from deerflow.persistence.model_profiles import ModelProfileRepository
from deerflow.persistence.workflow_definitions import WorkflowDefinitionRepository


class _Model:
    def __init__(self, name: str) -> None:
        self.name = name
        self.model = f"provider-{name}"
        self.display_name = name.upper()
        self.supports_thinking = True
        self.supports_reasoning_effort = False
        self.context_window = 128000
        self.max_tokens = 4096


class _Config:
    def __init__(self) -> None:
        self._models = {"cloud-fast": _Model("cloud-fast"), "cloud-big": _Model("cloud-big")}
        self.models = list(self._models.values())

    def get_model_config(self, name: str) -> _Model | None:
        return self._models.get(name)


async def _setup(tmp_path):
    await init_engine_from_config(DatabaseConfig(backend="sqlite", sqlite_dir=str(tmp_path)))
    sf = get_session_factory()
    assert sf is not None
    return sf


def _app(sf) -> FastAPI:
    app = FastAPI()
    app.state.model_profile_repo = ModelProfileRepository(sf)
    app.state.workflow_definition_repo = WorkflowDefinitionRepository(sf)
    thread_store = MagicMock()
    thread_store.check_access = AsyncMock(return_value=True)
    app.state.thread_store = thread_store
    app.dependency_overrides[get_config] = lambda: _Config()
    app.include_router(model_profile_routes.router)
    app.include_router(workflow_routes.router)
    return app


def _profile_payload(**overrides: Any) -> dict[str, Any]:
    return {
        "name": "fast",
        "display_name": "Fast",
        "description": "Fast tasks",
        "target_model": "cloud-fast",
        "enabled": True,
        **overrides,
    }


@pytest.mark.asyncio
async def test_model_profile_crud_and_target_resolution(tmp_path):
    sf = await _setup(tmp_path)
    client = TestClient(_app(sf))

    created = client.post("/api/model-profiles", json=_profile_payload())
    assert created.status_code == 200, created.text
    body = created.json()
    assert body["target_model"] == "cloud-fast"
    assert body["target"] == {
        "available": True,
        "model": "provider-cloud-fast",
        "display_name": "CLOUD-FAST",
        "supports_thinking": True,
        "supports_reasoning_effort": False,
    }
    profile_id = body["id"]

    duplicate = client.post("/api/model-profiles", json=_profile_payload())
    assert duplicate.status_code == 409

    unknown = client.post("/api/model-profiles", json=_profile_payload(name="other", target_model="missing"))
    assert unknown.status_code == 422

    updated = client.put(f"/api/model-profiles/{profile_id}", json={"enabled": False, "display_name": "Fast disabled"})
    assert updated.status_code == 200, updated.text
    assert updated.json()["enabled"] is False
    assert updated.json()["display_name"] == "Fast disabled"

    listed = client.get("/api/model-profiles")
    assert listed.status_code == 200
    assert [item["id"] for item in listed.json()["profiles"]] == [profile_id]
    assert listed.json()["profiles"][0]["referenced_by"] == 0

    assert client.delete(f"/api/model-profiles/{profile_id}").status_code == 200
    assert client.get(f"/api/model-profiles/{profile_id}").status_code == 404

    await close_engine()


@pytest.mark.asyncio
async def test_model_profiles_are_user_scoped(tmp_path):
    sf = await _setup(tmp_path)
    repo = ModelProfileRepository(sf)
    await repo.create(user_id="default", name="default-profile", display_name="Default", target_model="cloud-fast")
    await repo.create(user_id="other", name="other-profile", display_name="Other", target_model="cloud-big")

    client = TestClient(_app(sf))
    listed = client.get("/api/model-profiles")
    assert listed.status_code == 200
    assert [item["name"] for item in listed.json()["profiles"]] == ["default-profile"]

    await close_engine()


@pytest.mark.asyncio
async def test_workflow_save_validates_model_profile(tmp_path, monkeypatch):
    monkeypatch.setattr("deerflow.config.get_app_config", lambda: _Config())
    sf = await _setup(tmp_path)
    repo = ModelProfileRepository(sf)
    profile = await repo.create(user_id="default", name="fast", display_name="Fast", target_model="cloud-fast")
    client = TestClient(_app(sf))

    def definition(profile_id: str) -> dict[str, Any]:
        return {
            "id": "wf-profile",
            "name": "Profile workflow",
            "version": "0.1.0",
            "nodes": [
                {"id": "start", "type": "flow:start", "inputs": [], "outputs": [{"name": "out", "type": "data"}]},
                {
                    "id": "ai",
                    "type": "ai:llm_agent",
                    "inputs": [{"name": "in", "type": "data"}],
                    "outputs": [{"name": "out", "type": "data"}],
                    "params": {"instruction": "do it", "model_profile": profile_id},
                },
                {"id": "end", "type": "flow:end", "inputs": [{"name": "in", "type": "data"}], "outputs": []},
            ],
            "edges": [
                {"source": "start", "source_port": "out", "target": "ai", "target_port": "in"},
                {"source": "ai", "source_port": "out", "target": "end", "target_port": "in"},
            ],
            "metadata": {},
        }

    saved = client.post("/api/workflows", json={"name": "Profile workflow", "definition": definition(profile["id"])})
    assert saved.status_code in (200, 201), saved.text

    missing = client.post("/api/workflows", json={"name": "Missing", "definition": definition("mp-missing")})
    assert missing.status_code == 422, missing.text
    assert "does not exist" in missing.text

    await close_engine()


@pytest.mark.asyncio
async def test_referenced_profile_cannot_be_deleted(tmp_path):
    sf = await _setup(tmp_path)
    repo = ModelProfileRepository(sf)
    profile = await repo.create(user_id="default", name="fast", display_name="Fast", target_model="cloud-fast")
    definitions = WorkflowDefinitionRepository(sf)
    await definitions.create(
        definition_id="wf-ref",
        user_id="default",
        name="Referenced",
        schema_version=1,
        definition={
            "id": "wf-ref",
            "name": "Referenced",
            "version": "0.1.0",
            "nodes": [
                {
                    "id": "ai",
                    "type": "ai:llm_agent",
                    "inputs": [],
                    "outputs": [],
                    "params": {"instruction": "x", "model_profile": profile["id"]},
                }
            ],
            "edges": [],
            "metadata": {},
        },
    )

    client = TestClient(_app(sf))
    listed = client.get("/api/model-profiles")
    assert listed.status_code == 200
    item = listed.json()["profiles"][0]
    assert item["referenced_by"] == 1
    assert item["referenced_workflows"] == 1

    blocked = client.delete(f"/api/model-profiles/{profile['id']}")
    assert blocked.status_code == 409
    assert "referenced" in blocked.json()["detail"]

    await close_engine()
