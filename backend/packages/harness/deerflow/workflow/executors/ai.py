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

#: Reserved executor-result key carrying the sub-agent's aggregated token
#: usage.  ``_make_node_fn`` (workflow/compiler.py) lifts it onto a declared
#: state channel (``wf:<node_id>:__token_usage``) so it never pollutes the
#: node's declared output ports.
TOKEN_USAGE_RESULT_KEY = "__workflow_token_usage"

# ── ai:llm_agent ─────────────────────────────────────────────────────────────


def _aggregate_subagent_token_usage(records: list[dict[str, int | str | None]] | None) -> dict[str, int] | None:
    """Sum per-LLM-call usage records into one compact per-node snapshot.

    Returns ``None`` when no records were observed so the reserved
    ``__workflow_token_usage`` key stays absent from the executor output —
    callers that never saw provider usage keep the pre-observability shape.
    ``cache_read_tokens`` is included unconditionally (zero when no provider
    reported prompt-cache hits) so consumers get one stable aggregate shape.
    """
    if not records:
        return None
    totals = {"input_tokens": 0, "output_tokens": 0, "total_tokens": 0, "cache_read_tokens": 0}
    for record in records:
        for field in totals:
            try:
                totals[field] += int(record.get(field) or 0)
            except (TypeError, ValueError):
                # A malformed record field must never break node completion.
                continue
    return totals


async def exec_llm_agent(
    runtime: WorkflowRuntime,
    params: dict[str, Any],
    inputs: dict[str, Any],
) -> dict[str, Any]:
    """Execute an ``ai:llm_agent`` node through a sub-agent.

    Two modes, selected by ``inputs["continue_prompt"]``:

    **Template mode** (no / empty ``continue_prompt``) — the one-shot path:
    the system prompt is assembled from three layers — identity
    (``agent_name`` / default lead), capability (``capability_groups`` plus the
    custom agent's own skills), and task (the ``instruction`` template
    interpolated with ``inputs``) — and handed to a ``SubagentExecutor``
    (checkpointer disabled, recursion disabled).

    **Continue mode** (non-empty ``continue_prompt``) — session continuation:
    the same sub-agent runs under an independent checkpoint thread
    (``f"{thread_id}:wfai:{node_id}"``), so LangGraph appends the new turn to
    the session history.  Identity/capability layers live in the session's
    first (template) turn, so only ``build_task_layer(continue_prompt, inputs)``
    is executed as the new user input.  Requires a checkpointer in
    ``runtime.context`` (memory backends fail closed).

    In both modes the sub-agent's final text is returned on the ``out`` output
    port.
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

    continue_prompt = inputs.get("continue_prompt")
    # W2B cross-run continuation: when no ``continue_prompt`` arrives on the
    # input ports, the worker-injected ``__ai_continue`` mapping (node_id →
    # prompt) may still route THIS node through continue mode.  This is how a
    # fresh continue run reuses the original run's session checkpoint.
    if not continue_prompt:
        continue_nodes = context.get("__ai_continue")
        if isinstance(continue_nodes, dict):
            node_prompt = continue_nodes.get(node_id)
            if isinstance(node_prompt, str) and node_prompt:
                continue_prompt = node_prompt
    is_continue = bool(continue_prompt)

    # Continue mode: identity/capability are already in the session's first
    # turn, so the executed task is only the new task layer.  A missing
    # checkpointer (memory backend) or an unresolvable session key fails
    # closed — a silent one-shot fallback would break loop continuation.
    if is_continue:
        checkpointer = context.get("checkpointer")
        if checkpointer is None:
            raise WorkflowExecutionError(f"node '{node_id or 'ai:llm_agent'}': ai:llm_agent continue requires a checkpointer in runtime context (memory backend does not support session continuation)")
        if not thread_id:
            raise WorkflowExecutionError(f"node '{node_id or 'ai:llm_agent'}': ai:llm_agent continue requires a thread_id in runtime context")
        if not node_id:
            raise WorkflowExecutionError("node 'ai:llm_agent': ai:llm_agent continue requires a node_id to derive its session checkpoint thread")
        # Cross-run continue: the new run's thread differs from the original
        # run's, so the session checkpoint thread must be anchored on the
        # ORIGINAL thread id (``ai_origin_thread_id``) when one is injected.
        # Falls back to the current thread id (W1A in-loop behavior).
        checkpoint_thread_prefix = context.get("ai_origin_thread_id") or thread_id
        checkpoint_thread_id = f"{checkpoint_thread_prefix}:wfai:{node_id}"
        system_prompt: str | None = None
        task_prompt = build_task_layer(continue_prompt, inputs)
    else:
        checkpoint_thread_id = None
        # Template mode (one-shot): full three-layer prompt, no checkpointer —
        # a later continue never re-uses a stale session from an earlier loop.
        # Custom-agent skills whitelist feeds the capability layer (None = all
        # enabled, [] = disabled, a list = exactly those skills).  A missing
        # agent binding (agent_name=None) leaves the layer at "all enabled".
        agent_config = load_agent_config(agent_name, user_id=user_id) if agent_name else None
        agent_skills = agent_config.skills if agent_config is not None else None

        sections = [
            build_identity_layer(agent_name, user_id=user_id),
            build_capability_layer(capability_groups, agent_skills=agent_skills),
            build_task_layer(instruction, inputs),
        ]
        system_prompt = "\n\n".join(section for section in sections if section)
        task_prompt = system_prompt

    # Deferred imports: ``SubagentExecutor`` lives behind a lazy package export,
    # and importing it at module scope would pull the agent graph into the
    # workflow compiler's import path (a circular import).  The lazy export is
    # also the seam tests monkeypatch.
    from deerflow.subagents import SubagentExecutor
    from deerflow.subagents.config import SubagentConfig

    subagent_config = SubagentConfig(
        name=f"ai:{node_id}" if node_id else "ai:node",
        description=f"Execute AI workflow node '{node_id or '(unnamed)'}'",
        system_prompt=system_prompt,
        tools=None,
        disallowed_tools=["ask_clarification", "present_files"],
        checkpointer=is_continue,
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
    if is_continue:
        # Session coordinates: LangGraph resumes the checkpoint thread on the
        # next continue instead of replaying from scratch.
        executor_kwargs["checkpointer"] = context["checkpointer"]
        executor_kwargs["checkpoint_thread_id"] = checkpoint_thread_id
        executor_kwargs["resume_checkpoint_id"] = None

    executor = SubagentExecutor(**executor_kwargs)

    result = await executor._aexecute(task_prompt)

    # Non-completed delegation → runtime failure (compare by value so this
    # module stays free of a runtime import of the SubagentStatus enum).
    status_value = getattr(result.status, "value", None)
    if status_value != "completed":
        error_detail = getattr(result, "error", None) or status_value or "unknown"
        raise WorkflowExecutionError(f"node '{node_id or 'ai:llm_agent'}': ai:llm_agent execution failed: {error_detail}")

    output: dict[str, Any] = {"out": getattr(result, "result", None)}
    # Lift the sub-agent's aggregated token usage (input/output/total +
    # prompt-cache cache_read tokens) onto the reserved result key so the
    # compiler can expose it on a declared state channel.  Only present when
    # usage records exist — absent provider usage stays absent, not zero.
    token_usage = _aggregate_subagent_token_usage(getattr(result, "token_usage_records", None))
    if token_usage is not None:
        output[TOKEN_USAGE_RESULT_KEY] = token_usage
    return output
