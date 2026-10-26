"""Conversation-side workflow dispatch — harness-layer run entry point.

This module is the harness counterpart of
``app.gateway.services.start_workflow_run``: it admits a workflow run through
the run lifecycle (``RunManager.create_or_reject`` + background
``run_workflow`` task) and exposes the read/cancel/resume primitives a
conversation-side tool needs — all without importing any ``app.*`` module
(enforced by ``tests/test_harness_boundary.py``).

Runtime singleton contract (T18-1)
----------------------------------
The Gateway runtime injects a run-singleton bundle into
``runtime.context[WORKFLOW_RUNTIME_CONTEXT_KEY]``::

    {
        "run_manager": RunManager,
        "stream_bridge": StreamBridge,
        "run_ctx": RunContext,
        "human_task_repo": HumanTaskRepository | None,   # optional
        "workflow_undo_repo": WorkflowUndoRepository | None,  # optional (N10)
    }

Every public entry point reads this bundle from the ``ToolRuntime`` context.
Standalone / embedded runs without the injection raise
:class:`WorkflowDispatchUnavailableError` — the dispatch layer cannot fabricate
a run lifecycle on its own.

Event-loop affinity
-------------------
All functions here are ``async`` and drive the caller's running loop: they
create ``asyncio`` tasks on it and await ``RunManager`` (whose ``asyncio.Lock``
binds to the first loop that uses it).  Callers that bridge from a sync tool
context onto a *different* loop (e.g. ``deerflow.tools.builtins.workflow_tools``
``asyncio.run`` in a worker thread) must therefore dispatch on the loop that
owns the injected ``run_manager`` — the Gateway run loop — not on a fresh loop
(see the module report for T18-2).  The real Gateway path is exercised by the
T18-5 integration tests.
"""

from __future__ import annotations

import asyncio
import logging
import uuid
from collections.abc import Awaitable, Callable, Mapping
from typing import TYPE_CHECKING, Any

from langgraph.types import Command

from deerflow.runtime.context_keys import WORKFLOW_RUNTIME_CONTEXT_KEY
from deerflow.runtime.user_context import resolve_runtime_user_id
from deerflow.workflow.run_snapshot import definition_snapshot, load_definition_snapshot

if TYPE_CHECKING:
    from deerflow.workflow.schema import WorkflowDefinition

logger = logging.getLogger(__name__)

#: Event types emitted by ``deerflow.workflow.worker.run_workflow`` per node.
_WF_NODE_EVENT_TYPES = ("wf:node:started", "wf:node:completed", "wf:node:failed")

#: Cancel outcomes that mean "the cancellation was accepted/handled".
_OK_CANCEL_OUTCOMES = frozenset({"cancelled"})


class WorkflowDispatchUnavailableError(RuntimeError):
    """Raised when workflow dispatch is attempted without a Gateway run context.

    The dispatch entry points read a run-singleton bundle from
    ``runtime.context[WORKFLOW_RUNTIME_CONTEXT_KEY]``; that key is only injected
    by the Gateway runtime (T18-1).  Standalone / embedded runs without the
    injection cannot create or control workflow runs through this layer.
    """


class WorkflowRunNotFoundError(RuntimeError):
    """Raised when a workflow run id cannot be resolved for continuation.

    ``continue_workflow_node`` requires the original run record to derive the
    session checkpoint thread (``origin_thread_id``) and to inherit the
    definition / params.  A missing or inaccessible run cannot be continued.
    """


# ── Public entry points ───────────────────────────────────────────────────────


