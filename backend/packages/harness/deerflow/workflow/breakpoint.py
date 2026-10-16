"""Node breakpoints — the suspend half of the §25 debugging story.

§25 asks for debugging support ("节点断点、单步、回退重跑") beyond the
after-the-fact run inspector.  A breakpoint is the minimal useful primitive:
``params.breakpoint = true`` makes the node **suspend before it executes**, so
an operator can inspect the run's state, then resume to let it continue — or
skip the node.

It deliberately reuses the machinery the N10 approval gate already proved:

* the same **HumanTask row** (so the existing submit/skip tools, the
  ``/api/human-tasks`` routes, and the interrupted-run resume path all work
  unchanged — a breakpoint is just a task with nothing to approve);
* the same ``interrupt()`` suspension, and therefore the same
  ``(run_id, node_id)`` row-reuse rule: LangGraph re-executes a node from its
  head on resume, so an existing row is reused rather than minting a duplicate
  queued item;
* the same ``{"__skip": True}`` "declined to act" sentinel, which skips the
  node's outputs exactly like a skipped ``human:task``.

Two things it deliberately does **not** have: a preview (there is nothing to
verify — a breakpoint approves nothing) and a fingerprint re-check (nothing is
mutated before the pause).  That is the whole difference from the approval
gate, and it is why this lives in its own module rather than adding a branch
inside ``approval.py``.
"""

from __future__ import annotations

import logging
from typing import TYPE_CHECKING, Any

from langgraph.types import interrupt

from deerflow.workflow.registry import WorkflowExecutionError

if TYPE_CHECKING:  # pragma: no cover — typing only
    from deerflow.workflow.compiler import WorkflowRuntime

logger = logging.getLogger(__name__)

#: ``params.breakpoint`` — explicit ``True`` only (mirrors ``require_approval``).
BREAKPOINT_PARAM = "breakpoint"

#: Marker stored on the task row's ``inputs_snapshot``.
BREAKPOINT_SNAPSHOT_KIND = "breakpoint"

_DESCRIPTION_LIMIT = 500

#: What a breakpoint task asks the human for: one explicit acknowledgement.
#:
#: A port is required, not cosmetic: LangGraph treats a **falsy** ``Command(resume=...)``
#: payload as "not resumed" and re-suspends, so a breakpoint whose submission was an
#: empty dict would wedge the run forever.  Declaring one required boolean (constrained
#: by the shared ``enum`` rule, mirroring the approval task) guarantees the resume
#: payload that comes back through ``submit_human_task`` is non-empty.
BREAKPOINT_OUTPUT_SPEC: dict[str, Any] = {
    "ports": [
        {
            "name": "acknowledge",
            "type": "bool",
            "required": True,
            "description": "true to let the paused node continue",
        }
    ]
}
BREAKPOINT_VALIDATION_RULES: dict[str, Any] = {"enum": {"acknowledge": {"enum": [True]}}}


class BreakpointDecision:
    """Whether the paused node should be skipped instead of executed."""

    def __init__(self, *, skipped: bool, task_id: str | None = None) -> None:
        self.skipped = skipped
        self.task_id = task_id

    @classmethod
    def from_resume(cls, value: Any, *, task_id: str | None = None) -> BreakpointDecision:
        """Parse an ``interrupt()`` resume payload.

        Everything except the shared skip sentinel means "continue" — a
        breakpoint is not a decision, so requiring an explicit approval *here*
        would make resuming needlessly brittle.  The ``acknowledge`` port is
        what the *task* requires (see ``BREAKPOINT_OUTPUT_SPEC``); by the time a
        payload reaches the node it has already passed the shared submission
        validator, and a missing payload must not silently skip work the
        operator asked to inspect.
        """
        if isinstance(value, dict) and value.get("__skip") is True:
            return cls(skipped=True, task_id=task_id)
        return cls(skipped=False, task_id=task_id)


def breakpoint_requested(params: dict[str, Any]) -> bool:
    """Whether *params* asks for a breakpoint (explicit ``True`` only)."""
    return params.get(BREAKPOINT_PARAM) is True


def _require_repo(runtime: WorkflowRuntime, node_id: str) -> Any:
    repo = (runtime.context or {}).get("human_task_repo")
    if repo is None:
        raise WorkflowExecutionError(f"node '{node_id}': breakpoint needs a human_task_repo in runtime context (breakpoints are not supported inside subgraphs or without repository injection)")
    return repo


async def run_breakpoint(runtime: WorkflowRuntime, *, node_id: str, node_type: str) -> BreakpointDecision:
    """Create (or reuse) the breakpoint HumanTask and suspend until it resolves.

    Fails loudly without a repository: a breakpoint that cannot surface its task
    would silently run the node it was supposed to pause.
    """
    repo = _require_repo(runtime, node_id)
    context = runtime.context or {}
    user_id = str(context.get("user_id") or "")
    run_id = str(context.get("run_id") or "")

    existing = await repo.find_by_run_and_node(run_id=run_id, node_id=node_id)
    if existing is not None:
        task_id = str(existing["id"])
    else:
        row = await repo.create(
            user_id=user_id,
            workflow_run_id=run_id,
            node_id=node_id,
            kind=BREAKPOINT_SNAPSHOT_KIND,
            description=f"[breakpoint] {node_type} node '{node_id}'"[:_DESCRIPTION_LIMIT],
            inputs_snapshot={"kind": BREAKPOINT_SNAPSHOT_KIND, "node_id": node_id, "node_type": node_type},
            output_spec=BREAKPOINT_OUTPUT_SPEC,
            validation_rules=BREAKPOINT_VALIDATION_RULES,
            checkpoint_ref=None,
        )
        task_id = str(row["id"])

    resume = interrupt({"type": BREAKPOINT_SNAPSHOT_KIND, "task_id": task_id, "node_id": node_id, "node_type": node_type})
    return BreakpointDecision.from_resume(resume, task_id=task_id)


__all__ = [
    "BREAKPOINT_OUTPUT_SPEC",
    "BREAKPOINT_PARAM",
    "BREAKPOINT_SNAPSHOT_KIND",
    "BREAKPOINT_VALIDATION_RULES",
    "BreakpointDecision",
    "breakpoint_requested",
    "run_breakpoint",
]
