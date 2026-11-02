"""Human-interaction workflow executors.

``exec_human_task`` executes a ``human:task`` node by creating a pending
HumanTask via the injected repository and suspending the graph with LangGraph
``interrupt()``.  On resume (``Command(resume=...)``) it returns the submitted
values keyed by the node's declared output ports.

Each executor follows the ``Executor`` contract:
``(runtime: WorkflowRuntime, params: dict, inputs: dict) -> dict``.
"""

from __future__ import annotations

from typing import Any

from langgraph.types import interrupt

from deerflow.workflow.compiler import WorkflowRuntime
from deerflow.workflow.registry import WorkflowExecutionError

# ── human:task ───────────────────────────────────────────────────────────────


async def exec_human_task(
    runtime: WorkflowRuntime,
    params: dict[str, Any],
    inputs: dict[str, Any],
) -> dict[str, Any]:
    """Execute a ``human:task`` node.

    Flow:

    1. Resolve ``node_id`` / ``description`` / ``validation_rules`` /
       ``output_spec`` from ``params`` (the compiler injects ``node_id`` and
       ``output_spec`` for ``HUMAN_TASK`` nodes).
    2. Require a ``human_task_repo`` in ``runtime.context``.  Subgraphs compile
       with ``checkpointer=None`` where ``interrupt()`` cannot suspend, so a
       missing repository degrades to an explicit error instead of a silent
       half-state.
     3. Create a pending HumanTask (``checkpoint_ref=None`` — the T13-2 worker
        backfills it after detecting the suspension).
     4. Suspend via :func:`langgraph.types.interrupt`.  On the first execution
        this raises ``GraphInterrupt``; on resume it returns the submitted value
        (a plain dict — ``interrupt`` is synchronous, do not ``await`` it).
     5. Parse the resume value: ``{"__skip": True}`` skips (no output ports);
        otherwise return only the node's declared output ports.

    Idempotency (T13-4): LangGraph re-executes this node from its head when the
    graph is resumed with ``Command(resume=...)``.  ``create`` is therefore
    guarded by :meth:`find_by_run_and_node` so the re-execution reuses the
    already-created task instead of minting a duplicate pending row.  The latest
    row for ``(run_id, node_id)`` wins regardless of status — the re-execution
    happens after the original task was already submitted/skipped.
    """
    context = runtime.context or {}

    node_id = str(params.get("node_id", ""))
    description = str(params.get("description") or "")
    validation_rules = params.get("validation_rules") or {}
    output_spec = params.get("output_spec") or {}

    # 1. Repository is mandatory (subgraph / no-injection → clear degradation).
    repo = context.get("human_task_repo")
    if repo is None:
        raise WorkflowExecutionError(f"node '{node_id}': human task requires a human_task_repo in runtime context (human:task not supported inside subgraphs or without repository injection)")

    user_id = context.get("user_id") or ""
    run_id = context.get("run_id") or ""

    # 2. Create (or reuse) the pending HumanTask.
    #    Idempotency: on Command(resume=...) LangGraph re-runs this node from the
    #    top, so a prior create for the same run+node must be reused — otherwise
    #    each resume leaks a duplicate, never-resumable pending row.
    existing = await repo.find_by_run_and_node(run_id=run_id, node_id=node_id)
    if existing is not None:
        task_id = existing["id"]
    else:
        row = await repo.create(
            user_id=user_id,
            workflow_run_id=run_id,
            node_id=node_id,
            description=description,
            inputs_snapshot=inputs,
            output_spec=output_spec,
            validation_rules=validation_rules,
            checkpoint_ref=None,
        )
        task_id = row["id"]

    # 3. Suspend the graph.  On resume, interrupt() returns the resume value.
    resume = interrupt(
        {
            "type": "human_task",
            "task_id": task_id,
            "node_id": node_id,
            "description": description,
        }
    )

    # 4. Parse the resume value.
    if isinstance(resume, dict) and resume.get("__skip") is True:
        return {}

    if not isinstance(resume, dict):
        resume = {}

    declared = {port["name"] for port in (output_spec.get("ports") or []) if isinstance(port, dict) and isinstance(port.get("name"), str)}
    return {name: value for name, value in resume.items() if name in declared}
