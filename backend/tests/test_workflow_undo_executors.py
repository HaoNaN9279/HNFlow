"""Tests for N10 failure-time compensation (``params.rollback_on_failure``).

Covers the two mutating node families that go through the sandbox/host boundary —
``data:file`` write and ``data:asset`` import/export/convert — asserting that:

- nothing is snapshotted or recorded unless the node asked for rollback,
- a successful mutation is recorded as still standing (undoable later),
- a failed mutation restores the previous content (or removes a file it created),
- a backup that cannot be taken aborts the node *before* it mutates anything.

The undo repository is a recording double; the sandbox is mocked.
"""

from __future__ import annotations

import asyncio
from pathlib import Path
from typing import Any
from unittest.mock import MagicMock

import pytest

from deerflow.config.assets_config import load_assets_config_from_dict, reset_assets_config
from deerflow.workflow.compensation import CompensationUnavailable, rollback_requested
from deerflow.workflow.executors import WorkflowExecutionError
from deerflow.workflow.executors.asset import exec_asset
from deerflow.workflow.executors.data import exec_file
from deerflow.workflow.undo import UndoStatus

# ── helpers ───────────────────────────────────────────────────────────────────


@pytest.fixture(autouse=True)
def _reset_assets_config() -> Any:
    reset_assets_config()
    yield
    reset_assets_config()


class _RecordingUndoRepo:
    """Captures ``create`` calls; the real repository is covered separately."""

    def __init__(self) -> None:
        self.records: list[dict[str, Any]] = []

    async def create(self, **kwargs: Any) -> dict[str, Any]:
        record = {"id": f"undo-{len(self.records) + 1}", **kwargs}
        self.records.append(record)
        return record


class _FailingUndoRepo:
    async def create(self, **kwargs: Any) -> dict[str, Any]:
        raise RuntimeError("database is on fire")


def _runtime(**context: Any) -> Any:
    from deerflow.workflow.compiler import WorkflowRuntime

    return WorkflowRuntime(context=context, config={}, state={})


def _run(coro: Any) -> Any:
    return asyncio.run(coro)


# ── the switch itself ─────────────────────────────────────────────────────────


def test_rollback_is_always_enabled() -> None:
    assert rollback_requested({"rollback_on_failure": True}) is True
    assert rollback_requested({"rollback_on_failure": False}) is True
    assert rollback_requested({"rollback_on_failure": "yes"}) is True
    assert rollback_requested({}) is True


# ── data:file write ───────────────────────────────────────────────────────────


def _file_params(**extra: Any) -> dict[str, Any]:
    return {"operation": "write", "path": "/mnt/user-data/workspace/o.txt", "content": "new", "crash_confirm": True, "node_id": "f1", **extra}


def _sandbox_with_previous(content: bytes | None) -> MagicMock:
    sandbox = MagicMock()
    if content is None:
        sandbox.download_file.side_effect = OSError("not found")
    else:
        sandbox.download_file.return_value = content
    return sandbox


def test_write_defaults_to_recording_rollback(monkeypatch: pytest.MonkeyPatch) -> None:
    repo = _RecordingUndoRepo()
    sandbox = _sandbox_with_previous(b"old")
    monkeypatch.setattr("deerflow.workflow.executors.data.sandbox_tools.ensure_sandbox_initialized", lambda runtime=None: sandbox)

    result = _run(exec_file(_runtime(workflow_undo_repo=repo, run_id="r1", user_id="u1"), _file_params(), {}))

    assert result == {"out": "new"}
    sandbox.write_file.assert_called_once()
    sandbox.download_file.assert_called_once()
    assert len(repo.records) == 1