async def start_workflow_run(
    definition_id: str,
    definition: WorkflowDefinition,
    params: dict[str, Any],
    *,
    runtime: Any,
    thread_id: str | None = None,
    on_disconnect: str = "cancel",
    metadata: dict[str, Any] | None = None,
    resume: Any | None = None,
    origin_run_id: str | None = None,
    continue_nodes: dict[str, str] | None = None,
    origin_thread_id: str | None = None,
    debug_step: bool = False,
) -> dict[str, Any]:
    """Create a workflow ``RunRecord`` and launch the background worker task.

    Mirrors ``app.gateway.services.start_workflow_run`` without any ``app.*``
    import.  Returns a compact summary; the caller can watch the admitted
    ``record.task`` through :func:`get_workflow_run` / :func:`list_run_events`.

    Parameters
    ----------
    definition_id:
        The workflow definition id (used as ``assistant_id`` in the run record).
    definition:
        The validated workflow definition to compile and execute.
    params:
        Port-name → value mapping for the ``flow:start`` node.
    runtime:
        ``ToolRuntime`` carrying the Gateway-injected bundle under
        ``runtime.context[WORKFLOW_RUNTIME_CONTEXT_KEY]``.
    thread_id:
        Target thread; defaults to ``wf-run-<uuid4 hex>`` (one run, one thread).
    on_disconnect:
        ``"cancel"`` (default) or ``"continue"``.
    metadata:
        Optional run metadata.
    resume:
        Optional ``langgraph.types.Command``.  When set, the run resumes the
        graph from the interrupted ``human:task`` checkpoint
        (``Command(resume=...)``) on the same ``thread_id`` instead of seeding a
        fresh run from ``params``.
    origin_run_id:
        Optional original (hung) run id forwarded to ``run_workflow`` so the
        ``human:task`` executor reuses the existing pending task (see
        ``deerflow.workflow.worker.run_workflow``).
    continue_nodes:
        Optional ``{node_id: prompt}`` mapping forwarded to ``run_workflow``
        (W2B).  The ``ai:llm_agent`` executor falls back to it when the node has
        no ``continue_prompt`` input, letting a fresh run continue the target
        node's session.  Also persisted on the run record's ``kwargs`` so a
        chained continue can inherit it.
    origin_thread_id:
        Optional original run's thread id forwarded to ``run_workflow`` (W2B).
        Used as the checkpoint-thread prefix for cross-run continuation.
        Persisted on the run record's ``kwargs`` for chained continues.

    Raises
    ------
    WorkflowDispatchUnavailableError:
        No injected bundle in ``runtime.context``, or the bundle lacks
        ``run_manager`` / ``stream_bridge`` / ``run_ctx``.
    """
    bundle = _require_runtime_bundle(runtime)
    run_manager = bundle.get("run_manager")
    stream_bridge = bundle.get("stream_bridge")
    run_ctx = bundle.get("run_ctx")
    if run_manager is None or stream_bridge is None or run_ctx is None:
        raise WorkflowDispatchUnavailableError(f"Workflow runtime bundle is incomplete: expected 'run_manager', 'stream_bridge' and 'run_ctx', got {sorted(name for name, value in bundle.items() if value is None)!r} as None")

    resolved_thread_id = thread_id or _default_workflow_thread_id()
    user_id = resolve_runtime_user_id(runtime)

    # Template references are prefetched fail-open; a repository failure or a
    # missing template degrades to a resolver that returns None and the compile
    # step reports the explicit "not found" error instead of blocking admission.
    definition_resolver = await _build_workflow_template_resolver(definition, user_id)

    deps = _deps()
    disconnect = deps["DisconnectMode"].cancel if on_disconnect == "cancel" else deps["DisconnectMode"].continue_

    run_kwargs: dict[str, Any] = {"params": params, "definition_id": definition_id, **definition_snapshot(definition)}
    if continue_nodes is not None:
        run_kwargs["continue_nodes"] = continue_nodes
    if origin_thread_id is not None:
        run_kwargs["origin_thread_id"] = origin_thread_id

    record = await run_manager.create_or_reject(
        resolved_thread_id,
        definition_id,
        on_disconnect=disconnect,
        metadata=metadata or {},
        kwargs=run_kwargs,
        user_id=user_id,
    )

    run_workflow = deps["run_workflow"]
    human_task_repo = bundle.get("human_task_repo")
    workflow_undo_repo = bundle.get("workflow_undo_repo")

    async def worker() -> None:
        await run_workflow(
            stream_bridge,
            run_manager,
            record,
            ctx=run_ctx,
            definition=definition,
            params=params,
            definition_resolver=definition_resolver,
            resume=resume,
            human_task_repo=human_task_repo,
            workflow_undo_repo=workflow_undo_repo,
            origin_run_id=origin_run_id,
            continue_nodes=continue_nodes,
            origin_thread_id=origin_thread_id,
            debug_step=debug_step,
        )

    try:
        # No await is allowed between durable admission and task attachment.
        record.task = asyncio.create_task(worker())
    except Exception as exc:
        worker().close()
        await run_manager.fail_start_if_pending(
            record.run_id,
            error=f"Failed to attach workflow worker: {exc}",
        )
        raise

    return {
        "run_id": record.run_id,
        "thread_id": record.thread_id,
        "status": record.status.value,
    }


