"""Optimistic conflict detection (N10b, §17 / §21).

The guard is a *fact* checker: it refuses when a file it looked at changed, and
it says plainly when it could not look at all.  These tests pin both halves,
plus the end-to-end case it exists for — a person working in the application
while a node waits for it.
"""

from __future__ import annotations

import asyncio
import logging
import threading
import time
from pathlib import Path

import pytest

from deerflow.apps.drivers.mock import MOCK_PRESENCE_NAME
from deerflow.apps.registry import AppRegistry
from deerflow.apps.session import AppSessionManager, reset_session_manager
from deerflow.assets.ref import make_ref
from deerflow.config.apps_config import AppDefinition
from deerflow.runtime.context_keys import APP_RUNTIME_CONTEXT_KEY
from deerflow.workflow.compiler import WorkflowRuntime
from deerflow.workflow.conflict import CONFLICT_PARAM, ConflictGuard, WorkflowConflictError, conflicts_requested, observe_refs
from deerflow.workflow.executors import WorkflowExecutionError
from deerflow.workflow.executors.local_app import exec_app_launch, exec_app_script


@pytest.fixture(autouse=True)
def _cleanup():
    yield
    reset_session_manager()


class TestOptIn:
    def test_only_a_literal_true_arms_the_guard(self) -> None:
        assert conflicts_requested({CONFLICT_PARAM: True}) is True
        for value in (False, None, "true", 1):
            assert conflicts_requested({CONFLICT_PARAM: value}) is False

    def test_absent_param_is_off(self) -> None:
        assert conflicts_requested({}) is False


class TestObserveRefs:
    def test_host_ref_is_observed(self, tmp_path: Path) -> None:
        path = tmp_path / "artifact.txt"
        path.write_text("v1", encoding="utf-8")
        observed, unverifiable = observe_refs([make_ref(str(path), scope="host")])
        assert len(observed) == 1
        assert observed[0].observed is True
        assert observed[0].ref.size == 2
        assert unverifiable == []

    def test_a_missing_host_file_is_still_an_observation(self, tmp_path: Path) -> None:
        """Absence must be recorded, or "it appeared later" cannot be caught."""
        observed, _ = observe_refs([make_ref(str(tmp_path / "not-yet.txt"), scope="host")])
        assert observed[0].observed is True
        assert observed[0].ref.size is None

    def test_sandbox_refs_are_named_not_silently_skipped(self) -> None:
        observed, unverifiable = observe_refs([make_ref("/mnt/user-data/workspace/a.txt", scope="workspace")])
        assert observed == []
        assert unverifiable == ["/mnt/user-data/workspace/a.txt"]


class TestVerify:
    def test_unchanged_targets_pass(self, tmp_path: Path) -> None:
        path = tmp_path / "artifact.txt"
        path.write_text("v1", encoding="utf-8")
        guard = ConflictGuard.snapshot([make_ref(str(path), scope="host")], label="app:script")
        assert guard.size == 1
        assert guard.verify() == []
        guard.check()  # does not raise

    def test_modified_target_is_reported(self, tmp_path: Path) -> None:
        path = tmp_path / "artifact.txt"
        path.write_text("v1", encoding="utf-8")
        guard = ConflictGuard.snapshot([make_ref(str(path), scope="host")], label="app:script")

        path.write_text("v2-much-longer", encoding="utf-8")
        notes = guard.verify()
        assert len(notes) == 1
        assert "artifact.txt" in notes[0]
        assert "content changed" in notes[0]

    def test_a_same_size_same_second_rewrite_is_still_caught(self, tmp_path: Path) -> None:
        """The common case: an app rewriting the same-size value it just wrote."""
        path = tmp_path / "settings.json"
        path.write_text('{"a": 1}', encoding="utf-8")
        guard = ConflictGuard.snapshot([make_ref(str(path), scope="host")], label="app:script")

        path.write_text('{"a": 2}', encoding="utf-8")  # identical length, same second
        assert any("content changed" in note for note in guard.verify())

    def test_deleted_target_is_reported(self, tmp_path: Path) -> None:
        path = tmp_path / "artifact.txt"
        path.write_text("v1", encoding="utf-8")
        guard = ConflictGuard.snapshot([make_ref(str(path), scope="host")], label="app:script")

        path.unlink()
        assert any("disappeared" in note for note in guard.verify())

    def test_appearing_target_is_reported(self, tmp_path: Path) -> None:
        path = tmp_path / "artifact.txt"
        guard = ConflictGuard.snapshot([make_ref(str(path), scope="host")], label="app:script")

        path.write_text("someone else wrote this", encoding="utf-8")
        assert any("appeared" in note for note in guard.verify())

    def test_check_raises_a_conflict_error_with_the_notes(self, tmp_path: Path) -> None:
        path = tmp_path / "artifact.txt"
        path.write_text("v1", encoding="utf-8")
        guard = ConflictGuard.snapshot([make_ref(str(path), scope="host")], label="app:script")

        path.write_text("v2", encoding="utf-8")
        with pytest.raises(WorkflowConflictError) as exc:
            guard.check()
        assert "while this node was waiting" in str(exc.value)
        assert "artifact.txt" in str(exc.value)
        assert isinstance(exc.value, WorkflowExecutionError)  # the retry/DLQ path already understands this

    def test_nothing_observable_warns_instead_of_claiming_a_clean_check(self, caplog) -> None:
        guard = ConflictGuard.snapshot([make_ref("/mnt/user-data/workspace/a.txt", scope="workspace")], label="app:script")
        with caplog.at_level(logging.WARNING, logger="deerflow.workflow.conflict"):
            guard.check()
        assert "no target could be observed" in caplog.text

    def test_empty_guard_is_quiet(self, caplog) -> None:
        """A node that declares no artifacts has nothing to report about."""
        guard = ConflictGuard.snapshot([], label="app:script")
        with caplog.at_level(logging.WARNING, logger="deerflow.workflow.conflict"):
            guard.check()
        assert caplog.text == ""


