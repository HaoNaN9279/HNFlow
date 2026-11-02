"""Tests for the dialogue-side HumanTask tools (T18-4).

Covers the acceptance criteria for ``list_human_tasks`` / ``submit_human_task``
/ ``skip_human_task`` in ``deerflow.tools.builtins.workflow_runtime_tools``:

1. list empty / with data (including ``status`` filtering)
2. submit valid values → ok + repo state ``submitted`` + resume dispatched
3. submit invalid values (missing required port) → fail-closed errors + state unchanged
4. submit a non-existent task → error
5. submit an already-terminal task → 409 conflict
6. skip → ok + ``skipped`` + resume dispatched with ``{"__skip": True}``
7. missing human_task_repo (no ``__workflow_runtime`` injection, or a ``None``
   repository) → explicit ``human_tasks_unavailable`` error

Uses a real SQLite ``HumanTaskRepository`` (engine pattern from
``test_human_task_repository.py``) and mocks the T18-2 dispatch resume
(``deerflow.workflow.dispatch.resume_workflow_run``) so the repository
round-trips are real while the resume side-effect stays isolated.  The tools
pass the *transitioned* row (returned by ``repo.submit`` / ``repo.skip``) to
the dispatch layer; the resume value contract (submitted → ``submission``
dict, otherwise → ``{"__skip": True}``) is asserted through
``dispatch._resume_value_for_task``.
"""

from __future__ import annotations

import asyncio
import json
from types import SimpleNamespace
from unittest.mock import AsyncMock, patch

import pytest

from deerflow.config.database_config import DatabaseConfig
from deerflow.persistence.engine import close_engine, get_session_factory, init_engine_from_config
from deerflow.persistence.human_tasks import HumanTaskRepository
from deerflow.tools.builtins import workflow_runtime_tools as wrt
from deerflow.workflow.dispatch import _resume_value_for_task

asyncio_test = pytest.mark.asyncio

OUTPUT_SPEC = {
    "ports": [
        {"name": "answer", "type": "data", "required": True, "description": "最终结论"},
    ]
}


async def _cleanup_engine() -> None:
    """Close the engine and let Windows release the SQLite file handles.

    The tool entry points bridge async work through the shared tool executor,
    whose worker-thread loop opens SQLite connections; after ``dispose`` the
    OS can take a tick to release the ``.db`` handle, and ``tmp_path`` teardown
    would otherwise fail with ``PermissionError`` on Windows.
    """
    await close_engine()
    await asyncio.sleep(0.1)


# ── Helpers ─────────────────────────────────────────────────────────────────


async def _make_repo(tmp_path) -> HumanTaskRepository:
    """Init a real SQLite engine and return a HumanTaskRepository over it."""
    await init_engine_from_config(DatabaseConfig(backend="sqlite", sqlite_dir=str(tmp_path)))
    sf = get_session_factory()
    assert sf is not None
    return HumanTaskRepository(sf)


def _runtime(
    repo,
    user_id: str = "user-1",
    *,
    with_runtime: bool = True,
    run_manager=None,
    stream_bridge=None,
    run_ctx=None,
) -> SimpleNamespace:
    context = {"thread_id": "thread-1", "user_id": user_id}
    if with_runtime:
        context[wrt.WORKFLOW_RUNTIME_CONTEXT_KEY] = {
            "human_task_repo": repo,
            "run_manager": run_manager,
            "stream_bridge": stream_bridge,
            "run_ctx": run_ctx,
        }
    return SimpleNamespace(
        state={},
        context=context,
        config={"configurable": {"thread_id": "thread-1", "user_id": user_id}},
        tool_call_id="tool-1",
    )


def _payload(command) -> dict:
    message = command.update["messages"][0]
    return json.loads(message.content)


async def _create_task(
    repo: HumanTaskRepository,
    *,
    user_id: str = "user-1",
    workflow_run_id: str = "wf-run-1",
    node_id: str = "ht-node",
    description: str = "请确认最终结论",
    with_checkpoint: bool = True,
) -> dict:
    checkpoint_ref = {"thread_id": "thread-1", "checkpoint_id": "ck-1"} if with_checkpoint else None
    return await repo.create(
        user_id=user_id,
        workflow_run_id=workflow_run_id,
        node_id=node_id,
        description=description,
        output_spec=OUTPUT_SPEC,
        validation_rules={},
        checkpoint_ref=checkpoint_ref,
    )


# ── 1. list: empty / with data / status filter ──────────────────────────────