async def resume_workflow_run(task: Any, *, runtime: Any) -> None:
    """Fire a resume run on the task's original thread (best-effort).

    Mirrors ``app.gateway.routers.human_task_routes._resume_workflow`` without
    importing the app layer: reads ``checkpoint_ref`` / ``workflow_run_id`` from
    the human-task row, resolves the definition via the persisted
    ``workflow_definitions`` service, then starts a resume run with
    ``Command(resume=...)`` on the original ``thread_id``.

    The resume value is derived from the row: a ``submitted`` task resumes with
    its recorded ``submission`` dict; a skipped task (or any task without a
    submission) resumes with the skip sentinel ``{"__skip": True}``.

    Any failure here only logs a warning — it never changes the submit/skip
    result the caller already returned.
    """
    task_label = _task_label(task)
    try:
        checkpoint_ref = _task_field(task, "checkpoint_ref")
        if not isinstance(checkpoint_ref, Mapping) or not checkpoint_ref.get("thread_id"):
            logger.warning("Human task %s has no checkpoint_ref — skip resume", task_label)
            return
        workflow_run_id = _task_field(task, "workflow_run_id")
        if not workflow_run_id:
            logger.warning("Human task %s has no workflow_run_id — skip resume", task_label)
            return

        bundle = _require_runtime_bundle(runtime)
        run_manager = bundle.get("run_manager")
        if run_manager is None:
            logger.warning("Human task %s has no run_manager — skip resume", task_label)
            return

        user_id = resolve_runtime_user_id(runtime)
        record = await run_manager.get(workflow_run_id, user_id=user_id)
        definition_id = (record.kwargs or {}).get("definition_id") if record is not None else None
        if not definition_id:
            logger.warning("Human task %s has no resolvable definition_id — skip resume", task_label)
            return

        # Prefer the definition pinned on the run.  Reading the current row
        # would let an edit while suspended change the graph the checkpoint is
        # resumed into.
        definition = load_definition_snapshot(record.kwargs if record is not None else None)
        if definition is None:
            deps = _deps()
            row = await deps["get_workflow_definition"](user_id=user_id, definition_id=definition_id)
            if row is None:
                logger.warning("Human task %s definition %s not found �?skip resume", task_label, definition_id)
                return
            definition_dict = row.get("definition") if isinstance(row, dict) else getattr(row, "definition", None)
            if definition_dict is None:
                logger.warning("Human task %s definition %s has no body �?skip resume", task_label, definition_id)
                return

            definition = deps["WorkflowDefinition"].model_validate(definition_dict)

        # §25 single-step: a resume of a *step* task keeps stepping (mirrors the
        # app-layer resume path). The task row is the only place that knows
        # which kind of pause this was.
        from deerflow.workflow.debug_step import STEP_SNAPSHOT_KIND

        snapshot = _task_field(task, "inputs_snapshot")
        debug_step = isinstance(snapshot, Mapping) and snapshot.get("kind") == STEP_SNAPSHOT_KIND

        await start_workflow_run(
            definition_id=definition_id,
            definition=definition,
            params={},
            runtime=runtime,
            thread_id=checkpoint_ref["thread_id"],
            on_disconnect="cancel",
            metadata={},
            resume=Command(resume=_resume_value_for_task(task)),
            origin_run_id=workflow_run_id,
            debug_step=debug_step,
        )
    except Exception:  # noqa: BLE001 - best-effort by design
        logger.warning("Resume run for human task %s failed (non-fatal)", task_label, exc_info=True)


