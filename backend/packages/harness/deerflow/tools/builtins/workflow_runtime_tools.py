"""Dialogue-side workflow runtime tools — scheduling (T18-3) + HumanTask (T18-4).

This module combines two sibling tasks that both landed on this file:

**T18-3 — conversation-side scheduling tools.** Thin tool shells over the
``deerflow.workflow.dispatch`` layer (T18-2): ``run_workflow`` starts (and
optionally waits for) a workflow run, ``pause_workflow`` / ``cancel_workflow``
interrupt one, and ``get_workflow_run`` reports progress for the agent's own
status updates.  ``run_workflow`` adds a friendly pre-flight gate for
pending-review (dangerous) nodes — the executor's ``crash_confirm`` guard
remains the enforcement boundary; this is only an early interception with an
actionable message.

**T18-4 — HumanTask query / submit / skip tools.** ``list_human_tasks``
returns a compact summary of the current user's tasks (optionally filtered by
status), ``submit_human_task`` validates a submission against the stored
``output_spec`` + ``validation_rules`` and, on success, transitions the task
to ``submitted`` and fires a best-effort resume run, and ``skip_human_task``
transitions to ``skipped`` with a ``{"__skip": True}`` resume.  Storage comes
from the T18-1 runtime singleton injection
(``runtime.context[WORKFLOW_RUNTIME_CONTEXT_KEY]``) and the resume dispatch is
owned by ``deerflow.workflow.dispatch.resume_workflow_run`` (T18-2), which
derives the resume value from the transitioned row.

Harness-layer module: must never import from the app layer
(see tests/test_harness_boundary.py).  The dispatch functions are resolved
lazily on every call so a missing/unwired T18-2 layer collapses to a
fail-closed error ToolMessage instead of an import deadlock (mirrors
``workflow_tools._wave2_deps``).
"""

from __future__ import annotations

import asyncio
import contextvars
import json
import logging
from collections.abc import Awaitable
from typing import Any

from langchain_core.messages import ToolMessage
from langchain_core.tools import tool
from langgraph.types import Command

from deerflow.runtime.context_keys import WORKFLOW_RUNTIME_CONTEXT_KEY
from deerflow.runtime.user_context import resolve_runtime_user_id
from deerflow.tools.sync import _SYNC_TOOL_EXECUTOR
from deerflow.tools.types import Runtime

logger = logging.getLogger(__name__)

# ── T18-3: scheduling constants ─────────────────────────────────────────────

# Default wall-clock budget for ``wait=True`` before giving up (seconds).
_DEFAULT_WAIT_TIMEOUT = 300

# Polling cadence while waiting for a terminal run status (seconds).
_POLL_INTERVAL = 1.0

# Terminal statuses for the wait loop (values of RunStatus).
_TERMINAL_STATUSES = frozenset({"success", "error", "interrupted"})

# How many most-recent node events ``get_workflow_run`` reports.
_RECENT_EVENTS = 20

# ── T18-3: scheduling tools ─────────────────────────────────────────────────


@tool(parse_docstring=True)
def run_workflow(
    definition_id: str,
    params: dict,
    runtime: Runtime,
    wait: bool = False,
    wait_timeout: int | None = None,
) -> Command:
    """Run a workflow definition and optionally wait for it to finish.

    Starts a workflow run from a saved definition.  The definition must have
    passed its pending-review gate: any dangerous node (``tool:bash`` /
    ``tool:http``) that still needs human confirmation blocks the start with
    ``code=pending_review`` and the offending node ids — confirm it via
    ``edit_workflow`` (set ``crash_confirm=true`` on that node) or handle the
    node manually before retrying.

    With ``wait=False`` the tool returns immediately with ``{run_id, status}``
    (``pending``/``running``); the run keeps executing in the background.  With
    ``wait=True`` it polls until a terminal status (``success``/``error``/
    ``interrupted``) or the timeout elapses, then returns an aggregated summary
    of node progress.

    Args:
        definition_id: Identifier of the saved workflow definition to run.
        params: Port-name to value mapping that seeds the workflow's start node.
        wait: When true, block (with polling) until the run is terminal.
        wait_timeout: Seconds to poll before giving up when ``wait=True``
            (default 300).
    """
    tool_call_id = runtime.tool_call_id
    try:
        result = _rt_run_async(
            _run_workflow_async(
                definition_id=definition_id,
                params=params,
                runtime=runtime,
                wait=wait,
                wait_timeout=wait_timeout,
            )
        )
    except Exception as exc:
        return _rt_error_command("run_workflow", tool_call_id, [_rt_operation_error("run_workflow", exc)])
    if not result.get("ok"):
        return _rt_error_command("run_workflow", tool_call_id, result.get("errors") or [])
    return _rt_success_command("run_workflow", tool_call_id, result)


