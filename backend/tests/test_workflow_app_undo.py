"""Tests for N10 native app undo (driver capability, session gate, executor use).

Three levels:

1. ``driver_supports_undo`` / ``driver_undo`` — the capability contract: a driver
   must *both* declare the flag and implement ``undo``, and an unsupported driver
   answers truthfully instead of raising.
2. ``AppSessionManager.undo`` — the compensation goes through the same N8
   admission choke point as every other operation.
3. ``app:script`` with ``rollback_on_failure`` — a failed script is compensated
   through the application's own undo, and the absence of that capability is
   recorded rather than hidden.
"""

from __future__ import annotations

import asyncio
from pathlib import Path
from typing import Any

import pytest

from deerflow.apps.driver import DriverLaunch, DriverUndoResult, driver_supports_undo, driver_undo
from deerflow.apps.drivers.cli import CliAppDriver
from deerflow.apps.drivers.mock import MockAppDriver
from deerflow.apps.registry import AppRegistry
from deerflow.apps.session import AppSessionManager, reset_session_manager
from deerflow.config.apps_config import AppDefinition, AppsConfig
from deerflow.runtime.context_keys import APP_RUNTIME_CONTEXT_KEY
from deerflow.workflow.compiler import WorkflowRuntime
from deerflow.workflow.executors.local_app import exec_app_launch, exec_app_script
from deerflow.workflow.undo import UndoStatus

# ── helpers ───────────────────────────────────────────────────────────────────


@pytest.fixture(autouse=True)
def _cleanup() -> Any:
    yield
    reset_session_manager()


def _definition(**kwargs: Any) -> AppDefinition:
    kwargs.setdefault("driver", "mock")
    kwargs.setdefault("description", "demo")
    return AppDefinition(**kwargs)


def _manager(tmp_path: Path, *, driver: str = "mock") -> AppSessionManager:
    definition = _definition(driver=driver, working_dir=str(tmp_path), **({"command": "demo-bin"} if driver == "cli" else {}))
    return AppSessionManager(AppRegistry.from_config(AppsConfig(enabled=True, definitions={"demo": definition})))


def _runtime(manager: AppSessionManager, **extra: Any) -> WorkflowRuntime:
    return WorkflowRuntime(context={APP_RUNTIME_CONTEXT_KEY: manager, **extra}, state={})


class _RecordingUndoRepo:
    def __init__(self) -> None:
        self.records: list[dict[str, Any]] = []

    async def create(self, **kwargs: Any) -> dict[str, Any]:
        record = {"id": f"undo-{len(self.records) + 1}", **kwargs}
        self.records.append(record)
        return record


class _FailingDriver:
    """A driver whose script always fails, with configurable undo support."""

    name = "failing"

    def __init__(self, *, supports_undo: bool = True, undo_status: str = "undone", undo_raises: Exception | None = None) -> None:
        self.supports_undo = supports_undo
        self.undo_calls: list[int] = []
        self._undo_status = undo_status
        self._undo_raises = undo_raises

    def available(self, definition: AppDefinition) -> bool:
        return True

    def launch(self, definition: AppDefinition, *, mode: str) -> DriverLaunch:
        return DriverLaunch(status="ready")

    def run_script(self, definition: AppDefinition, launch: DriverLaunch, *, script: str | None, args: list[str], env: dict[str, str] | None = None) -> Any:
        from deerflow.apps.driver import DriverScriptResult

        return DriverScriptResult(status="failed", exit_code=1, stdout="", stderr="script blew up")

    def wait(self, definition: AppDefinition, launch: DriverLaunch, *, reason: str | None, timeout: float | None) -> Any:
        from deerflow.apps.driver import DriverWaitResult

        return DriverWaitResult(status="done")

    def collect(self, definition: AppDefinition, launch: DriverLaunch, *, globs: list[str] | None) -> list[str]:
        return []

    def health(self, definition: AppDefinition, launch: DriverLaunch) -> bool:
        return True

    def close(self, definition: AppDefinition, launch: DriverLaunch) -> None:
        return None

    def undo(self, definition: AppDefinition, launch: DriverLaunch, *, steps: int = 1) -> DriverUndoResult:
        self.undo_calls.append(steps)
        if self._undo_raises is not None:
            raise self._undo_raises
        return DriverUndoResult(status=self._undo_status, steps=steps, detail="native undo")