async def continue_workflow_node(
    run_id: str,
    node_id: str,
    prompt: str,
    *,
    runtime: Any,
    definition_id: str | None = None,
    params: dict[str, Any] | None = None,
) -> dict[str, Any]:
    """Start a same-session continue run for a target ``ai:llm_agent`` node.

    W2B: the lead agent can continue a completed / interrupted run's AI node in
    the *same sub-agent session* instead of starting a fresh one-shot turn.  A
    new workflow run is admitted and executed with ``continue_nodes={node_id:
    prompt}`` plus ``origin_thread_id=<original run's thread>``; the executor
    then resumes the original session checkpoint
    (``f"{origin_thread_id}:wfai:{node_id}"``) rather than the new run's thread.

    ``definition_id`` / ``params`` default to the original run's own values
    (inherited from ``record.kwargs``) so a single ``run_id`` is usually
    enough; pass them explicitly to override.

    Returns the ``start_workflow_run`` summary augmented with ``continue_node_id``
    and ``origin_run_id``.

    Raises
    ------
    WorkflowRunNotFoundError:
        No run record exists for ``run_id`` (or it is inaccessible).
    WorkflowDispatchUnavailableError:
        No injected runtime bundle.
    ValueError:
        The definition cannot be inherited (no reference on the original run)
        or its body cannot be resolved.
    """
    bundle = _require_runtime_bundle(runtime)
    run_manager = bundle.get("run_manager")
    if run_manager is None:
        raise WorkflowDispatchUnavailableError("Workflow runtime bundle has no 'run_manager' — cannot continue workflow runs")
    user_id = resolve_runtime_user_id(runtime)
    record = await run_manager.get(run_id, user_id=user_id)
    if record is None:
        raise WorkflowRunNotFoundError(f"workflow run '{run_id}' not found or not accessible")

    # Inherit definition / params from the original run when not supplied.
    resolved_definition_id = definition_id
    if resolved_definition_id is None:
        resolved_definition_id = (record.kwargs or {}).get("definition_id") or record.assistant_id
        if not resolved_definition_id:
            raise ValueError(f"cannot continue workflow node '{node_id}': run '{run_id}' has no definition reference — pass definition_id explicitly")
    resolved_params = params if params is not None else (record.kwargs or {}).get("params") or {}

    # Resolve the run's pinned definition first.  A continue run must inherit
    # the graph the original run used, not a later edit.
    definition = load_definition_snapshot(record.kwargs)
    if definition is None:
        deps = _deps()
        row = await deps["get_workflow_definition"](user_id=user_id, definition_id=resolved_definition_id)
        if row is None:
            raise ValueError(f"workflow definition '{resolved_definition_id}' not found for user '{user_id}'")
        definition_dict = row.get("definition") if isinstance(row, dict) else getattr(row, "definition", None)
        if definition_dict is None:
            raise ValueError(f"workflow definition '{resolved_definition_id}' has no body")
        definition = deps["WorkflowDefinition"].model_validate(definition_dict)

    started = await start_workflow_run(
        definition_id=resolved_definition_id,
        definition=definition,
        params=resolved_params,
        runtime=runtime,
        continue_nodes={node_id: prompt},
        origin_thread_id=record.thread_id,
        metadata={"continue_from_run_id": run_id, "continue_node_id": node_id},
    )
    return {**started, "continue_node_id": node_id, "origin_run_id": run_id}


async def cancel_workflow_run(run_id: str, *, runtime: Any) -> dict[str, Any]:
    """Cancel a workflow run via the injected run manager.

    Maps :class:`deerflow.runtime.runs.manager.CancelOutcome` to a compact
    result: ``cancelled`` → ``{"ok": True, "outcome": ...}``; any other
    outcome → ``{"ok": False, "reason": ...}``.
    """
    bundle = _require_runtime_bundle(runtime)
    run_manager = bundle.get("run_manager")
    if run_manager is None:
        raise WorkflowDispatchUnavailableError("Workflow runtime bundle has no 'run_manager' — cannot cancel workflow runs")
    outcome = await run_manager.cancel(run_id, action="interrupt")
    value = getattr(outcome, "value", outcome)
    if value in _OK_CANCEL_OUTCOMES:
        return {"ok": True, "outcome": value}
    return {"ok": False, "reason": value}


