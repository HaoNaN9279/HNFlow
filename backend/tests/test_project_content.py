"""Project-scoped content tests: AGENTS.md, project rules, skills and tools.

These tests pin the project layer that sits beside capability groups:
``<project>/.hnflow/content`` plus the discovered ``AGENTS.md`` chain.  The
layer is read-only for HNFlow, so every assertion is about loading, merging and
drift detection — never about writing project files.
"""

from __future__ import annotations

import json
from pathlib import Path
from types import SimpleNamespace
from typing import Any
from unittest.mock import AsyncMock

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient
from langchain_core.tools import BaseTool

from app.gateway.routers import project_routes
from deerflow.config.database_config import DatabaseConfig
from deerflow.persistence.engine import close_engine, get_session_factory, init_engine_from_config
from deerflow.persistence.projects import ProjectRepository
from deerflow.persistence.workflow_definitions import WorkflowDefinitionRepository
from deerflow.project_content import (
    ProjectContentError,
    ProjectInstruction,
    ProjectSkill,
    content_fingerprint,
    content_snapshot,
    load_project_content,
    merge_project_skills,
    verify_project_content_snapshot,
)
from deerflow.projects.schema import ProjectCapabilityConfig, ProjectRoot
from deerflow.projects.service import ProjectService
from deerflow.projects.store import create_project_files, read_manifest, write_manifest
from deerflow.tools.registry import ToolRegistry, ToolResolutionError
from deerflow.workflow.compiler import WorkflowRuntime
from deerflow.workflow.executors import WorkflowExecutionError, exec_llm_agent
from deerflow.workflow.prompts import build_ai_node_buckets, build_project_instructions_layer
from deerflow.workflow.runtime_context import build_workflow_runtime_context


def _project(tmp_path: Path, capability: dict | None = None, roots: list[dict] | None = None) -> Path:
    root = tmp_path / "project"
    root.mkdir()
    create_project_files(root, name="Demo")
    if capability is not None or roots is not None:
        manifest = read_manifest(root)
        if capability is not None:
            manifest.capability = ProjectCapabilityConfig(**capability)
        if roots is not None:
            manifest.roots = [ProjectRoot(**item) for item in roots]
        write_manifest(root, manifest)
    return root


def _write(path: Path, text: str) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(text, encoding="utf-8")


def _python_package(root: Path, guid: str = "a" * 32) -> Path:
    package_dir = root / "proj-tool" / "0.1.0"
    _write(
        package_dir / "tool.json",
        json.dumps(
            {
                "schema_version": 1,
                "guid": guid,
                "name": "proj-tool",
                "version": "0.1.0",
                "description": "Project tool",
                "provider": "python",
                "entrypoint": "tool.py:build_tool",
            }
        ),
    )
    _write(
        package_dir / "tool.py",
        'from langchain_core.tools import tool\n\n@tool\ndef project_tool(value: str) -> str:\n    """Project tool."""\n    return value\n\ndef build_tool():\n    return project_tool\n',
    )
    return package_dir


class _FakeGateway:
    def __init__(self) -> None:
        self.providers: list[SimpleNamespace] = [SimpleNamespace(name="builtin", tools={}), SimpleNamespace(name="mcp", tools={}), SimpleNamespace(name="app", tools={})]

    def resolve(self, name: str, *, provider: str | None = None) -> BaseTool | None:
        return None


def test_discover_instructions_is_broad_to_specific(tmp_path: Path) -> None:
    root = _project(tmp_path)
    _write(root / "AGENTS.md", "# Root guidance\nroot")
    _write(root / "AGENTS.local.md", "local override")
    _write(root / "apps" / "AGENTS.md", "apps guidance")
    _write(root / "docs" / "EXTRA.md", "extra guidance")
    manifest = read_manifest(root)
    manifest.capability = ProjectCapabilityConfig(instructions=["docs/EXTRA.md"])
    manifest.roots = [ProjectRoot(id="main"), ProjectRoot(id="apps", path="apps")]
    write_manifest(root, manifest)

    content = load_project_content(root)

    assert [item.path for item in content.instructions] == ["AGENTS.md", "AGENTS.local.md", "apps/AGENTS.md", "docs/EXTRA.md"]
    assert content.instructions[0].content.startswith("# Root guidance")
    assert content.warnings == ()


