"""Cross-workbench workflow run monitor.

Read-only reporting for the persistent right-hand monitor.  It intentionally
does not own execution controls: launching, stepping and cancelling stay on a
workbench.  The endpoint aggregates runs by launch provenance so a workbench
board can request only its own members while the global panel can request all.
"""

from __future__ import annotations

import json
from datetime import UTC, datetime
from typing import Any

from fastapi import APIRouter, HTTPException, Query, Request
from sqlalchemy import select

from app.gateway.deps import get_current_user, get_run_context
from app.gateway.permissions import require_permission
from deerflow.persistence.engine import get_session_factory
from deerflow.persistence.human_tasks.model import HumanTaskRow
from deerflow.persistence.run.model import RunRow
from deerflow.persistence.workflow_definitions.model import WorkflowDefinitionRow
from deerflow.persistence.workflow_workbenches.model import WorkflowWorkbenchRow
from deerflow.runtime.runs.schemas import RunStatus
from deerflow.utils.time import coerce_iso

router = APIRouter(prefix="/api/workflow-monitor", tags=["workflow-monitor"])

_ACTIVE_STATUSES = {RunStatus.pending.value, RunStatus.running.value}
_PENDING_TASK_STATUSES = ("pending", "reopened")
_NODE_EVENT_TYPES = ("wf:node:started", "wf:node:completed", "wf:node:failed")


def _as_utc(value: datetime | None) -> datetime | None:
    if value is None:
        return None
    return value.replace(tzinfo=UTC) if value.tzinfo is None else value


def _elapsed_seconds(started: datetime | None, finished: datetime | None = None) -> float | None:
    start = _as_utc(started)
    if start is None:
        return None
    end = _as_utc(finished) or datetime.now(UTC)
    return max(0.0, (end - start).total_seconds())


def _error_excerpt(value: str | None, limit: int = 300) -> str | None:
    if not value:
        return None
    return value[:limit]


def _definition_total_nodes(raw: Any) -> int | None:
    if not isinstance(raw, dict):
        return None
    nodes = raw.get("nodes")
    return len(nodes) if isinstance(nodes, list) else None


def _progress_from_events(events: list[dict[str, Any]]) -> dict[str, Any]:
    completed: set[str] = set()
    current: str | None = None
    last_error: str | None = None
    for event in events:
        content = event.get("content")
        if isinstance(content, str):
            try:
                content = json.loads(content)
            except (TypeError, ValueError):
                content = {}
        if not isinstance(content, dict):
            continue
        node_id = content.get("node_id")
        if not isinstance(node_id, str) or not node_id:
            continue
        event_type = event.get("event_type")
        current = node_id
        if event_type == "wf:node:completed":
            completed.add(node_id)
        elif event_type == "wf:node:failed":
            error = content.get("error")
            if isinstance(error, str) and error:
                last_error = error
    return {
        "current_node": current,
        "completed_nodes": len(completed),
        "event_error": last_error,
    }


