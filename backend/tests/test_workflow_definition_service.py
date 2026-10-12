"""Tests for ``deerflow.persistence.workflow_definitions.service``.

Covers the harness-layer ``save_workflow_definition`` helper: validation gate,
engine wiring (memory backend rejects with ``WorkflowDefinitionSaveError``),
and capability-group resolution (fail-open on skills storage failure).
"""

from __future__ import annotations

from pathlib import Path
from unittest.mock import AsyncMock, MagicMock, patch

import pytest

from deerflow.persistence.workflow_definitions import service as wf_service
from deerflow.persistence.workflow_definitions.service import (
    WorkflowDefinitionSaveError,
    save_workflow_definition,
)
from deerflow.skills.types import Skill, SkillCategory
from deerflow.workflow.schema import WorkflowDefinition

asyncio_test = pytest.mark.asyncio


# ── Helpers ─────────────────────────────────────────────────────────────────


def _make_skill(name: str, skill_id: str | None = None, version: str = "0.1.0") -> Skill:
    """Construct a minimal Skill for test catalogs."""
    return Skill(
        name=name,
        description=f"Skill {name}",
        license=None,
        skill_dir=Path("."),
        skill_file=Path("SKILL.md"),
        relative_path=Path("."),
        category=SkillCategory.CUSTOM,
        skill_id=skill_id,
        version=version,
    )


def _valid_definition() -> WorkflowDefinition:
    """A structurally valid workflow: start → assign → end."""
    return WorkflowDefinition.model_validate(
        {
            "id": "wf-test-def",
            "name": "Test Workflow",
            "nodes": [
                {"id": "start", "type": "flow:start", "outputs": [{"name": "out", "type": "data"}]},
                {"id": "assign", "type": "data:assign", "inputs": [{"name": "in", "type": "data"}], "outputs": [{"name": "out", "type": "data"}]},
                {"id": "end", "type": "flow:end", "inputs": [{"name": "in", "type": "data"}]},
            ],
            "edges": [
                {"source": "start", "source_port": "out", "target": "assign", "target_port": "in"},
                {"source": "assign", "source_port": "out", "target": "end", "target_port": "in"},
            ],
        }
    )


def _definition_with_capability_groups() -> WorkflowDefinition:
    """A valid workflow whose assign node references a capability group."""
    definition = _valid_definition()
    definition.nodes[1].capability_groups = ["data-analysis"]
    return definition


def _cycle_definition() -> WorkflowDefinition:
    """A structurally invalid workflow: cyclic edges, no start/end."""
    return WorkflowDefinition.model_validate(
        {
            "id": "cycle-wf",
            "name": "Cycle Workflow",
            "nodes": [
                {"id": "A", "type": "data:assign", "inputs": [{"name": "in", "type": "data"}], "outputs": [{"name": "out", "type": "data"}]},
                {"id": "B", "type": "data:assign", "inputs": [{"name": "in", "type": "data"}], "outputs": [{"name": "out", "type": "data"}]},
                {"id": "C", "type": "data:assign", "inputs": [{"name": "in", "type": "data"}], "outputs": [{"name": "out", "type": "data"}]},
            ],
            "edges": [
                {"source": "A", "source_port": "out", "target": "B", "target_port": "in"},
                {"source": "B", "source_port": "out", "target": "C", "target_port": "in"},
                {"source": "C", "source_port": "out", "target": "A", "target_port": "in"},
            ],
        }
    )


# ── Fixtures ─────────────────────────────────────────────────────────────────


@pytest.fixture
def engine_and_repo():
    """Patch engine wiring + repository.create; yield the create mock.

    Mirrors the engine-mock pattern from ``test_persistence_bootstrap.py`` /
    ``test_workflow_routes.py``: never touches the real memory backend.
    """
    mock_config = MagicMock()
    mock_config.database = MagicMock()
    create_mock = AsyncMock()
    with (
        patch.object(wf_service, "get_app_config", return_value=mock_config),
        patch.object(wf_service, "init_engine_from_config", new=AsyncMock()),
        patch.object(wf_service, "get_session_factory", return_value=object()),
        patch.object(wf_service.WorkflowDefinitionRepository, "create", new=create_mock),
    ):
        yield create_mock


# ── Success path ─────────────────────────────────────────────────────────────


@asyncio_test
async def test_save_success_calls_repository_create(engine_and_repo) -> None:
    """A valid definition saves through repository.create with expected args."""
    create_mock = engine_and_repo
    create_mock.return_value = {"id": "wf-abc", "user_id": "user-1", "name": "Test Workflow"}

    result = await save_workflow_definition(definition=_valid_definition(), user_id="user-1")

    create_mock.assert_awaited_once()
    kwargs = create_mock.await_args.kwargs
    assert kwargs["definition_id"].startswith("wf-")
    assert len(kwargs["definition_id"]) == len("wf-") + 32  # uuid4().hex
    assert kwargs["user_id"] == "user-1"
    assert kwargs["name"] == "Test Workflow"  # falls back to definition.name
    assert kwargs["schema_version"] == 1
    assert isinstance(kwargs["definition"], dict)
    assert kwargs["version"] == "0.1.0"
    assert kwargs["resolved_at"] is not None
    assert result == create_mock.return_value


@asyncio_test
async def test_save_name_override_is_forwarded(engine_and_repo) -> None:
    """An explicit name wins over definition.name."""
    create_mock = engine_and_repo

    await save_workflow_definition(definition=_valid_definition(), user_id="user-1", name="Renamed")

    assert create_mock.await_args.kwargs["name"] == "Renamed"


