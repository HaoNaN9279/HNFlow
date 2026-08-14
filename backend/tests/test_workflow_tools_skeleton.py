"""Skeleton tests for the workflow definition tools (T17-3 / T17-5).

These tests pin the model-visible tool boundary: registration in
``BUILTIN_TOOLS``, argument schemas, and the fail-closed error path. After
T17-5 the generators are wired, so the former ``NotImplementedError`` stub
tests now drive the wired error paths with mocked LLM/persistence helpers.
"""

import json
import logging
from types import SimpleNamespace
from unittest.mock import AsyncMock, MagicMock, patch

from deerflow.tools.builtins import edit_workflow, generate_workflow
from deerflow.tools.tools import BUILTIN_TOOLS, get_available_tools


def _runtime() -> SimpleNamespace:
    return SimpleNamespace(
        state={},
        context={"thread_id": "thread-1", "user_id": "default"},
        config={"configurable": {"thread_id": "thread-1", "user_id": "default"}},
        tool_call_id="tool-1",
    )


def _make_minimal_config() -> MagicMock:
    config = MagicMock()
    config.tools = []
    config.models = []
    config.tool_search.enabled = False
    config.skill_evolution.enabled = False
    config.sandbox = MagicMock()
    config.acp_agents = {}
    return config


def test_generate_workflow_schema_exposes_prompt():
    assert generate_workflow.name == "generate_workflow"
    assert "workflow" in generate_workflow.description.lower()
    assert "prompt" in generate_workflow.args_schema.model_fields


def test_edit_workflow_schema_exposes_definition_id_and_instruction():
    assert edit_workflow.name == "edit_workflow"
    assert "workflow" in edit_workflow.description.lower()
    fields = edit_workflow.args_schema.model_fields
    assert "definition_id" in fields
    assert "instruction" in fields


def test_generate_workflow_error_path_returns_error_tool_message():
    """A wired generator failure still collapses to a structured error ToolMessage."""
    mock_llm = AsyncMock(side_effect=RuntimeError("boom"))
    with (
        patch("deerflow.config.app_config.get_app_config", return_value=MagicMock()),
        patch("deerflow.utils.oneshot_llm.run_oneshot_llm", new=mock_llm),
    ):
        command = generate_workflow.func(prompt="Build a review workflow", runtime=_runtime())

    message = command.update["messages"][0]
    assert message.status == "error"
    payload = json.loads(message.content)
    assert payload["ok"] is False
    assert payload["errors"][0]["code"] == "workflow_operation_failed"
    assert payload["errors"][0]["message"].startswith("generate_workflow failed")


def test_edit_workflow_missing_definition_returns_error_tool_message():
    """Editing an unknown definition id fails closed with the id in the error."""
    mock_get = AsyncMock(return_value=None)
    with (
        patch("deerflow.config.app_config.get_app_config", return_value=MagicMock()),
        patch("deerflow.persistence.workflow_definitions.service.get_workflow_definition", new=mock_get),
    ):
        command = edit_workflow.func(definition_id="def-1", instruction="Add a check step", runtime=_runtime())

    message = command.update["messages"][0]
    assert message.status == "error"
    payload = json.loads(message.content)
    assert payload["ok"] is False
    assert payload["errors"][0]["code"] == "workflow_operation_failed"
    assert "def-1" in payload["errors"][0]["message"]


def test_workflow_tools_registered_in_builtin_tools():
    assert generate_workflow in BUILTIN_TOOLS
    assert edit_workflow in BUILTIN_TOOLS
    names = [t.name for t in BUILTIN_TOOLS]
    assert len(names) == len(set(names))


@patch("deerflow.tools.tools.get_app_config")
@patch("deerflow.tools.tools.is_host_bash_allowed", return_value=True)
def test_get_available_tools_includes_workflow_tools_without_duplicate_warning(mock_bash, mock_cfg, caplog):
    mock_cfg.return_value = _make_minimal_config()

    with caplog.at_level(logging.WARNING, logger="deerflow.tools.tools"):
        result = get_available_tools(include_mcp=False, app_config=mock_cfg.return_value)

    names = [t.name for t in result]
    assert "generate_workflow" in names
    assert "edit_workflow" in names
    assert len(names) == len(set(names))
    assert not any("Duplicate tool name" in r.message for r in caplog.records)