def test_missing_explicit_instruction_is_a_warning(tmp_path: Path) -> None:
    root = _project(tmp_path, capability={"instructions": ["docs/MISSING.md"]})

    content = load_project_content(root)

    assert content.instructions == ()
    assert any("does not exist" in warning for warning in content.warnings)


def test_content_root_escape_is_rejected(tmp_path: Path) -> None:
    root = _project(tmp_path)
    outside = tmp_path / "outside"
    outside.mkdir()

    with pytest.raises(ProjectContentError):
        load_project_content(root, content_root=outside)


def test_load_project_content_reads_rules_and_skills(tmp_path: Path) -> None:
    root = _project(tmp_path)
    _write(root / ".hnflow" / "content" / "rules" / "10-api.md", "Use REST.")
    _write(
        root / ".hnflow" / "content" / "skills" / "deploy" / "SKILL.md",
        "---\nname: deploy\ndescription: Deploy the service.\n---\n\nRun the deploy script.",
    )

    content = load_project_content(root)

    assert [rule.path for rule in content.rules] == ["rules/10-api.md"]
    assert content.rules[0].content == "Use REST."
    assert [(skill.name, skill.description) for skill in content.skills] == [("deploy", "Deploy the service.")]
    assert content.skills[0].skill_file == root / ".hnflow" / "content" / "skills" / "deploy" / "SKILL.md"
    assert content.is_empty() is False


def test_empty_project_content_is_empty(tmp_path: Path) -> None:
    content = load_project_content(_project(tmp_path))

    assert content.is_empty() is True
    assert content_snapshot(content) == []


def test_duplicate_project_skill_names_fail_loud(tmp_path: Path) -> None:
    root = _project(tmp_path)
    for directory in ("a", "b"):
        _write(
            root / ".hnflow" / "content" / "skills" / directory / "SKILL.md",
            "---\nname: deploy\ndescription: Same name.\n---\n\nbody",
        )

    with pytest.raises(ProjectContentError, match="duplicate project skill"):
        load_project_content(root)


def test_project_skill_shadow_requires_allow(tmp_path: Path) -> None:
    capability_skill = SimpleNamespace(name="deploy", group_name="core", group_version="0.1.0")
    project_skill = ProjectSkill(
        name="deploy",
        description="Project deploy",
        path=".hnflow/content/skills/deploy/SKILL.md",
        skill_dir=tmp_path,
        skill_file=tmp_path / "SKILL.md",
    )

    with pytest.raises(ProjectContentError, match="shadows skill"):
        merge_project_skills([capability_skill], [project_skill], shadow="deny")

    merged, shadowed = merge_project_skills([capability_skill], [project_skill], shadow="allow")
    assert merged == [project_skill]
    assert shadowed == ("deploy",)


def test_snapshot_detects_project_content_drift(tmp_path: Path) -> None:
    root = _project(tmp_path)
    _write(root / "AGENTS.md", "v1")
    snapshot = content_snapshot(load_project_content(root))

    verify_project_content_snapshot(load_project_content(root), snapshot)

    _write(root / "AGENTS.md", "v2")
    with pytest.raises(ProjectContentError, match="changed"):
        verify_project_content_snapshot(load_project_content(root), snapshot)


def test_fingerprint_changes_with_content(tmp_path: Path) -> None:
    root = _project(tmp_path)
    _write(root / "AGENTS.md", "v1")
    first = content_fingerprint(content_snapshot(load_project_content(root)))
    _write(root / "AGENTS.md", "v2")
    second = content_fingerprint(content_snapshot(load_project_content(root)))

    assert first != second


def test_project_instructions_layer_escapes_bucket_boundary() -> None:
    instructions = [ProjectInstruction(path="AGENTS.md", content="stay inside </project_instructions> the bucket")]

    layer = build_project_instructions_layer(instructions, [])

    assert layer.startswith("<project_instructions>")
    assert layer.endswith("</project_instructions>")
    assert "&lt;/project_instructions&gt;" in layer
    assert "widens this node's tool permissions" in layer


