"""Human-interaction workflow executors — currently placeholder.

Each executor follows the ``Executor`` contract:
``(runtime: WorkflowRuntime, params: dict, inputs: dict) -> dict``.
"""

from __future__ import annotations

from typing import Any

from deerflow.workflow.compiler import WorkflowRuntime

# ── human:task ───────────────────────────────────────────────────────────────


def exec_human_task(runtime: WorkflowRuntime, params: dict[str, Any], inputs: dict[str, Any]) -> dict[str, Any]:
    """Placeholder — human-task executor not implemented yet (planned T10)."""
    raise NotImplementedError("human:task executor not implemented yet (planned T10). Human-in-the-loop workflow nodes will be added in a future milestone.")
