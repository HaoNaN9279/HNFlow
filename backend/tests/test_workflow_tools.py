"""Tests for the wired workflow definition tools (T17-5).

Replaces the T17-3 skeleton-only coverage with the full generator wiring:
LLM retry loops (invalid JSON / validation errors), pending-review metadata,
save/update persistence through the harness service helpers, and the
fail-closed error paths. The tool entry points stay synchronous; the async
``run_oneshot_llm`` / persistence helpers are mocked with ``AsyncMock``.
"""

from __future__ import annotations

import json
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import AsyncMock, MagicMock, patch

from deerflow.persistence.workflow_definitions.service import WorkflowDefinitionSaveError
from deerflow.skills.types import Skill, SkillCategory
from deerflow.tools.builtins import edit_workflow, generate_workflow

# ── Helpers ─────────────────────────────────────────────────────────────────


def _runtime(user_id: str = "user-1") -> SimpleNamespace:
    return SimpleNamespace(
        state={},
        context={"thread_id": "thread-1", "user_id": user_id},
        config={"configurable": {"thread_id": "thread-1", "user_id": user_id}},
        tool_call_id="tool-1",
    )


def _valid_definition_json() -> str:
    """A structurally valid workflow that includes a pending-review bash node."""
    return json.dumps(
        {
            "id": "wf-review",
            "name": "Review Workflow",
            "version": "0.1.0",
            "nodes": [
                {"id": "start", "type": "flow:start", "outputs": [{"name": "out", "type": "data"}]},
                {
                    "id": "run",
                    "type": "tool:bash",
                    "inputs": [{"name": "in", "type": "data"}],
                    "outputs": [{"name": "out", "type": "data"}],
                    "params": {"command": "echo hi"},
                },
                {"id": "end", "type": "flow:end", "inputs": [{"name": "in", "type": "data"}]},
            ],
            "edges": [
                {"source": "start", "source_port": "out", "target": "run", "target_port": "in"},
                {"source": "run", "source_port": "out", "target": "end", "target_port": "in"},
            ],
        }
    )


def _cycle_definition_json() -> str:
    """A structurally invalid workflow: a cycle and no start/end nodes."""
    return json.dumps(
        {
            "id": "cycle-wf",
            "name": "Cycle Workflow",
            "nodes": [
                {"id": "A", "type": "data:assign", "inputs": [{"name": "in", "type": "data"}], "outputs": [{"name": "out", "type": "data"}], "params": {"value": "x"}},
                {"id": "B", "type": "data:assign", "inputs": [{"name": "in", "type": "data"}], "outputs": [{"name": "out", "type": "data"}], "params": {"value": "x"}},
                {"id": "C", "type": "data:assign", "inputs": [{"name": "in", "type": "data"}], "outputs": [{"name": "out", "type": "data"}], "params": {"value": "x"}},
            ],
            "edges": [
                {"source": "A", "source_port": "out", "target": "B", "target_port": "in"},
                {"source": "B", "source_port": "out", "target": "C", "target_port": "in"},
                {"source": "C", "source_port": "out", "target": "A", "target_port": "in"},
            ],
        }
    )


def _existing_row(definition_json: str, definition_id: str = "wf-orig") -> dict:
    return {
        "id": definition_id,
        "user_id": "user-1",
        "name": "Original",
        "schema_version": 1,
        "definition": json.loads(definition_json),
        "metadata": {},
        "version": "0.1.0",
    }


def _make_skill(name: str, skill_id: str | None = None, version: str = "0.1.0") -> Skill:
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


def _command_payload(command) -> dict:
    message = command.update["messages"][0]
    return json.loads(message.content)


# ── Generate: success and retry paths ────────────────────────────────────────


def test_generate_retries_invalid_json_then_saves():
    mock_llm = AsyncMock(side_effect=["not json at all", _valid_definition_json()])
    mock_save = AsyncMock(return_value={"id": "wf-saved", "user_id": "user-1", "name": "Review Workflow"})
    with (
        patch("deerflow.config.app_config.get_app_config", return_value=MagicMock()),
        patch("deerflow.utils.oneshot_llm.run_oneshot_llm", new=mock_llm),
        patch("deerflow.persistence.workflow_definitions.service.save_workflow_definition", new=mock_save),
    ):
        command = generate_workflow.func(prompt="build a review workflow", runtime=_runtime())

    payload = _command_payload(command)
    assert payload["ok"] is True
    assert payload["definition_id"] == "wf-saved"
    assert payload["definition"]["id"] == "wf-review"
    assert payload["pending_review"] == ["run"]

    assert mock_llm.await_count == 2
    mock_save.assert_awaited_once()
    save_kwargs = mock_save.await_args.kwargs
    assert save_kwargs["user_id"] == "user-1"
    assert save_kwargs["version"] == "0.1.0"
    assert save_kwargs["definition"].metadata.pending_review_nodes == ["run"]