async def get_workflow_run(run_id: str, *, runtime: Any) -> dict[str, Any] | None:
    """Return a compact run summary, or ``None`` when no record exists.

    Summary shape: ``{run_id, thread_id, status, error, created_at}``.  When
    the run has terminated and its ``run.end`` event is persisted in the
    injected event store, additive optional keys carry its observability
    aggregates: ``token_usage`` (aggregated AI-node sub-agent tokens —
    input/output/total + prompt-cache ``cache_read_tokens``, plus a per-node
    ``nodes`` breakdown) and ``node_timings`` (N14x per-node execution
    milliseconds + ``total_ms`` + ``slowest_node``).
    """
    bundle = _require_runtime_bundle(runtime)
    run_manager = bundle.get("run_manager")
    if run_manager is None:
        raise WorkflowDispatchUnavailableError("Workflow runtime bundle has no 'run_manager' — cannot read workflow runs")
    user_id = resolve_runtime_user_id(runtime)
    record = await run_manager.get(run_id, user_id=user_id)
    if record is None:
        return None
    summary = {
        "run_id": record.run_id,
        "thread_id": record.thread_id,
        "status": record.status.value,
        "error": record.error,
        "created_at": record.created_at,
    }
    token_usage = await _read_run_token_usage(record, bundle)
    if token_usage is not None:
        summary["token_usage"] = token_usage
    node_timings = await _read_run_node_timings(record, bundle)
    if node_timings is not None:
        summary["node_timings"] = node_timings
    verification = await _read_run_verification(record, bundle)
    if verification is not None:
        summary["verification_summary"] = verification
    return summary


async def undo_workflow_run(run_id: str, *, runtime: Any, dry_run: bool = False) -> dict[str, Any]:
    """Undo a run's reversible actions, newest first (N10, §21).

    Conversation-side counterpart of ``POST /api/workflows/{id}/runs/{rid}/undo``:
    both drive :func:`deerflow.workflow.undo_service.execute_run_undo`, so the
    agent and the canvas undo through the same logic and the same records.

    Returns ``{run_id, dry_run, planned, outcomes}``.  Raises
    :class:`WorkflowRunNotFoundError` for an unknown run and
    :class:`WorkflowDispatchUnavailableError` when the bundle has no undo
    repository (a memory backend has no records to replay).
    """
    from deerflow.workflow.undo_service import execute_run_undo, plan_run_undo

    bundle = _require_runtime_bundle(runtime)
    run_manager = bundle.get("run_manager")
    if run_manager is None:
        raise WorkflowDispatchUnavailableError("Workflow runtime bundle has no 'run_manager' — cannot undo workflow runs")
    repo = bundle.get("workflow_undo_repo")
    if repo is None:
        raise WorkflowDispatchUnavailableError("Workflow runtime bundle has no 'workflow_undo_repo' — undo records need a SQL database backend")

    user_id = resolve_runtime_user_id(runtime)
    record = await run_manager.get(run_id, user_id=user_id)
    if record is None:
        raise WorkflowRunNotFoundError(f"Workflow run {run_id} was not found")

    rows = await repo.list_by_run(run_id, user_id=user_id)
    planned = plan_run_undo(rows)
    outcomes = await execute_run_undo(
        planned,
        repo=repo,
        user_id=user_id,
        sandbox_factory=_workflow_thread_sandbox_factory(record.thread_id, user_id),
        session_manager=_session_manager(),
        dry_run=dry_run,
    )
    return {
        "run_id": run_id,
        "dry_run": dry_run,
        "planned": len(planned),
        "outcomes": [outcome.to_port() for outcome in outcomes],
    }


def _workflow_thread_sandbox_factory(thread_id: str, user_id: str) -> Any:
    """Lazy sandbox accessor for the run's thread (host-only undo without one)."""

    def _build() -> Any:
        from deerflow.sandbox.sandbox_provider import get_sandbox_provider

        provider = get_sandbox_provider()
        return provider.get(provider.acquire(thread_id, user_id=user_id))

    return _build


def _session_manager() -> Any | None:
    try:
        from deerflow.apps.session import get_session_manager

        return get_session_manager()
    except Exception:  # noqa: BLE001 — undo of file targets still works without it
        return None