@tool(parse_docstring=True)
def pause_workflow(run_id: str, runtime: Runtime) -> Command:
    """Pause (interrupt) a running workflow.

    Requests an interrupt for the workflow run identified by ``run_id``.  The
    run stops at its next cancellation point; node side-effects already
    executed are not rolled back.  Returns the run id and the cancellation
    outcome.

    Args:
        run_id: Identifier of the workflow run to interrupt.
    """
    tool_call_id = runtime.tool_call_id
    try:
        result = _rt_run_async(_interrupt_workflow_async(run_id=run_id, runtime=runtime))
    except Exception as exc:
        return _rt_error_command("pause_workflow", tool_call_id, [_rt_operation_error("pause_workflow", exc)])
    if not result.get("ok"):
        return _rt_error_command("pause_workflow", tool_call_id, result.get("errors") or [])
    return _rt_success_command("pause_workflow", tool_call_id, result)


@tool(parse_docstring=True)
def cancel_workflow(run_id: str, runtime: Runtime) -> Command:
    """Cancel a running workflow.

    Semantically equivalent to ``pause_workflow``: the current run API has a
    single ``interrupt`` cancellation action, so "cancel" and "pause" both
    stop the run at its next cancellation point without rolling back executed
    node side-effects.  Kept as a separate tool name so the agent can express
    either intent.

    Args:
        run_id: Identifier of the workflow run to cancel.
    """
    tool_call_id = runtime.tool_call_id
    try:
        result = _rt_run_async(_interrupt_workflow_async(run_id=run_id, runtime=runtime))
    except Exception as exc:
        return _rt_error_command("cancel_workflow", tool_call_id, [_rt_operation_error("cancel_workflow", exc)])
    if not result.get("ok"):
        return _rt_error_command("cancel_workflow", tool_call_id, result.get("errors") or [])
    return _rt_success_command("cancel_workflow", tool_call_id, result)


@tool(parse_docstring=True)
def get_workflow_run(run_id: str, runtime: Runtime) -> Command:
    """Get the status and recent node events of a workflow run.

    Reports the current run status plus the most recent node progress entries
    (``started`` / ``completed`` / ``failed``).  This is the agent's
    progress-report query: call it repeatedly to report progress to the user
    or to locate a failed node.

    Args:
        run_id: Identifier of the workflow run to inspect.
    """
    tool_call_id = runtime.tool_call_id
    try:
        result = _rt_run_async(_get_workflow_run_async(run_id=run_id, runtime=runtime))
    except Exception as exc:
        return _rt_error_command("get_workflow_run", tool_call_id, [_rt_operation_error("get_workflow_run", exc)])
    if not result.get("ok"):
        return _rt_error_command("get_workflow_run", tool_call_id, result.get("errors") or [])
    return _rt_success_command("get_workflow_run", tool_call_id, result)


