"""Deterministic mock application driver (N4) — offline tests and demos.

Never spawns a process and never touches the network.  ``run_script`` writes
a small JSON marker file (``mock-output.txt``) into the app's working
directory so :meth:`collect` has something real to return, and echoes the
request on stdout.  ``wait`` is immediate.
"""

from __future__ import annotations

import json
import os
from pathlib import Path

from deerflow.apps.driver import (
    DriverLaunch,
    DriverScriptResult,
    DriverUndoResult,
    DriverWaitResult,
)
from deerflow.apps.presence import PRESENCE_IDLE, SOURCE_DRIVER, PresenceReport, parse_presence_output
from deerflow.config.apps_config import AppDefinition

#: Filename the mock driver always writes; also its default artifact glob.
MOCK_ARTIFACT_NAME = "mock-output.txt"

#: N10b: presence marker file the mock driver reads.  Its content is a presence
#: state token; when it is absent the mock reports ``idle``.  A file (rather
#: than a config field or an in-process switch) keeps the probe reachable from
#: the host the way a real application's own state would be, so a test can make
#: the application "human-occupied" with one write and no API.
MOCK_PRESENCE_NAME = ".mock-presence"


def _workdir(definition: AppDefinition, launch: DriverLaunch | None = None) -> Path:
    if launch is not None:
        cwd = launch.handle.get("cwd")
        if cwd:
            return Path(cwd)
    if definition.working_dir:
        return Path(os.path.expandvars(definition.working_dir)).expanduser().resolve()
    return Path.cwd()


class MockAppDriver:
    """A no-op driver that records calls as files."""

    name = "mock"

    #: N10: the mock *does* implement undo so tests can exercise the native
    #: compensation path without a real application.  Steps are recorded in the
    #: instance's handle so a test can assert what was asked for.
    supports_undo = True

    def undo(self, definition: AppDefinition, launch: DriverLaunch, *, steps: int = 1) -> DriverUndoResult:
        """Record an undo request (the mock has no real in-app state)."""
        return DriverUndoResult(status="undone", steps=max(1, int(steps)), detail=f"mock undid {max(1, int(steps))} step(s)")

    def available(self, definition: AppDefinition) -> bool:
        return True

    def launch(self, definition: AppDefinition, *, mode: str) -> DriverLaunch:
        status = "attached" if mode == "attach" else "ready"
        return DriverLaunch(status=status, endpoint="mock://local", handle={"cwd": str(_workdir(definition))})

    def run_script(
        self,
        definition: AppDefinition,
        launch: DriverLaunch,
        *,
        script: str | None,
        args: list[str],
        env: dict[str, str] | None = None,
    ) -> DriverScriptResult:
        payload = {"script": script, "args": list(args)}
        workdir = _workdir(definition, launch)
        workdir.mkdir(parents=True, exist_ok=True)
        (workdir / MOCK_ARTIFACT_NAME).write_text(json.dumps(payload, ensure_ascii=False), encoding="utf-8")
        return DriverScriptResult(status="completed", exit_code=0, stdout=json.dumps(payload, ensure_ascii=False), stderr="")

    def wait(
        self,
        definition: AppDefinition,
        launch: DriverLaunch,
        *,
        reason: str | None,
        timeout: float | None,
    ) -> DriverWaitResult:
        return DriverWaitResult(status="done", detail=f"mock wait ({reason or 'idle'})")

    def collect(
        self,
        definition: AppDefinition,
        launch: DriverLaunch,
        *,
        globs: list[str] | None,
    ) -> list[str]:
        import glob as _glob

        patterns = list(globs) if globs else (list(definition.artifact_globs) or [MOCK_ARTIFACT_NAME])
        workdir = _workdir(definition, launch)
        found: list[str] = []
        for pattern in patterns:
            base = pattern if os.path.isabs(pattern) else os.path.join(str(workdir), pattern)
            found.extend(sorted(_glob.glob(base, recursive=True)))
        return list(dict.fromkeys(found))

    def health(self, definition: AppDefinition, launch: DriverLaunch) -> bool:
        return True

    #: N10b: the mock reports presence from a marker file so the sharing rules
    #: (wait / refuse / preempt) can be tested offline without a real GUI.
    supports_presence = True

    def probe_presence(self, definition: AppDefinition) -> PresenceReport:
        """Read the presence marker file (absent = ``idle``)."""
        path = _workdir(definition) / MOCK_PRESENCE_NAME
        try:
            text = path.read_text(encoding="utf-8")
        except FileNotFoundError:
            return PresenceReport(state=PRESENCE_IDLE, source=SOURCE_DRIVER, detail=f"mock: no {MOCK_PRESENCE_NAME} marker")
        except OSError as exc:
            return PresenceReport.unknown(detail=f"mock: could not read {MOCK_PRESENCE_NAME}: {exc}", source=SOURCE_DRIVER)
        return PresenceReport(state=parse_presence_output(text), source=SOURCE_DRIVER, detail=f"mock: {MOCK_PRESENCE_NAME}")

    def close(self, definition: AppDefinition, launch: DriverLaunch) -> None:
        return None


__all__ = ["MockAppDriver", "MOCK_ARTIFACT_NAME", "MOCK_PRESENCE_NAME"]
