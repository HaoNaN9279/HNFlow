"""Workflow run endpoints — create, stream, wait, cancel, join, state, continue.

Follows the pattern established by ``thread_runs.py``, adapted for
workflow executions where each run is a single-thread workflow instance
rather than a multi-turn chat thread.
"""

from __future__ import annotations

import logging
import uuid
from types import SimpleNamespace
from typing import Any

from fastapi import APIRouter, HTTPException, Request, Response
from fastapi.responses import StreamingResponse
from pydantic import BaseModel, Field

from app.gateway.deps import get_current_user, get_optional_user_from_request, get_run_context, get_run_manager, get_stream_bridge, get_workflow_definition_repo
from app.gateway.permissions import require_permission
from app.gateway.routers.thread_runs import RunResponse, _record_to_response
from app.gateway.services import _build_workflow_template_resolver, sse_consumer, start_workflow_run, wait_for_run_completion
from deerflow.config import get_app_config
from deerflow.runtime.runs.schemas import RunStatus
from deerflow.workflow.costs import build_run_cost_report

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/api/workflows", tags=["workflow-runs"])


# ── Request models ────────────────────────────────────────────────────────────


class WorkflowRunRequest(BaseModel):
    params: dict[str, Any] = Field(default_factory=dict)
    thread_id: str | None = None
    on_disconnect: str = "cancel"
    metadata: dict[str, Any] = Field(default_factory=dict)
    # §25 single-step debugging: suspend before **every** node so a caller can
    # advance the graph one node at a time. A resume run keeps stepping while
    # the task it resumes was a step task (see the human-task resume path).
    debug_step: bool = False


class WorkflowRunContinueRequest(BaseModel):
    node_id: str = Field(min_length=1)
    prompt: str = Field(min_length=1)
    params: dict[str, Any] | None = None


class WorkflowRunRewindRequest(BaseModel):
    """§25 rewind & re-run: re-execute *node_id* and everything after it."""

    node_id: str = Field(min_length=1)


#: Run statuses a rewind may start from — a live run is still writing its own
#: checkpoints, so rewinding it would race the writes it exists to replay.
_REWINDABLE_RUN_STATUSES = frozenset({RunStatus.success, RunStatus.error, RunStatus.timeout, RunStatus.interrupted})


class WorkflowNodePreviewRequest(BaseModel):
    """N10: describe one node's mutation without running it.

    ``params`` is merged over the node's own params (so a canvas can preview an
    edit it has not saved yet) and ``inputs`` supplies the port values to preview
    with — a definition-level preview makes no claim about a *running* run's
    state, which is why the caller states the inputs.
    """

    node_id: str = Field(min_length=1)
    params: dict[str, Any] = Field(default_factory=dict)
    inputs: dict[str, Any] = Field(default_factory=dict)


class WorkflowUndoRequest(BaseModel):
    dry_run: bool = False


# ── Helpers ───────────────────────────────────────────────────────────────────


def _default_workflow_thread_id(definition_id: str) -> str:
    """Default thread id for a fresh workflow run — one run, one isolated thread."""
    return f"wf-run-{uuid.uuid4().hex}"


async def _resolve_definition(request: Request, definition_id: str, user) -> tuple[Any, Any]:
    """Look up a workflow definition by id and verify it belongs to *user*.

    Returns ``(definition_repo_row, parsed_definition)`` or raises 404.
    """
    repo = get_workflow_definition_repo(request)
    row = await repo.get(definition_id, user_id=str(user.id))
    if row is None:
        raise HTTPException(status_code=404, detail=f"Workflow {definition_id} not found")
    # The repo row may carry a ``definition`` key containing the raw dict.
    definition_dict = row.get("definition") if isinstance(row, dict) else getattr(row, "definition", None)
    if definition_dict is None:
        raise HTTPException(status_code=404, detail=f"Workflow {definition_id} has no definition body")
    from deerflow.workflow.schema import WorkflowDefinition

    parsed = WorkflowDefinition.model_validate(definition_dict)
    return row, parsed


