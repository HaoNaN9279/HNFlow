"""Human/machine sharing through the ``app:*`` executors (N10b, §17 / §21).

The policy decides who wins; these tests pin the whole path — probe, decision,
queueing, take-over bookkeeping, and the visible ``holder`` — at the node level,
where a real run would meet it.
"""

from __future__ import annotations

import asyncio
import threading
import time
from pathlib import Path

import pytest

from deerflow.apps.drivers.mock import MOCK_PRESENCE_NAME
from deerflow.apps.registry import AppRegistry
from deerflow.apps.session import AppSessionManager, reset_session_manager
from deerflow.config.apps_config import AppDefinition, AppsConfig
from deerflow.runtime.context_keys import APP_RUNTIME_CONTEXT_KEY
from deerflow.workflow.compiler import WorkflowRuntime
from deerflow.workflow.executors import WorkflowExecutionError
from deerflow.workflow.executors.local_app import exec_app_launch, exec_app_script, preview_app_launch, preview_app_script


@pytest.fixture(autouse=True)
def _cleanup():
    yield
    reset_session_manager()


def _registry(tmp_path: Path, *, policy: str = "fail", allow_preempt: bool = False, budget: float = 60.0) -> AppRegistry:
    return AppRegistry(
        enabled=True,
        definitions={"demo": AppDefinition(driver="mock", working_dir=str(tmp_path), allow_preempt=allow_preempt)},
        on_human_conflict=policy,
        acquire_timeout_seconds=budget,
    )


def _manager(tmp_path: Path, **kwargs) -> AppSessionManager:
    return AppSessionManager(_registry(tmp_path, **kwargs))


def _occupy(tmp_path: Path, state: str = "human") -> None:
    """Make the mock application look occupied (its own probe reads this file)."""
    (tmp_path / MOCK_PRESENCE_NAME).write_text(state, encoding="utf-8")


def _release_after(tmp_path: Path, delay: float, *, state: str = "idle") -> threading.Thread:
    def _flip() -> None:
        time.sleep(delay)
        (tmp_path / MOCK_PRESENCE_NAME).write_text(state, encoding="utf-8")

    thread = threading.Thread(target=_flip, daemon=True)
    thread.start()
    return thread


def _runtime(manager: AppSessionManager) -> WorkflowRuntime:
    return WorkflowRuntime(context={APP_RUNTIME_CONTEXT_KEY: manager}, state={})