def _manager_with_driver(driver: Any) -> AppSessionManager:
    """A manager whose ``mock`` driver slot is replaced by *driver*.

    ``AppSessionManager._drivers`` is keyed by the definition's driver name, so
    seeding that slot is how the suite swaps in a script that fails on purpose.
    """
    manager = AppSessionManager(AppRegistry.from_config(AppsConfig(enabled=True, definitions={"demo": _definition()})))
    manager._drivers = {"mock": driver}  # type: ignore[attr-defined]
    return manager


# ── capability contract ───────────────────────────────────────────────────────


def test_cli_driver_declares_no_undo_support() -> None:
    driver = CliAppDriver()

    assert driver.supports_undo is False
    assert driver_supports_undo(driver) is False


def test_cli_driver_answers_unsupported_rather_than_raising() -> None:
    driver = CliAppDriver()
    definition = _definition(driver="cli", command="demo-bin")

    # Through the capability contract (the flag short-circuits the call)…
    assert driver_undo(driver, definition, DriverLaunch(status="ready")).status == "unsupported"
    # …and directly, where the driver states its own honest reason.
    direct = driver.undo(definition, DriverLaunch(status="ready"))
    assert direct.status == "unsupported"
    assert "no application undo" in direct.detail


def test_mock_driver_supports_undo() -> None:
    driver = MockAppDriver()

    assert driver_supports_undo(driver) is True
    result = driver_undo(driver, _definition(), DriverLaunch(status="ready"), steps=3)

    assert result.status == "undone"
    assert result.steps == 3


def test_a_flag_without_an_implementation_is_not_support() -> None:
    """Both halves are required — a false positive would promise a rollback that cannot happen."""

    class _HalfDriver:
        supports_undo = True

    assert driver_supports_undo(_HalfDriver()) is False


def test_a_driver_error_becomes_a_failed_result() -> None:
    driver = _FailingDriver(undo_raises=RuntimeError("undo exploded"))

    result = driver_undo(driver, _definition(), DriverLaunch(status="ready"))

    assert result.status == "failed"
    assert "undo exploded" in result.detail


# ── session gate ──────────────────────────────────────────────────────────────


def test_manager_supports_undo_reflects_the_driver(tmp_path: Path) -> None:
    assert _manager(tmp_path, driver="mock").supports_undo("demo") is True
    assert _manager(tmp_path, driver="cli").supports_undo("demo") is False


def test_manager_supports_undo_is_false_for_an_unknown_app(tmp_path: Path) -> None:
    assert _manager(tmp_path).supports_undo("nope") is False


def test_manager_undo_reaches_the_driver(tmp_path: Path) -> None:
    manager = _manager(tmp_path)
    session = manager.launch("demo", mode="launch")

    result = manager.undo(session, steps=2)

    assert result.status == "undone"
    assert result.steps == 2
    assert session.status == "ready"  # the operation released the instance back


def test_manager_undo_requires_a_session(tmp_path: Path) -> None:
    manager = _manager(tmp_path)
    from deerflow.apps.session import AppSession

    ghost = AppSession(session_id="sess-ghost", app_name="demo", driver="mock", status="ready")

    with pytest.raises(Exception, match="no live session"):
        manager.undo(ghost)


# ── app:script compensation ───────────────────────────────────────────────────


def test_failed_script_is_compensated_through_native_undo(tmp_path: Path) -> None:
    driver = _FailingDriver()
    manager = _manager_with_driver(driver)
    repo = _RecordingUndoRepo()
    runtime = _runtime(manager, workflow_undo_repo=repo, run_id="r1", user_id="u1")
    session = manager.launch("demo", mode="launch")

    result = asyncio.run(exec_app_script(runtime, {"app": "demo", "script": "render", "crash_confirm": True, "node_id": "s1", "rollback_on_failure": True, "undo_steps": 2}, {"session": session.to_port()}))

    assert result["out"]["status"] == "failed"
    assert driver.undo_calls == [2]
    assert repo.records[0]["kind"] == "app_undo"
    assert repo.records[0]["status"] == UndoStatus.UNDONE.value
    assert repo.records[0]["app_steps"] == 2
    assert repo.records[0]["session_id"] == session.session_id