async def _require_run_owner(request: Request, run_mgr, run_id: str) -> Any:
    """Fetch a run record and verify the caller owns it.

    Returns the ``record`` or raises 404.
    """
    user_id = await get_current_user(request)
    record = await run_mgr.get(run_id, user_id=user_id)
    if record is None:
        raise HTTPException(status_code=404, detail=f"Run {run_id} not found")
    return record


# ── Routes ────────────────────────────────────────────────────────────────────


@router.post("/{definition_id}/runs", response_model=RunResponse)
@require_permission("runs", "create")
async def create_workflow_run(definition_id: str, body: WorkflowRunRequest, request: Request) -> RunResponse:
    """Create a background workflow run (returns immediately)."""
    user = await get_optional_user_from_request(request)
    if user is None:
        raise HTTPException(status_code=401, detail="Authentication required")

    _, definition = await _resolve_definition(request, definition_id, user)

    record = await start_workflow_run(
        definition_id=definition_id,
        definition=definition,
        params=body.params,
        thread_id=body.thread_id or _default_workflow_thread_id(definition_id),
        request=request,
        on_disconnect=body.on_disconnect,
        metadata=body.metadata,
        debug_step=body.debug_step,
    )
    return _record_to_response(record)


@router.post("/{definition_id}/runs/stream")
@require_permission("runs", "create")
async def stream_workflow_run(definition_id: str, body: WorkflowRunRequest, request: Request) -> StreamingResponse:
    """Create a workflow run and stream events via SSE.

    The response includes a ``Content-Location`` header with the run's
    resource URL, matching the LangGraph Platform protocol.
    """
    user = await get_optional_user_from_request(request)
    if user is None:
        raise HTTPException(status_code=401, detail="Authentication required")

    _, definition = await _resolve_definition(request, definition_id, user)
    bridge = get_stream_bridge(request)
    run_mgr = get_run_manager(request)

    record = await start_workflow_run(
        definition_id=definition_id,
        definition=definition,
        params=body.params,
        thread_id=body.thread_id or _default_workflow_thread_id(definition_id),
        request=request,
        on_disconnect=body.on_disconnect,
        metadata=body.metadata,
        debug_step=body.debug_step,
    )

    return StreamingResponse(
        sse_consumer(bridge, record, request, run_mgr),
        media_type="text/event-stream",
        headers={
            "Cache-Control": "no-cache",
            "Connection": "keep-alive",
            "X-Accel-Buffering": "no",
            "Content-Location": f"/api/workflows/{definition_id}/runs/{record.run_id}",
        },
    )


@router.post("/{definition_id}/runs/wait")
@require_permission("runs", "create")
async def wait_workflow_run(definition_id: str, body: WorkflowRunRequest, request: Request) -> dict[str, Any]:
    """Create a workflow run and block until it completes, returning the outcome."""
    user = await get_optional_user_from_request(request)
    if user is None:
        raise HTTPException(status_code=401, detail="Authentication required")

    _, definition = await _resolve_definition(request, definition_id, user)
    bridge = get_stream_bridge(request)
    run_mgr = get_run_manager(request)

    record = await start_workflow_run(
        definition_id=definition_id,
        definition=definition,
        params=body.params,
        thread_id=body.thread_id or _default_workflow_thread_id(definition_id),
        request=request,
        on_disconnect=body.on_disconnect,
        metadata=body.metadata,
        debug_step=body.debug_step,
    )

    completed = True
    if record.task is not None:
        completed = await wait_for_run_completion(bridge, record, request, run_mgr)

    return {
        "run_id": record.run_id,
        "thread_id": record.thread_id,
        "status": record.status.value if completed else "disconnected",
    }


@router.get("/{definition_id}/runs/{run_id}", response_model=RunResponse)
@require_permission("runs", "read")
async def get_workflow_run(definition_id: str, run_id: str, request: Request) -> RunResponse:
    """Get details of a specific workflow run."""
    run_mgr = get_run_manager(request)
    record = await _require_run_owner(request, run_mgr, run_id)
    return _record_to_response(record)