def test_generate_retries_validation_error_with_feedback():
    mock_llm = AsyncMock(side_effect=[_cycle_definition_json(), _valid_definition_json()])
    mock_save = AsyncMock(return_value={"id": "wf-saved", "user_id": "user-1", "name": "Review Workflow"})
    with (
        patch("deerflow.config.app_config.get_app_config", return_value=MagicMock()),
        patch("deerflow.utils.oneshot_llm.run_oneshot_llm", new=mock_llm),
        patch("deerflow.persistence.workflow_definitions.service.save_workflow_definition", new=mock_save),
    ):
        command = generate_workflow.func(prompt="build a review workflow", runtime=_runtime())

    payload = _command_payload(command)
    assert payload["ok"] is True
    assert payload["definition_id"] == "wf-saved"
    assert mock_llm.await_count == 2

    second_call = mock_llm.await_args  # last awaited call
    assert "→" in second_call.kwargs["user_content"]  # cycle path surfaced to the retry
    assert "missing flow:start" in second_call.kwargs["user_content"]
    mock_save.assert_awaited_once()


def test_generate_exhausts_retries_returns_error_without_saving():
    mock_llm = AsyncMock(side_effect=["bad one", "bad two", "bad three"])
    mock_save = AsyncMock()
    with (
        patch("deerflow.config.app_config.get_app_config", return_value=MagicMock()),
        patch("deerflow.utils.oneshot_llm.run_oneshot_llm", new=mock_llm),
        patch("deerflow.persistence.workflow_definitions.service.save_workflow_definition", new=mock_save),
    ):
        command = generate_workflow.func(prompt="build a review workflow", runtime=_runtime())

    message = command.update["messages"][0]
    assert message.status == "error"
    payload = _command_payload(command)
    assert payload["ok"] is False
    assert payload["errors"]
    assert any("JSON" in error["message"] for error in payload["errors"])
    assert mock_llm.await_count == 3
    mock_save.assert_not_awaited()


def test_generate_prompt_is_build_generate_prompt_output():
    """The full ``build_generate_prompt`` string goes out as system_instruction."""
    mock_llm = AsyncMock(return_value=_valid_definition_json())
    mock_save = AsyncMock(return_value={"id": "wf-saved", "user_id": "user-1", "name": "Review Workflow"})
    with (
        patch("deerflow.config.app_config.get_app_config", return_value=MagicMock()),
        patch("deerflow.utils.oneshot_llm.run_oneshot_llm", new=mock_llm),
        patch("deerflow.persistence.workflow_definitions.service.save_workflow_definition", new=mock_save),
    ):
        generate_workflow.func(prompt="build a review workflow", runtime=_runtime())

    call = mock_llm.await_args
    assert "你是一名工作流定义生成器" in call.kwargs["system_instruction"]
    assert "tool:bash" in call.kwargs["system_instruction"]
    assert call.kwargs["user_content"] == "build a review workflow"
    assert call.kwargs["thread_id"] == "thread-1"


# ── Edit: success and error paths ───────────────────────────────────────────


def test_edit_preserves_original_definition_id():
    existing = _existing_row(_valid_definition_json())
    edited_json = _valid_definition_json().replace("Review Workflow", "Edited Workflow")
    mock_get = AsyncMock(return_value=existing)
    mock_llm = AsyncMock(return_value=edited_json)
    mock_update = AsyncMock(return_value={"id": "wf-orig", "user_id": "user-1", "name": "Edited Workflow"})
    with (
        patch("deerflow.config.app_config.get_app_config", return_value=MagicMock()),
        patch("deerflow.persistence.workflow_definitions.service.get_workflow_definition", new=mock_get),
        patch("deerflow.utils.oneshot_llm.run_oneshot_llm", new=mock_llm),
        patch("deerflow.persistence.workflow_definitions.service.update_workflow_definition", new=mock_update),
    ):
        command = edit_workflow.func(definition_id="wf-orig", instruction="rename it", runtime=_runtime())

    payload = _command_payload(command)
    assert payload["ok"] is True
    assert payload["definition_id"] == "wf-orig"
    assert payload["pending_review"] == ["run"]

    mock_update.assert_awaited_once()
    update_kwargs = mock_update.await_args.kwargs
    assert update_kwargs["definition_id"] == "wf-orig"
    assert update_kwargs["user_id"] == "user-1"
    assert update_kwargs["definition"].name == "Edited Workflow"
    assert update_kwargs["definition"].metadata.pending_review_nodes == ["run"]

    edit_call = mock_llm.await_args
    assert "现有工作流定义" in edit_call.kwargs["user_content"]
    assert "rename it" in edit_call.kwargs["user_content"]


