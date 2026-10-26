"""Project-scoped capability-group discovery and API tests."""

from __future__ import annotations

import json
from pathlib import Path

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient
from pydantic import ValidationError

from app.gateway.routers import capability_groups as capability_group_routes
from deerflow.capability_groups import discover_capability_groups, load_capability_group
from deerflow.config import paths as paths_module
from deerflow.config.database_config import DatabaseConfig
from deerflow.config.paths import Paths
from deerflow.persistence.engine import close_engine, get_session_factory, init_engine_from_config
from deerflow.persistence.projects import ProjectRepository
from deerflow.persistence.workflow_definitions.service import _resolve_workflow_metadata
from deerflow.projects.schema import ProjectCapabilityGroupRoot
from deerflow.projects.service import ProjectService
from deerflow.runtime.user_context import get_effective_user_id
from deerflow.workflow.schema import WorkflowDefinition


async def _service(tmp_path: Path) -> ProjectService:
    await init_engine_from_config(DatabaseConfig(backend="sqlite", sqlite_dir=str(tmp_path / "db")))
    session_factory = get_session_factory()
    assert session_factory is not None
    return ProjectService(ProjectRepository(session_factory))


def _write_group(root: Path, *, name: str, version: str, guid: str, description: str = "") -> None:
    group = root / name / version
    group.mkdir(parents=True, exist_ok=True)
    (group / "group.json").write_text(
        json.dumps(
            {
                "guid": guid,
                "name": name,
                "version": version,
                "description": description,
                "permissions": ["fs"],
                "extends": [],
            }
        ),
        encoding="utf-8",
    )


def _app(service: ProjectService) -> FastAPI:
    app = FastAPI()
    app.state.project_service = service
    app.include_router(capability_group_routes.router)
    return app


@pytest.mark.asyncio
async def test_project_capability_group_is_discovered_outside_hnflow(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(paths_module, "_paths", Paths(base_dir=tmp_path / "home"))
    user_id = get_effective_user_id()
    service = await _service(tmp_path)
    root = tmp_path / "project"
    project = await service.create_project(root_path=str(root), user_id=user_id, name="Demo")
    _write_group(root / ".vibestack" / "capability-groups", name="project-only", version="0.1.0", guid="a" * 32)

    roots = await service.capability_group_roots(project["project_id"], user_id=user_id)
    assert len(roots) == 1
    assert roots[0].source == "project"
    assert roots[0].project_id == project["project_id"]
    assert roots[0].root_id == "project"

    groups = discover_capability_groups(user_id=user_id, project_roots=roots)
    assert [(group.name, group.source, group.project_id) for group in groups] == [("project-only", "project", project["project_id"])]
    loaded = load_capability_group("project-only", user_id=user_id, project_roots=roots)
    assert loaded.root_id == "project"

    status = await service.capability_group_root_status(project["project_id"], user_id=user_id)
    assert status[0]["path"] == ".vibestack/capability-groups"
    assert status[0]["exists"] is True
    assert status[0]["group_count"] == 1

    await close_engine()


@pytest.mark.asyncio
async def test_project_group_shadows_same_name_global(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    home = tmp_path / "home"
    monkeypatch.setattr(paths_module, "_paths", Paths(base_dir=home))
    _write_group(home / "capability-groups", name="shared", version="0.1.0", guid="b" * 32)
    user_id = get_effective_user_id()
    service = await _service(tmp_path)
    root = tmp_path / "project"
    project = await service.create_project(root_path=str(root), user_id=user_id, name="Demo")
    _write_group(root / ".vibestack" / "capability-groups", name="shared", version="0.2.0", guid="c" * 32)

    roots = await service.capability_group_roots(project["project_id"], user_id=user_id)
    groups = discover_capability_groups(user_id=user_id, project_roots=roots)

    assert len(groups) == 1
    assert groups[0].guid == "c" * 32
    assert groups[0].source == "project"

    await close_engine()


def test_project_capability_group_path_cannot_live_under_hnflow() -> None:
    with pytest.raises(ValidationError):
        ProjectCapabilityGroupRoot(path=".hnflow/capability-groups")
    with pytest.raises(ValidationError):
        ProjectCapabilityGroupRoot(path="../outside")
    with pytest.raises(ValidationError):
        ProjectCapabilityGroupRoot(path="C:/outside")


@pytest.mark.asyncio
async def test_capability_group_api_accepts_project_scope(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(paths_module, "_paths", Paths(base_dir=tmp_path / "home"))
    user_id = get_effective_user_id()
    service = await _service(tmp_path)
    root = tmp_path / "project"
    project = await service.create_project(root_path=str(root), user_id=user_id, name="Demo")
    _write_group(root / ".vibestack" / "capability-groups", name="project-only", version="0.1.0", guid="d" * 32)

    client = TestClient(_app(service))
    response = client.get("/api/capability-groups", params={"project_id": project["project_id"]})
    assert response.status_code == 200, response.text
    groups = response.json()["groups"]
    assert [(group["name"], group["source"], group["project_id"]) for group in groups] == [("project-only", "project", project["project_id"])]

    detail = client.get(f"/api/capability-groups/{'d' * 32}", params={"project_id": project["project_id"]})
    assert detail.status_code == 200, detail.text
    assert detail.json()["project_id"] == project["project_id"]

    missing = client.get("/api/capability-groups", params={"project_id": "proj-missing"})
    assert missing.status_code == 404

    await close_engine()


@pytest.mark.asyncio
async def test_workflow_metadata_freezes_project_group_snapshot(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(paths_module, "_paths", Paths(base_dir=tmp_path / "home"))
    user_id = get_effective_user_id()
    service = await _service(tmp_path)
    root = tmp_path / "project"
    project = await service.create_project(root_path=str(root), user_id=user_id, name="Demo")
    _write_group(root / ".vibestack" / "capability-groups", name="project-only", version="0.1.0", guid="e" * 32)
    roots = await service.capability_group_roots(project["project_id"], user_id=user_id)
    definition = WorkflowDefinition.model_validate(
        {
            "id": "wf-snapshot",
            "name": "Snapshot",
            "nodes": [
                {"id": "start", "type": "flow:start", "outputs": [{"name": "out", "type": "data"}]},
                {
                    "id": "ai",
                    "type": "ai:llm_agent",
                    "capability_groups": ["project-only"],
                    "inputs": [{"name": "in", "type": "data"}],
                    "outputs": [{"name": "out", "type": "data"}],
                },
                {"id": "end", "type": "flow:end", "inputs": [{"name": "in", "type": "data"}]},
            ],
            "edges": [
                {"source": "start", "source_port": "out", "target": "ai", "target_port": "in"},
                {"source": "ai", "source_port": "out", "target": "end", "target_port": "in"},
            ],
        }
    )

    metadata = _resolve_workflow_metadata(
        definition,
        {},
        user_id=user_id,
        project_roots=tuple(roots),
    )

    assert metadata["resolved_groups"] == [f"{'e' * 32}@v0.1.0"]
    assert metadata["capability_group_roots"][0]["source"] == "project"
    assert metadata["capability_group_snapshot"][0]["name"] == "project-only"
    assert metadata["capability_group_snapshot"][0]["content_hash"]
    assert metadata["lockfile"]["capability_group_snapshot"] == metadata["capability_group_snapshot"]

    await close_engine()