@router.post("/{definition_id}/runs/{run_id}/cancel")
@require_permission("runs", "cancel")
async def cancel_workflow_run(definition_id: str, run_id: str, request: Request) -> Response:
    """Cancel a running or pending workflow run."""
    run_mgr = get_run_manager(request)
    _ = await _require_run_owner(request, run_mgr, run_id)

    from deerflow.runtime import CancelOutcome

    outcome = await run_mgr.cancel(run_id, action="interrupt")

    if outcome == CancelOutcome.cancelled:
        return Response(status_code=202)

    raise HTTPException(status_code=409, detail=f"Run {run_id} cannot be cancelled")


@router.post("/{definition_id}/runs/{run_id}/continue", response_model=RunResponse)
@require_permission("runs", "create")
async def continue_workflow_run(definition_id: str, run_id: str, body: WorkflowRunContinueRequest, request: Request) -> RunResponse:
    """Continue a completed / interrupted run's AI node in its own session.

    Admits a new workflow run whose ``ai:llm_agent`` executor resumes the
    *original* run's session checkpoint (W2B ``deerflow.workflow.dispatch.
    continue_workflow_node``).  The definition and params inherit from the
    original run unless ``params`` is supplied.

    Error mapping:
    - ``WorkflowRunNotFoundError`` → 404 (the original run is unknown)
    - ``WorkflowDispatchUnavailableError`` → 503 (no workflow runtime bundle)
    - ``ValueError`` → 422 (definition cannot be inherited / not found)
    """
    user = await get_optional_user_from_request(request)
    if user is None:
        raise HTTPException(status_code=401, detail="Authentication required")

    # The harness dispatch layer reads a run-singleton bundle from
    # ``runtime.context[WORKFLOW_RUNTIME_CONTEXT_KEY]`` (the same injection the
    # run worker performs for the conversation-side tools).  Reconstruct that
    # bundle from the request singletons so the REST path reuses the W2B
    # continue logic instead of a parallel execution stack.
    from deerflow.runtime.context_keys import WORKFLOW_RUNTIME_CONTEXT_KEY
    from deerflow.workflow.dispatch import (
        WorkflowDispatchUnavailableError,
        WorkflowRunNotFoundError,
        continue_workflow_node,
    )

    runtime = SimpleNamespace(
        context={
            WORKFLOW_RUNTIME_CONTEXT_KEY: {
                "run_manager": get_run_manager(request),
                "stream_bridge": get_stream_bridge(request),
                "run_ctx": get_run_context(request),
                "human_task_repo": getattr(request.app.state, "human_task_repo", None),
            },
            "user_id": str(user.id),
        },
    )

    try:
        summary = await continue_workflow_node(
            run_id,
            body.node_id,
            body.prompt,
            runtime=runtime,
            params=body.params,
        )
    except WorkflowRunNotFoundError as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc
    except WorkflowDispatchUnavailableError as exc:
        raise HTTPException(status_code=503, detail=str(exc)) from exc
    except ValueError as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc

    run_mgr = get_run_manager(request)
    record = await run_mgr.get(summary["run_id"], user_id=str(user.id))
    if record is None:
        raise HTTPException(status_code=500, detail=f"Continue run {summary['run_id']} was not created")
    return _record_to_response(record)


