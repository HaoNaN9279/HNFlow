"""Tests for the CLI application driver (N4)."""

from __future__ import annotations

import sys
from pathlib import Path

from deerflow.apps.drivers.cli import CliAppDriver
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


def test_available_when_command_exists(tmp_path):
    driver = CliAppDriver()
    assert driver.available(_python_definition(tmp_path)) is True
    assert driver.available(AppDefinition(driver="cli", command="definitely-not-a-real-binary-xyz")) is False


def test_run_script_captures_stdout_and_exit(tmp_path):
    driver = CliAppDriver()
    definition = _python_definition(tmp_path)
    launch = driver.launch(definition, mode="launch")

    result = driver.run_script(definition, launch, script="-c", args=["print('hello-app')"], env=None)

    assert result.status == "completed"
    assert result.exit_code == 0
    assert "hello-app" in result.stdout


def test_run_script_nonzero_exit_is_failed(tmp_path):
    driver = CliAppDriver()
    definition = _python_definition(tmp_path)
    launch = driver.launch(definition, mode="launch")

    result = driver.run_script(definition, launch, script="-c", args=["import sys; sys.exit(3)"], env=None)

    assert result.status == "failed"
    assert result.exit_code == 3


def test_run_script_timeout_is_reported(tmp_path):
    driver = CliAppDriver()
    definition = _python_definition(tmp_path, timeout_seconds=1)
    launch = driver.launch(definition, mode="launch")

    result = driver.run_script(definition, launch, script="-c", args=["import time; time.sleep(10)"], env=None)

    assert result.status == "failed"
    assert "timeout" in result.stderr


def test_collect_returns_artifact_paths(tmp_path):
    driver = CliAppDriver()
    definition = _python_definition(tmp_path, artifact_globs=["out/*.txt"])
    launch = driver.launch(definition, mode="launch")

    driver.run_script(definition, launch, script="-c", args=["import pathlib; p=pathlib.Path('out'); p.mkdir(exist_ok=True); (p/'a.txt').write_text('x')"], env=None)
    artifacts = driver.collect(definition, launch, globs=None)

    assert len(artifacts) == 1
    assert artifacts[0].endswith("a.txt")


def test_spawn_launch_health_and_close(tmp_path):
    driver = CliAppDriver()
    definition = _python_definition(tmp_path, spawn_on_launch=True, args=["-c", "import time; time.sleep(60)"])
    launch = driver.launch(definition, mode="launch")

    assert launch.status == "ready"
    assert launch.pid
    assert driver.health(definition, launch) is True

    driver.close(definition, launch)
    assert driver.health(definition, launch) is False


def test_attach_mode_does_not_spawn(tmp_path):
    driver = CliAppDriver()
    definition = _python_definition(tmp_path, spawn_on_launch=True)
    launch = driver.launch(definition, mode="attach")

    assert launch.status == "attached"
    assert launch.pid is None