def test_write_with_rollback_records_the_action(monkeypatch: pytest.MonkeyPatch) -> None:
    repo = _RecordingUndoRepo()
    sandbox = _sandbox_with_previous(b"old")
    monkeypatch.setattr("deerflow.workflow.executors.data.sandbox_tools.ensure_sandbox_initialized", lambda runtime=None: sandbox)

    _run(exec_file(_runtime(workflow_undo_repo=repo, run_id="r1", user_id="u1"), _file_params(rollback_on_failure=True), {}))

    assert len(repo.records) == 1
    record = repo.records[0]
    assert record["status"] == UndoStatus.RECORDED.value
    assert record["kind"] == "file_backup"
    assert record["node_id"] == "f1"
    assert record["run_id"] == "r1"
    assert record["targets"][0]["path"] == "/mnt/user-data/workspace/o.txt"
    assert record["backup_paths"], "the previous content must have been snapshotted"


def test_failed_write_restores_the_previous_content(monkeypatch: pytest.MonkeyPatch) -> None:
    repo = _RecordingUndoRepo()
    sandbox = _sandbox_with_previous(b"old content")
    sandbox.write_file.side_effect = OSError("disk full")
    monkeypatch.setattr("deerflow.workflow.executors.data.sandbox_tools.ensure_sandbox_initialized", lambda runtime=None: sandbox)

    with pytest.raises(OSError, match="disk full"):
        _run(exec_file(_runtime(workflow_undo_repo=repo, run_id="r1", user_id="u1"), _file_params(rollback_on_failure=True), {}))

    sandbox.update_file.assert_called_once_with("/mnt/user-data/workspace/o.txt", b"old content")
    assert repo.records[0]["status"] == UndoStatus.UNDONE.value
    assert "disk full" in repo.records[0]["detail"]


def test_failed_write_removes_a_file_it_created(monkeypatch: pytest.MonkeyPatch) -> None:
    """Nothing to restore → the created file is removed instead."""
    repo = _RecordingUndoRepo()
    sandbox = _sandbox_with_previous(None)  # did not exist
    sandbox.write_file.side_effect = OSError("nope")
    monkeypatch.setattr("deerflow.workflow.executors.data.sandbox_tools.ensure_sandbox_initialized", lambda runtime=None: sandbox)

    with pytest.raises(OSError):
        _run(exec_file(_runtime(workflow_undo_repo=repo, run_id="r1", user_id="u1"), _file_params(rollback_on_failure=True), {}))

    sandbox.update_file.assert_not_called()
    sandbox.execute_command.assert_called_once()
    assert "rm -f" in sandbox.execute_command.call_args.args[0]


def test_write_without_a_repo_still_rolls_back(monkeypatch: pytest.MonkeyPatch) -> None:
    """A memory backend has no undo repository — compensation must still work."""
    sandbox = _sandbox_with_previous(b"old")
    sandbox.write_file.side_effect = OSError("failed")
    monkeypatch.setattr("deerflow.workflow.executors.data.sandbox_tools.ensure_sandbox_initialized", lambda runtime=None: sandbox)

    with pytest.raises(OSError):
        _run(exec_file(_runtime(), _file_params(rollback_on_failure=True), {}))

    sandbox.update_file.assert_called_once_with("/mnt/user-data/workspace/o.txt", b"old")


def test_unwritable_backup_aborts_before_mutating(monkeypatch: pytest.MonkeyPatch, tmp_path: Path) -> None:
    """The conservative default: no rollback promise we cannot keep.

    The snapshot directory cannot be created (its parent path is a file), so the
    node must refuse to write rather than proceed with a broken promise.
    """
    blocker = tmp_path / "undo"
    blocker.write_text("a file where the backup directory should go")
    monkeypatch.setattr("deerflow.workflow.compensation.backup_root", lambda: blocker)

    sandbox = _sandbox_with_previous(b"old")
    monkeypatch.setattr("deerflow.workflow.executors.data.sandbox_tools.ensure_sandbox_initialized", lambda runtime=None: sandbox)

    with pytest.raises(CompensationUnavailable, match="refusing to mutate"):
        _run(exec_file(_runtime(), _file_params(rollback_on_failure=True), {}))

    sandbox.write_file.assert_not_called()
    sandbox.update_file.assert_not_called()