@router.post("/{definition_id}/runs/{run_id}/rewind", response_model=RunResponse)
@require_permission("runs", "create")
async def rewind_workflow_run(definition_id: str, run_id: str, body: WorkflowRunRewindRequest, request: Request) -> RunResponse:
    """Re-execute a finished run from *node_id* onward (§25 rewind & re-run).

    The checkpoint where that node was scheduled is the rewind point: resuming
    there re-runs the node and everything downstream while the already-produced
    upstream outputs stay in state, so an upstream side effect (a ``tool:bash``,
    an ``app:launch``) is not repeated.  The new run lands on the **same**
    ``thread_id`` — that is what makes it a continuation of this run's state
    rather than a fresh execution.

    Error mapping:
    - 404 the run is unknown / not owned
    - 409 the run is not finished (a live run is still writing its checkpoints)
    - 422 the node cannot be rewound to (unknown, sentinel, never scheduled)
    - 503 no checkpointer is configured (nothing to rewind to)
    """
    from deerflow.workflow.rewind import RewindError, locate_rewind_point

    user = await get_optional_user_from_request(request)
    if user is None:
        raise HTTPException(status_code=401, detail="Authentication required")

    run_mgr = get_run_manager(request)
    record = await _require_run_owner(request, run_mgr, run_id)

    status = getattr(record, "status", None)
    if status not in _REWINDABLE_RUN_STATUSES:
        raise HTTPException(status_code=409, detail=f"Run {run_id} is not finished (status: {getattr(status, 'value', status)}); a rewind needs a settled run")

    ctx = get_run_context(request)
    if ctx.checkpointer is None:
        raise HTTPException(status_code=503, detail="Checkpointer not configured — rewind is unavailable")

    _, definition = await _resolve_definition(request, definition_id, user)
    kwargs = getattr(record, "kwargs", None) or {}
    params = kwargs.get("params") if isinstance(kwargs, dict) else None

    try:
        point = await locate_rewind_point(
            definition,
            ctx.checkpointer,
            record.thread_id,
            body.node_id,
            definition_resolver=await _build_workflow_template_resolver(definition, request, user_id=str(user.id)),
            max_delegation_depth=get_app_config().subagents.max_delegation_depth,
        )
    except RewindError as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc

    new_record = await start_workflow_run(
        definition_id=definition_id,
        definition=definition,
        params=dict(params) if isinstance(params, dict) else {},
        thread_id=record.thread_id,
        request=request,
        on_disconnect="cancel",
        metadata={
            "rewind_from_run_id": run_id,
            "rewind_node_id": body.node_id,
            "rewind_checkpoint_id": point.checkpoint_id,
        },
        checkpoint_id=point.checkpoint_id,
    )
    return _record_to_response(new_record)


@router.get("/{definition_id}/runs/{run_id}/join")
@require_permission("runs", "read")
async def join_workflow_run(definition_id: str, run_id: str, request: Request) -> StreamingResponse:
    """Join an existing workflow run's SSE stream."""
    run_mgr = get_run_manager(request)
    user_id = await get_current_user(request)
    record = await run_mgr.get(run_id, user_id=user_id)
    if record is None:
        raise HTTPException(status_code=404, detail=f"Run {run_id} not found")

    bridge = get_stream_bridge(request)
    if record.store_only and not bridge.supports_cross_process:
        raise HTTPException(status_code=409, detail=f"Run {run_id} is not active on this worker and cannot be streamed")

    return StreamingResponse(
        sse_consumer(bridge, record, request, run_mgr),
        media_type="text/event-stream",
        headers={
            "Cache-Control": "no-cache",
            "Connection": "keep-alive",
            "X-Accel-Buffering": "no",
        },
    )


@router.get("/{definition_id}/runs/{run_id}/state")
@require_permission("runs", "read")
async def get_workflow_run_state(definition_id: str, run_id: str, request: Request) -> dict[str, Any]:
    """Return the latest checkpoint state for a workflow run.

    Reads the checkpointed channel values from the checkpointer, keyed
    by the run's ``thread_id``.  Returns ``503`` when no checkpointer
    is configured; returns an empty dict when no checkpoint exists yet.
    """
    run_mgr = get_run_manager(request)
    record = await _require_run_owner(request, run_mgr, run_id)

    ctx = get_run_context(request)
    if ctx.checkpointer is None:
        raise HTTPException(status_code=503, detail="Checkpointer not configured — state is unavailable")

    try:
        snapshot = await ctx.checkpointer.aget_tuple(
            config={"configurable": {"thread_id": record.thread_id}},
        )
    except Exception:
        logger.exception("Failed to fetch checkpoint state for run %s (thread %s)", run_id, record.thread_id)
        raise HTTPException(status_code=500, detail="Failed to read checkpoint state")

    if snapshot is None:
        return {}

    # channel_values may be a dict or a sentinel (delta mode).
    values = getattr(snapshot, "channel_values", None)
    if values is None or not isinstance(values, dict):
        return {}

    return {k: v for k, v in values.items() if k.startswith("wf:")}


