"""Human task CRUD routes.

REST endpoints for listing a user's human tasks and acting on them
(submit / skip / reopen).  Every task is user-scoped; a submission is
validated against the stored ``output_spec`` + ``validation_rules`` before
being accepted, and a rejected submission moves the task back to ``reopened``
while preserving the failed values for a retry.
"""

from __future__ import annotations

import logging
from typing import Any

from fastapi import APIRouter, HTTPException, Request
from langgraph.types import Command
from pydantic import BaseModel, Field

from app.gateway.deps import get_human_task_repo, get_optional_user_from_request, get_run_manager, get_workflow_definition_repo
from app.gateway.permissions import require_permission
from app.gateway.services import start_workflow_run
from deerflow.workflow.human_task_state import HumanTaskStatus, validate_human_task_submission
from deerflow.workflow.review import REVIEW_TASK_KIND
from deerflow.workflow.run_snapshot import load_definition_snapshot
from deerflow.workflow.schema import WorkflowDefinition

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/api/human-tasks", tags=["human-tasks"])

#: Accepted ``kind`` values for the list filter.  ``review`` tasks are created
#: by a ``human:review`` node; everything else is a plain ``human:task``.
HUMAN_TASK_KINDS: frozenset[str] = frozenset({"task", REVIEW_TASK_KIND})


# ── Request / Response models ─────────────────────────────────────────────────


class HumanTaskSubmitRequest(BaseModel):
    values: dict[str, Any] = Field(default_factory=dict)


# ── Helpers ───────────────────────────────────────────────────────────────────


def _task_field(task: Any, key: str) -> Any:
    """Read a field from a repo row (dict or ORM object)."""
    if isinstance(task, dict):
        return task.get(key)
    return getattr(task, key, None)


async def _resume_workflow(
    task: Any,
    resume_value: Any,
    request: Request,
    *,
    task_id: str,
    user_id: str,
) -> None:
    """Fire a resume run on the task's original thread (best-effort).

    submit → ``resume_value`` is the user-submitted values dict; skip →
    ``{"__skip": True}``.  The engine creates a *resume* run on the same
    ``thread_id`` with ``Command(resume=...)`` so the graph continues from the
    interrupted ``human:task`` checkpoint.

    Any failure here only logs a warning — it never changes the submit/skip
    HTTP result (the frontend already sees ``submitted`` + the pending card
    gone; a lost resume is recovered by T13-4 / operations).
    """
    try:
        checkpoint_ref = _task_field(task, "checkpoint_ref")
        if not isinstance(checkpoint_ref, dict) or not checkpoint_ref.get("thread_id"):
            logger.warning("Human task %s has no checkpoint_ref — skip resume", task_id)
            return

        workflow_run_id = _task_field(task, "workflow_run_id")
        if not workflow_run_id:
            logger.warning("Human task %s has no workflow_run_id — skip resume", task_id)
            return

        run_mgr = get_run_manager(request)
        record = await run_mgr.get(workflow_run_id, user_id=user_id)
        definition_id = (record.kwargs or {}).get("definition_id") if record else None
        if not definition_id:
            logger.warning("Human task %s has no resolvable definition_id — skip resume", task_id)
            return

        # Prefer the exact definition pinned on the run.  The row may have been
        # edited while the task was pending; resuming with the new graph would
        # re-enter a checkpoint that belongs to a different topology.
        definition = load_definition_snapshot(record.kwargs if record is not None else None)
        if definition is None:
            repo = get_workflow_definition_repo(request)
            row = await repo.get(definition_id, user_id=user_id)
            if row is None:
                logger.warning("Human task %s definition %s not found — skip resume", task_id, definition_id)
                return
            definition_dict = row.get("definition") if isinstance(row, dict) else getattr(row, "definition", None)
            if definition_dict is None:
                logger.warning("Human task %s definition %s has no body — skip resume", task_id, definition_id)
                return

            definition = WorkflowDefinition.model_validate(definition_dict)

        # §25 single-step: a resume of a *step* task keeps stepping, so the
        # operator advances one node per resume instead of the run falling back
        # to normal execution. The task row is the only place that knows which
        # kind of pause this was.
        from deerflow.workflow.breakpoint import STEP_SNAPSHOT_KIND

        snapshot = _task_field(task, "inputs_snapshot")
        debug_step = isinstance(snapshot, dict) and snapshot.get("kind") == STEP_SNAPSHOT_KIND

        await start_workflow_run(
            definition_id=definition_id,
            definition=definition,
            params={},
            thread_id=checkpoint_ref["thread_id"],
            request=request,
            on_disconnect="cancel",
            metadata={},
            resume=Command(resume=resume_value),
            origin_run_id=workflow_run_id,
            debug_step=debug_step,
        )
    except Exception:
        logger.warning("Resume run for human task %s failed (non-fatal)", task_id, exc_info=True)