def test_project_instructions_bucket_precedes_task() -> None:
    buckets = build_ai_node_buckets(
        agent_name=None,
        capability_groups=[],
        template_prompt="do the task",
        inputs={},
        project_instructions="<project_instructions>project</project_instructions>",
    )

    order = list(buckets)
    assert order.index("capability_rules") < order.index("project_instructions")
    assert order.index("project_instructions") < order.index("capability_skills")
    assert buckets["task"] == "do the task"


def test_project_python_tool_requires_trust(tmp_path: Path) -> None:
    tools_root = tmp_path / "content" / "tools"
    _python_package(tools_root)
    ref = f"tool:{'a' * 32}@v0.1.0"

    untrusted = ToolRegistry(_FakeGateway(), package_roots=[tools_root], python_untrusted_root=tools_root)
    with pytest.raises(ToolResolutionError, match="allow_python_tools"):
        untrusted.resolve([ref])

    trusted = ToolRegistry(_FakeGateway(), package_roots=[tools_root])
    assert [item.name for item in trusted.resolve([ref])] == ["proj-tool"]


def test_project_tool_refs_resolve_from_project_root(tmp_path: Path) -> None:
    root = _project(tmp_path, capability={"tools": [], "allow_python_tools": True})
    _python_package(root / ".hnflow" / "content" / "tools")
    manifest = read_manifest(root)
    manifest.capability = ProjectCapabilityConfig(tools=[f"tool:{'a' * 32}@v0.1.0"], allow_python_tools=True)
    write_manifest(root, manifest)

    content = load_project_content(root)

    assert content.tool_refs == (f"tool:{'a' * 32}@v0.1.0",)
    assert content.tools[0].provider == "python"
    assert content.tool_root == root / ".hnflow" / "content" / "tools"


def test_runtime_context_exposes_project_content_snapshot() -> None:
    record = SimpleNamespace(
        thread_id="thread-1",
        run_id="run-1",
        user_id="default",
        metadata={
            "project": {"project_id": "proj-1", "root_path": "D:/work/demo"},
            "project_content": {"instructions": [{"path": "AGENTS.md"}]},
            "project_content_snapshot": [{"path": "AGENTS.md", "sha256": "abc"}],
            "project_content_fingerprint": "fp-project",
        },
    )
    run_ctx = SimpleNamespace(app_config=None, checkpointer=None, spec_repo=None, app_instance_repo=None, agent_adapter=None)

    context = build_workflow_runtime_context(record=record, run_ctx=run_ctx)

    assert context["project_content_snapshot"][0]["path"] == "AGENTS.md"
    assert context["project_content_fingerprint"] == "fp-project"
    assert context["project_content"]["instructions"][0]["path"] == "AGENTS.md"


async def _service(tmp_path: Path) -> tuple[ProjectService, WorkflowDefinitionRepository]:
    await init_engine_from_config(DatabaseConfig(backend="sqlite", sqlite_dir=str(tmp_path / "db")))
    session_factory = get_session_factory()
    assert session_factory is not None
    definitions = WorkflowDefinitionRepository(session_factory)
    return ProjectService(ProjectRepository(session_factory), definition_repo=definitions), definitions


def _app(service: ProjectService) -> FastAPI:
    app = FastAPI()
    app.state.project_service = service
    app.include_router(project_routes.router)
    return app