@tool(parse_docstring=True)
def continue_node(
    run_id: str,
    node_id: str,
    prompt: str,
    runtime: Runtime,
    definition_id: str | None = None,
    params: dict | None = None,
) -> Command:
    """Continue a workflow's AI node in the same session.

    Starts a NEW workflow run that continues the target ``ai:llm_agent`` node of
    a previous (completed or interrupted) run in the same sub-agent session: the
    new run reuses the original run's session checkpoint for that node, so the
    prompt is appended to the node's existing conversation history instead of
    starting a fresh one-shot turn.  Returns the new run id immediately
    (``{run_id, thread_id, status}``); use ``get_workflow_run`` to poll it.

    Args:
        run_id: Identifier of the previous workflow run whose AI-node session to continue.
        node_id: Id of the ``ai:llm_agent`` node in that run to continue.
        prompt: The user prompt appended to the node's existing session.
        definition_id: Optional definition id to run (defaults to the original run's).
        params: Optional start-node params (defaults to the original run's).
    """
    tool_call_id = runtime.tool_call_id
    try:
        result = _rt_run_async(
            _continue_node_async(
                run_id=run_id,
                node_id=node_id,
                prompt=prompt,
                runtime=runtime,
                definition_id=definition_id,
                params=params,
            )
        )
    except Exception as exc:
        return _rt_error_command("continue_node", tool_call_id, [_rt_operation_error("continue_node", exc)])
    if not result.get("ok"):
        return _rt_error_command("continue_node", tool_call_id, result.get("errors") or [])
    return _rt_success_command("continue_node", tool_call_id, result)


# ── T18-3: async implementations ────────────────────────────────────────────


async def _run_workflow_async(
    *,
    definition_id: str,
    params: dict,
    runtime: Runtime,
    wait: bool,
    wait_timeout: int | None,
) -> dict:
    deps = _rt_deps()
    user_id = resolve_runtime_user_id(runtime)

    row = await deps["get_workflow_definition"](user_id=user_id, definition_id=definition_id)
    if row is None:
        return {
            "ok": False,
            "errors": [{"code": "not_found", "message": f"workflow definition '{definition_id}' not found for user '{user_id}'"}],
        }

    definition = deps["WorkflowDefinition"].model_validate(row["definition"])
    pending = deps["collect_pending_review_nodes"](definition)
    if pending:
        return {
            "ok": False,
            "errors": [
                {
                    "code": "pending_review",
                    "nodes": pending,
                    "message": f"危险节点待人工确认：{', '.join(pending)}。确认后请用 edit_workflow 为该节点补 crash_confirm=true 或人工处理后重试",
                }
            ],
        }

    started = await deps["start_workflow_run"](
        definition_id=definition_id,
        definition=definition,
        params=params,
        runtime=runtime,
    )
    run_id = started.get("run_id")
    if not isinstance(run_id, str) or not run_id:
        raise ValueError(f"start_workflow_run returned no run_id: {started!r}")

    if not wait:
        return {"ok": True, "run_id": run_id, "status": started.get("status", "pending")}

    timeout = wait_timeout if wait_timeout is not None else _DEFAULT_WAIT_TIMEOUT
    record, status, timed_out = await _rt_poll_until_terminal(deps, run_id, runtime, timeout)
    if timed_out:
        return {
            "ok": False,
            "errors": [
                {
                    "code": "timeout",
                    "message": f"workflow run {run_id} did not reach a terminal state within {timeout}s (last status: {status})",
                }
            ],
            "run_id": run_id,
            "status": status,
        }

    summary = await _rt_aggregate_summary(deps, run_id, runtime, status, definition)
    return {"ok": True, **summary}


async def _interrupt_workflow_async(*, run_id: str, runtime: Runtime) -> dict:
    deps = _rt_deps()
    result = await deps["cancel_workflow_run"](run_id, runtime=runtime)
    if not result.get("ok"):
        return {
            "ok": False,
            "errors": [{"code": "cancel_failed", "message": f"cancel workflow run {run_id} failed: {result.get('reason') or 'unknown reason'}"}],
            "run_id": run_id,
        }
    return {"ok": True, "run_id": run_id, "action": "interrupt", "outcome": result.get("outcome")}


async def _get_workflow_run_async(*, run_id: str, runtime: Runtime) -> dict:
    deps = _rt_deps()
    record = await deps["get_workflow_run"](run_id, runtime=runtime)
    if record is None:
        return {"ok": False, "errors": [{"code": "not_found", "message": f"workflow run '{run_id}' not found"}]}
    events = await deps["list_run_events"](run_id, runtime=runtime)
    return {
        "ok": True,
        "run_id": run_id,
        "status": record.get("status"),
        "events": events[-_RECENT_EVENTS:],
    }