@router.get("/runs")
@require_permission("workflows", "read")
async def list_monitor_runs(
    request: Request,
    workbench_id: str | None = Query(default=None),
    status: str = Query(default="active"),
    limit: int = Query(default=100, ge=1, le=200),
):
    """Return current runs and runs waiting for a human decision.

    ``status=active`` includes pending/running runs plus any run with a pending
    human task (even when its run status has already become ``interrupted``).
    ``status=all`` returns the most recent runs regardless of state.
    """
    if status not in {"active", "waiting_human", "all"}:
        raise HTTPException(status_code=422, detail={"errors": [f"Unsupported status filter: {status}"]})

    user_id = await get_current_user(request)
    sf = get_session_factory()
    if sf is None:
        raise HTTPException(
            status_code=503,
            detail="Workflow monitor requires a SQL database backend; set database.backend to sqlite or postgres.",
        )

    stmt = (
        select(RunRow, WorkflowDefinitionRow, WorkflowWorkbenchRow)
        .outerjoin(WorkflowDefinitionRow, WorkflowDefinitionRow.id == RunRow.assistant_id)
        .outerjoin(WorkflowWorkbenchRow, WorkflowWorkbenchRow.id == RunRow.workbench_id)
        .where(RunRow.user_id == user_id, RunRow.operation_kind == "run")
    )
    if workbench_id:
        stmt = stmt.where(RunRow.workbench_id == workbench_id)
    stmt = stmt.order_by(RunRow.updated_at.desc(), RunRow.run_id.desc()).limit(limit)

    async with sf() as session:
        rows = (await session.execute(stmt)).all()
        run_ids = [row[0].run_id for row in rows]
        pending: dict[str, dict[str, Any]] = {}
        if run_ids:
            task_stmt = select(HumanTaskRow).where(
                HumanTaskRow.user_id == user_id,
                HumanTaskRow.status.in_(_PENDING_TASK_STATUSES),
                HumanTaskRow.workflow_run_id.in_(run_ids),
            )
            tasks = (await session.execute(task_stmt)).scalars().all()
            for task in tasks:
                bucket = pending.setdefault(task.workflow_run_id, {"count": 0, "kinds": set()})
                bucket["count"] += 1
                bucket["kinds"].add(task.kind)

    event_store = get_run_context(request).event_store
    runs: list[dict[str, Any]] = []
    for run_row, definition_row, workbench_row in rows:
        pending_meta = pending.get(run_row.run_id, {"count": 0, "kinds": set()})
        pending_count = int(pending_meta["count"])
        if status == "active" and run_row.status not in _ACTIVE_STATUSES and pending_count == 0:
            continue
        if status == "waiting_human" and pending_count == 0:
            continue

        progress: dict[str, Any] = {
            "current_node": None,
            "completed_nodes": None,
            "event_error": None,
        }
        if run_row.status in _ACTIVE_STATUSES or pending_count > 0:
            try:
                events = await event_store.list_events(
                    run_row.thread_id,
                    run_row.run_id,
                    event_types=list(_NODE_EVENT_TYPES),
                    limit=500,
                )
                progress = _progress_from_events(events)
            except Exception:
                # Progress is observability; the run row and pending task are
                # still authoritative.
                pass

        display_state = run_row.status
        if pending_count > 0 and run_row.status not in _ACTIVE_STATUSES:
            display_state = "waiting_human"
        elif pending_count > 0 and run_row.status == RunStatus.running.value:
            display_state = "waiting_human"

        definition_name = definition_row.name if definition_row is not None and definition_row.user_id == user_id else None
        workbench_name = workbench_row.name if workbench_row is not None and workbench_row.user_id == user_id else None
        terminal = run_row.status not in _ACTIVE_STATUSES
        runs.append(
            {
                "run_id": run_row.run_id,
                "thread_id": run_row.thread_id,
                "definition_id": run_row.assistant_id,
                "definition_name": definition_name,
                "workbench_id": run_row.workbench_id,
                "workbench_name": workbench_name,
                "status": run_row.status,
                "display_state": display_state,
                "created_at": coerce_iso(run_row.created_at) if run_row.created_at is not None else None,
                "updated_at": coerce_iso(run_row.updated_at) if run_row.updated_at is not None else None,
                "elapsed_seconds": _elapsed_seconds(run_row.created_at, run_row.updated_at if terminal else None),
                "current_node": progress["current_node"],
                "completed_nodes": progress["completed_nodes"],
                "total_nodes": _definition_total_nodes(definition_row.definition if definition_row is not None else None),
                "pending_human_task_count": pending_count,
                "pending_human_task_kinds": sorted(pending_meta["kinds"]),
                "error_excerpt": _error_excerpt(run_row.error),
                "workbench_attached": run_row.workbench_id is not None,
            }
        )
    return {"runs": runs}