def _manager(tmp_path: Path, *, policy: str = "fail", budget: float = 60.0, artifact_glob: str | None = None) -> AppSessionManager:
    definition = AppDefinition(driver="mock", working_dir=str(tmp_path), artifact_globs=[artifact_glob] if artifact_glob else [])
    return AppSessionManager(AppRegistry(enabled=True, definitions={"demo": definition}, on_human_conflict=policy, acquire_timeout_seconds=budget))


def _runtime(manager: AppSessionManager) -> WorkflowRuntime:
    return WorkflowRuntime(context={APP_RUNTIME_CONTEXT_KEY: manager}, state={})


class TestAppScriptIntegration:
    def test_off_by_default(self, tmp_path: Path) -> None:
        artifact = tmp_path / "render.txt"
        artifact.write_text("v1", encoding="utf-8")
        manager = _manager(tmp_path, artifact_glob="render.txt")
        runtime = _runtime(manager)
        launched = asyncio.run(exec_app_launch(runtime, {"app": "demo", "crash_confirm": True}, {}))

        artifact.write_text("v2-changed", encoding="utf-8")
        outcome = asyncio.run(exec_app_script(runtime, {"app": "demo", "script": "render", "crash_confirm": True}, {"session": launched["session"]}))
        assert outcome["out"]["status"] == "completed"

    def test_a_change_during_the_presence_wait_refuses_the_node(self, tmp_path: Path) -> None:
        """The §21 scenario: the person keeps working while the engine queues."""
        artifact = tmp_path / "render.txt"
        artifact.write_text("v1", encoding="utf-8")
        manager = _manager(tmp_path, policy="wait", budget=10.0, artifact_glob="render.txt")
        runtime = _runtime(manager)
        launched = asyncio.run(exec_app_launch(runtime, {"app": "demo", "crash_confirm": True}, {}))

        # A person takes the application, then keeps working in it: the artifact
        # changes while the node waits for presence, and the app is released
        # afterwards so only the conflict (not the presence rule) can refuse.
        (tmp_path / MOCK_PRESENCE_NAME).write_text("human", encoding="utf-8")

        def _work_then_leave() -> None:
            time.sleep(0.2)
            artifact.write_text("v2-the human's new render", encoding="utf-8")
            (tmp_path / MOCK_PRESENCE_NAME).write_text("idle", encoding="utf-8")

        thread = threading.Thread(target=_work_then_leave, daemon=True)
        thread.start()

        params = {"app": "demo", "script": "render", "crash_confirm": True, "check_presence": True, CONFLICT_PARAM: True}
        with pytest.raises(WorkflowConflictError) as exc:
            asyncio.run(exec_app_script(runtime, params, {"session": launched["session"]}))
        assert "render.txt" in str(exc.value)

    def test_explicit_conflict_globs_override_the_declared_artifacts(self, tmp_path: Path) -> None:
        """A node can watch a narrower (or different) set than the app declares."""
        declared = tmp_path / "unrelated.txt"
        watched = tmp_path / "watched.txt"
        declared.write_text("v1", encoding="utf-8")
        watched.write_text("v1", encoding="utf-8")

        manager = _manager(tmp_path, policy="wait", budget=10.0, artifact_glob="unrelated.txt")
        runtime = _runtime(manager)
        launched = asyncio.run(exec_app_launch(runtime, {"app": "demo", "crash_confirm": True}, {}))

        # Both files change while the node waits for the application.
        (tmp_path / MOCK_PRESENCE_NAME).write_text("human", encoding="utf-8")

        def _both_change_then_leave() -> None:
            time.sleep(0.2)
            declared.write_text("v2", encoding="utf-8")
            watched.write_text("v2", encoding="utf-8")
            (tmp_path / MOCK_PRESENCE_NAME).write_text("idle", encoding="utf-8")

        threading.Thread(target=_both_change_then_leave, daemon=True).start()

        params = {"app": "demo", "script": "render", "crash_confirm": True, "check_presence": True, CONFLICT_PARAM: True, "conflict_globs": ["watched.txt"]}
        with pytest.raises(WorkflowConflictError) as exc:
            asyncio.run(exec_app_script(runtime, params, {"session": launched["session"]}))

        message = str(exc.value)
        assert "watched.txt" in message
        assert "unrelated.txt" not in message  # the declared set was replaced, not unioned

    def test_unchanged_artifacts_let_the_node_run(self, tmp_path: Path) -> None:
        artifact = tmp_path / "render.txt"
        artifact.write_text("v1", encoding="utf-8")
        manager = _manager(tmp_path, artifact_glob="render.txt")
        runtime = _runtime(manager)
        launched = asyncio.run(exec_app_launch(runtime, {"app": "demo", "crash_confirm": True}, {}))

        params = {"app": "demo", "script": "render", "crash_confirm": True, CONFLICT_PARAM: True}
        outcome = asyncio.run(exec_app_script(runtime, params, {"session": launched["session"]}))
        assert outcome["out"]["status"] == "completed"