# ── Validation gate ──────────────────────────────────────────────────────────


@asyncio_test
async def test_invalid_definition_raises_before_create(engine_and_repo) -> None:
    """An invalid definition raises SaveError with the error list; create never runs."""
    create_mock = engine_and_repo

    with pytest.raises(WorkflowDefinitionSaveError) as excinfo:
        await save_workflow_definition(definition=_cycle_definition(), user_id="user-1")

    message = str(excinfo.value)
    assert "missing flow:start" in message
    assert "→" in message  # cycle path reported
    create_mock.assert_not_awaited()


# ── Memory backend ───────────────────────────────────────────────────────────


@asyncio_test
async def test_memory_backend_raises_save_error() -> None:
    """session_factory None (memory backend) → SaveError, create never runs."""
    mock_config = MagicMock()
    mock_config.database = MagicMock()
    create_mock = AsyncMock()
    with (
        patch.object(wf_service, "get_app_config", return_value=mock_config),
        patch.object(wf_service, "init_engine_from_config", new=AsyncMock()),
        patch.object(wf_service, "get_session_factory", return_value=None),
        patch.object(wf_service.WorkflowDefinitionRepository, "create", new=create_mock),
    ):
        with pytest.raises(WorkflowDefinitionSaveError, match="SQL database backend"):
            await save_workflow_definition(definition=_valid_definition(), user_id="user-1")

    create_mock.assert_not_awaited()


# ── Update (edit path) ───────────────────────────────────────────────────────


@asyncio_test
async def test_update_success_reuses_definition_id(engine_and_repo) -> None:
    """update_workflow_definition forwards the original id to repo.update."""
    update_mock = AsyncMock()
    update_mock.return_value = {"id": "wf-abc", "user_id": "user-1", "name": "Test Workflow"}
    with patch.object(wf_service.WorkflowDefinitionRepository, "update", new=update_mock):
        result = await wf_service.update_workflow_definition(
            definition_id="wf-abc",
            definition=_valid_definition(),
            user_id="user-1",
        )

    update_mock.assert_awaited_once()
    assert update_mock.await_args.args[0] == "wf-abc"
    kwargs = update_mock.await_args.kwargs
    assert kwargs["user_id"] == "user-1"
    updates = kwargs["updates"]
    assert updates["name"] == "Test Workflow"
    assert updates["schema_version"] == 1
    assert isinstance(updates["definition"], dict)
    assert updates["version"] == "0.1.0"
    assert updates["resolved_at"] is not None
    assert result == update_mock.return_value


@asyncio_test
async def test_update_not_found_raises_save_error(engine_and_repo) -> None:
    """repo.update returning None (no owned row) surfaces as a SaveError."""
    update_mock = AsyncMock(return_value=None)
    with patch.object(wf_service.WorkflowDefinitionRepository, "update", new=update_mock):
        with pytest.raises(WorkflowDefinitionSaveError, match="not found"):
            await wf_service.update_workflow_definition(
                definition_id="wf-ghost",
                definition=_valid_definition(),
                user_id="user-1",
            )


# ── Capability-group resolution ──────────────────────────────────────────────


@asyncio_test
async def test_resolves_capability_groups_into_metadata(engine_and_repo) -> None:
    """Resolvable capability groups populate metadata['resolved_groups']."""
    create_mock = engine_and_repo
    mock_storage = MagicMock()
    mock_storage.load_skills.return_value = [
        _make_skill("data-analysis", skill_id="550e8400-e29b", version="0.2.0"),
    ]

    with patch("deerflow.skills.storage.get_or_new_skill_storage", return_value=mock_storage):
        await save_workflow_definition(definition=_definition_with_capability_groups(), user_id="user-1")

    metadata = create_mock.await_args.kwargs["metadata"]
    assert metadata["resolved_groups"] == ["550e8400-e29b@v0.2.0"]


@asyncio_test
async def test_unknown_skill_yields_none_resolved_groups(engine_and_repo) -> None:
    """Unknown capability group names resolve to None (not an empty list)."""
    create_mock = engine_and_repo
    mock_storage = MagicMock()
    mock_storage.load_skills.return_value = []

    with patch("deerflow.skills.storage.get_or_new_skill_storage", return_value=mock_storage):
        await save_workflow_definition(definition=_definition_with_capability_groups(), user_id="user-1")

    metadata = create_mock.await_args.kwargs["metadata"]
    assert metadata["resolved_groups"] is None


@asyncio_test
async def test_save_attaches_lockfile_snapshot(engine_and_repo) -> None:
    """Saving freezes a lockfile snapshot into metadata (C3)."""
    create_mock = engine_and_repo

    await save_workflow_definition(definition=_definition_with_capability_groups(), user_id="user-1")

    metadata = create_mock.await_args.kwargs["metadata"]
    lockfile = metadata["lockfile"]
    assert lockfile["schema_version"] == 1
    assert lockfile["workflow"] == {"id": "wf-test-def", "version": "0.1.0"}
    assert isinstance(lockfile["capability_groups"], list)
    assert lockfile["created_at"]


@asyncio_test
async def test_skills_storage_failure_fails_open(engine_and_repo) -> None:
    """Skills storage failure is fail-open: save succeeds, no resolved_groups."""
    create_mock = engine_and_repo

    with patch("deerflow.skills.storage.get_or_new_skill_storage", side_effect=RuntimeError("boom")):
        await save_workflow_definition(definition=_definition_with_capability_groups(), user_id="user-1")

    metadata = create_mock.await_args.kwargs["metadata"]
    assert "resolved_groups" not in metadata
    create_mock.assert_awaited_once()