def test_a_failing_record_write_does_not_fail_the_mutation(monkeypatch: pytest.MonkeyPatch) -> None:
    sandbox = _sandbox_with_previous(b"old")
    monkeypatch.setattr("deerflow.workflow.executors.data.sandbox_tools.ensure_sandbox_initialized", lambda runtime=None: sandbox)

    result = _run(exec_file(_runtime(workflow_undo_repo=_FailingUndoRepo(), run_id="r1"), _file_params(rollback_on_failure=True), {}))

    assert result == {"out": "new"}


# ── data:asset import ─────────────────────────────────────────────────────────


def test_import_records_the_created_sandbox_file(monkeypatch: pytest.MonkeyPatch, tmp_path: Path) -> None:
    load_assets_config_from_dict({"roots": [str(tmp_path)]})
    source = tmp_path / "chair.fbx"
    source.write_bytes(b"payload")
    repo = _RecordingUndoRepo()
    sandbox = _sandbox_with_previous(None)
    monkeypatch.setattr("deerflow.workflow.executors.asset.sandbox_tools.ensure_sandbox_initialized", lambda runtime=None: sandbox)

    _run(exec_asset(_runtime(workflow_undo_repo=repo, run_id="r1", user_id="u1"), {"operation": "import", "path": str(source), "crash_confirm": True, "node_id": "a1", "rollback_on_failure": True}, {}))

    sandbox.update_file.assert_called_once()
    assert repo.records[0]["status"] == UndoStatus.RECORDED.value
    assert repo.records[0]["targets"][0]["path"] == "/mnt/user-data/workspace/chair.fbx"


def test_failed_import_removes_the_created_sandbox_file(monkeypatch: pytest.MonkeyPatch, tmp_path: Path) -> None:
    load_assets_config_from_dict({"roots": [str(tmp_path)]})
    source = tmp_path / "chair.fbx"
    source.write_bytes(b"payload")
    repo = _RecordingUndoRepo()
    sandbox = _sandbox_with_previous(None)
    sandbox.update_file.side_effect = OSError("write failed")
    monkeypatch.setattr("deerflow.workflow.executors.asset.sandbox_tools.ensure_sandbox_initialized", lambda runtime=None: sandbox)

    with pytest.raises(OSError):
        _run(exec_asset(_runtime(workflow_undo_repo=repo, run_id="r1", user_id="u1"), {"operation": "import", "path": str(source), "crash_confirm": True, "node_id": "a1", "rollback_on_failure": True}, {}))

    assert "rm -f" in sandbox.execute_command.call_args.args[0]
    assert repo.records[0]["status"] == UndoStatus.UNDONE.value


# ── data:asset export ─────────────────────────────────────────────────────────


def test_export_records_the_overwritten_host_file(monkeypatch: pytest.MonkeyPatch, tmp_path: Path) -> None:
    load_assets_config_from_dict({"roots": [str(tmp_path)]})
    existing = tmp_path / "out.obj"
    existing.write_bytes(b"previous render")
    repo = _RecordingUndoRepo()
    sandbox = _sandbox_with_previous(b"new render")
    monkeypatch.setattr("deerflow.workflow.executors.asset.sandbox_tools.ensure_sandbox_initialized", lambda runtime=None: sandbox)

    _run(exec_asset(_runtime(workflow_undo_repo=repo, run_id="r1", user_id="u1"), {"operation": "export", "path": "/mnt/user-data/outputs/out.obj", "crash_confirm": True, "node_id": "a1", "rollback_on_failure": True}, {}))

    assert existing.read_bytes() == b"new render"
    assert repo.records[0]["status"] == UndoStatus.RECORDED.value
    assert repo.records[0]["backup_paths"]
    assert Path(repo.records[0]["backup_paths"][0]).read_bytes() == b"previous render"


