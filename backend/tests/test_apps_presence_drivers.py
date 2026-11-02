"""Driver presence capability (N10b, §17).

The driver boundary must never turn a missing or broken probe into "the
application is free": every failure direction is ``unknown``.  The CLI driver
probes only what the definition declares; the mock driver reads a marker file
so the sharing rules stay testable offline.
"""

from __future__ import annotations

import sys
from pathlib import Path

from deerflow.apps.driver import AppDriverError, DriverLaunch, DriverScriptResult, DriverWaitResult, driver_presence, driver_supports_presence
from deerflow.apps.drivers.cli import CliAppDriver
from deerflow.apps.drivers.mock import MOCK_PRESENCE_NAME, MockAppDriver
from deerflow.apps.presence import PRESENCE_BUSY, PRESENCE_HUMAN, PRESENCE_IDLE, PRESENCE_UNKNOWN, SOURCE_DRIVER, SOURCE_NONE, PresenceReport
from deerflow.config.apps_config import AppDefinition


def _python_definition(tmp_path: Path, **overrides) -> AppDefinition:
    payload = {
        "driver": "cli",
        "command": sys.executable,
        "working_dir": str(tmp_path),
        "timeout_seconds": 30,
    }
    payload.update(overrides)
    return AppDefinition(**payload)


class _FlagOnlyDriver:
    """Declares the capability but cannot answer."""

    name = "flag-only"
    supports_presence = True


class _MethodOnlyDriver:
    """Implements the probe but never promised it."""

    name = "method-only"

    def probe_presence(self, definition: AppDefinition) -> PresenceReport:  # pragma: no cover - never called
        return PresenceReport(state=PRESENCE_IDLE)


class _RaisingDriver:
    name = "raising"
    supports_presence = True

    def probe_presence(self, definition: AppDefinition) -> PresenceReport:
        raise AppDriverError("the application refused to answer")


class _ExplodingDriver:
    name = "exploding"
    supports_presence = True

    def probe_presence(self, definition: AppDefinition) -> PresenceReport:
        raise RuntimeError("boom")


class _ThinDriver:
    """A driver that answers with a bare value instead of the report type."""

    name = "thin"
    supports_presence = True

    def __init__(self, answer: object) -> None:
        self._answer = answer

    def probe_presence(self, definition: AppDefinition) -> object:
        return self._answer


class TestDriverSupportsPresence:
    def test_needs_both_the_flag_and_the_method(self) -> None:
        """Mirrors ``driver_supports_undo`` (N10): one half is not a capability."""
        assert driver_supports_presence(_FlagOnlyDriver()) is False
        assert driver_supports_presence(_MethodOnlyDriver()) is False

    def test_true_for_a_real_probe(self) -> None:
        assert driver_supports_presence(MockAppDriver()) is True
        assert driver_supports_presence(CliAppDriver()) is True


class TestDriverPresenceBoundary:
    def test_absent_capability_is_unknown_and_not_an_error(self, tmp_path: Path) -> None:
        report = driver_presence(_FlagOnlyDriver(), _python_definition(tmp_path))
        assert report.state == PRESENCE_UNKNOWN
        assert report.source == SOURCE_NONE
        assert "cannot report human presence" in report.detail

    def test_driver_error_becomes_unknown(self, tmp_path: Path) -> None:
        report = driver_presence(_RaisingDriver(), _python_definition(tmp_path))
        assert report.state == PRESENCE_UNKNOWN
        assert "refused to answer" in report.detail

    def test_unexpected_exception_never_escapes(self, tmp_path: Path) -> None:
        report = driver_presence(_ExplodingDriver(), _python_definition(tmp_path))
        assert report.state == PRESENCE_UNKNOWN
        assert "boom" in report.detail

    def test_report_passes_through(self, tmp_path: Path) -> None:
        report = driver_presence(_ThinDriver(PresenceReport(state=PRESENCE_HUMAN, source=SOURCE_DRIVER)), _python_definition(tmp_path))
        assert report.state == PRESENCE_HUMAN

    def test_bare_string_is_normalized(self, tmp_path: Path) -> None:
        assert driver_presence(_ThinDriver("human"), _python_definition(tmp_path)).state == PRESENCE_HUMAN
        assert driver_presence(_ThinDriver("who-knows"), _python_definition(tmp_path)).state == PRESENCE_UNKNOWN

    def test_mapping_is_normalized(self, tmp_path: Path) -> None:
        report = driver_presence(_ThinDriver({"state": "Busy", "detail": "rendering"}), _python_definition(tmp_path))
        assert report.state == PRESENCE_BUSY
        assert report.detail == "rendering"

    def test_unshaped_answer_is_unknown(self, tmp_path: Path) -> None:
        assert driver_presence(_ThinDriver(42), _python_definition(tmp_path)).state == PRESENCE_UNKNOWN