@asyncio_test
async def test_list_empty(tmp_path) -> None:
    repo = await _make_repo(tmp_path)
    try:
        command = wrt.list_human_tasks.func(runtime=_runtime(repo))
        payload = _payload(command)
        assert payload["ok"] is True
        assert payload["tasks"] == []
        assert payload["total"] == 0
    finally:
        await _cleanup_engine()


@asyncio_test
async def test_list_with_data_and_status_filter(tmp_path) -> None:
    repo = await _make_repo(tmp_path)
    try:
        pending = await _create_task(repo, workflow_run_id="wf-run-1", node_id="n1", description="Approve")
        done = await _create_task(repo, workflow_run_id="wf-run-2", node_id="n2", description="Already done")
        await repo.submit(done["id"], user_id="user-1", values={"answer": "ok"}, to_status="submitted")

        all_command = wrt.list_human_tasks.func(runtime=_runtime(repo))
        all_payload = _payload(all_command)
        assert all_payload["ok"] is True
        assert all_payload["total"] == 2
        by_id = {t["id"]: t for t in all_payload["tasks"]}
        assert set(by_id) == {pending["id"], done["id"]}

        pending_command = wrt.list_human_tasks.func(runtime=_runtime(repo), status="pending")
        pending_payload = _payload(pending_command)
        assert pending_payload["total"] == 1
        task = pending_payload["tasks"][0]
        assert task["id"] == pending["id"]
        assert task["node_id"] == "n1"
        assert task["description"] == "Approve"
        assert task["status"] == "pending"
        assert task["created_at"] is not None
        assert task["output_spec"] == OUTPUT_SPEC
    finally:
        await _cleanup_engine()


# ── 2. submit: valid values ─────────────────────────────────────────────────


@asyncio_test
async def test_submit_valid_ok_and_resume_dispatched(tmp_path) -> None:
    repo = await _make_repo(tmp_path)
    try:
        task = await _create_task(repo, workflow_run_id="wf-run-1")
        resume_mock = AsyncMock()
        with patch("deerflow.workflow.dispatch.resume_workflow_run", new=resume_mock):
            command = wrt.submit_human_task.func(task_id=task["id"], values={"answer": "yes"}, runtime=_runtime(repo))

        payload = _payload(command)
        assert payload["ok"] is True
        assert payload["task_id"] == task["id"]
        assert payload["status"] == "submitted"

        fetched = await repo.get(task["id"], user_id="user-1")
        assert fetched["status"] == "submitted"
        assert fetched["submission"] == {"answer": "yes"}

        # The *transitioned* row is handed to the dispatch layer, and its
        # recorded submission drives the resume value.
        resume_mock.assert_awaited_once()
        transitioned = resume_mock.await_args.args[0]
        assert transitioned["id"] == task["id"]
        assert transitioned["status"] == "submitted"
        assert transitioned["submission"] == {"answer": "yes"}
        assert _resume_value_for_task(transitioned) == {"answer": "yes"}
    finally:
        await _cleanup_engine()


# ── 3. submit: invalid values → fail-closed ─────────────────────────────────


@asyncio_test
async def test_submit_invalid_fail_closed_keeps_state(tmp_path) -> None:
    repo = await _make_repo(tmp_path)
    try:
        task = await _create_task(repo, workflow_run_id="wf-run-1")
        resume_mock = AsyncMock()
        with patch("deerflow.workflow.dispatch.resume_workflow_run", new=resume_mock):
            command = wrt.submit_human_task.func(task_id=task["id"], values={}, runtime=_runtime(repo))

        payload = _payload(command)
        assert payload["ok"] is False
        errors = payload["errors"]
        assert errors[0]["code"] == "human_task_validation_failed"
        assert any("缺少必填字段" in message for message in errors[0]["errors"])

        fetched = await repo.get(task["id"], user_id="user-1")
        assert fetched["status"] == "pending"  # state unchanged — user may retry
        assert fetched["submission"] is None
        resume_mock.assert_not_awaited()
    finally:
        await _cleanup_engine()


# ── 4. submit: non-existent task ────────────────────────────────────────────


@asyncio_test
async def test_submit_missing_task_returns_not_found(tmp_path) -> None:
    repo = await _make_repo(tmp_path)
    try:
        resume_mock = AsyncMock()
        with patch("deerflow.workflow.dispatch.resume_workflow_run", new=resume_mock):
            command = wrt.submit_human_task.func(task_id="ht-nope", values={"answer": "x"}, runtime=_runtime(repo))

        payload = _payload(command)
        assert payload["ok"] is False
        assert payload["errors"][0]["code"] == "human_task_not_found"
        resume_mock.assert_not_awaited()
    finally:
        await _cleanup_engine()