def test_failed_export_restores_the_host_file(monkeypatch: pytest.MonkeyPatch, tmp_path: Path) -> None:
    load_assets_config_from_dict({"roots": [str(tmp_path)]})
    existing = tmp_path / "out.obj"
    existing.write_bytes(b"previous render")
    repo = _RecordingUndoRepo()
    sandbox = _sandbox_with_previous(b"new render")
    monkeypatch.setattr("deerflow.workflow.executors.asset.sandbox_tools.ensure_sandbox_initialized", lambda runtime=None: sandbox)

    def _boom(*args: Any, **kwargs: Any) -> Any:
        raise OSError("target is locked")

    monkeypatch.setattr("deerflow.workflow.executors.asset._write_host_atomically", _boom)

    with pytest.raises(OSError, match="locked"):
        _run(exec_asset(_runtime(workflow_undo_repo=repo, run_id="r1", user_id="u1"), {"operation": "export", "path": "/mnt/user-data/outputs/out.obj", "crash_confirm": True, "node_id": "a1", "rollback_on_failure": True}, {}))

    assert existing.read_bytes() == b"previous render"
    assert repo.records[0]["status"] == UndoStatus.UNDONE.value


def test_export_removes_a_host_file_it_created(monkeypatch: pytest.MonkeyPatch, tmp_path: Path) -> None:
    load_assets_config_from_dict({"roots": [str(tmp_path)]})
    target = tmp_path / "fresh.obj"
    repo = _RecordingUndoRepo()
    sandbox = _sandbox_with_previous(b"new render")
    monkeypatch.setattr("deerflow.workflow.executors.asset.sandbox_tools.ensure_sandbox_initialized", lambda runtime=None: sandbox)

    def _boom(*args: Any, **kwargs: Any) -> Any:
        raise OSError("target is locked")

    monkeypatch.setattr("deerflow.workflow.executors.asset._write_host_atomically", _boom)

    with pytest.raises(OSError):
        _run(exec_asset(_runtime(workflow_undo_repo=repo, run_id="r1", user_id="u1"), {"operation": "export", "path": "/mnt/user-data/outputs/fresh.obj", "crash_confirm": True, "node_id": "a1", "rollback_on_failure": True}, {}))

    assert not target.exists()


# ── data:asset convert ────────────────────────────────────────────────────────


def test_convert_records_and_rolls_back(monkeypatch: pytest.MonkeyPatch, tmp_path: Path) -> None:
    load_assets_config_from_dict({"converters": {"fbx_to_obj": {"from": ".fbx", "to": ".obj", "command": "assimp", "args": ["export", "{in}", "{out}"]}}})
    repo = _RecordingUndoRepo()
    sandbox = MagicMock()
    sandbox.download_file.side_effect = OSError("did not exist")  # the converted output is new
    sandbox.execute_command.return_value = "assimp: crash"
    monkeypatch.setattr("deerflow.workflow.executors.asset.sandbox_tools.ensure_sandbox_initialized", lambda runtime=None: sandbox)
    monkeypatch.setattr("deerflow.workflow.executors.asset.sandbox_tools.get_thread_data", lambda runtime=None: {})
    monkeypatch.setattr("deerflow.workflow.executors.asset.sandbox_tools.replace_virtual_paths_in_command", lambda command, thread_data: command)

    with pytest.raises(WorkflowExecutionError, match="produced no output"):
        _run(
            exec_asset(
                _runtime(workflow_undo_repo=repo, run_id="r1", user_id="u1"),
                {"operation": "convert", "converter": "fbx_to_obj", "path": "/mnt/user-data/workspace/chair.fbx", "crash_confirm": True, "node_id": "a1", "rollback_on_failure": True},
                {},
            )
        )

    assert repo.records[0]["status"] == UndoStatus.UNDONE.value
    assert "assimp" in repo.records[0]["detail"]