async def _read_run_end_content(record: Any, bundle: dict[str, Any]) -> dict[str, Any] | None:
    """Read the run's terminal ``run.end`` content, or ``None``.

    Shared by the additive observability readers (token usage, node timings) so
    one summary read costs one event-store round trip.  Best-effort and
    optional: without a run context / event store, or before the run has
    terminated, the caller keeps its key absent rather than failing.
    """
    run_ctx = bundle.get("run_ctx")
    if run_ctx is None:
        return None
    event_store = getattr(run_ctx, "event_store", None)
    if event_store is None:
        return None
    try:
        events = await event_store.list_events(
            record.thread_id,
            record.run_id,
            event_types=["run.end"],
        )
    except Exception:  # noqa: BLE001 - observability must never fail the read
        logger.warning("Failed to read run.end for run %s (non-fatal)", record.run_id, exc_info=True)
        return None
    if not events:
        return None
    content = events[-1].get("content")
    return content if isinstance(content, dict) else None


async def _read_run_token_usage(record: Any, bundle: dict[str, Any]) -> dict[str, Any] | None:
    """Read the run's terminal ``run.end`` event and return its ``token_usage``.

    The workflow worker writes an additive ``token_usage`` aggregate onto the
    ``run.end`` content (see ``deerflow.workflow.worker``).  This lookup is
    best-effort and optional: without a run context / event store, or before
    the run has terminated, the key stays absent rather than failing the
    summary read.
    """
    content = await _read_run_end_content(record, bundle)
    if content is None:
        return None
    token_usage = content.get("token_usage")
    return token_usage if isinstance(token_usage, dict) else None


async def _read_run_node_timings(record: Any, bundle: dict[str, Any]) -> dict[str, Any] | None:
    """N14x: read the run's per-node execution timings off the ``run.end`` event.

    Same best-effort contract as :func:`_read_run_token_usage`; a run whose
    nodes predate the timing channel simply has no ``node_timings`` key.
    """
    content = await _read_run_end_content(record, bundle)
    if content is None:
        return None
    node_timings = content.get("node_timings")
    return node_timings if isinstance(node_timings, dict) else None


async def _read_run_verification(record: Any, bundle: dict[str, Any]) -> dict[str, Any] | None:
    """Read the run's additive ``verification_summary`` from ``run.end``."""
    content = await _read_run_end_content(record, bundle)
    if content is None:
        return None
    summary = content.get("verification_summary")
    return summary if isinstance(summary, dict) else None


async def list_run_events(run_id: str, *, runtime: Any) -> list[dict[str, Any]]:
    """Return the node-progress sequence for a workflow run.

    Aggregates the persisted ``wf:node:started`` / ``wf:node:completed`` /
    ``wf:node:failed`` events (via ``run_ctx.event_store.list_events``) into an
    ordered list of progress entries::

        {"node_id": str, "step": int, "status": "started"|"completed"|"failed",
         "output": Any | None, "error": str | None}

    ``output`` is present only for ``completed`` entries and ``error`` only for
    ``failed`` entries.  Returns ``[]`` when the run or its event store is
    unavailable.
    """
    bundle = _require_runtime_bundle(runtime)
    run_manager = bundle.get("run_manager")
    run_ctx = bundle.get("run_ctx")
    if run_manager is None or run_ctx is None:
        raise WorkflowDispatchUnavailableError("Workflow runtime bundle is incomplete: expected 'run_manager' and 'run_ctx'")
    user_id = resolve_runtime_user_id(runtime)
    record = await run_manager.get(run_id, user_id=user_id)
    if record is None:
        return []
    event_store = getattr(run_ctx, "event_store", None)
    if event_store is None:
        return []
    events = await event_store.list_events(
        record.thread_id,
        run_id,
        event_types=list(_WF_NODE_EVENT_TYPES),
    )
    return [_aggregate_node_progress(event) for event in events]


# ── Template resolution (fail-open) ───────────────────────────────────────────