def test_edit_missing_definition_returns_error():
    mock_get = AsyncMock(return_value=None)
    mock_llm = AsyncMock()
    with (
        patch("deerflow.config.app_config.get_app_config", return_value=MagicMock()),
        patch("deerflow.persistence.workflow_definitions.service.get_workflow_definition", new=mock_get),
        patch("deerflow.utils.oneshot_llm.run_oneshot_llm", new=mock_llm),
    ):
        command = edit_workflow.func(definition_id="wf-nope", instruction="rename it", runtime=_runtime())

    message = command.update["messages"][0]
    assert message.status == "error"
    payload = _command_payload(command)
    assert payload["ok"] is False
    assert "wf-nope" in payload["errors"][0]["message"]
    mock_llm.assert_not_awaited()


def test_edit_skill_context_failure_fails_open():
    existing = _existing_row(_valid_definition_json())
    mock_get = AsyncMock(return_value=existing)
    mock_llm = AsyncMock(return_value=_valid_definition_json())
    mock_update = AsyncMock(return_value={"id": "wf-orig", "user_id": "user-1", "name": "Review Workflow"})
    with (
        patch("deerflow.config.app_config.get_app_config", return_value=MagicMock()),
        patch("deerflow.persistence.workflow_definitions.service.get_workflow_definition", new=mock_get),
        patch("deerflow.skills.storage.get_or_new_skill_storage", side_effect=RuntimeError("boom")),
        patch("deerflow.utils.oneshot_llm.run_oneshot_llm", new=mock_llm),
        patch("deerflow.persistence.workflow_definitions.service.update_workflow_definition", new=mock_update),
    ):
        command = edit_workflow.func(definition_id="wf-orig", instruction="rename it", runtime=_runtime())

    payload = _command_payload(command)
    assert payload["ok"] is True
    assert mock_llm.await_count == 1


# ── Persistence failure paths ────────────────────────────────────────────────


def test_generate_save_error_returns_error_tool_message():
    mock_llm = AsyncMock(return_value=_valid_definition_json())
    mock_save = AsyncMock(side_effect=WorkflowDefinitionSaveError("workflow definition persistence requires a SQL database backend (database.backend: sqlite or postgres); the configured backend is 'memory'"))
    with (
        patch("deerflow.config.app_config.get_app_config", return_value=MagicMock()),
        patch("deerflow.utils.oneshot_llm.run_oneshot_llm", new=mock_llm),
        patch("deerflow.persistence.workflow_definitions.service.save_workflow_definition", new=mock_save),
    ):
        command = generate_workflow.func(prompt="build a review workflow", runtime=_runtime())

    message = command.update["messages"][0]
    assert message.status == "error"
    payload = _command_payload(command)
    assert payload["ok"] is False
    assert "SQL database backend" in payload["errors"][0]["message"]


def test_edit_update_error_returns_error_tool_message():
    existing = _existing_row(_valid_definition_json())
    mock_get = AsyncMock(return_value=existing)
    mock_llm = AsyncMock(return_value=_valid_definition_json())
    mock_update = AsyncMock(side_effect=WorkflowDefinitionSaveError("workflow definition persistence requires a SQL database backend (database.backend: sqlite or postgres); the configured backend is 'memory'"))
    with (
        patch("deerflow.config.app_config.get_app_config", return_value=MagicMock()),
        patch("deerflow.persistence.workflow_definitions.service.get_workflow_definition", new=mock_get),
        patch("deerflow.utils.oneshot_llm.run_oneshot_llm", new=mock_llm),
        patch("deerflow.persistence.workflow_definitions.service.update_workflow_definition", new=mock_update),
    ):
        command = edit_workflow.func(definition_id="wf-orig", instruction="rename it", runtime=_runtime())

    message = command.update["messages"][0]
    assert message.status == "error"
    payload = _command_payload(command)
    assert payload["ok"] is False
    assert "SQL database backend" in payload["errors"][0]["message"]