@router.get("/{definition_id}/runs/{run_id}/cost")
@require_permission("runs", "read")
async def get_workflow_run_cost(definition_id: str, run_id: str, request: Request) -> dict[str, Any]:
    """N14 §24.10: estimate this run's spend from its per-node token usage.

    Prices the reserved ``wf:<node>:__token_usage`` channels against the
    optional ``models[*].pricing`` metadata (the same convention the console
    cost display uses). The usage channels record tokens but not the model
    that spent them, so each node is priced with the deployment's default
    model unless a per-node override is supplied — documented, and reported
    per node. Returns ``503`` when ``models[*].pricing`` is unconfigured or
    mixes currencies (unpriced nodes carry ``cost: null``, and the whole
    report is still returned rather than a fabricated zero).
    """
    run_mgr = get_run_manager(request)
    record = await _require_run_owner(request, run_mgr, run_id)

    ctx = get_run_context(request)
    if ctx.checkpointer is None:
        raise HTTPException(status_code=503, detail="Checkpointer not configured — cost is unavailable")

    try:
        snapshot = await ctx.checkpointer.aget_tuple(
            config={"configurable": {"thread_id": record.thread_id}},
        )
    except Exception:
        logger.exception("Failed to fetch checkpoint state for cost of run %s (thread %s)", run_id, record.thread_id)
        raise HTTPException(status_code=500, detail="Failed to read checkpoint state")

    values = getattr(snapshot, "channel_values", None) if snapshot is not None else None
    state = values if isinstance(values, dict) else {}

    try:
        models = get_app_config().models
    except Exception:  # pragma: no cover - defensive: cost reporting must not 500
        logger.warning("workflow cost: failed to load model pricing from config", exc_info=True)
        models = []

    default_model = getattr(models[0], "name", None) if models else None
    report = build_run_cost_report(state, models, default_model=default_model)
    report["run_id"] = run_id
    report["definition_id"] = definition_id
    return report


# ── N10: action preview + run-level undo ──────────────────────────────────────


@router.post("/{definition_id}/preview")
@require_permission("workflows", "read")
async def preview_workflow_node(definition_id: str, body: WorkflowNodePreviewRequest, request: Request) -> dict[str, Any]:
    """Describe what one node would do, without running it (N10, §21).

    Read-only: the node type's previewer reads the files it would touch (to
    fingerprint them) and writes nothing.  Returns ``{preview: null}`` for a node
    that has nothing to preview (a read-only or control-flow node) so a canvas can
    distinguish "no preview available" from "preview failed".
    """
    import inspect as _inspect

    from deerflow.workflow.compiler import WorkflowRuntime
    from deerflow.workflow.executors import build_default_registry

    user = await get_optional_user_from_request(request)
    if user is None:
        raise HTTPException(status_code=401, detail="Authentication required")
    _, definition = await _resolve_definition(request, definition_id, user)
    node = next((n for n in definition.nodes if n.id == body.node_id), None)
    if node is None:
        raise HTTPException(status_code=404, detail=f"Node {body.node_id} not found in workflow {definition_id}")

    previewer = build_default_registry().build_context().previews.get(node.type)
    if previewer is None:
        return {"preview": None, "reason": f"node type '{node.type.value}' has nothing to preview"}

    runtime = WorkflowRuntime(context=_preview_context(request, user), config={}, state={})
    params = {**node.params, **body.params, "node_id": node.id, "node_type": node.type.value}
    try:
        preview = previewer(runtime, params, dict(body.inputs))
        if _inspect.isawaitable(preview):
            preview = await preview
    except Exception as exc:  # noqa: BLE001 — an unpreviewable node is a 422, not a 500
        raise HTTPException(status_code=422, detail=f"cannot preview node {node.id}: {exc}") from exc
    return {"preview": preview.to_port() if preview is not None else None}


