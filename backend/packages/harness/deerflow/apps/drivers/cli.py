"""Generic subprocess CLI application driver (N4).

Models a command-line application: a single executable that is either kept
alive as a long-lived process (``spawn_on_launch: true``) or invoked per
script call.  All process execution is host-side — see the layer docstring
for the deliberate sandbox exception.

Argument layout for :meth:`run_script`::

    <command> <definition.args> <definition.script_args> [<script>] <args...>

Working directory defaults to ``definition.working_dir`` (else the current
process directory); environment starts from ``os.environ`` with
``definition.env`` overlaid (``$VAR`` values resolve from the host env).
"""

from __future__ import annotations

import glob as _glob
import logging
import os
import shutil
import subprocess
import time
from pathlib import Path

from deerflow.apps.driver import (
    AppDriverError,
    DriverLaunch,
    DriverScriptResult,
    DriverUndoResult,
    DriverWaitResult,
)
from deerflow.config.apps_config import AppDefinition

logger = logging.getLogger(__name__)

#: Wall-clock cap for a graceful terminate before a hard kill on close.
_TERMINATE_GRACE_SECONDS = 5.0


def _resolve_env(definition: AppDefinition) -> dict[str, str]:
    """Merge the host environment with the definition's env block."""
    env = dict(os.environ)
    for key, value in definition.env.items():
        env[key] = os.path.expandvars(value) if value.startswith("$") else value
    return env


def _resolve_cwd(definition: AppDefinition) -> Path:
    if definition.working_dir:
        return Path(os.path.expandvars(definition.working_dir)).expanduser().resolve()
    return Path.cwd()


def _pid_alive(pid: int) -> bool:
    """Best-effort liveness check for a host process id."""
    if pid <= 0:
        return False
    if os.name == "nt":
        import ctypes

        PROCESS_QUERY_LIMITED_INFORMATION = 0x1000
        STILL_ACTIVE = 259
        kernel32 = ctypes.windll.kernel32  # type: ignore[attr-defined]
        handle = kernel32.OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, False, pid)
        if not handle:
            return False
        try:
            code = ctypes.c_ulong()
            if not kernel32.GetExitCodeProcess(handle, ctypes.byref(code)):
                return False
            return code.value == STILL_ACTIVE
        finally:
            kernel32.CloseHandle(handle)
    try:
        os.kill(pid, 0)
    except ProcessLookupError:
        return False
    except PermissionError:
        return True
    except OSError:
        return False
    return True


