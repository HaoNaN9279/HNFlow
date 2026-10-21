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

N6: after each successful operation the executor writes the instance record
through the injected :class:`~deerflow.persistence.app_instances.AppInstanceRepository`
(best-effort; a persistence failure never fails the live operation).
"""

from __future__ import annotations

import asyncio
import logging
import os
import time
from typing import Any

from deerflow.apps.persistence import record_launch, record_operation
from deerflow.apps.presence import ACCESS_PREEMPT, HOLDER_HUMAN, HOLDER_MACHINE, AccessDecision
from deerflow.apps.session import AppError, AppSessionManager, get_session_manager
from deerflow.assets.ref import fingerprint_file, make_ref
from deerflow.resources.governor import ResourceUnavailableError
from deerflow.runtime.context_keys import APP_INSTANCE_REPO_CONTEXT_KEY, APP_RUNTIME_CONTEXT_KEY
from deerflow.runtime.user_context import DEFAULT_USER_ID
from deerflow.workflow.compensation import record_undo, rollback_requested
from deerflow.workflow.compiler import WorkflowRuntime
from deerflow.workflow.conflict import ConflictGuard, conflicts_requested
from deerflow.workflow.executors import WorkflowExecutionError
from deerflow.workflow.preview import RECOVERY_APP_UNDO, RECOVERY_NONE, ActionPreview, make_preview
from deerflow.workflow.resource_access import ResourceAccess, app_write_access
from deerflow.workflow.undo import UndoKind, UndoStatus

logger = logging.getLogger(__name__)


# ── helpers ──────────────────────────────────────────────────────────────────


def _require_crash_confirm(params: dict[str, Any], node_label: str) -> None:
    """Raise if ``params.crash_confirm`` is not truthy."""
    if params.get("crash_confirm") is not True:
        raise WorkflowExecutionError(f"{node_label}: node requires crash_confirm=true (non-idempotent execution must be explicitly confirmed)")


def _resource_error(node_label: str, exc: ResourceUnavailableError) -> WorkflowExecutionError:
    """Translate an N8 admission failure into a node failure.

    A queued operation that never fit is a *real* failure: the node reports the
    blocking dimension (or license group) so the run error is actionable and the
    scheduler's retry/backoff (N7) can act on it.
    """
    return WorkflowExecutionError(f"{node_label}: local resource unavailable: {exc}")


def _human_conflict_error(node_label: str, app_name: str, decision: AccessDecision) -> WorkflowExecutionError:
    """Translate an N10b human-conflict refusal into a node failure.

    Names the application, what was observed, and the knob that changes the
    outcome — a bare "busy" would leave both the operator and the N7 retry path
    guessing whether waiting or preempting was intended.
    """
    return WorkflowExecutionError(f"{node_label}: application {app_name!r} is not free: {decision.reason} (observed presence: {decision.presence.state}; see apps.on_human_conflict)")


def _note_takeover(session: Any, decision: AccessDecision) -> None:
    """Record a preemption on the session so the take-over stays visible (N10b)."""
    if decision.outcome == ACCESS_PREEMPT:
        session.taken_over_from = HOLDER_HUMAN
        session.taken_over_at = time.time()


def _allow_preempt(manager: AppSessionManager, app_name: str) -> bool:
    """Whether the application opted in to being taken over from a person (N10b)."""
    definition = manager.registry.get(app_name)
    return bool(getattr(definition, "allow_preempt", False))


def _conflict_targets(manager: AppSessionManager, app_name: str, params: dict[str, Any]) -> list[str]:
    """Host paths whose change counts as a conflict for this node (N10b).

    ``params.conflict_globs`` overrides the application's declared
    ``artifact_globs``; either way, patterns resolve like the drivers resolve
    them (relative to the definition's ``working_dir``), and only paths that
    exist are returned — the guard asserts "what I saw is unchanged", and a file
    that does not exist yet says nothing a re-check could compare against.
    """
    override = params.get("conflict_globs")
    if override is None:
        definition = manager.registry.get(app_name)
        patterns = list(getattr(definition, "artifact_globs", []) or [])
    else:
        patterns = _string_list(override)

    definition = manager.registry.get(app_name)
    working_dir = getattr(definition, "working_dir", None)
    base = os.path.expandvars(str(working_dir)) if working_dir else None
    return _expand_globs(patterns, base=base)


def _expand_globs(patterns: list[str], *, base: str | None) -> list[str]:
    """Resolve declared patterns to existing host paths (order-preserving)."""
    import glob as _glob

    found: list[str] = []
    for pattern in patterns:
        expanded = os.path.expandvars(pattern)
        absolute = expanded if os.path.isabs(expanded) or not base else os.path.join(base, expanded)
        found.extend(sorted(_glob.glob(absolute, recursive=True)))
    return list(dict.fromkeys(found))


def _degraded_delta(before: int, session: Any) -> int:
    """How many of this node's operations ran against an oversubscribed quota (N8)."""
    return max(0, int(getattr(session, "degraded_operations", before)) - before)


def _context(runtime: WorkflowRuntime) -> dict[str, Any]:
    context = getattr(runtime, "context", None)
    return context if isinstance(context, dict) else {}


def _manager(runtime: WorkflowRuntime) -> AppSessionManager:
    """Resolve the session manager from runtime context, else the process singleton."""
    candidate = _context(runtime).get(APP_RUNTIME_CONTEXT_KEY)
    if isinstance(candidate, AppSessionManager):
        return candidate
    return get_session_manager()


def _repo(runtime: WorkflowRuntime) -> Any | None:
    """Resolve the durable instance repository (N6), or ``None`` when absent."""
    return _context(runtime).get(APP_INSTANCE_REPO_CONTEXT_KEY)


def _user_id(runtime: WorkflowRuntime) -> str:
    """Resolve the record owner; the single-user build always runs as ``default``."""
    value = _context(runtime).get("user_id")
    return value if isinstance(value, str) and value else DEFAULT_USER_ID


def _require_app(params: dict[str, Any], node_label: str) -> str:
    app = params.get("app")
    if not isinstance(app, str) or not app:
        raise WorkflowExecutionError(f"{node_label}: missing required param 'app'")
    return app


def app_resource_access(runtime: WorkflowRuntime, params: dict[str, Any], _inputs: dict[str, Any]) -> tuple[ResourceAccess, ...]:
    """All app operations lock the application while the node runs.

    ``app:wait`` / ``app:collect`` are read-like, but an application is a
    stateful host resource: a concurrent script on the same app is exactly the
    race this lock exists to prevent.
    """
    app = params.get("app")
    if not isinstance(app, str) or not app:
        return ()
    return (app_write_access(app),)


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
    except ResourceUnavailableError as exc:
        raise _resource_error("app:launch", exc) from exc
    except AppError as exc:
        raise WorkflowExecutionError(f"app:launch: {exc}") from exc

    # N8 records a degraded launch here; N10b records who the engine found holding
    # the application, so the durable record can answer "was this taken over?"
    # without a schema change.
    launch_deltas: dict[str, Any] = {}
    if getattr(session, "launch_degraded", False):
        launch_deltas["degraded"] = 1
    if getattr(session, "holder", HOLDER_MACHINE) != HOLDER_MACHINE:
        launch_deltas["holder"] = session.holder
    if getattr(session, "taken_over_from", None):
        launch_deltas["taken_over_from"] = session.taken_over_from
    await record_launch(_repo(runtime), session, user_id=_user_id(runtime), resource_deltas=launch_deltas)

    port = session.to_port()
    return {"session": port, "out": port}


# ── app:script ───────────────────────────────────────────────────────────────


async def exec_app_script(runtime: WorkflowRuntime, params: dict[str, Any], inputs: dict[str, Any]) -> dict[str, Any]:
    """Run an in-app script command against the resolved session.

    N10: with ``params.rollback_on_failure`` the node records what it did (for a
    later run-level undo), and when the script fails it asks the application to
    undo its own steps.  Applications that declare no undo support are reported
    as such instead of silently pretending the state was rolled back.
    """
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
    undo_requested = rollback_requested(params)
    undo_steps = _undo_steps(params)
    try:
        session = manager.resolve(app, inputs.get("session"))
    except AppError as exc:
        raise WorkflowExecutionError(f"app:script: {exc}") from exc

    # N10b (§21): snapshot the declared artifacts *before* the node waits, so a
    # person regenerating them while we queue is detected instead of clobbered.
    guard: ConflictGuard | None = None
    if conflicts_requested(params):
        paths = await asyncio.to_thread(_conflict_targets, manager, app, params)
        refs = [make_ref(path, scope="host") for path in paths]
        guard = await asyncio.to_thread(lambda: ConflictGuard.snapshot(refs, label="app:script"))

    # N10b (§17): opt-in per-operation presence check.  Off by default because a
    # presence probe cannot attribute in-flight work — an application whose probe
    # reports generic busyness would refuse on the engine's own previous job.
    if params.get("check_presence") is True:
        decision = await asyncio.to_thread(manager.acquire_access, app)
        if not decision.allowed:
            raise _human_conflict_error("app:script", app, decision)
        _note_takeover(session, decision)

    if guard is not None:
        await asyncio.to_thread(guard.check)

    try:
        started = time.monotonic()
        before = int(getattr(session, "degraded_operations", 0))
        result = await asyncio.to_thread(manager.run_script, session, script=script, args=args, env=env)
    except ResourceUnavailableError as exc:
        raise _resource_error("app:script", exc) from exc
    except AppError as exc:
        raise WorkflowExecutionError(f"app:script: {exc}") from exc

    if result.status == "failed" and undo_requested:
        await _undo_app_script(runtime, manager, session, params=params, steps=undo_steps)

    deltas: dict[str, Any] = {"scripts_run": 1, "busy_seconds": round(time.monotonic() - started, 3)}
    if result.status == "failed":
        deltas["last_error"] = result.stderr or "script failed"
    degraded = _degraded_delta(before, session)
    if degraded:
        deltas["degraded"] = degraded
    await record_operation(_repo(runtime), session, user_id=_user_id(runtime), status=session.status, resource_deltas=deltas)

    if undo_requested and result.status != "failed":
        # The action stands, so it stays undoable: record the native undo (or the
        # absence of one) for a later run-level compensation.
        supported = manager.supports_undo(app)
        await record_undo(
            runtime,
            node_id=str(params.get("node_id") or ""),
            kind=UndoKind.APP_UNDO if supported else UndoKind.FILE_BACKUP,
            session_id=session.session_id,
            app_steps=undo_steps if supported else None,
            detail=("application undo available" if supported else f"{app} declares no undo support; in-app state cannot be rolled back"),
            status=UndoStatus.RECORDED if supported else UndoStatus.SKIPPED,
        )

    return {
        "session": session.to_port(),
        "out": {
            "status": result.status,
            "exit_code": result.exit_code,
            "stdout": result.stdout,
            "stderr": result.stderr,
        },
    }


def _undo_steps(params: dict[str, Any]) -> int:
    """How many in-app undo steps compensate this node (default 1)."""
    raw = params.get("undo_steps", 1)
    try:
        steps = int(raw)
    except (TypeError, ValueError) as exc:
        raise WorkflowExecutionError("app:script: param 'undo_steps' must be an integer") from exc
    if steps < 1:
        raise WorkflowExecutionError("app:script: param 'undo_steps' must be at least 1")
    return steps


async def _undo_app_script(runtime: WorkflowRuntime, manager: AppSessionManager, session: Any, *, params: dict[str, Any], steps: int) -> None:
    """Compensate a failed in-app script through the application's own undo.

    A driver without undo support leaves the in-app state as it is; the record
    says so explicitly rather than implying a rollback happened.
    """
    node_id = str(params.get("node_id") or "")
    if not manager.supports_undo(session.app_name):
        await record_undo(
            runtime,
            node_id=node_id,
            kind=UndoKind.FILE_BACKUP,
            session_id=session.session_id,
            detail=f"script failed; {session.app_name} declares no undo support, so in-app state was not rolled back",
            status=UndoStatus.FAILED,
        )
        return
    try:
        outcome = await asyncio.to_thread(manager.undo, session, steps=steps)
    except ResourceUnavailableError as exc:
        await record_undo(runtime, node_id=node_id, kind=UndoKind.APP_UNDO, session_id=session.session_id, app_steps=steps, detail=f"undo blocked: {exc}", status=UndoStatus.FAILED)
        return
    except AppError as exc:
        await record_undo(runtime, node_id=node_id, kind=UndoKind.APP_UNDO, session_id=session.session_id, app_steps=steps, detail=f"undo failed: {exc}", status=UndoStatus.FAILED)
        return
    await record_undo(
        runtime,
        node_id=node_id,
        kind=UndoKind.APP_UNDO,
        session_id=session.session_id,
        app_steps=steps,
        detail=f"rolled back {outcome.steps} step(s) after failure: {outcome.detail}",
        status=UndoStatus.UNDONE if outcome.status == "undone" else UndoStatus.FAILED,
    )


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
        started = time.monotonic()
        before = int(getattr(session, "degraded_operations", 0))
        result = await asyncio.to_thread(manager.wait, session, reason=reason, timeout=timeout)
    except ResourceUnavailableError as exc:
        raise _resource_error("app:wait", exc) from exc
    except AppError as exc:
        raise WorkflowExecutionError(f"app:wait: {exc}") from exc

    wait_deltas: dict[str, Any] = {"waits": 1, "busy_seconds": round(time.monotonic() - started, 3)}
    degraded = _degraded_delta(before, session)
    if degraded:
        wait_deltas["degraded"] = degraded
    await record_operation(
        _repo(runtime),
        session,
        user_id=_user_id(runtime),
        status=session.status,
        resource_deltas=wait_deltas,
    )

    return {"session": session.to_port(), "out": {"status": result.status, "detail": result.detail}}


# ── app:collect ──────────────────────────────────────────────────────────────


def _artifact_refs(paths: list[str], *, want_hash: bool) -> list[dict[str, Any]]:
    """Wrap collected host artifact paths as asset references (N9).

    Fingerprinting is best-effort: an artifact may already be gone (rotated,
    deleted by the application) and that must not fail the collect node — the
    path is still reported, just without size/mtime.
    """
    refs: list[dict[str, Any]] = []
    for path in paths:
        size: int | None = None
        mtime: float | None = None
        sha256: str | None = None
        try:
            stat_result = os.stat(path)
            size = int(stat_result.st_size)
            mtime = float(stat_result.st_mtime)
            if want_hash:
                sha256 = fingerprint_file(path)
        except OSError:
            logger.debug("app artifact vanished before fingerprinting: %s", path)
        refs.append(make_ref(path, scope="host", size=size, sha256=sha256, mtime=mtime, source="app:collect").to_port())
    return refs


async def exec_app_collect(runtime: WorkflowRuntime, params: dict[str, Any], inputs: dict[str, Any]) -> dict[str, Any]:
    """Collect artifacts produced by the application.

    The ``out`` port carries the first artifact path (or ``None`` when nothing
    matched); the complete list is available on ``artifacts``, and since N9 the
    same list is also reported as first-class asset references on ``assets``
    (``scope="host"``, with size/mtime and — when ``params.hash`` is true — a
    SHA-256), so an ``app:collect`` result can feed ``data:asset`` directly.
    """
    app = _require_app(params, "app:collect")
    globs = params.get("globs")
    if globs is not None:
        globs = _string_list(globs)

    manager = _manager(runtime)
    try:
        session = manager.resolve(app, inputs.get("session"))
        before = int(getattr(session, "degraded_operations", 0))
        artifacts = await asyncio.to_thread(manager.collect, session, globs=globs)
    except ResourceUnavailableError as exc:
        raise _resource_error("app:collect", exc) from exc
    except AppError as exc:
        raise WorkflowExecutionError(f"app:collect: {exc}") from exc

    assets = await asyncio.to_thread(_artifact_refs, artifacts, want_hash=params.get("hash") is True)

    collect_deltas: dict[str, Any] = {"artifacts": len(artifacts)}
    degraded = _degraded_delta(before, session)
    if degraded:
        collect_deltas["degraded"] = degraded
    await record_operation(
        _repo(runtime),
        session,
        user_id=_user_id(runtime),
        status=session.status,
        resource_deltas=collect_deltas,
    )

    return {"session": session.to_port(), "out": artifacts[0] if artifacts else None, "artifacts": artifacts, "assets": assets}


# ── preview (N10) ────────────────────────────────────────────────────────────


def _driver_undo_supported(manager: AppSessionManager, app_name: str) -> bool:
    """Whether the application's driver can undo in-app steps (N10).

    Delegates to the manager, which probes the live driver registry — so a
    reloaded definition or a swapped driver cannot leave a stale capability claim
    behind.  An unknown app or a probe failure answers ``False``: never upgrade
    the recovery claim on a guess.
    """
    try:
        return bool(manager.supports_undo(app_name))
    except Exception:  # noqa: BLE001 — an unknown app is simply not undoable
        return False


def preview_app_launch(runtime: WorkflowRuntime, params: dict[str, Any], inputs: dict[str, Any]) -> ActionPreview:
    """Describe an ``app:launch`` — starting or attaching to an instance."""
    app = _require_app(params, "app:launch")
    mode = params.get("mode") or "launch"
    verb = "Attach to" if mode == "attach" else "Start"
    risks = ["a started instance keeps running until it is closed (closing it is cleanup, not a rollback)"]
    if _allow_preempt(_manager(runtime), app):
        # Declarative only: who is using the application is decided live when the
        # node runs, not frozen into an approval snapshot (a person leaving or
        # arriving between approval and execution is the expected case).
        risks.append(f"if a person is using {app}, this may take the application over (allow_preempt is declared)")
    return make_preview(
        params,
        action="attach_app" if mode == "attach" else "launch_app",
        summary=f"{verb} a local application instance: {app}",
        reversible=False,
        recovery=RECOVERY_NONE,
        risks=risks,
        required_confirmations=["crash_confirm"],
    )


def preview_app_script(runtime: WorkflowRuntime, params: dict[str, Any], inputs: dict[str, Any]) -> ActionPreview:
    """Describe an ``app:script`` — an in-app mutation.

    Recovery is claimed as ``app_undo`` only when the driver actually supports
    it; otherwise the action is reported as irreversible so the approver is not
    told a rollback exists when it does not.
    """
    app = _require_app(params, "app:script")
    script = params.get("script")
    args = _string_list(params.get("args"))
    manager = _manager(runtime)
    undoable = _driver_undo_supported(manager, app)

    target = f"script {script!r}" if script else "the application's default action"
    if args:
        target = f"{target} with {len(args)} argument(s)"
    summary = f"Run {target} in {app}"

    if undoable:
        risks = ["in-app state changes are rolled back through the application's own undo when they fail"]
        recovery = RECOVERY_APP_UNDO
    else:
        risks = [f"{app} declares no undo support, so in-app state changes cannot be rolled back automatically"]
        recovery = RECOVERY_NONE

    if params.get("check_presence") is True:
        risks.append(f"this node waits for or refuses an application a person is using (apps.on_human_conflict; {app} allow_preempt={_allow_preempt(manager, app)})")

    return make_preview(
        params,
        action="run_script",
        summary=summary,
        reversible=undoable,
        recovery=recovery,
        risks=risks,
        required_confirmations=["crash_confirm"],
    )


__all__ = [
    "exec_app_launch",
    "exec_app_script",
    "exec_app_wait",
    "exec_app_collect",
    "preview_app_launch",
    "preview_app_script",
]
