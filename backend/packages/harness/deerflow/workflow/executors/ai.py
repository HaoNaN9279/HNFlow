"""AI-node workflow executors — currently placeholder.

Each executor follows the ``Executor`` contract:
``(runtime: WorkflowRuntime, params: dict, inputs: dict) -> dict``.
"""

from __future__ import annotations

from typing import Any

from deerflow.workflow.compiler import WorkflowRuntime
from deerflow.workflow.executors import WorkflowExecutionError

# ── ai:llm_agent ─────────────────────────────────────────────────────────────


def exec_llm_agent(runtime: WorkflowRuntime, params: dict[str, Any], inputs: dict[str, Any]) -> dict[str, Any]:
    """Placeholder — LLM agent executor not implemented yet.

    Full AI-node execution (model invocation, tool binding, sub-agent
    delegation) is planned for T6 / T10.
    """
    raise WorkflowExecutionError(
        "ai:llm_agent executor not implemented yet (planned T6). AI nodes require the full agent runtime — model resolution, system prompt assembly, tool binding, and streaming — which will be delivered in a future milestone."
    )