class CliAppDriver:
    """Drive a command-line application as a host subprocess."""

    name = "cli"

    # -- availability --

    def available(self, definition: AppDefinition) -> bool:
        command = definition.command
        if not command:
            return False
        if any(sep in command for sep in ("/", "\\")):
            return Path(os.path.expandvars(command)).exists()
        return shutil.which(command) is not None

    # -- lifecycle --

    def launch(self, definition: AppDefinition, *, mode: str) -> DriverLaunch:
        cwd = _resolve_cwd(definition)
        if mode == "attach":
            return DriverLaunch(status="attached", handle={"cwd": str(cwd)})

        command = definition.command
        if not command:
            raise AppDriverError("cli driver launch requires a command")
        if not definition.spawn_on_launch:
            # Nothing long-lived to start: the app is driven per script call.
            return DriverLaunch(status="attached", handle={"cwd": str(cwd)})

        creationflags = getattr(subprocess, "CREATE_NEW_PROCESS_GROUP", 0) if os.name == "nt" else 0
        process = subprocess.Popen(  # noqa: S603 - operator-configured command
            [command, *definition.args],
            cwd=str(cwd),
            env=_resolve_env(definition),
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
            creationflags=creationflags,
        )
        return DriverLaunch(status="ready", pid=process.pid, handle={"cwd": str(cwd)})

    # -- operations --

    def run_script(
        self,
        definition: AppDefinition,
        launch: DriverLaunch,
        *,
        script: str | None,
        args: list[str],
        env: dict[str, str] | None = None,
    ) -> DriverScriptResult:
        command = definition.command
        if not command:
            raise AppDriverError("cli driver run_script requires a command")

        argv = [command, *definition.args, *definition.script_args]
        if script:
            argv.append(script)
        argv.extend(args)

        merged_env = _resolve_env(definition)
        if env:
            merged_env.update(env)

        cwd = launch.handle.get("cwd") or str(_resolve_cwd(definition))
        timeout = float(definition.timeout_seconds)
        try:
            completed = subprocess.run(  # noqa: S603 - operator-configured command
                argv,
                cwd=cwd,
                env=merged_env,
                capture_output=True,
                text=True,
                timeout=timeout,
                check=False,
            )
        except subprocess.TimeoutExpired as exc:
            return DriverScriptResult(
                status="failed",
                exit_code=None,
                stdout=exc.stdout.decode(errors="replace") if isinstance(exc.stdout, bytes) else (exc.stdout or ""),
                stderr=f"timeout after {timeout:g}s",
            )
        return DriverScriptResult(
            status="completed" if completed.returncode == 0 else "failed",
            exit_code=completed.returncode,
            stdout=completed.stdout or "",
            stderr=completed.stderr or "",
        )

    def wait(
        self,
        definition: AppDefinition,
        launch: DriverLaunch,
        *,
        reason: str | None,
        timeout: float | None,
    ) -> DriverWaitResult:
        pid = launch.pid
        if not pid:
            return DriverWaitResult(status="done", detail="no long-lived process to wait for")
        limit = float(timeout if timeout is not None else definition.timeout_seconds)
        deadline = time.monotonic() + limit
        while time.monotonic() < deadline:
            if not _pid_alive(pid):
                return DriverWaitResult(status="done", detail=f"process {pid} exited")
            time.sleep(0.2)
        return DriverWaitResult(status="timeout", detail=f"process {pid} still running after {limit:g}s")

    def collect(
        self,
        definition: AppDefinition,
        launch: DriverLaunch,
        *,
        globs: list[str] | None,
    ) -> list[str]:
        patterns = list(globs) if globs else list(definition.artifact_globs)
        cwd = launch.handle.get("cwd") or str(_resolve_cwd(definition))
        found: list[str] = []
        for pattern in patterns:
            base = pattern if os.path.isabs(pattern) else os.path.join(cwd, pattern)
            found.extend(sorted(_glob.glob(base, recursive=True)))
        # De-duplicate while preserving order.
        return list(dict.fromkeys(found))

    def health(self, definition: AppDefinition, launch: DriverLaunch) -> bool:
        pid = launch.pid
        if not pid:
            return True
        return _pid_alive(pid)

    #: N10: a bare subprocess has no undo history the engine can drive, so this
    #: driver states that plainly instead of guessing.  The engine then falls back
    #: to file-level backups for the paths a node declares.
    supports_undo = False

    def undo(self, definition: AppDefinition, launch: DriverLaunch, *, steps: int = 1) -> DriverUndoResult:
        """Report the honest absence of native undo for a plain CLI application."""
        return DriverUndoResult(status="unsupported", detail="cli driver has no application undo/history")

    def close(self, definition: AppDefinition, launch: DriverLaunch) -> None:
        pid = launch.pid
        if not pid or not _pid_alive(pid):
            return
        try:
            if os.name == "nt":
                subprocess.run(["taskkill", "/PID", str(pid), "/T", "/F"], capture_output=True, check=False, timeout=_TERMINATE_GRACE_SECONDS + 5)
            else:
                os.kill(pid, 15)
        except Exception:  # noqa: BLE001 - best-effort teardown
            logger.warning("cli driver: failed to stop process %s", pid, exc_info=True)


__all__ = ["CliAppDriver"]