def _collect_template_refs(definition: WorkflowDefinition) -> set[str]:
    """Collect every template id referenced by *definition* (inline subgraphs recursed).

    Mirrors ``app.gateway.services._collect_template_refs``.  Walks
    ``nested:subworkflow`` nodes: template specs contribute their
    ``template_id``; inline specs are re-parsed as ``WorkflowDefinition`` and
    scanned recursively.  Malformed specs are skipped — the compile step
    surfaces the real error later.
    """
    deps = _deps()

    def _walk(current: WorkflowDefinition) -> None:
        for node in current.nodes:
            if node.type != deps["NodeType"].NESTED_SUBWORKFLOW:
                continue
            try:
                spec = deps["parse_subworkflow_spec"](node)
            except deps["WorkflowCompileError"]:
                continue
            if spec is None:
                continue
            if spec["type"] == "template":
                refs.add(spec["template_id"])
                continue
            try:
                child = deps["WorkflowDefinition"].model_validate(spec["definition"])
            except Exception:  # noqa: BLE001 - malformed inline specs surface at compile time
                continue
            _walk(child)

    refs: set[str] = set()
    _walk(definition)
    return refs


async def _prefetch_workflow_templates(
    definition: WorkflowDefinition,
    repo_get: Callable[[str, str], Awaitable[dict[str, Any] | None]],
    user_id: str,
) -> dict[str, WorkflowDefinition]:
    """Load the transitive closure of template references into a dict.

    Mirrors ``app.gateway.services._prefetch_workflow_templates``.  The
    top-level definition's own ``id`` is seeded first (so a cycle that points
    back at it is caught by the compiler before any resolver miss), then each
    referenced template is loaded via ``repo_get(template_id, user_id=...)``
    and scanned for further references until a fixed point is reached.  Missing
    templates are skipped — the resolver returns ``None`` for them and the
    compile step reports ``not found``.
    """
    deps = _deps()
    result: dict[str, WorkflowDefinition] = {definition.id: definition}
    pending: set[str] = _collect_template_refs(definition)
    visited: set[str] = set()

    while pending:
        template_id = pending.pop()
        if template_id in visited or template_id in result:
            continue
        visited.add(template_id)

        row = await repo_get(template_id, user_id=user_id)
        if row is None:
            continue
        definition_dict = row.get("definition") if isinstance(row, dict) else getattr(row, "definition", None)
        if definition_dict is None:
            continue
        try:
            parsed = deps["WorkflowDefinition"].model_validate(definition_dict)
        except Exception:  # noqa: BLE001 - skip malformed templates
            continue
        result[template_id] = parsed
        pending |= _collect_template_refs(parsed)

    return result


def _make_template_resolver(
    templates: dict[str, WorkflowDefinition],
) -> Callable[[str, str | None], WorkflowDefinition | None]:
    """Build a pure synchronous dict-lookup resolver for template references."""

    def resolver(template_id: str, _version: str | None = None) -> WorkflowDefinition | None:
        return templates.get(template_id)

    return resolver


async def _build_workflow_template_resolver(
    definition: WorkflowDefinition,
    user_id: str,
) -> Callable[[str, str | None], WorkflowDefinition | None] | None:
    """Prefetch template references and return a sync resolver (fail-open).

    Mirrors ``app.gateway.services._build_workflow_template_resolver``.  A
    repository failure or missing templates degrade to ``None`` so run creation
    is never blocked by template prefetch; a template reference then fails at
    compile time with the explicit ``not found`` / ``no definition_resolver``
    error instead of silently skipping.
    """
    if user_id is None:
        return None
    try:
        deps = _deps()
        get_workflow_definition = deps["get_workflow_definition"]

        async def _get(template_id: str, *, user_id: str) -> dict[str, Any] | None:
            return await get_workflow_definition(user_id=user_id, definition_id=template_id)

        templates = await _prefetch_workflow_templates(definition, _get, user_id)
    except Exception:  # noqa: BLE001 - fail-open by design
        logger.warning(
            "Workflow template prefetch failed for definition %s (non-fatal)",
            getattr(definition, "id", "<unknown>"),
            exc_info=True,
        )
        return None
    return _make_template_resolver(templates)


# ── Small helpers ─────────────────────────────────────────────────────────────


def _default_workflow_thread_id() -> str:
    """Default thread id for a fresh workflow run — one run, one isolated thread."""
    return f"wf-run-{uuid.uuid4().hex}"


