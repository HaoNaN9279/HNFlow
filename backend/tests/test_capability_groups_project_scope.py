"""VibeStack project stack and workbench activation tests."""

from __future__ import annotations

import json
from pathlib import Path
from types import SimpleNamespace

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from app.gateway import project_context
from app.gateway.routers import capability_groups as capability_group_routes
from deerflow.capability_groups.vibestack import discover_repository_groups, ensure_project_stack, load_group_closure, read_project_stack, write_project_stack
from deerflow.config.database_config import DatabaseConfig
from deerflow.persistence.engine import close_engine, get_session_factory, init_engine_from_config
from deerflow.persistence.projects import ProjectRepository
from deerflow.persistence.workflow_definitions import WorkflowDefinitionRepository
from deerflow.projects import service as project_service_module
from deerflow.projects.service import ProjectService
from deerflow.runtime.user_context import get_effective_user_id
from deerflow.workflow.schema import WorkflowDefinition


def _write_group(repository: Path, name: str, version: str, guid: str, *, extends: list[str] | None = None, category: str | None = None) -> None:
    root = repository / "capability-groups"
    if category is not None:
        root = root / category
    root = root / name / version
    root.mkdir(parents=True, exist_ok=True)
    (root / "group.json").write_text(
        json.dumps(
            {
                "guid": guid,
                "name": name,
                "version": version,
                "description": f"{name} {version}",
                "permissions": ["fs"],
                "extends": extends or [],
                "tools": [],
            }
        ),
        encoding="utf-8",
    )


def _write_repository(tmp_path: Path) -> Path:
    repository = tmp_path / "VibeStack"
    _write_group(repository, "core", "0.1.0", "a" * 32)
    _write_group(repository, "alpha", "0.1.0", "b" * 32)
    _write_group(repository, "alpha", "0.2.0", "b" * 32)
    _write_group(repository, "beta", "1.0.0", "c" * 32)
    return repository


def test_repository_discovery_supports_core_and_domain_layouts(tmp_path: Path) -> None:
    repository = tmp_path / "VibeStack"
    _write_group(repository, "core", "0.1.0", "a" * 32)
    _write_group(repository, "excel", "1.0.0", "d" * 32, category="domain")
    _write_group(repository, "excel", "1.1.0", "e" * 32, category="domain")

    groups = discover_repository_groups(repository)

    assert [(group.name, group.version) for group in groups] == [
        ("core", "0.1.0"),
        ("excel", "1.0.0"),
        ("excel", "1.1.0"),
    ]


def _fake_plan(root: Path, *, repository: Path, timeout: float = 30.0) -> SimpleNamespace:
    stack = read_project_stack(root)
    references = [f"{group.name}@{group.version}" for group in (stack.groups if stack is not None else ())]
    groups = load_group_closure(repository, references)
    return SimpleNamespace(
        core=groups[0] if groups else None,
        groups=tuple(groups[1:]),
        closure=tuple(groups),
        active_versions={group.name: group.version for group in groups},
    )


def _use_repository(monkeypatch: pytest.MonkeyPatch, repository: Path) -> None:
    monkeypatch.setattr(project_service_module, "resolve_repository", lambda: repository)
    monkeypatch.setattr(capability_group_routes, "resolve_repository", lambda: repository)
    monkeypatch.setattr(project_context, "resolve_repository", lambda: repository)
    monkeypatch.setattr(project_context, "resolve_project_plan", _fake_plan)


def _definition(definition_id: str, groups: list[str]) -> dict:
    return {
        "id": definition_id,
        "name": definition_id,
        "version": "0.1.0",
        "metadata": {},
        "nodes": [
            {"id": "start", "type": "flow:start", "inputs": [], "outputs": [{"name": "out", "type": "data"}]},
            {
                "id": "ai",
                "type": "ai:llm_agent",
                "capability_groups": groups,
                "inputs": [{"name": "in", "type": "data"}],
                "outputs": [{"name": "out", "type": "data"}],
            },
            {"id": "end", "type": "flow:end", "inputs": [{"name": "in", "type": "data"}], "outputs": []},
        ],
        "edges": [
            {"source": "start", "source_port": "out", "target": "ai", "target_port": "in"},
            {"source": "ai", "source_port": "out", "target": "end", "target_port": "in"},
        ],
    }


async def _service(tmp_path: Path) -> tuple[ProjectService, WorkflowDefinitionRepository]:
    await init_engine_from_config(DatabaseConfig(backend="sqlite", sqlite_dir=str(tmp_path / "db")))
    session_factory = get_session_factory()
    assert session_factory is not None
    definitions = WorkflowDefinitionRepository(session_factory)
    await definitions.create(
        definition_id="wf-alpha",
        user_id="default",
        name="Alpha workflow",
        schema_version=1,
        definition=_definition("wf-alpha", ["alpha@0.1.0"]),
    )
    await definitions.create(
        definition_id="wf-empty",
        user_id="default",
        name="Core-only workflow",
        schema_version=1,
        definition=_definition("wf-empty", []),
    )
    service = ProjectService(ProjectRepository(session_factory), definition_repo=definitions)
    return service, definitions


def _app(service: ProjectService) -> FastAPI:
    app = FastAPI()
    app.state.project_service = service
    app.include_router(capability_group_routes.router)
    return app