class TestLaunchGate:
    def test_free_application_launches_and_is_machine_held(self, tmp_path: Path) -> None:
        manager = _manager(tmp_path)
        session = asyncio.run(exec_app_launch(_runtime(manager), {"app": "demo", "crash_confirm": True}, {}))
        assert session["session"]["holder"] == "machine"
        assert session["session"]["taken_over_from"] is None

    def test_human_held_application_fails_the_node_by_default(self, tmp_path: Path) -> None:
        _occupy(tmp_path)
        manager = _manager(tmp_path)
        with pytest.raises(WorkflowExecutionError, match="is not free") as exc:
            asyncio.run(exec_app_launch(_runtime(manager), {"app": "demo", "crash_confirm": True}, {}))

        message = str(exc.value)
        assert "human" in message
        assert "apps.on_human_conflict" in message  # actionable: names the knob
        assert manager.list_sessions() == []  # nothing was started

    def test_unknown_presence_launches_and_is_recorded_as_unknown_holder(self, tmp_path: Path) -> None:
        """Ignorance must not block — but it is never presented as certainty."""
        _occupy(tmp_path, "maybe")
        manager = _manager(tmp_path)
        session = asyncio.run(exec_app_launch(_runtime(manager), {"app": "demo", "crash_confirm": True}, {}))
        assert session["session"]["holder"] == "unknown"

    def test_wait_policy_queues_until_the_person_lets_go(self, tmp_path: Path) -> None:
        _occupy(tmp_path)
        manager = _manager(tmp_path, policy="wait", budget=10.0)
        _release_after(tmp_path, 0.2)

        started = time.monotonic()
        session = asyncio.run(exec_app_launch(_runtime(manager), {"app": "demo", "crash_confirm": True}, {}))

        # It queued (did not fail) and then took the application once it was free.
        assert time.monotonic() - started >= 0.2
        assert session["session"]["holder"] == "machine"

    def test_wait_policy_gives_up_with_an_actionable_error(self, tmp_path: Path) -> None:
        _occupy(tmp_path)
        manager = _manager(tmp_path, policy="wait", budget=0.3)
        with pytest.raises(WorkflowExecutionError) as exc:
            asyncio.run(exec_app_launch(_runtime(manager), {"app": "demo", "crash_confirm": True}, {}))
        assert "gave up after" in str(exc.value)

    def test_preempt_policy_without_the_opt_in_refuses(self, tmp_path: Path) -> None:
        _occupy(tmp_path)
        manager = _manager(tmp_path, policy="preempt", allow_preempt=False)
        with pytest.raises(WorkflowExecutionError, match="allow_preempt"):
            asyncio.run(exec_app_launch(_runtime(manager), {"app": "demo", "crash_confirm": True}, {}))

    def test_declared_preempt_takes_over_and_records_it(self, tmp_path: Path) -> None:
        _occupy(tmp_path)
        manager = _manager(tmp_path, policy="preempt", allow_preempt=True)
        session = asyncio.run(exec_app_launch(_runtime(manager), {"app": "demo", "crash_confirm": True}, {}))

        port = session["session"]
        assert port["holder"] == "human"
        assert port["taken_over_from"] == "human"
        live = manager.get(port["session_id"])
        assert live is not None
        assert live.taken_over_at > 0.0

    def test_reusing_the_engines_own_session_never_consults_presence(self, tmp_path: Path) -> None:
        """A person appearing later does not revoke the instance we already hold."""
        manager = _manager(tmp_path)
        runtime = _runtime(manager)
        first = asyncio.run(exec_app_launch(runtime, {"app": "demo", "crash_confirm": True}, {}))

        _occupy(tmp_path)
        again = asyncio.run(exec_app_launch(runtime, {"app": "demo", "crash_confirm": True}, {}))

        assert again["session"]["session_id"] == first["session"]["session_id"]
        assert again["session"]["status"] == "attached"


class TestScriptPresenceOptIn:
    def test_script_runs_while_a_person_is_there_unless_asked(self, tmp_path: Path) -> None:
        """Per-operation probing is opt-in: a probe cannot attribute busyness."""
        manager = _manager(tmp_path)
        runtime = _runtime(manager)
        launched = asyncio.run(exec_app_launch(runtime, {"app": "demo", "crash_confirm": True}, {}))
        _occupy(tmp_path)
        outcome = asyncio.run(exec_app_script(runtime, {"app": "demo", "script": "render", "crash_confirm": True}, {"session": launched["session"]}))
        assert outcome["out"]["status"] == "completed"

    def test_check_presence_refuses_the_node_when_a_person_holds_it(self, tmp_path: Path) -> None:
        manager = _manager(tmp_path)
        runtime = _runtime(manager)
        launched = asyncio.run(exec_app_launch(runtime, {"app": "demo", "crash_confirm": True}, {}))
        _occupy(tmp_path)

        with pytest.raises(WorkflowExecutionError, match="is not free"):
            asyncio.run(exec_app_script(runtime, {"app": "demo", "script": "render", "crash_confirm": True, "check_presence": True}, {"session": launched["session"]}))

    def test_check_presence_marks_a_takeover_on_preempt(self, tmp_path: Path) -> None:
        manager = _manager(tmp_path, policy="preempt", allow_preempt=True)
        runtime = _runtime(manager)
        launched = asyncio.run(exec_app_launch(runtime, {"app": "demo", "crash_confirm": True}, {}))
        _occupy(tmp_path)

        outcome = asyncio.run(exec_app_script(runtime, {"app": "demo", "script": "render", "crash_confirm": True, "check_presence": True}, {"session": launched["session"]}))
        assert outcome["out"]["status"] == "completed"
        live = manager.get(launched["session"]["session_id"])
        assert live is not None
        assert live.taken_over_from == "human"