async def _continue_node_async(
    *,
    run_id: str,
    node_id: str,
    prompt: str,
    runtime: Runtime,
    definition_id: str | None,
    params: dict | None,
) -> dict:
    deps = _rt_deps()
    try:
        started = await deps["continue_workflow_node"](
            run_id,
            node_id,
            prompt,
            runtime=runtime,
            definition_id=definition_id,
            params=params,
        )
    except deps["WorkflowRunNotFoundError"]:
        return {
            "ok": False,
            "errors": [{"code": "run_not_found", "message": f"workflow run '{run_id}' not found or not accessible"}],
        }
    run_id_value = started.get("run_id")
    if not isinstance(run_id_value, str) or not run_id_value:
        raise ValueError(f"continue_workflow_node returned no run_id: {started!r}")
    return {"ok": True, **started}


async def _rt_poll_until_terminal(
    deps: dict[str, Any],
    run_id: str,
    runtime: Runtime,
    timeout: int,
) -> tuple[dict | None, str, bool]:
    """Poll ``get_workflow_run`` until terminal status or *timeout* elapses.

    Returns ``(record, status, timed_out)``; on timeout the last non-terminal
    record/status is returned with ``timed_out=True``.  A missing record
    (``None``) counts as unknown status and keeps polling.
    """
    loop = asyncio.get_running_loop()
    deadline = loop.time() + float(timeout)
    while True:
        record = await deps["get_workflow_run"](run_id, runtime=runtime)
        status = str(record.get("status") or "unknown") if record is not None else "unknown"
        if status in _TERMINAL_STATUSES:
            return record, status, False
        if loop.time() >= deadline:
            return record, status, True
        await asyncio.sleep(_POLL_INTERVAL)


async def _rt_aggregate_summary(
    deps: dict[str, Any],
    run_id: str,
    runtime: Runtime,
    status: str,
    definition: Any,
) -> dict:
    """Build the aggregated progress summary for a terminal run."""
    events = await deps["list_run_events"](run_id, runtime=runtime)
    progress = _rt_collect_progress(events, definition, deps["flow_types"])

    idempotent_retryable: bool | None = None
    failed_node = progress["failed_node"]
    if failed_node is not None and progress["failed_type"] is not None:
        idempotent_retryable = progress["failed_type"] not in deps["non_idempotent_types"]

    return {
        "run_id": run_id,
        "status": status,
        "completed_nodes": progress["completed_count"],
        "total_nodes": progress["total_nodes"],
        "current_node": progress["current_node"],
        "failed_node": failed_node,
        "failed_error": progress["failed_error"],
        "idempotent_retryable": idempotent_retryable,
    }


def _rt_collect_progress(events: list[dict], definition: Any, flow_types: tuple[Any, ...]) -> dict:
    """Aggregate the dispatch ``list_run_events`` entries into a progress snapshot.

    Each entry has the shape ``{"node_id", "step", "status", "output", "error"}``
    (see ``deerflow.workflow.dispatch.list_run_events``).  ``total_nodes`` counts
    definition nodes excluding the ``flow:start`` / ``flow:end`` control-flow
    nodes; ``current_node`` is the most recently started node that has neither
    completed nor failed.
    """
    started: list[str] = []
    completed: set[str] = set()
    failed_node: str | None = None
    failed_error: str | None = None
    for entry in events:
        node_id = entry.get("node_id")
        status = entry.get("status")
        if status == "started" and isinstance(node_id, str):
            started.append(node_id)
        elif status == "completed" and isinstance(node_id, str):
            completed.add(node_id)
        elif status == "failed" and isinstance(node_id, str):
            failed_node = node_id
            failed_error = entry.get("error")

    total_nodes = sum(1 for node in definition.nodes if node.type not in flow_types)

    current_node: str | None = None
    for node_id in reversed(started):
        if node_id not in completed and node_id != failed_node:
            current_node = node_id
            break

    failed_type = None
    if failed_node is not None:
        failed_type = next((node.type for node in definition.nodes if node.id == failed_node), None)

    return {
        "completed_count": len(completed),
        "total_nodes": total_nodes,
        "current_node": current_node,
        "failed_node": failed_node,
        "failed_error": failed_error,
        "failed_type": failed_type,
    }