class TestCliPresenceProbe:
    def test_without_a_declared_command_the_answer_is_unknown_not_free(self, tmp_path: Path) -> None:
        report = driver_presence(CliAppDriver(), _python_definition(tmp_path))
        assert report.state == PRESENCE_UNKNOWN
        assert "no presence_command" in report.detail

    def test_declared_command_reports_the_state(self, tmp_path: Path) -> None:
        definition = _python_definition(tmp_path, args=["-c"], presence_command="print('human')")
        report = driver_presence(CliAppDriver(), definition)
        assert report.state == PRESENCE_HUMAN
        assert report.source == SOURCE_DRIVER

    def test_banner_output_is_not_read_as_free(self, tmp_path: Path) -> None:
        definition = _python_definition(tmp_path, args=["-c"], presence_command="print('Blender 4.2')")
        assert driver_presence(CliAppDriver(), definition).state == PRESENCE_UNKNOWN

    def test_non_zero_exit_is_unknown(self, tmp_path: Path) -> None:
        definition = _python_definition(tmp_path, args=["-c"], presence_command="import sys; sys.stderr.write('no scene\\n'); sys.exit(3)")
        report = driver_presence(CliAppDriver(), definition)
        assert report.state == PRESENCE_UNKNOWN
        assert "no scene" in report.detail

    def test_timeout_is_unknown(self, tmp_path: Path) -> None:
        definition = _python_definition(tmp_path, args=["-c"], presence_command="import time; time.sleep(5)", timeout_seconds=1)
        report = driver_presence(CliAppDriver(), definition)
        assert report.state == PRESENCE_UNKNOWN
        assert "timed out" in report.detail

    def test_blank_command_is_treated_as_absent(self, tmp_path: Path) -> None:
        definition = _python_definition(tmp_path, presence_command="   ")
        assert definition.presence_command is None
        assert driver_presence(CliAppDriver(), definition).state == PRESENCE_UNKNOWN

    def test_probe_is_not_a_session_operation(self, tmp_path: Path) -> None:
        """The probe must not need a launch handle (it answers before any session)."""
        definition = _python_definition(tmp_path, args=["-c"], presence_command="print('idle')")
        assert CliAppDriver().probe_presence(definition).state == PRESENCE_IDLE


class TestMockPresenceProbe:
    def test_missing_marker_means_idle(self, tmp_path: Path) -> None:
        report = driver_presence(MockAppDriver(), _python_definition(tmp_path, driver="mock"))
        assert report.state == PRESENCE_IDLE
        assert MOCK_PRESENCE_NAME in report.detail

    def test_marker_reports_the_state(self, tmp_path: Path) -> None:
        (tmp_path / MOCK_PRESENCE_NAME).write_text("human\n", encoding="utf-8")
        assert driver_presence(MockAppDriver(), _python_definition(tmp_path, driver="mock")).state == PRESENCE_HUMAN

    def test_garbage_marker_is_unknown(self, tmp_path: Path) -> None:
        (tmp_path / MOCK_PRESENCE_NAME).write_text("maybe later\n", encoding="utf-8")
        assert driver_presence(MockAppDriver(), _python_definition(tmp_path, driver="mock")).state == PRESENCE_UNKNOWN

    def test_marker_in_working_dir_not_cwd(self, tmp_path: Path) -> None:
        workdir = tmp_path / "app"
        workdir.mkdir()
        (workdir / MOCK_PRESENCE_NAME).write_text("busy", encoding="utf-8")
        assert driver_presence(MockAppDriver(), _python_definition(tmp_path, driver="mock", working_dir=str(workdir))).state == PRESENCE_BUSY


def test_drivers_without_presence_still_satisfy_the_protocol() -> None:
    """Presence stays optional: the protocol itself must not require it."""

    class _PlainDriver:
        name = "plain"

        def available(self, definition: AppDefinition) -> bool:  # pragma: no cover - shape only
            return True

        def launch(self, definition: AppDefinition, *, mode: str) -> DriverLaunch:  # pragma: no cover
            return DriverLaunch(status="ready")

        def run_script(self, definition, launch, *, script, args, env=None) -> DriverScriptResult:  # pragma: no cover
            return DriverScriptResult(status="completed")

        def wait(self, definition, launch, *, reason, timeout) -> DriverWaitResult:  # pragma: no cover
            return DriverWaitResult(status="done")

        def collect(self, definition, launch, *, globs) -> list[str]:  # pragma: no cover
            return []

        def health(self, definition, launch) -> bool:  # pragma: no cover
            return True

        def close(self, definition, launch) -> None:  # pragma: no cover
            return None

    driver = _PlainDriver()
    from deerflow.apps.driver import AppDriver

    assert isinstance(driver, AppDriver)
    assert driver_supports_presence(driver) is False
