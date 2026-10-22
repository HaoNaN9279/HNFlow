"""Run-level single-step debugging.

Single-step is a *run-level* switch, not a node parameter: with it on, every
node suspends before it executes so an operator can advance the graph one node
at a time.  It reuses the same HumanTask row and ``interrupt()`` machinery as
``human:task`` / ``human:review``; the task kind is :data:`STEP_SNAPSHOT_KIND`,
which is how a resume run knows to keep stepping.

There is no static per-node breakpoint: the engine only pauses when the run was
started in single-step mode.
"""

from __future__ import annotations

from typing import TYPE_CHECKING, Any

from langgraph.types import interrupt

from deerflow.workflow.registry import WorkflowExecutionError

if TYPE_CHECKING:  # pragma: no cover - typing only
    from deerflow.workflow.compiler import WorkflowRuntime

#: Marker stored on the task row's ``inputs_snapshot``.
STEP_SNAPSHOT_KIND = "step"

#: Runtime-context key carrying the run-level single-step switch.
DEBUG_STEP_CONTEXT_KEY = "debug_step"

_DESCRIPTION_LIMIT = 500

#: A step pause asks the human for one explicit acknowledgement.
#:
#: A port is required, not cosmetic: LangGraph treats a **falsy**
#: ``Command(resume=...)`` payload as "not resumed" and re-suspends, so an
#: empty submission would wedge the run forever.
STEP_OUTPUT_SPEC: dict[str, Any] = {
    "ports": [
        {
            "name": "acknowledge",
            "type": "bool",
            "required": True,
            "description": "true to advance the stepped run by one node",
        }
    ]
}
STEP_VALIDATION_RULES: dict[str, Any] = {"enum": {"acknowledge": {"enum": [True]}}}


class StepDecision:
    """Whether the stepped node should be skipped instead of executed."""

    def __init__(self, *, skipped: bool, task_id: str | None = None) -> None:
        self.skipped = skipped
        self.task_id = task_id

    @classmethod
    def from_resume(cls, value: Any, *, task_id: str | None = None) -> StepDecision:
        """Parse an ``interrupt()`` resume payload.

        Everything except the shared skip sentinel means "continue"; the
        ``acknowledge`` port is what the task requires.
        """
        if isinstance(value, dict) and value.get("__skip") is True:
            return cls(skipped=True, task_id=task_id)
        return cls(skipped=False, task_id=task_id)


def step_mode_requested(context: Any) -> bool:
    """Whether this run is single-stepping (explicit ``True`` only)."""
    if not isinstance(context, dict):
        return False
    return context.get(DEBUG_STEP_CONTEXT_KEY) is True


def _require_repo(runtime: WorkflowRuntime, node_id: str) -> Any:
    repo = (runtime.context or {}).get("human_task_repo")
    if repo is None:
        raise WorkflowExecutionError(f"node '{node_id}': single-step needs a human_task_repo in runtime context (stepping is not supported inside subgraphs or without repository injection)")
    return repo


async def run_step_pause(runtime: WorkflowRuntime, *, node_id: str, node_type: str) -> StepDecision:
    """Create (or reuse) the step HumanTask and suspend until it resolves.

    Fails loudly without a repository: a pause that cannot surface its task
    would silently run the node it was supposed to stop.
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
            kind=STEP_SNAPSHOT_KIND,
            description=f"[{STEP_SNAPSHOT_KIND}] {node_type} node '{node_id}'"[:_DESCRIPTION_LIMIT],
            inputs_snapshot={"kind": STEP_SNAPSHOT_KIND, "node_id": node_id, "node_type": node_type},
            output_spec=STEP_OUTPUT_SPEC,
            validation_rules=STEP_VALIDATION_RULES,
            checkpoint_ref=None,
        )
        task_id = str(row["id"])

    resume = interrupt({"type": STEP_SNAPSHOT_KIND, "task_id": task_id, "node_id": node_id, "node_type": node_type})
    return StepDecision.from_resume(resume, task_id=task_id)


__all__ = [
    "DEBUG_STEP_CONTEXT_KEY",
    "STEP_OUTPUT_SPEC",
    "STEP_SNAPSHOT_KIND",
    "STEP_VALIDATION_RULES",
    "StepDecision",
    "run_step_pause",
    "step_mode_requested",
]
