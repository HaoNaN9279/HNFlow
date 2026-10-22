"""Integration tests for the wired workflow definition tools (T17-6).

Exercises the full harness chain against a REAL sqlite database: the tool
entry points (``generate_workflow`` / ``edit_workflow``), the async generator
bridge, the lenient parse + structural validation retry loop, the
pending-review metadata stamping, and the harness persistence service writing
through ``WorkflowDefinitionRepository`` into a temp SQLite file. The only
mocked piece is ``run_oneshot_llm`` -- no real LLM, network, or API key is
involved.

Each test injects a ``DatabaseConfig`` with ``backend="sqlite"`` (pointed at
``tmp_path``) by patching ``get_app_config`` at BOTH call sites: the lazy
``_wave2_deps()`` import in ``workflow_tools.py`` (re-read on every call) and
the module-level binding in ``persistence/workflow_definitions/service.py``.
The tool's own ``get_app_config`` therefore hands the injected database to
``run_oneshot_llm`` while ``service.py`` hands it to ``init_engine_from_config``.
"""

from __future__ import annotations

import asyncio
import json
from contextlib import ExitStack
from types import SimpleNamespace
from unittest.mock import AsyncMock, MagicMock, patch

import pytest

from deerflow.config.database_config import DatabaseConfig
from deerflow.persistence.engine import close_engine, get_session_factory, init_engine_from_config
from deerflow.persistence.workflow_definitions import WorkflowDefinitionRepository
from deerflow.tools.builtins import edit_workflow, generate_workflow
from deerflow.workflow import WorkflowDefinition, validate_definition
from deerflow.workflow.danger import collect_pending_review_nodes

# ── Fixtures ─────────────────────────────────────────────────────────────────


@pytest.fixture(autouse=True)
def _clean_engine():
    """Reset the module-level persistence engine around every test.

    ``deerflow.persistence.engine`` keeps a process-global engine/session
    factory. The sqlite tests initialise it against ``tmp_path``; the memory
    test requires it to be ``None``. Resetting before AND after keeps the
    tests independent of each other and of the rest of the suite.
    """
    try:
        asyncio.run(close_engine())
    except Exception:  # noqa: BLE001 - best-effort cross-loop dispose
        pass
    yield
    try:
        asyncio.run(close_engine())
    except Exception:  # noqa: BLE001 - best-effort cross-loop dispose
        pass


# ── Helpers ──────────────────────────────────────────────────────────────────


def _runtime(user_id: str) -> SimpleNamespace:
    return SimpleNamespace(
        state={},
        context={"thread_id": "thread-1", "user_id": user_id},
        config={"configurable": {"thread_id": "thread-1", "user_id": user_id}},
        tool_call_id="tool-1",
    )


def _publish_definition_json() -> str:
    """A legal definition with no dangerous nodes and no capability groups."""
    return json.dumps(
        {
            "id": "wf-publish",
            "name": "Publish Workflow",
            "version": "0.1.0",
            "nodes": [
                {"id": "start", "type": "flow:start", "outputs": [{"name": "out", "type": "data"}]},
                {"id": "compile", "type": "data:assign", "inputs": [{"name": "in", "type": "data"}], "outputs": [{"name": "out", "type": "data"}], "params": {"value": "docs"}},
                {"id": "end", "type": "flow:end", "inputs": [{"name": "in", "type": "data"}]},
            ],
            "edges": [
                {"source": "start", "source_port": "out", "target": "compile", "target_port": "in"},
                {"source": "compile", "source_port": "out", "target": "end", "target_port": "in"},
            ],
            "metadata": {},
        }
    )


def _bash_definition_json() -> str:
    """A legal definition whose ``run`` node is a pending-review ``tool:bash``."""
    return json.dumps(
        {
            "id": "wf-review",
            "name": "Review Workflow",
            "version": "0.1.0",
            "nodes": [
                {"id": "start", "type": "flow:start", "outputs": [{"name": "out", "type": "data"}]},
                {"id": "run", "type": "tool:bash", "inputs": [{"name": "in", "type": "data"}], "outputs": [{"name": "out", "type": "data"}], "params": {"command": "echo hi"}},
                {"id": "end", "type": "flow:end", "inputs": [{"name": "in", "type": "data"}]},
            ],
            "edges": [
                {"source": "start", "source_port": "out", "target": "run", "target_port": "in"},
                {"source": "run", "source_port": "out", "target": "end", "target_port": "in"},
            ],
        }
    )