def _rt_deps() -> dict[str, Any]:
    """Load the workflow/persistence/dispatch modules on first use.

    ``deerflow.workflow.dispatch`` (T18-2) and ``deerflow.workflow.registry``
    are resolved lazily on every call so their imports are never dragged into
    ``deerflow.tools`` module scope (the workflow package root eagerly imports
    the executor registry, which reaches back into ``deerflow.tools`` through
    sandbox tool types — see ``workflow_tools._wave2_deps``).
    """
    from deerflow.persistence.workflow_definitions.service import get_workflow_definition
    from deerflow.workflow.danger import collect_pending_review_nodes
    from deerflow.workflow.dispatch import (
        WorkflowRunNotFoundError,
        cancel_workflow_run,
        continue_workflow_node,
        get_workflow_run,
        list_run_events,
        start_workflow_run,
    )
    from deerflow.workflow.registry import _NON_IDEMPOTENT_TYPES
    from deerflow.workflow.schema import NodeType, WorkflowDefinition

    return {
        "get_workflow_definition": get_workflow_definition,
        "collect_pending_review_nodes": collect_pending_review_nodes,
        "WorkflowDefinition": WorkflowDefinition,
        "start_workflow_run": start_workflow_run,
        "get_workflow_run": get_workflow_run,
        "cancel_workflow_run": cancel_workflow_run,
        "list_run_events": list_run_events,
        "continue_workflow_node": continue_workflow_node,
        "WorkflowRunNotFoundError": WorkflowRunNotFoundError,
        "non_idempotent_types": _NON_IDEMPOTENT_TYPES,
        "flow_types": (NodeType.FLOW_START, NodeType.FLOW_END),
    }


# ── T18-4: HumanTask tools ──────────────────────────────────────────────────

_HUMAN_TASKS_UNAVAILABLE_MESSAGE = "human task 存储不可用（需 SQL database backend）"


class HumanTaskUnavailableError(RuntimeError):
    """Raised when ``runtime.context`` carries no usable human-task repository."""


@tool(parse_docstring=True)
def list_human_tasks(runtime: Runtime, status: str | None = None) -> Command:
    """List the current user's human tasks with a compact per-task summary.

    Returns tasks newest-first. A ``status`` filter (``pending`` / ``reopened``
    / ``submitted`` / ``skipped`` / ``expired``) narrows the result; omitting it
    returns every task of the user. Requires the workflow runtime injection
    (SQL database backend).

    Args:
        status: Optional status to filter by.
    """
    tool_call_id = runtime.tool_call_id
    try:
        repo = _human_task_repo(runtime)
        user_id = resolve_runtime_user_id(runtime)
        rows = _rt_run_async(repo.list_by_user(user_id, status=status))
        tasks = [_task_summary(row) for row in rows]
        return _rt_success_command("list_human_tasks", tool_call_id, {"ok": True, "tasks": tasks, "total": len(tasks)})
    except HumanTaskUnavailableError:
        return _rt_error_command("list_human_tasks", tool_call_id, [_unavailable_error()])
    except Exception as exc:
        return _rt_error_command("list_human_tasks", tool_call_id, [_rt_operation_error("list_human_tasks", exc)])


