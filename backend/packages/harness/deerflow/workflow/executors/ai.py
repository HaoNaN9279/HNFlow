"""AI-node workflow executors.

``exec_llm_agent`` executes an ``ai:llm_agent`` node by assembling its system
prompt from three layers (identity / capability / task) and running it through
a one-shot :class:`deerflow.subagents.SubagentExecutor`.  It follows the
``Executor`` contract — ``(runtime, params, inputs) -> Awaitable[dict]`` — so
the compiler's ``_resolve_executor`` awaits it like any async executor.
"""

from __future__ import annotations

from typing import Any

from deerflow.config.agents_config import load_agent_config
from deerflow.workflow.compiler import WorkflowRuntime
from deerflow.workflow.prompts import build_capability_layer, build_identity_layer, build_task_layer
from deerflow.workflow.registry import WorkflowExecutionError

# ── ai:llm_agent ─────────────────────────────────────────────────────────────


async def exec_llm_agent(
    runtime: WorkflowRuntime,
    params: dict[str, Any],
    inputs: dict[str, Any],
) -> dict[str, Any]:
    """Execute an ``ai:llm_agent`` node through a one-shot sub-agent.

    The node's system prompt is assembled from three layers — identity
    (``agent_name`` / default lead), capability (``capability_groups`` plus the
    custom agent's own skills), and task (the ``instruction`` template
    interpolated with ``inputs``).  The assembled prompt is handed to a
    ``SubagentExecutor`` (checkpointer disabled, recursion disabled); the
    sub-agent's final text is returned on the ``out`` output port.
    """
    instruction = params.get("instruction")
    node_id = params.get("node_id")
    if not instruction:
        raise WorkflowExecutionError(f"node '{node_id or 'ai:llm_agent'}': ai:llm_agent requires a non-empty 'instruction' param")

    agent_name = params.get("agent_name")
    capability_groups = params.get("capability_groups") or []

    context = runtime.context
    user_id = context.get("user_id")
    app_config = context.get("app_config")
    thread_id = context.get("thread_id")
    delegation_depth = context.get("delegation_depth", 0)

    # Custom-agent skills whitelist feeds the capability layer (None = all
    # enabled, [] = disabled, a list = exactly those skills).  A missing agent
    # binding (agent_name=None) leaves the layer at "all enabled".
    agent_config = load_agent_config(agent_name, user_id=user_id) if agent_name else None
    agent_skills = agent_config.skills if agent_config is not None else None

    sections = [
        build_identity_layer(agent_name, user_id=user_id),
        build_capability_layer(capability_groups, agent_skills=agent_skills),
        build_task_layer(instruction, inputs),
    ]
    prompt = "\n\n".join(section for section in sections if section)

    # Deferred imports: ``SubagentExecutor`` lives behind a lazy package export,
    # and importing it at module scope would pull the agent graph into the
    # workflow compiler's import path (a circular import).  The lazy export is
    # also the seam tests monkeypatch.
    from deerflow.subagents import SubagentExecutor
    from deerflow.subagents.config import SubagentConfig

    subagent_config = SubagentConfig(
        name=f"ai:{node_id}" if node_id else "ai:node",
        description=f"Execute AI workflow node '{node_id or '(unnamed)'}'",
        system_prompt=prompt,
        tools=None,
        disallowed_tools=["ask_clarification", "present_files"],
        checkpointer=False,
        allow_recursion=False,
    )

    executor_kwargs: dict[str, Any] = {
        "config": subagent_config,
        "tools": [],
        "delegation_depth": delegation_depth,
    }
    if user_id is not None:
        executor_kwargs["user_id"] = user_id
    if app_config is not None:
        executor_kwargs["app_config"] = app_config
    if thread_id is not None:
        executor_kwargs["thread_id"] = thread_id

    executor = SubagentExecutor(**executor_kwargs)

    result = await executor._aexecute(prompt)

    # Non-completed delegation → runtime failure (compare by value so this
    # module stays free of a runtime import of the SubagentStatus enum).
    status_value = getattr(result.status, "value", None)
    if status_value != "completed":
        error_detail = getattr(result, "error", None) or status_value or "unknown"
        raise WorkflowExecutionError(f"node '{node_id or 'ai:llm_agent'}': ai:llm_agent execution failed: {error_detail}")

    return {"out": getattr(result, "result", None)}