def _cycle_definition_json() -> str:
    """A structurally invalid definition: a cycle and no start/end nodes."""
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


def _install(database_config: DatabaseConfig, llm: AsyncMock | None = None) -> ExitStack:
    """Patch ``get_app_config`` at both call sites plus the LLM, if given."""
    stack = ExitStack()
    config_stub = SimpleNamespace(database=database_config)
    stack.enter_context(patch("deerflow.config.app_config.get_app_config", return_value=config_stub))
    stack.enter_context(patch("deerflow.persistence.workflow_definitions.service.get_app_config", return_value=config_stub))
    if llm is not None:
        stack.enter_context(patch("deerflow.utils.oneshot_llm.run_oneshot_llm", new=llm))
    return stack


def _init_db(database_config: DatabaseConfig) -> None:
    """Initialise the engine in THIS caller's loop so repo reads stay loop-local."""
    asyncio.run(init_engine_from_config(database_config))


def _get_row(database_config: DatabaseConfig, user_id: str, definition_id: str) -> dict | None:
    _init_db(database_config)

    async def _go() -> dict | None:
        session_factory = get_session_factory()
        assert session_factory is not None
        repo = WorkflowDefinitionRepository(session_factory)
        try:
            return await repo.get(definition_id, user_id=user_id)
        finally:
            # Dispose inside THIS loop so aiosqlite worker threads never wake
            # against a closed event loop.
            await close_engine()

    return asyncio.run(_go())


def _list_rows(database_config: DatabaseConfig, user_id: str) -> list[dict]:
    _init_db(database_config)

    async def _go() -> list[dict]:
        session_factory = get_session_factory()
        assert session_factory is not None
        repo = WorkflowDefinitionRepository(session_factory)
        try:
            return await repo.list_by_user(user_id)
        finally:
            await close_engine()

    return asyncio.run(_go())


# ── Generate: real sqlite round-trip ─────────────────────────────────────────


def test_generate_persists_publish_workflow_to_sqlite(tmp_path):
    """A valid generation returns ok + a definition id whose row is readable back."""
    database_config = DatabaseConfig(backend="sqlite", sqlite_dir=tmp_path.as_posix())
    llm = AsyncMock(return_value=_publish_definition_json())
    with _install(database_config, llm=llm):
        command = generate_workflow.func(prompt="创建一个发布流程", runtime=_runtime("user-int-1"))

    message = command.update["messages"][0]
    payload = json.loads(message.content)
    assert payload["ok"] is True
    definition_id = payload["definition_id"]
    assert definition_id.startswith("wf-")
    assert llm.await_count == 1

    # The returned definition is structurally valid and carries no pending review.
    definition = WorkflowDefinition.model_validate(payload["definition"])
    assert validate_definition(definition) == []
    assert definition.metadata.pending_review_nodes is None
    assert definition.metadata.resolved_groups is None  # no capability_groups

    # The saved row is readable back through the repository with the same shape.
    row = _get_row(database_config, "user-int-1", definition_id)
    assert row is not None
    assert row["user_id"] == "user-int-1"
    stored = WorkflowDefinition.model_validate(row["definition"])
    assert stored.id == "wf-publish"
    assert stored.name == "Publish Workflow"
    assert row["metadata"].get("resolved_groups") is None
    assert row["metadata"].get("pending_review_nodes") is None


def test_generate_retries_cycle_definition_with_error_feedback(tmp_path):
    """A cyclic first draft is fed back to the LLM retry, then succeeds and saves."""
    database_config = DatabaseConfig(backend="sqlite", sqlite_dir=tmp_path.as_posix())
    llm = AsyncMock(side_effect=[_cycle_definition_json(), _publish_definition_json()])
    with _install(database_config, llm=llm):
        command = generate_workflow.func(prompt="创建一个发布流程", runtime=_runtime("user-int-2"))

    payload = json.loads(command.update["messages"][0].content)
    assert payload["ok"] is True
    assert payload["definition_id"].startswith("wf-")
    assert llm.await_count == 2

    # The retry prompt surfaces the cycle path and the missing start/end errors.
    retry_call = llm.await_args
    assert "→" in retry_call.kwargs["user_content"]
    assert "missing flow:start" in retry_call.kwargs["user_content"]