@pytest.mark.asyncio
async def test_create_workbench_initializes_core_stack(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    repository = _write_repository(tmp_path)
    _use_repository(monkeypatch, repository)
    service, _ = await _service(tmp_path)
    project = await service.create_project(root_path=str(tmp_path / "project"), user_id="default", name="Demo")

    await service.create_workbench(project["project_id"], user_id="default", name="Daily")

    stack = read_project_stack(tmp_path / "project")
    assert stack is not None
    assert stack.core is not None
    assert (stack.core.name, stack.core.version) == ("core", "0.1.0")
    assert stack.groups == ()
    await close_engine()


def test_empty_node_selection_loads_core_only(tmp_path: Path) -> None:
    repository = _write_repository(tmp_path)

    groups = load_group_closure(repository, [])

    assert [group.name for group in groups] == ["core"]


@pytest.mark.asyncio
async def test_add_member_activates_only_needed_groups_and_preserves_unrelated(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    repository = _write_repository(tmp_path)
    _use_repository(monkeypatch, repository)
    service, _ = await _service(tmp_path)
    root = tmp_path / "project"
    project = await service.create_project(root_path=str(root), user_id="default", name="Demo")
    workbench = await service.create_workbench(project["project_id"], user_id="default", name="Daily")

    # An unrelated manually-managed group must survive workbench activation.
    ensure_project_stack(root)
    stack = read_project_stack(root)
    assert stack is not None
    from deerflow.capability_groups.vibestack import VibeStackGroupRef

    write_project_stack(
        root,
        type(stack)(
            path=stack.path,
            schema_version=stack.schema_version,
            core=stack.core,
            agents=stack.agents,
            groups=(VibeStackGroupRef("beta", "1.0.0"),),
            raw=stack.raw,
        ),
    )

    member = await service.add_member(project["project_id"], workbench["id"], user_id="default", definition_id="wf-alpha")
    assert member["activation"]["activated"][0]["name"] == "alpha"

    stack = read_project_stack(root)
    assert stack is not None
    assert [(group.name, group.version) for group in stack.groups] == [("beta", "1.0.0"), ("alpha", "0.1.0")]
    await close_engine()


@pytest.mark.asyncio
async def test_activate_workflow_groups_keeps_unrelated_entries(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    repository = _write_repository(tmp_path)
    _use_repository(monkeypatch, repository)
    service, _ = await _service(tmp_path)
    root = tmp_path / "project"
    project = await service.create_project(root_path=str(root), user_id="default", name="Demo")
    ensure_project_stack(root)
    stack = read_project_stack(root)
    assert stack is not None
    from deerflow.capability_groups.vibestack import VibeStackGroupRef

    write_project_stack(
        root,
        type(stack)(
            path=stack.path,
            schema_version=stack.schema_version,
            core=stack.core,
            agents=stack.agents,
            groups=(VibeStackGroupRef("beta", "1.0.0"),),
            raw=stack.raw,
        ),
    )

    definition = WorkflowDefinition.model_validate(_definition("wf-alpha", ["alpha@0.1.0"]))
    result = await service.activate_workflow_groups(project["project_id"], definition, user_id="default")

    assert result["activated"][0]["name"] == "alpha"
    stack = read_project_stack(root)
    assert stack is not None
    assert [(group.name, group.version) for group in stack.groups] == [("beta", "1.0.0"), ("alpha", "0.1.0")]
    await close_engine()


@pytest.mark.asyncio
async def test_delete_workbench_does_not_change_project_stack(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    repository = _write_repository(tmp_path)
    _use_repository(monkeypatch, repository)
    service, _ = await _service(tmp_path)
    root = tmp_path / "project"
    project = await service.create_project(root_path=str(root), user_id="default", name="Demo")
    workbench = await service.create_workbench(project["project_id"], user_id="default", name="Daily")
    await service.add_member(project["project_id"], workbench["id"], user_id="default", definition_id="wf-alpha")
    before = (root / ".vibestack" / "stack.json").read_bytes()

    assert await service.delete_workbench(project["project_id"], workbench["id"], user_id="default") is True

    assert (root / ".vibestack" / "stack.json").read_bytes() == before
    await close_engine()


@pytest.mark.asyncio
async def test_capability_group_api_lists_all_versions_and_marks_active(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    repository = _write_repository(tmp_path)
    _use_repository(monkeypatch, repository)
    service, _ = await _service(tmp_path)
    root = tmp_path / "project"
    project = await service.create_project(root_path=str(root), user_id=get_effective_user_id(), name="Demo")
    ensure_project_stack(root)
    stack = read_project_stack(root)
    assert stack is not None
    from deerflow.capability_groups.vibestack import VibeStackGroupRef

    write_project_stack(
        root,
        type(stack)(
            path=stack.path,
            schema_version=stack.schema_version,
            core=stack.core,
            agents=stack.agents,
            groups=(VibeStackGroupRef("alpha", "0.1.0"),),
            raw=stack.raw,
        ),
    )

    client = TestClient(_app(service))
    response = client.get("/api/capability-groups", params={"project_id": project["project_id"]})
    assert response.status_code == 200, response.text
    payload = response.json()
    alpha_versions = [group for group in payload["groups"] if group["name"] == "alpha"]
    assert {group["version"] for group in alpha_versions} == {"0.1.0", "0.2.0"}
    assert next(group for group in alpha_versions if group["version"] == "0.1.0")["active"] is True
    assert next(group for group in alpha_versions if group["version"] == "0.2.0")["active"] is False
    assert next(group for group in payload["groups"] if group["name"] == "core")["is_core"] is True
    await close_engine()
