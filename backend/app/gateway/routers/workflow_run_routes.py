"""Workflow run endpoints — create, stream, wait, cancel, join, state.

Follows the pattern established by ``thread_runs.py``, adapted for
workflow executions where each run is a single-thread workflow instance
rather than a multi-turn chat thread.
"""

from __future__ import annotations

import logging
import uuid
from typing import Any

from fastapi import APIRouter, HTTPException, Request, Response
from fastapi.responses import StreamingResponse
from pydantic import BaseModel, Field

from app.gateway.authz import require_permission
from app.gateway.deps import get_current_user, get_optional_user_from_request, get_run_context, get_run_manager, get_stream_bridge, get_workflow_definition_repo
from app.gateway.routers.thread_runs import RunResponse, _record_to_response
from app.gateway.services import sse_consumer, start_workflow_run, wait_for_run_completion

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/api/workflows", tags=["workflow-runs"])


# ── Request models ────────────────────────────────────────────────────────────


class WorkflowRunRequest(BaseModel):
    params: dict[str, Any] = Field(default_factory=dict)
    thread_id: str | None = None
    on_disconnect: str = "cancel"
    metadata: dict[str, Any] = Field(default_factory=dict)


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

    if outcome in (CancelOutcome.cancelled, CancelOutcome.requested, CancelOutcome.taken_over):
        return Response(status_code=202)

    if outcome == CancelOutcome.lease_valid_elsewhere:
        raise HTTPException(status_code=409, detail=f"Run {run_id} is active on another worker")

    raise HTTPException(status_code=409, detail=f"Run {run_id} cannot be cancelled")


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