def test_generate_marks_dangerous_nodes_pending_review(tmp_path):
    """A definition containing tool:bash lands with pending_review_nodes == [run]."""
    database_config = DatabaseConfig(backend="sqlite", sqlite_dir=tmp_path.as_posix())
    llm = AsyncMock(return_value=_bash_definition_json())
    with _install(database_config, llm=llm):
        command = generate_workflow.func(prompt="build a review workflow", runtime=_runtime("user-int-3"))

    payload = json.loads(command.update["messages"][0].content)
    assert payload["ok"] is True
    definition_id = payload["definition_id"]

    definition = WorkflowDefinition.model_validate(payload["definition"])
    assert collect_pending_review_nodes(definition) == ["run"]
    assert definition.metadata.pending_review_nodes == ["run"]

    row = _get_row(database_config, "user-int-3", definition_id)
    assert row is not None
    assert row["metadata"]["pending_review_nodes"] == ["run"]


# ── Edit: same-row update through the repository ──────────────────────────────


def test_edit_updates_saved_row_preserving_definition_id(tmp_path):
    """Edit reads the persisted row, LLM-revises it, and updates the same id."""
    database_config = DatabaseConfig(backend="sqlite", sqlite_dir=tmp_path.as_posix())
    mock_storage = MagicMock()
    mock_storage.load_skills.return_value = []

    gen_llm = AsyncMock(return_value=_publish_definition_json())
    with _install(database_config, llm=gen_llm):
        gen_command = generate_workflow.func(prompt="创建一个发布流程", runtime=_runtime("user-int-4"))
    gen_payload = json.loads(gen_command.update["messages"][0].content)
    assert gen_payload["ok"] is True
    definition_id = gen_payload["definition_id"]

    edited_json = _publish_definition_json().replace("Publish Workflow", "Edited Publish Workflow")
    edit_llm = AsyncMock(return_value=edited_json)
    with (
        _install(database_config, llm=edit_llm),
        patch("deerflow.skills.storage.get_or_new_skill_storage", return_value=mock_storage),
    ):
        edit_command = edit_workflow.func(definition_id=definition_id, instruction="改名为 Edited Publish Workflow", runtime=_runtime("user-int-4"))

    payload = json.loads(edit_command.update["messages"][0].content)
    assert payload["ok"] is True
    assert payload["definition_id"] == definition_id
    assert edit_llm.await_count == 1

    row = _get_row(database_config, "user-int-4", definition_id)
    assert row is not None
    stored = WorkflowDefinition.model_validate(row["definition"])
    assert stored.name == "Edited Publish Workflow"
    assert stored.id == definition_id


# ── Failure paths ─────────────────────────────────────────────────────────────


def test_generate_rejects_invalid_definition_without_persisting(tmp_path):
    """Exhausted LLM retries collapse to an error and leave the repo untouched."""
    database_config = DatabaseConfig(backend="sqlite", sqlite_dir=tmp_path.as_posix())
    llm = AsyncMock(side_effect=["bad one", "bad two", "bad three"])
    with _install(database_config, llm=llm):
        command = generate_workflow.func(prompt="build a review workflow", runtime=_runtime("user-int-5"))

    message = command.update["messages"][0]
    assert message.status == "error"
    payload = json.loads(message.content)
    assert payload["ok"] is False
    assert payload["errors"]
    assert llm.await_count == 3

    assert _list_rows(database_config, "user-int-5") == []


def test_generate_fails_closed_on_memory_backend(tmp_path):
    """The memory backend cannot persist; the tool returns a structured error."""
    database_config = DatabaseConfig(backend="memory")
    llm = AsyncMock(return_value=_publish_definition_json())
    with _install(database_config, llm=llm):
        command = generate_workflow.func(prompt="创建一个发布流程", runtime=_runtime("user-int-6"))

    message = command.update["messages"][0]
    assert message.status == "error"
    payload = json.loads(message.content)
    assert payload["ok"] is False
    assert "SQL database backend" in payload["errors"][0]["message"]
    assert llm.await_count == 1