def _preview_context(request: Request, user: Any) -> dict[str, Any]:
    """Runtime context a previewer needs (the shared session manager).

    Deliberately *without* ``app_config``: the previewers read the process-level
    configs directly (``get_assets_config()`` / ``get_apps_config()``), and calling
    ``get_app_config()`` here would reload those singletons as a side effect —
    a read-only preview must not mutate global configuration.
    """
    from deerflow.apps.session import get_session_manager

    return {
        "user_id": str(getattr(user, "id", "") or ""),
        "app_session_manager": get_session_manager(),
    }


def _undo_repo(request: Request) -> Any:
    repo = getattr(request.app.state, "workflow_undo_repo", None)
    if repo is None:
        raise HTTPException(status_code=503, detail="Undo records require a SQL database backend")
    return repo


def _sandbox_factory(request: Request, thread_id: str, user_id: str):
    """A lazy sandbox accessor for run-level undo of sandbox targets.

    Returns the ``Sandbox`` for the run's thread, or ``None``-raising when no
    provider can supply one — the service then reports sandbox targets as failed
    while still restoring host files.
    """

    def _build() -> Any:
        from deerflow.sandbox.sandbox_provider import get_sandbox_provider

        provider = get_sandbox_provider()
        sandbox_id = provider.acquire(thread_id, user_id=user_id)
        return provider.get(sandbox_id)

    return _build


@router.get("/{definition_id}/runs/{run_id}/undo")
@require_permission("runs", "read")
async def list_workflow_run_undo(definition_id: str, run_id: str, request: Request) -> dict[str, Any]:
    """List a run's recorded irreversible actions and what an undo would replay."""
    from deerflow.workflow.undo import UndoRecord, plan_undo

    user = await get_optional_user_from_request(request)
    if user is None:
        raise HTTPException(status_code=401, detail="Authentication required")
    await _resolve_definition(request, definition_id, user)
    run_mgr = get_run_manager(request)
    await _require_run_owner(request, run_mgr, run_id)
    repo = _undo_repo(request)

    rows = await repo.list_by_run(run_id, user_id=str(user.id))
    records = [UndoRecord.from_row(row) for row in rows]
    planned = plan_undo(records)
    return {
        "records": [record.to_port() for record in records],
        "planned": [record.to_port() for record in planned],
    }


@router.post("/{definition_id}/runs/{run_id}/undo")
@require_permission("runs", "write")
async def undo_workflow_run(definition_id: str, run_id: str, body: WorkflowUndoRequest, request: Request) -> dict[str, Any]:
    """Undo a run's reversible actions, newest first (N10, §21).

    ``dry_run=true`` reports the plan without touching anything.  Each record ends
    in one terminal state, so repeating the request cannot apply a compensation
    twice.
    """
    from deerflow.apps.session import get_session_manager
    from deerflow.workflow.undo_service import execute_run_undo, plan_run_undo

    user = await get_optional_user_from_request(request)
    if user is None:
        raise HTTPException(status_code=401, detail="Authentication required")
    await _resolve_definition(request, definition_id, user)
    run_mgr = get_run_manager(request)
    record = await _require_run_owner(request, run_mgr, run_id)
    repo = _undo_repo(request)

    rows = await repo.list_by_run(run_id, user_id=str(user.id))
    planned = plan_run_undo(rows)
    outcomes = await execute_run_undo(
        planned,
        repo=repo,
        user_id=str(user.id),
        sandbox_factory=_sandbox_factory(request, record.thread_id, str(user.id)),
        session_manager=get_session_manager(),
        dry_run=body.dry_run,
    )
    return {
        "run_id": run_id,
        "dry_run": body.dry_run,
        "planned": len(planned),
        "outcomes": [outcome.to_port() for outcome in outcomes],
    }