@tool(parse_docstring=True)
def submit_human_task(task_id: str, values: dict, runtime: Runtime) -> Command:
    """Submit values for a pending human task and resume its workflow.

    The submission is validated against the task's stored ``output_spec`` and
    ``validation_rules``. A failed validation returns the error list and leaves
    the task untouched (the user may retry). A successful submission transitions
    the task to ``submitted`` and best-effort resumes the interrupted workflow
    run with these values.

    Args:
        task_id: Identifier of the human task to submit.
        values: Port-name → value mapping matching the task's output spec.
    """
    tool_call_id = runtime.tool_call_id
    try:
        repo = _human_task_repo(runtime)
        user_id = resolve_runtime_user_id(runtime)
        task = _rt_run_async(repo.get(task_id, user_id=user_id))
        if task is None:
            return _rt_error_command("submit_human_task", tool_call_id, [_not_found_error(task_id)])

        from deerflow.workflow.human_task_state import validate_human_task_submission

        output_spec = _task_field(task, "output_spec") or {}
        validation_rules = _task_field(task, "validation_rules")
        errors = validate_human_task_submission(values, output_spec, validation_rules)
        if errors:
            # Fail-closed: no status change on a rejected submission (deliberately
            # simplified vs. the app route's ``reopened`` bounce — the user simply
            # retries with corrected values).
            return _rt_error_command("submit_human_task", tool_call_id, [_validation_error(errors)])

        result = _rt_run_async(repo.submit(task_id, user_id=user_id, values=values, to_status="submitted"))
        if result is None:
            return _rt_error_command("submit_human_task", tool_call_id, [_conflict_error("任务当前状态不允许提交")])
        _resume_transitioned(result, runtime)
        return _rt_success_command("submit_human_task", tool_call_id, {"ok": True, "task_id": task_id, "status": result.get("status", "submitted")})
    except HumanTaskUnavailableError:
        return _rt_error_command("submit_human_task", tool_call_id, [_unavailable_error()])
    except Exception as exc:
        return _rt_error_command("submit_human_task", tool_call_id, [_rt_operation_error("submit_human_task", exc)])


@tool(parse_docstring=True)
def skip_human_task(task_id: str, runtime: Runtime) -> Command:
    """Skip a pending human task and resume its workflow without values.

    Transitions the task to ``skipped`` and best-effort resumes the interrupted
    workflow run with ``{"__skip": True}``, so the ``human:task`` node continues
    with its output ports unset.

    Args:
        task_id: Identifier of the human task to skip.
    """
    tool_call_id = runtime.tool_call_id
    try:
        repo = _human_task_repo(runtime)
        user_id = resolve_runtime_user_id(runtime)
        task = _rt_run_async(repo.get(task_id, user_id=user_id))
        if task is None:
            return _rt_error_command("skip_human_task", tool_call_id, [_not_found_error(task_id)])

        result = _rt_run_async(repo.skip(task_id, user_id=user_id))
        if result is None:
            return _rt_error_command("skip_human_task", tool_call_id, [_conflict_error("任务当前状态不允许跳过")])
        _resume_transitioned(result, runtime)
        return _rt_success_command("skip_human_task", tool_call_id, {"ok": True, "task_id": task_id, "status": result.get("status", "skipped")})
    except HumanTaskUnavailableError:
        return _rt_error_command("skip_human_task", tool_call_id, [_unavailable_error()])
    except Exception as exc:
        return _rt_error_command("skip_human_task", tool_call_id, [_rt_operation_error("skip_human_task", exc)])


# ── T18-4: repository / runtime context access ──────────────────────────────


def _workflow_runtime_dict(runtime: Runtime) -> dict[str, Any] | None:
    """Return the ``__workflow_runtime`` singleton dict, or ``None``."""
    context = getattr(runtime, "context", None)
    if isinstance(context, dict):
        value = context.get(WORKFLOW_RUNTIME_CONTEXT_KEY)
        if isinstance(value, dict):
            return value
    return None


def _human_task_repo(runtime: Runtime) -> Any:
    """Resolve the injected human-task repository; raises when unavailable.

    The T18-1 injection lives under ``WORKFLOW_RUNTIME_CONTEXT_KEY`` in
    ``runtime.context``. A missing key or a ``None`` repository means the
    SQL-backed repository is not available (memory backend, or the injection
    is not wired) — tools must fail closed instead of crashing.
    """
    wr = _workflow_runtime_dict(runtime)
    repo = wr.get("human_task_repo") if wr is not None else None
    if repo is None:
        raise HumanTaskUnavailableError(_HUMAN_TASKS_UNAVAILABLE_MESSAGE)
    return repo


def _task_summary(row: dict[str, Any]) -> dict[str, Any]:
    """Project one repo row into the compact list payload."""
    return {
        "id": row.get("id"),
        "node_id": row.get("node_id"),
        "description": row.get("description") or "",
        "status": row.get("status"),
        "created_at": row.get("created_at"),
        "output_spec": row.get("output_spec") or {},
    }


def _task_field(task: Any, key: str) -> Any:
    """Read a field from a repo row (dict or ORM object)."""
    if isinstance(task, dict):
        return task.get(key)
    return getattr(task, key, None)


