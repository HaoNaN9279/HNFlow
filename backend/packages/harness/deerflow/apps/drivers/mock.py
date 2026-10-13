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
    DriverWaitResult,
)
from deerflow.config.apps_config import AppDefinition

#: Filename the mock driver always writes; also its default artifact glob.
MOCK_ARTIFACT_NAME = "mock-output.txt"


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

    def close(self, definition: AppDefinition, launch: DriverLaunch) -> None:
        return None


__all__ = ["MockAppDriver", "MOCK_ARTIFACT_NAME"]
