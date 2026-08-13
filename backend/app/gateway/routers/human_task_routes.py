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
from pydantic import BaseModel, Field

from app.gateway.authz import require_permission
from app.gateway.deps import get_human_task_repo, get_optional_user_from_request
from deerflow.workflow.human_task_state import HumanTaskStatus, validate_human_task_submission

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/api/human-tasks", tags=["human-tasks"])


# ── Request / Response models ─────────────────────────────────────────────────


class HumanTaskSubmitRequest(BaseModel):
    values: dict[str, Any] = Field(default_factory=dict)


# ── Helpers ───────────────────────────────────────────────────────────────────


def _task_field(task: Any, key: str) -> Any:
    """Read a field from a repo row (dict or ORM object)."""
    if isinstance(task, dict):
        return task.get(key)
    return getattr(task, key, None)


# ── Routes ────────────────────────────────────────────────────────────────────


@router.get("")
@require_permission("threads", "read")
async def list_human_tasks(request: Request, status: str | None = None):
    user = await get_optional_user_from_request(request)
    if user is None:
        raise HTTPException(status_code=401, detail="Authentication required")
    if status is not None and status not in {member.value for member in HumanTaskStatus}:
        raise HTTPException(status_code=422, detail={"errors": [f"无效的 status 过滤值: {status}"]})
    repo = get_human_task_repo(request)
    return await repo.list_by_user(str(user.id), status=status)


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

    result = await repo.skip(task_id, user_id=str(user.id))
    if result is None:
        raise HTTPException(status_code=409, detail={"errors": ["任务当前状态不允许跳过"]})
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