# ── T18-4: resume dispatch ──────────────────────────────────────────────────


def _resume_transitioned(result: dict, runtime: Runtime) -> None:
    """Best-effort resume the interrupted workflow run via the T18-2 dispatch.

    Delegates to ``deerflow.workflow.dispatch.resume_workflow_run`` (the
    harness mirror of ``app.gateway.routers.human_task_routes._resume_workflow``
    — it reads the run singletons from the ``__workflow_runtime`` injection and
    derives the resume value from the *transitioned* row: a ``submitted`` task
    resumes with its recorded ``submission`` dict, a skipped task (or any row
    without a submission) with the ``{"__skip": True}`` sentinel.  Passing the
    transitioned row returned by ``repo.submit`` / ``repo.skip`` is what makes
    the resume carry the submitted ``values`` vs. the skip sentinel correctly.

    Every failure is logged and swallowed inside the dispatch layer — a lost
    resume is recovered by T13-4 / operations and must never change the
    submit/skip tool result.
    """
    from deerflow.workflow.dispatch import resume_workflow_run

    _rt_run_async(resume_workflow_run(result, runtime=runtime))


# ── Sync bridge ─────────────────────────────────────────────────────────────


def _rt_run_async(coro: Awaitable[Any]) -> Any:
    """Run an async helper from a synchronous tool context.

    Mirrors ``deerflow.tools.sync.make_sync_tool_wrapper`` / T17
    ``workflow_tools._run_async``: a fresh event loop drives the coroutine
    directly, or the shared tool executor when a loop is already running
    (LangGraph may dispatch sync tools from the async path).
    """
    try:
        loop = asyncio.get_running_loop()
    except RuntimeError:
        loop = None
    if loop is not None and loop.is_running():
        captured = contextvars.copy_context()
        return _SYNC_TOOL_EXECUTOR.submit(captured.run, lambda: asyncio.run(coro)).result()
    return asyncio.run(coro)


# ── Command construction ─────────────────────────────────────────────────────


def _rt_success_command(tool_name: str, tool_call_id: str, payload: dict[str, Any]) -> Command:
    """Build the compact success ToolMessage payload for a workflow-runtime operation."""
    return Command(
        update={
            "messages": [
                ToolMessage(
                    content=json.dumps(payload, ensure_ascii=False, separators=(",", ":")),
                    tool_call_id=tool_call_id,
                    name=tool_name,
                )
            ]
        }
    )


def _rt_error_command(tool_name: str, tool_call_id: str, errors: list[dict[str, Any]]) -> Command:
    """Build the compact error ToolMessage payload for a workflow-runtime operation."""
    payload = {"ok": False, "errors": errors}
    return Command(
        update={
            "messages": [
                ToolMessage(
                    content=json.dumps(payload, ensure_ascii=False, separators=(",", ":")),
                    tool_call_id=tool_call_id,
                    name=tool_name,
                    status="error",
                )
            ]
        }
    )


def _rt_operation_error(tool_name: str, exc: Exception) -> dict[str, Any]:
    """Convert an operation failure into one structured error entry."""
    if isinstance(exc, NotImplementedError):
        return {"code": "not_wired", "message": f"{tool_name} not yet wired: {exc}"}
    return {"code": "workflow_operation_failed", "message": f"{tool_name} failed: {type(exc).__name__}: {exc}"}


def _unavailable_error() -> dict[str, Any]:
    return {"code": "human_tasks_unavailable", "message": _HUMAN_TASKS_UNAVAILABLE_MESSAGE}


def _not_found_error(task_id: str) -> dict[str, Any]:
    return {"code": "human_task_not_found", "message": f"human task '{task_id}' 不存在或无权访问"}


def _validation_error(errors: list[str]) -> dict[str, Any]:
    return {"code": "human_task_validation_failed", "message": "提交校验未通过", "errors": errors}


def _conflict_error(message: str) -> dict[str, Any]:
    return {"code": "human_task_conflict", "message": message}


__all__ = [
    "run_workflow",
    "pause_workflow",
    "cancel_workflow",
    "get_workflow_run",
    "continue_node",
    "list_human_tasks",
    "submit_human_task",
    "skip_human_task",
]