def _require_runtime_bundle(runtime: Any) -> dict[str, Any]:
    """Return the injected workflow run bundle, or raise WorkflowDispatchUnavailableError."""
    context = getattr(runtime, "context", None)
    if not isinstance(context, Mapping):
        raise WorkflowDispatchUnavailableError(
            "Workflow dispatch requires a Gateway run context: runtime.context is missing "
            f"(got {type(context).__name__ if context is not None else 'None'}). The Gateway "
            f"injects the workflow run singleton under {WORKFLOW_RUNTIME_CONTEXT_KEY!r}; "
            "standalone/embedded runs without the injection cannot dispatch workflow runs."
        )
    bundle = context.get(WORKFLOW_RUNTIME_CONTEXT_KEY)
    if not isinstance(bundle, Mapping):
        raise WorkflowDispatchUnavailableError(
            "Workflow dispatch requires the Gateway-injected workflow runtime: "
            f"{WORKFLOW_RUNTIME_CONTEXT_KEY!r} is missing from runtime.context. The Gateway "
            "injects the run-singleton bundle (T18-1); standalone/embedded runs without it "
            "cannot dispatch workflow runs."
        )
    return dict(bundle)


def _task_field(task: Any, key: str) -> Any:
    """Read a field from a human-task row (dict or ORM object)."""
    if isinstance(task, dict):
        return task.get(key)
    return getattr(task, key, None)


def _task_label(task: Any) -> str:
    """Return a stable log label for a human-task row."""
    task_id = _task_field(task, "id")
    return str(task_id) if task_id is not None else "<unknown>"


def _resume_value_for_task(task: Any) -> Any:
    """Derive the resume value from a human-task row (submit vs skip).

    A ``submitted`` task resumes with its recorded ``submission`` dict; a
    skipped task (or any task without a submission) resumes with the skip
    sentinel ``{"__skip": True}`` — matching the app-layer routes' submit/skip
    behavior.
    """
    if _task_field(task, "status") == "submitted":
        submission = _task_field(task, "submission")
        if isinstance(submission, dict):
            return submission
    return {"__skip": True}


def _aggregate_node_progress(event: dict[str, Any]) -> dict[str, Any]:
    """Map one persisted ``wf:node:*`` event to a compact progress entry."""
    content = event.get("content")
    if not isinstance(content, dict):
        content = {}
    metadata = event.get("metadata")
    if not isinstance(metadata, dict):
        metadata = {}
    node_id = content.get("node_id") or metadata.get("node_id")
    progress: dict[str, Any] = {"node_id": node_id, "step": content.get("step", 0)}
    event_type = event.get("event_type")
    if event_type == "wf:node:started":
        progress["status"] = "started"
    elif event_type == "wf:node:completed":
        progress["status"] = "completed"
        progress["output"] = content.get("output")
    elif event_type == "wf:node:failed":
        progress["status"] = "failed"
        progress["error"] = content.get("error")
    else:
        progress["status"] = "unknown"
    return progress


def _deps() -> dict[str, Any]:
    """Load workflow/run modules on first use (import-cycle break).

    ``deerflow.workflow``'s package ``__init__`` eagerly imports the executor
    registry, which reaches back into ``deerflow.tools``.  A module-scope import
    here would therefore deadlock while ``deerflow.tools.builtins`` is still
    initializing (the same cycle ``workflow_tools._wave2_deps`` breaks);
    importing lazily on every call is cheap (module cache) and keeps the
    resolved names live so tests can patch the source modules.
    """
    from deerflow.persistence.workflow_definitions.service import get_workflow_definition
    from deerflow.runtime.runs.schemas import DisconnectMode
    from deerflow.workflow.compiler import WorkflowCompileError, parse_subworkflow_spec
    from deerflow.workflow.schema import NodeType, WorkflowDefinition
    from deerflow.workflow.worker import run_workflow

    return {
        "get_workflow_definition": get_workflow_definition,
        "DisconnectMode": DisconnectMode,
        "WorkflowCompileError": WorkflowCompileError,
        "parse_subworkflow_spec": parse_subworkflow_spec,
        "NodeType": NodeType,
        "WorkflowDefinition": WorkflowDefinition,
        "run_workflow": run_workflow,
    }


__all__ = [
    "WORKFLOW_RUNTIME_CONTEXT_KEY",
    "WorkflowDispatchUnavailableError",
    "WorkflowRunNotFoundError",
    "start_workflow_run",
    "resume_workflow_run",
    "continue_workflow_node",
    "cancel_workflow_run",
    "get_workflow_run",
    "list_run_events",
]