class TestPresenceProbe:
    def test_answers_are_cached_briefly_and_reprobe_on_demand(self, tmp_path: Path) -> None:
        manager = _manager(tmp_path)
        assert manager.probe_presence("demo").state == "idle"

        _occupy(tmp_path)  # a person sits down
        assert manager.probe_presence("demo").state == "idle"  # cached
        assert manager.probe_presence("demo", force=True).state == "human"

    def test_probe_reports_when_it_was_observed(self, tmp_path: Path) -> None:
        report = _manager(tmp_path).probe_presence("demo")
        assert report.observed_at > 0.0

    def test_unknown_app_is_an_error_not_a_guess(self, tmp_path: Path) -> None:
        from deerflow.apps.session import AppNotFoundError

        with pytest.raises(AppNotFoundError):
            _manager(tmp_path).probe_presence("nope")


class TestRelease:
    def test_release_hands_the_instance_back_without_stopping_it(self, tmp_path: Path) -> None:
        manager = _manager(tmp_path, policy="preempt", allow_preempt=True)
        launched = asyncio.run(exec_app_launch(_runtime(manager), {"app": "demo", "crash_confirm": True}, {}))
        session_id = launched["session"]["session_id"]

        _occupy(tmp_path)
        asyncio.run(exec_app_script(_runtime(manager), {"app": "demo", "script": "render", "crash_confirm": True, "check_presence": True}, {"session": launched["session"]}))

        released = manager.release(session_id)
        assert released is not None
        assert released.holder == "human"
        assert released.taken_over_from is None
        assert released.status != "stopped"  # the instance is still running
        assert manager.get(session_id) is not None

    def test_release_of_an_unknown_session_is_none(self, tmp_path: Path) -> None:
        assert _manager(tmp_path).release("app-nope") is None

    def test_release_rejects_an_unknown_holder(self, tmp_path: Path) -> None:
        manager = _manager(tmp_path)
        launched = asyncio.run(exec_app_launch(_runtime(manager), {"app": "demo", "crash_confirm": True}, {}))
        with pytest.raises(ValueError):
            manager.release(launched["session"]["session_id"], to="nobody")


class TestConfigWiring:
    def test_policy_and_budget_come_from_the_apps_config(self, tmp_path: Path) -> None:
        """The registry view is what the manager enforces — config must reach it."""
        config = AppsConfig(
            enabled=True,
            definitions={"demo": AppDefinition(driver="mock", working_dir=str(tmp_path))},
            on_human_conflict="preempt",
            acquire_timeout_seconds=7.0,
        )
        manager = AppSessionManager(AppRegistry.from_config(config))
        assert manager._human_conflict_policy() == "preempt"
        assert manager._human_conflict_budget() == 7.0


class TestPreviewRisks:
    def test_launch_preview_announces_a_possible_takeover(self, tmp_path: Path) -> None:
        with_opt_in = preview_app_launch(_runtime(_manager(tmp_path, allow_preempt=True)), {"app": "demo"}, {})
        assert any("take the application over" in risk for risk in with_opt_in.risks)

        without = preview_app_launch(_runtime(_manager(tmp_path)), {"app": "demo"}, {})
        assert not any("take the application over" in risk for risk in without.risks)

    def test_script_preview_mentions_the_presence_check_only_when_asked(self, tmp_path: Path) -> None:
        manager = _manager(tmp_path)
        runtime = _runtime(manager)
        plain = preview_app_script(runtime, {"app": "demo", "script": "render"}, {})
        assert not any("on_human_conflict" in risk for risk in plain.risks)

        checked = preview_app_script(runtime, {"app": "demo", "script": "render", "check_presence": True}, {})
        assert any("on_human_conflict" in risk for risk in checked.risks)

    def test_preview_never_probes(self, tmp_path: Path) -> None:
        """A snapshot must not freeze presence: a person leaving is expected, not staleness."""
        _occupy(tmp_path)
        manager = _manager(tmp_path)
        preview = preview_app_launch(_runtime(manager), {"app": "demo"}, {})
        assert "human" not in preview.summary
        assert manager.list_sessions() == []