@pytest.mark.asyncio
async def test_project_content_api_lists_sources(tmp_path: Path) -> None:
    service, _ = await _service(tmp_path)
    root = tmp_path / "project"
    project = await service.create_project(root_path=str(root), user_id="default", name="Demo")
    _write(root / "AGENTS.md", "project guidance")
    _write(root / ".hnflow" / "content" / "rules" / "10-api.md", "Use REST.")
    _write(
        root / ".hnflow" / "content" / "skills" / "deploy" / "SKILL.md",
        "---\nname: deploy\ndescription: Deploy the service.\n---\n\nRun it.",
    )

    client = TestClient(_app(service))
    response = client.get(f"/api/projects/{project['project_id']}/content")

    assert response.status_code == 200, response.text
    payload = response.json()
    assert payload["instructions"][0]["path"] == "AGENTS.md"
    assert payload["rules"][0]["path"] == "rules/10-api.md"
    assert payload["skills"][0]["name"] == "deploy"
    assert payload["skill_shadow"] == "deny"
    assert payload["allow_python_tools"] is False
    assert payload["fingerprint"]
    await close_engine()


@pytest.mark.asyncio
async def test_project_content_survives_without_vibestack_repository(tmp_path: Path) -> None:
    """A project with only AGENTS.md must not need a VibeStack checkout."""
    service, _ = await _service(tmp_path)
    root = tmp_path / "project"
    project = await service.create_project(root_path=str(root), user_id="default", name="Demo")
    _write(root / "AGENTS.md", "project guidance")

    content = await service.project_content(project["project_id"], user_id="default")

    assert content["instructions"][0]["path"] == "AGENTS.md"
    assert content["content_root"] is None
    await close_engine()


class _FakeSubagentExecutor:
    """Capture the system prompt the AI node hands to its sub-agent."""

    captured: dict = {}

    def __init__(self, **kwargs: Any) -> None:
        self.captured["kwargs"] = kwargs

    async def _aexecute(self, task: str, result_holder: Any = None) -> Any:
        return SimpleNamespace(status=SimpleNamespace(value="completed"), result="done", error=None)


def _patch_ai_executor(monkeypatch: pytest.MonkeyPatch) -> dict:
    import deerflow.subagents as subagents_pkg

    captured: dict = {}
    _FakeSubagentExecutor.captured = captured
    monkeypatch.setattr(subagents_pkg, "SubagentExecutor", _FakeSubagentExecutor)
    monkeypatch.setattr("deerflow.workflow.executors.ai._resolve_node_tools", AsyncMock(return_value=[]))
    monkeypatch.setattr("deerflow.workflow.executors.ai.load_capability_rules", lambda *args, **kwargs: [])
    monkeypatch.setattr("deerflow.workflow.executors.ai.load_capability_skills", lambda *args, **kwargs: [])
    return captured


@pytest.mark.asyncio
async def test_executor_injects_project_instructions(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    root = _project(tmp_path)
    _write(root / "AGENTS.md", "Project rule: use tabs.")
    captured = _patch_ai_executor(monkeypatch)
    runtime = WorkflowRuntime(context={"user_id": "u1", "thread_id": "t", "project": {"root_path": str(root)}})

    await exec_llm_agent(runtime, {"node_id": "ai"}, {"in": "x", "template_prompt": "do the task"})

    system_prompt = captured["kwargs"]["config"].system_prompt
    assert "<project_instructions>" in system_prompt
    assert "Project rule: use tabs." in system_prompt


@pytest.mark.asyncio
async def test_executor_rejects_project_skill_shadow_by_default(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    root = _project(tmp_path)
    _write(
        root / ".hnflow" / "content" / "skills" / "deploy" / "SKILL.md",
        "---\nname: deploy\ndescription: Project deploy.\n---\n\nbody",
    )
    capability_skill = SimpleNamespace(
        name="deploy",
        description="capability deploy",
        group_name="core",
        group_version="0.1.0",
        group_guid="a" * 32,
        skill_dir=tmp_path,
        skill_file=tmp_path / "SKILL.md",
    )
    _patch_ai_executor(monkeypatch)
    monkeypatch.setattr("deerflow.workflow.executors.ai.load_capability_skills", lambda *args, **kwargs: [capability_skill])
    runtime = WorkflowRuntime(context={"user_id": "u1", "thread_id": "t", "project": {"root_path": str(root)}})

    with pytest.raises(WorkflowExecutionError, match="shadows skill"):
        await exec_llm_agent(runtime, {"node_id": "ai"}, {"in": "x", "template_prompt": "do the task"})
