"""Human review executor — approve/reject with a static retry target.

The node examines the value on its ``in`` port, suspends through the shared
HumanTask + ``interrupt()`` stack, and returns:

- ``approved`` — the reviewed value, when the human approves;
- ``rejected`` — the reviewer's continue prompt, when the human rejects.

The compiler routes those outputs to the configured downstream node and to the
``ai:llm_agent`` retry target.  Unlike ``human:task``, a review node can be
visited multiple times in one run: each visit owns a distinct task row, keyed by
``inputs_snapshot.visit``.  The visit counter round-trips through state so a
``Command(resume=...)`` re-execution reuses its own task instead of creating a
duplicate.
"""

from __future__ import annotations

from typing import Any

from langgraph.types import interrupt

from deerflow.workflow.compiler import WorkflowRuntime
from deerflow.workflow.registry import WorkflowExecutionError
from deerflow.workflow.review import (
    REVIEW_APPROVED_PORT,
    REVIEW_DECISION_APPROVED,
    REVIEW_DECISION_CHANNEL,
    REVIEW_DECISION_REJECTED,
    REVIEW_INPUT_PORT,
    REVIEW_OUTPUT_SPEC,
    REVIEW_REJECTED_PORT,
    REVIEW_TARGET_PARAM,
    REVIEW_TASK_KIND,
    REVIEW_VALIDATION_RULES,
    REVIEW_VISIT_CHANNEL,
    ReviewDecision,
    ReviewDecisionError,
    review_state_key,
    review_visit_from_task,
)

_REVIEW_DESCRIPTION_LIMIT = 500


def _task_status(task: Any) -> str:
    if isinstance(task, dict):
        return str(task.get("status") or "")
    return str(getattr(task, "status", "") or "")


def _task_id(task: Any) -> str:
    if isinstance(task, dict):
        return str(task.get("id") or "")
    return str(getattr(task, "id", "") or "")


def _state_visit(runtime: WorkflowRuntime, node_id: str) -> int:
    value = runtime.state.get(review_state_key(node_id, REVIEW_VISIT_CHANNEL), 0)
    if isinstance(value, bool) or not isinstance(value, int) or value < 0:
        return 0
    return value


def _snapshot(visit: int, params: dict[str, Any], inputs: dict[str, Any]) -> dict[str, Any]:
    return {
        "kind": REVIEW_TASK_KIND,
        "visit": visit,
        "previous_rejections": max(visit - 1, 0),
        "target_node_id": params.get(REVIEW_TARGET_PARAM),
        "instructions": params.get("instructions") or "",
        REVIEW_INPUT_PORT: inputs.get(REVIEW_INPUT_PORT),
    }


async def exec_human_review(
    runtime: WorkflowRuntime,
    params: dict[str, Any],
    inputs: dict[str, Any],
) -> dict[str, Any]:
    """Suspend for an approve/reject decision and emit the routed ports."""
    context = runtime.context or {}
    node_id = str(params.get("node_id", ""))
    target_node_id = params.get(REVIEW_TARGET_PARAM)
    instructions = str(params.get("instructions") or "")
    repo = context.get("human_task_repo")
    if repo is None:
        raise WorkflowExecutionError(f"node '{node_id}': human:review requires a human_task_repo in runtime context (reviews are not supported inside subgraphs or without repository injection)")
    if not isinstance(target_node_id, str) or not target_node_id:
        raise WorkflowExecutionError(f"node '{node_id}': human:review requires a compiler-injected reject target")

    user_id = str(context.get("user_id") or "")
    run_id = str(context.get("run_id") or "")
    latest = await repo.find_by_run_and_node(run_id=run_id, node_id=node_id)

    state_visit = _state_visit(runtime, node_id)
    latest_visit = review_visit_from_task(latest) if latest is not None else 0
    latest_status = _task_status(latest) if latest is not None else ""

    if latest is not None and latest_status in ("pending", "reopened"):
        # A pending row owns the current visit.  This is the first execution
        # before the interrupt, or a retry after a checkpoint-write failure.
        task_id = _task_id(latest)
        visit = latest_visit or state_visit or 1
    elif latest is not None and state_visit < latest_visit:
        # LangGraph re-executes the review node from its head after
        # Command(resume=...).  The node had not returned its visit write yet,
        # so state still holds the *previous* visit; reuse the resolved row.
        task_id = _task_id(latest)
        visit = latest_visit
    else:
        # A new visit after a rejection (or the first visit).
        visit = max(state_visit, latest_visit) + 1
        row = await repo.create(
            user_id=user_id,
            workflow_run_id=run_id,
            node_id=node_id,
            kind=REVIEW_TASK_KIND,
            description=(instructions or f"Review output before retrying '{target_node_id}'")[:_REVIEW_DESCRIPTION_LIMIT],
            inputs_snapshot=_snapshot(visit, params, inputs),
            output_spec=REVIEW_OUTPUT_SPEC,
            validation_rules=REVIEW_VALIDATION_RULES,
            checkpoint_ref=None,
        )
        task_id = _task_id(row)

    resume = interrupt(
        {
            "type": REVIEW_TASK_KIND,
            "task_id": task_id,
            "node_id": node_id,
            "visit": visit,
            "target_node_id": target_node_id,
            "instructions": instructions,
        }
    )

    try:
        decision = ReviewDecision.from_resume(resume)
    except ReviewDecisionError as exc:
        raise WorkflowExecutionError(f"node '{node_id}': {exc}") from exc

    if decision.approved:
        return {
            REVIEW_APPROVED_PORT: inputs.get(REVIEW_INPUT_PORT),
            REVIEW_REJECTED_PORT: None,
            REVIEW_DECISION_CHANNEL: REVIEW_DECISION_APPROVED,
            REVIEW_VISIT_CHANNEL: visit,
        }
    return {
        REVIEW_APPROVED_PORT: None,
        REVIEW_REJECTED_PORT: decision.feedback,
        REVIEW_DECISION_CHANNEL: REVIEW_DECISION_REJECTED,
        REVIEW_VISIT_CHANNEL: visit,
    }


__all__ = ["exec_human_review"]
