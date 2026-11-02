"""Human review node contract — pure decision/task shapes.

A ``human:review`` node suspends the graph, asks the user to approve or reject
the value on its ``in`` port, and routes the result:

- ``approved`` carries the reviewed value forward;
- ``rejected`` carries the reviewer's feedback back to the configured
  ``ai:llm_agent`` retry target's ``continue_prompt`` port.

This module deliberately has no I/O and no LangGraph dependency so the
compiler, executor, API routes and tests share one contract.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any

#: Task kind stored on ``human_tasks.kind``.
REVIEW_TASK_KIND = "review"

#: Node ports.
REVIEW_INPUT_PORT = "in"
REVIEW_APPROVED_PORT = "approved"
REVIEW_REJECTED_PORT = "rejected"
REVIEW_DECISION_PORT = "decision"
REVIEW_FEEDBACK_PORT = "feedback"

#: Reserved state channels.  ``__review_decision`` is the routing truth (never
#: a declared output); ``__review_visit`` makes the next visit of the same node
#: in one run distinct without a schema migration — the task row's
#: ``inputs_snapshot.visit`` is the durable per-visit identity.
REVIEW_DECISION_CHANNEL = "__review_decision"
REVIEW_VISIT_CHANNEL = "__review_visit"

REVIEW_DECISION_APPROVED = "approved"
REVIEW_DECISION_REJECTED = "rejected"

#: Compiler-injected retry target (the ``rejected`` edge's target node id).
REVIEW_TARGET_PARAM = "reject_target"

#: What the human submits.  ``decision`` is required; ``feedback`` is optional
#: and only meaningful for a rejection.
REVIEW_OUTPUT_SPEC: dict[str, Any] = {
    "ports": [
        {
            "name": REVIEW_DECISION_PORT,
            "type": "bool",
            "required": True,
            "description": "true to approve, false to reject",
        },
        {
            "name": REVIEW_FEEDBACK_PORT,
            "type": "data",
            "required": False,
            "description": "Optional prompt for the LLM Agent continue retry",
        },
    ]
}
REVIEW_VALIDATION_RULES: dict[str, Any] = {"enum": {REVIEW_DECISION_PORT: {"enum": [True, False]}}}

#: Used when a rejection carries no usable feedback.  It must be non-empty:
#: the AI retry target selects continue mode from a non-empty
#: ``continue_prompt`` and silently falling back to template mode would lose
#: the prior session the reviewer just judged.
DEFAULT_REJECT_FEEDBACK = "The previous result was rejected. Revise it based on the reviewer's feedback and produce the corrected result."


class ReviewDecisionError(ValueError):
    """A review resume payload that cannot be interpreted as a decision."""


@dataclass(frozen=True)
class ReviewDecision:
    """The human's approve/reject decision for one review visit."""

    approved: bool
    feedback: str = ""

    @classmethod
    def from_resume(cls, value: Any) -> ReviewDecision:
        """Parse ``{"decision": bool, "feedback": str}``.

        ``{"__skip": True}`` is not a valid review decision: a review has no
        skip path, and silently treating skip as approval or rejection would
        let a caller bypass the explicit choice.  Malformed payloads fail loudly
        for the same reason.
        """
        if not isinstance(value, dict):
            raise ReviewDecisionError("review resume payload must be an object with a boolean 'decision'")
        if value.get("__skip") is True:
            raise ReviewDecisionError("review tasks cannot be skipped; submit approve or reject")
        decision = value.get(REVIEW_DECISION_PORT)
        if not isinstance(decision, bool):
            raise ReviewDecisionError("review resume payload requires a boolean 'decision'")
        raw_feedback = value.get(REVIEW_FEEDBACK_PORT)
        feedback = raw_feedback.strip() if isinstance(raw_feedback, str) else ""
        if not decision and not feedback:
            feedback = DEFAULT_REJECT_FEEDBACK
        return cls(approved=decision, feedback=feedback)


def review_state_key(node_id: str, channel: str) -> str:
    """Return the reserved state key for a review node channel."""
    return f"wf:{node_id}:{channel}"


def review_visit_from_task(task: Any) -> int:
    """Read the visit number from a human-task row (or dict), defaulting to 0.

    Review tasks carry their visit in ``inputs_snapshot.visit`` so no database
    column or migration is needed.  An unreadable value is treated as 0; the
    executor only uses it to decide whether a row belongs to the current visit.
    """
    snapshot = task.get("inputs_snapshot") if isinstance(task, dict) else getattr(task, "inputs_snapshot", None)
    if not isinstance(snapshot, dict):
        return 0
    visit = snapshot.get("visit")
    if isinstance(visit, bool) or not isinstance(visit, int) or visit < 1:
        return 0
    return visit


__all__ = [
    "DEFAULT_REJECT_FEEDBACK",
    "REVIEW_APPROVED_PORT",
    "REVIEW_DECISION_APPROVED",
    "REVIEW_DECISION_CHANNEL",
    "REVIEW_DECISION_PORT",
    "REVIEW_DECISION_REJECTED",
    "REVIEW_FEEDBACK_PORT",
    "REVIEW_INPUT_PORT",
    "REVIEW_OUTPUT_SPEC",
    "REVIEW_REJECTED_PORT",
    "REVIEW_TARGET_PARAM",
    "REVIEW_TASK_KIND",
    "REVIEW_VALIDATION_RULES",
    "REVIEW_VISIT_CHANNEL",
    "ReviewDecision",
    "ReviewDecisionError",
    "review_state_key",
    "review_visit_from_task",
]
