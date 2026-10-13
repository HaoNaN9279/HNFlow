"""Local-application workflow executors (N5, plan §6.7 / §17).

Four executors drive a registered local application through the
:mod:`deerflow.apps` access layer:

- ``app:launch``  — start / attach an instance, emit a ``session`` handle.
- ``app:script``  — run an in-app script command.
- ``app:wait``    — wait for an in-app task (render / compile / idle).
- ``app:collect`` — gather artifacts produced by the application.

``app:launch`` / ``app:script`` are non-idempotent (they start a process /
mutate in-app state) and gate on ``params.crash_confirm``; ``app:wait`` /
``app:collect`` are idempotent.  This is a deliberate exception to the
"commands must go through the sandbox" rule: local professional software runs
on the host, not in the command sandbox.

Driver calls are synchronous (subprocess / HTTP) and are offloaded to a worker
thread so the LangGraph event loop is never blocked.
"""

from __future__ import annotations

import asyncio
import logging
from typing import Any

from deerflow.apps.session import AppError, AppSessionManager, get_session_manager
from deerflow.runtime.context_keys import APP_RUNTIME_CONTEXT_KEY
from deerflow.workflow.compiler import WorkflowRuntime
from deerflow.workflow.executors import WorkflowExecutionError

logger = logging.getLogger(__name__)


# ── helpers ──────────────────────────────────────────────────────────────────


def _require_crash_confirm(params: dict[str, Any], node_label: str) -> None:
    """Raise if ``params.crash_confirm`` is not truthy."""
    if params.get("crash_confirm") is not True:
        raise WorkflowExecutionError(f"{node_label}: node requires crash_confirm=true (non-idempotent execution must be explicitly confirmed)")


def _manager(runtime: WorkflowRuntime) -> AppSessionManager:
    """Resolve the session manager from runtime context, else the process singleton."""
    context = getattr(runtime, "context", None)
    if isinstance(context, dict):
        candidate = context.get(APP_RUNTIME_CONTEXT_KEY)
        if isinstance(candidate, AppSessionManager):
            return candidate
    return get_session_manager()


def _require_app(params: dict[str, Any], node_label: str) -> str:
    app = params.get("app")
    if not isinstance(app, str) or not app:
        raise WorkflowExecutionError(f"{node_label}: missing required param 'app'")
    return app


def _string_list(value: Any) -> list[str]:
    if value is None:
        return []
    if not isinstance(value, list) or not all(isinstance(item, str) for item in value):
        raise WorkflowExecutionError("app:script: param 'args' must be a list of strings")
    return list(value)


# ── app:launch ───────────────────────────────────────────────────────────────


async def exec_app_launch(runtime: WorkflowRuntime, params: dict[str, Any], inputs: dict[str, Any]) -> dict[str, Any]:
    """Start a new application instance or attach to an existing one."""
    _require_crash_confirm(params, "app:launch")
    app = _require_app(params, "app:launch")
    mode = params.get("mode") or "launch"
    if mode not in ("launch", "attach"):
        raise WorkflowExecutionError(f"app:launch: param 'mode' must be 'launch' or 'attach', got {mode!r}")

    manager = _manager(runtime)
    try:
        session = await asyncio.to_thread(manager.launch, app, mode=mode)
    except AppError as exc:
        raise WorkflowExecutionError(f"app:launch: {exc}") from exc

    port = session.to_port()
    return {"session": port, "out": port}


# ── app:script ───────────────────────────────────────────────────────────────


async def exec_app_script(runtime: WorkflowRuntime, params: dict[str, Any], inputs: dict[str, Any]) -> dict[str, Any]:
    """Run an in-app script command against the resolved session."""
    _require_crash_confirm(params, "app:script")
    app = _require_app(params, "app:script")
    script = params.get("script")
    if script is not None and not isinstance(script, str):
        raise WorkflowExecutionError("app:script: param 'script' must be a string")
    args = _string_list(params.get("args"))
    env = params.get("env")
    if env is not None and not isinstance(env, dict):
        raise WorkflowExecutionError("app:script: param 'env' must be a mapping")

    manager = _manager(runtime)
    try:
        session = manager.resolve(app, inputs.get("session"))
        result = await asyncio.to_thread(manager.run_script, session, script=script, args=args, env=env)
    except AppError as exc:
        raise WorkflowExecutionError(f"app:script: {exc}") from exc

    return {
        "session": session.to_port(),
        "out": {
            "status": result.status,
            "exit_code": result.exit_code,
            "stdout": result.stdout,
            "stderr": result.stderr,
        },
    }


# ── app:wait ─────────────────────────────────────────────────────────────────


async def exec_app_wait(runtime: WorkflowRuntime, params: dict[str, Any], inputs: dict[str, Any]) -> dict[str, Any]:
    """Wait for an in-app task to complete (or time out)."""
    app = _require_app(params, "app:wait")
    reason = params.get("for")
    timeout = params.get("timeout")
    if timeout is not None:
        try:
            timeout = float(timeout)
        except (TypeError, ValueError) as exc:
            raise WorkflowExecutionError("app:wait: param 'timeout' must be a number") from exc

    manager = _manager(runtime)
    try:
        session = manager.resolve(app, inputs.get("session"))
        result = await asyncio.to_thread(manager.wait, session, reason=reason, timeout=timeout)
    except AppError as exc:
        raise WorkflowExecutionError(f"app:wait: {exc}") from exc

    return {"session": session.to_port(), "out": {"status": result.status, "detail": result.detail}}


# ── app:collect ──────────────────────────────────────────────────────────────


async def exec_app_collect(runtime: WorkflowRuntime, params: dict[str, Any], inputs: dict[str, Any]) -> dict[str, Any]:
    """Collect artifacts produced by the application.

    The ``out`` port carries the first artifact path (or ``None`` when nothing
    matched); the complete list is available on ``artifacts``.
    """
    app = _require_app(params, "app:collect")
    globs = params.get("globs")
    if globs is not None:
        globs = _string_list(globs)

    manager = _manager(runtime)
    try:
        session = manager.resolve(app, inputs.get("session"))
        artifacts = await asyncio.to_thread(manager.collect, session, globs=globs)
    except AppError as exc:
        raise WorkflowExecutionError(f"app:collect: {exc}") from exc

    return {"session": session.to_port(), "out": artifacts[0] if artifacts else None, "artifacts": artifacts}


__all__ = [
    "exec_app_launch",
    "exec_app_script",
    "exec_app_wait",
    "exec_app_collect",
]