# ── Routes ────────────────────────────────────────────────────────────────────


@router.get("")
@require_permission("threads", "read")
async def list_human_tasks(request: Request, status: str | None = None, kind: str | None = None):
    user = await get_optional_user_from_request(request)
    if user is None:
        raise HTTPException(status_code=401, detail="Authentication required")
    if status is not None and status not in {member.value for member in HumanTaskStatus}:
        raise HTTPException(status_code=422, detail={"errors": [f"无效的 status 过滤值: {status}"]})
    if kind is not None and kind not in HUMAN_TASK_KINDS:
        raise HTTPException(status_code=422, detail={"errors": [f"无效的 kind 过滤值: {kind}"]})
    repo = get_human_task_repo(request)
    return await repo.list_by_user(str(user.id), status=status, kind=kind)


@router.post("/{task_id}/submit")
@require_permission("threads", "write")
async def submit_human_task(task_id: str, body: HumanTaskSubmitRequest, request: Request):
    user = await get_optional_user_from_request(request)
    if user is None:
        raise HTTPException(status_code=401, detail="Authentication required")

    repo = get_human_task_repo(request)
    task = await repo.get(task_id, user_id=str(user.id))
    if task is None:
        raise HTTPException(status_code=404, detail="Human task not found")

    output_spec = _task_field(task, "output_spec") or {}
    validation_rules = _task_field(task, "validation_rules")
    errors = validate_human_task_submission(body.values, output_spec, validation_rules)
    if errors:
        # Reject the submission but keep the failed values for a retry. The
        # conditional transition to ``reopened`` fails (returns None) when the
        # task is already terminal — silently ignored so a 422 never mutates a
        # terminal task.
        await repo.submit(task_id, user_id=str(user.id), values=body.values, to_status="reopened")
        raise HTTPException(status_code=422, detail={"errors": errors})

    result = await repo.submit(task_id, user_id=str(user.id), values=body.values, to_status="submitted")
    if result is None:
        raise HTTPException(status_code=409, detail={"errors": ["任务当前状态不允许提交"]})
    await _resume_workflow(task, body.values, request, task_id=task_id, user_id=str(user.id))
    return result


@router.post("/{task_id}/skip")
@require_permission("threads", "write")
async def skip_human_task(task_id: str, request: Request):
    user = await get_optional_user_from_request(request)
    if user is None:
        raise HTTPException(status_code=401, detail="Authentication required")

    repo = get_human_task_repo(request)
    task = await repo.get(task_id, user_id=str(user.id))
    if task is None:
        raise HTTPException(status_code=404, detail="Human task not found")
    if _task_field(task, "kind") == REVIEW_TASK_KIND:
        raise HTTPException(status_code=409, detail={"errors": ["Review tasks require an approve or reject decision"]})

    result = await repo.skip(task_id, user_id=str(user.id))
    if result is None:
        raise HTTPException(status_code=409, detail={"errors": ["任务当前状态不允许跳过"]})
    await _resume_workflow(task, {"__skip": True}, request, task_id=task_id, user_id=str(user.id))
    return result


@router.post("/{task_id}/reopen")
@require_permission("threads", "write")
async def reopen_human_task(task_id: str, request: Request):
    user = await get_optional_user_from_request(request)
    if user is None:
        raise HTTPException(status_code=401, detail="Authentication required")

    repo = get_human_task_repo(request)
    task = await repo.get(task_id, user_id=str(user.id))
    if task is None:
        raise HTTPException(status_code=404, detail="Human task not found")

    result = await repo.reopen(task_id, user_id=str(user.id))
    if result is None:
        raise HTTPException(status_code=409, detail={"errors": ["任务当前状态不允许重新打开"]})
    return result