def test_failed_script_without_undo_support_records_the_gap(tmp_path: Path) -> None:
    driver = _FailingDriver(supports_undo=False)
    manager = _manager_with_driver(driver)
    repo = _RecordingUndoRepo()
    runtime = _runtime(manager, workflow_undo_repo=repo, run_id="r1", user_id="u1")
    session = manager.launch("demo", mode="launch")

    asyncio.run(exec_app_script(runtime, {"app": "demo", "script": "render", "crash_confirm": True, "node_id": "s1", "rollback_on_failure": True}, {"session": session.to_port()}))

    assert repo.records[0]["status"] == UndoStatus.FAILED.value
    assert "no undo support" in repo.records[0]["detail"]
    assert driver.undo_calls == []


def test_failed_undo_is_recorded_as_failed(tmp_path: Path) -> None:
    driver = _FailingDriver(undo_status="failed")
    manager = _manager_with_driver(driver)
    repo = _RecordingUndoRepo()
    runtime = _runtime(manager, workflow_undo_repo=repo, run_id="r1", user_id="u1")
    session = manager.launch("demo", mode="launch")

    asyncio.run(exec_app_script(runtime, {"app": "demo", "script": "render", "crash_confirm": True, "node_id": "s1", "rollback_on_failure": True}, {"session": session.to_port()}))

    assert repo.records[0]["status"] == UndoStatus.FAILED.value


def test_failed_undo_does_not_mask_the_script_result(tmp_path: Path) -> None:
    """A compensation problem must never replace the node's own outcome."""
    driver = _FailingDriver(undo_raises=RuntimeError("undo exploded"))
    manager = _manager_with_driver(driver)
    runtime = _runtime(manager, workflow_undo_repo=_RecordingUndoRepo(), run_id="r1")
    session = manager.launch("demo", mode="launch")

    result = asyncio.run(exec_app_script(runtime, {"app": "demo", "script": "render", "crash_confirm": True, "node_id": "s1", "rollback_on_failure": True}, {"session": session.to_port()}))

    assert result["out"]["status"] == "failed"
    assert result["out"]["stderr"] == "script blew up"


def test_successful_script_is_recorded_as_undoable(tmp_path: Path) -> None:
    manager = _manager(tmp_path)  # mock driver: script succeeds and supports undo
    repo = _RecordingUndoRepo()
    runtime = _runtime(manager, workflow_undo_repo=repo, run_id="r1", user_id="u1")
    launched = asyncio.run(exec_app_launch(runtime, {"app": "demo", "crash_confirm": True}, {}))

    asyncio.run(exec_app_script(runtime, {"app": "demo", "script": "render", "crash_confirm": True, "node_id": "s1", "rollback_on_failure": True}, {"session": launched["session"]}))

    assert repo.records[0]["kind"] == "app_undo"
    assert repo.records[0]["status"] == UndoStatus.RECORDED.value
    assert repo.records[0]["app_steps"] == 1


def test_successful_script_without_rollback_records_nothing(tmp_path: Path) -> None:
    manager = _manager(tmp_path)
    repo = _RecordingUndoRepo()
    runtime = _runtime(manager, workflow_undo_repo=repo, run_id="r1")
    launched = asyncio.run(exec_app_launch(runtime, {"app": "demo", "crash_confirm": True}, {}))

    asyncio.run(exec_app_script(runtime, {"app": "demo", "script": "render", "crash_confirm": True}, {"session": launched["session"]}))

    assert repo.records == []


def test_bad_undo_steps_is_rejected(tmp_path: Path) -> None:
    manager = _manager(tmp_path)
    runtime = _runtime(manager, run_id="r1")
    launched = asyncio.run(exec_app_launch(runtime, {"app": "demo", "crash_confirm": True}, {}))

    with pytest.raises(Exception, match="undo_steps"):
        asyncio.run(exec_app_script(runtime, {"app": "demo", "script": "render", "crash_confirm": True, "rollback_on_failure": True, "undo_steps": 0}, {"session": launched["session"]}))