# ── 5. submit: already-terminal task → 409 conflict ─────────────────────────


@asyncio_test
async def test_submit_terminal_task_conflict(tmp_path) -> None:
    repo = await _make_repo(tmp_path)
    try:
        task = await _create_task(repo, workflow_run_id="wf-run-1")
        await repo.submit(task["id"], user_id="user-1", values={"answer": "first"}, to_status="submitted")

        resume_mock = AsyncMock()
        with patch("deerflow.workflow.dispatch.resume_workflow_run", new=resume_mock):
            command = wrt.submit_human_task.func(task_id=task["id"], values={"answer": "second"}, runtime=_runtime(repo))

        payload = _payload(command)
        assert payload["ok"] is False
        assert payload["errors"][0]["code"] == "human_task_conflict"
        resume_mock.assert_not_awaited()

        fetched = await repo.get(task["id"], user_id="user-1")
        assert fetched["status"] == "submitted"
        assert fetched["submission"] == {"answer": "first"}  # second submission rejected
    finally:
        await _cleanup_engine()


# ── 6. skip ─────────────────────────────────────────────────────────────────


@asyncio_test
async def test_skip_ok_and_resume_with_skip_marker(tmp_path) -> None:
    repo = await _make_repo(tmp_path)
    try:
        task = await _create_task(repo, workflow_run_id="wf-run-1")
        resume_mock = AsyncMock()
        with patch("deerflow.workflow.dispatch.resume_workflow_run", new=resume_mock):
            command = wrt.skip_human_task.func(task_id=task["id"], runtime=_runtime(repo))

        payload = _payload(command)
        assert payload["ok"] is True
        assert payload["task_id"] == task["id"]
        assert payload["status"] == "skipped"

        fetched = await repo.get(task["id"], user_id="user-1")
        assert fetched["status"] == "skipped"

        # The transitioned (skipped, submission=None) row drives the skip sentinel.
        resume_mock.assert_awaited_once()
        transitioned = resume_mock.await_args.args[0]
        assert transitioned["id"] == task["id"]
        assert transitioned["status"] == "skipped"
        assert transitioned.get("submission") is None
        assert _resume_value_for_task(transitioned) == {"__skip": True}
    finally:
        await _cleanup_engine()


@asyncio_test
async def test_skip_terminal_task_conflict(tmp_path) -> None:
    repo = await _make_repo(tmp_path)
    try:
        task = await _create_task(repo, workflow_run_id="wf-run-1")
        await repo.submit(task["id"], user_id="user-1", values={"answer": "first"}, to_status="submitted")

        resume_mock = AsyncMock()
        with patch("deerflow.workflow.dispatch.resume_workflow_run", new=resume_mock):
            command = wrt.skip_human_task.func(task_id=task["id"], runtime=_runtime(repo))

        payload = _payload(command)
        assert payload["ok"] is False
        assert payload["errors"][0]["code"] == "human_task_conflict"
        resume_mock.assert_not_awaited()
    finally:
        await _cleanup_engine()


# ── 7. missing human_task_repo → explicit error ─────────────────────────────


def test_list_unavailable_without_runtime_injection() -> None:
    runtime = _runtime(repo=None, with_runtime=False)
    command = wrt.list_human_tasks.func(runtime=runtime)
    payload = _payload(command)
    assert payload["ok"] is False
    assert payload["errors"] == [{"code": "human_tasks_unavailable", "message": "human task 存储不可用（需 SQL database backend）"}]


def test_list_unavailable_when_repo_is_none() -> None:
    runtime = _runtime(repo=None, with_runtime=True)
    command = wrt.list_human_tasks.func(runtime=runtime)
    payload = _payload(command)
    assert payload["ok"] is False
    assert payload["errors"][0]["code"] == "human_tasks_unavailable"


def test_submit_unavailable_without_runtime_injection() -> None:
    runtime = _runtime(repo=None, with_runtime=False)
    command = wrt.submit_human_task.func(task_id="ht-1", values={"answer": "x"}, runtime=runtime)
    payload = _payload(command)
    assert payload["ok"] is False
    assert payload["errors"][0]["code"] == "human_tasks_unavailable"


def test_skip_unavailable_without_runtime_injection() -> None:
    runtime = _runtime(repo=None, with_runtime=False)
    command = wrt.skip_human_task.func(task_id="ht-1", runtime=runtime)
    payload = _payload(command)
    assert payload["ok"] is False
    assert payload["errors"][0]["code"] == "human_tasks_unavailable"
