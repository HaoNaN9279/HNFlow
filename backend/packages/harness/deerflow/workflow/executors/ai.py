"""AI-node workflow executors.

``exec_llm_agent`` executes an ``ai:llm_agent`` node by assembling its system
prompt from identity, capability (group names, rules, skill descriptions),
examples/context/schema and task layers, then running it through a one-shot
:class:`deerflow.subagents.SubagentExecutor`.  It follows the ``Executor``
contract — ``(runtime, params, inputs) -> Awaitable[dict]`` — so the compiler's
``_resolve_executor`` awaits it like any async executor.
"""

from __future__ import annotations

import logging
from typing import Any

from deerflow.capability_groups.discovery import CapabilityGroupError
from deerflow.capability_groups.runtime import CapabilityContentError, load_capability_rules, load_capability_skills
from deerflow.config.agents_config import load_agent_config
from deerflow.config.token_budget_config import TokenBudgetConfig
from deerflow.runtime.context_keys import APP_INSTANCE_REPO_CONTEXT_KEY
from deerflow.workflow.agent_port import get_agent_adapter
from deerflow.workflow.capability_skills import build_read_capability_skill_tool
from deerflow.workflow.compiler import WorkflowRuntime
from deerflow.workflow.context_compression import ContextCompressionError, estimate_tokens, resolve_context_compression
from deerflow.workflow.model_profiles import (
    MODEL_PROFILES_CONTEXT_KEY,
    ModelProfileError,
    parse_model_profile_id,
    resolve_model_profile,
)
from deerflow.workflow.prompts import (
    BUCKET_ORDER,
    TEMPLATE_PROMPT_PORT,
    build_ai_node_buckets,
    build_task_layer,
)
from deerflow.workflow.registry import WorkflowExecutionError
from deerflow.workflow.structured_output import (
    OUTPUT_SCHEMA_PARAM,
    StructuredOutputError,
    parse_output_schema,
    schema_instruction,
)

logger = logging.getLogger(__name__)

#: Reserved executor-result key carrying the sub-agent's aggregated token
#: usage.  ``_make_node_fn`` (workflow/compiler.py) lifts it onto a declared
#: state channel (``wf:<node_id>:__token_usage``) so it never pollutes the
#: node's declared output ports.
TOKEN_USAGE_RESULT_KEY = "__workflow_token_usage"

#: Reserved executor-result key carrying the sub-agent's ``stop_reason`` when a
#: guardrail cap ended its run (N14 §24.5).  ``_make_node_fn`` lifts it onto a
#: declared/reserved state channel ``wf:<node_id>:__stop_reason``.
STOP_REASON_RESULT_KEY = "__stop_reason"

#: Reserved executor-result key: how many repair attempts a structured-output
#: node needed (N14 §24.4).  Lifted onto ``wf:<node_id>:__schema_repairs``.
SCHEMA_REPAIRS_RESULT_KEY = "__schema_repairs"

#: Reserved executor-result key carrying the full assembled prompt.  Lifted
#: onto ``wf:<node_id>:__prompt`` for ``ai:prompt_preview``.
PROMPT_RESULT_KEY = "__workflow_prompt"


def _check_subagent_completed(result: Any, node_id: Any) -> None:
    """Raise when the sub-agent did not finish cleanly (N14 §24.4 / §24.5 share this)."""
    status_value = getattr(result.status, "value", None)
    if status_value != "completed":
        error_detail = getattr(result, "error", None) or status_value or "unknown"
        raise WorkflowExecutionError(f"node '{node_id or 'ai:llm_agent'}': ai:llm_agent execution failed: {error_detail}")


async def _run_structured_output(adapter: Any, request: Any, task_prompt: str, schema: dict[str, Any], node_id: Any) -> tuple[Any, dict[str, Any]]:
    """Run the node and coerce its output into ``schema`` (N14 §24.4).

    Bounded repair loop: a parse/validation failure re-runs the agent with the
    error appended, up to ``schema['max_repairs']`` times; exhausting it fails
    the node with the last error.
    """
    from dataclasses import replace

    from deerflow.workflow.structured_output import StructuredOutputError, extract_json_object, validate_payload

    last_error: str | None = None
    for attempt in range(schema["max_repairs"] + 1):
        prompt = task_prompt
        if attempt > 0:
            prompt = f"{task_prompt}\n\nYour previous response was invalid: {last_error}\nRespond again with a single JSON object that matches the schema."
        result = await adapter.execute(replace(request, task=prompt))
        _check_subagent_completed(result, node_id)
        try:
            fields = validate_payload(extract_json_object(getattr(result, "result", None)), schema)
        except StructuredOutputError as exc:
            last_error = str(exc)
            continue
        output: dict[str, Any] = {"out": getattr(result, "result", None)}
        output.update(fields)
        output[SCHEMA_REPAIRS_RESULT_KEY] = attempt
        return result, output
    raise WorkflowExecutionError(f"node '{node_id or 'ai:llm_agent'}': structured output failed after {schema['max_repairs'] + 1} attempt(s): {last_error}")


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


def _resolve_node_tools(
    capability_groups: list[str],
    *,
    user_id: str | None,
    app_config: Any,
    instance_repo: Any = None,
    node_id: str | None = None,
) -> list[Any]:
    """Resolve the AI node's tool set from its capability groups (C1).

    Delegates to the tool gateway (N1), which maps the groups' ``allowed-tools``
    union to concrete ``BaseTool`` objects.  Fail-open: a gateway/skill-storage
    failure degrades to an empty tool set rather than failing the node (the
    three-layer prompt still executes).  ``instance_repo`` (N6) is forwarded so
    the gateway's ``app`` provider writes instance records through.
    """
    if not capability_groups:
        return []
    from deerflow.tools.registry import ToolResolutionError
    from deerflow.workflow.tool_gateway import resolve_capability_tools

    try:
        return resolve_capability_tools(capability_groups, user_id=user_id, app_config=app_config, instance_repo=instance_repo)
    except ToolResolutionError as exc:
        # An explicitly declared tool is part of the node's contract.  Silently
        # running with a smaller tool set would make configuration errors look
        # like model failures, so the node fails loudly instead.
        raise WorkflowExecutionError(f"node '{node_id or 'ai:llm_agent'}': {exc}") from exc
    except Exception as exc:
        logger.warning("ai:llm_agent failed to resolve capability-group tools", exc_info=True)
        raise WorkflowExecutionError(f"node '{node_id or 'ai:llm_agent'}': failed to resolve capability-group tools: {exc}") from exc


async def exec_llm_agent(
    runtime: WorkflowRuntime,
    params: dict[str, Any],
    inputs: dict[str, Any],
) -> dict[str, Any]:
    """Execute one ``ai:llm_agent`` node.

    The node has exactly one task source per mode: ``template_prompt`` for a
    template turn, ``continue_prompt`` for a continued session.  Output schema
    comes from a ``data:schema`` node through the compiler-injected
    ``__output_schema`` param.  Context compression is automatic and derives its
    budget from the effective model's configured ``context_window``.
    """
    node_id = params.get("node_id")
    context = runtime.context
    user_id = context.get("user_id")
    app_config = context.get("app_config")
    instance_repo = context.get(APP_INSTANCE_REPO_CONTEXT_KEY)
    thread_id = context.get("thread_id")

    raw_groups = params.get("capability_groups") or []
    capability_groups = list(dict.fromkeys(str(item) for item in raw_groups if isinstance(item, str) and item))

    continue_prompt = inputs.get("continue_prompt")
    if not continue_prompt:
        continue_nodes = context.get("__ai_continue")
        if isinstance(continue_nodes, dict):
            node_prompt = continue_nodes.get(node_id)
            if isinstance(node_prompt, str) and node_prompt:
                continue_prompt = node_prompt
    is_continue = bool(continue_prompt)

    raw_template_prompt = inputs.get(TEMPLATE_PROMPT_PORT)
    if not raw_template_prompt:
        # Legacy definitions may still carry the removed ``params.instruction``.
        # It is only a read-compatibility fallback; the editor no longer writes it.
        raw_template_prompt = params.get("instruction")
    if not is_continue:
        if not isinstance(raw_template_prompt, str) or not raw_template_prompt.strip():
            raise WorkflowExecutionError(f"node '{node_id or 'ai:llm_agent'}': ai:llm_agent requires a non-empty '{TEMPLATE_PROMPT_PORT}' input")

    try:
        output_schema = parse_output_schema(params.get(OUTPUT_SCHEMA_PARAM))
    except StructuredOutputError as exc:
        raise WorkflowExecutionError(f"node '{node_id or 'ai:llm_agent'}': invalid output_schema: {exc}") from exc
    if output_schema is not None and is_continue:
        raise WorkflowExecutionError(f"node '{node_id or 'ai:llm_agent'}': output_schema is not supported with session continuation (continue mode)")

    try:
        model_profile_id = parse_model_profile_id(params)
    except ModelProfileError as exc:
        raise WorkflowExecutionError(f"node '{node_id or 'ai:llm_agent'}': invalid model_profile: {exc}") from exc
    if model_profile_id is not None and is_continue:
        raise WorkflowExecutionError(f"node '{node_id or 'ai:llm_agent'}': model_profile is not supported with session continuation (continue mode)")

    model_names = list(getattr(app_config, "models", None) or ()) if app_config is not None else []
    if model_profile_id is not None:
        try:
            model_name = resolve_model_profile(
                model_profile_id,
                context.get(MODEL_PROFILES_CONTEXT_KEY) or {},
                model_names,
            )
        except ModelProfileError as exc:
            raise WorkflowExecutionError(f"node '{node_id or 'ai:llm_agent'}': {exc}") from exc
    elif model_names:
        model_name = str(model_names[0].name)
    else:
        model_name = "inherit"

    summary_model_name = None
    if app_config is not None:
        summary_model_name = getattr(getattr(app_config, "summarization", None), "model_name", None)
    compression = None
    if app_config is not None and model_name != "inherit":
        try:
            compression = resolve_context_compression(
                model_name,
                model_names,
                summary_model_name=summary_model_name,
            )
        except ContextCompressionError as exc:
            raise WorkflowExecutionError(f"node '{node_id or 'ai:llm_agent'}': {exc}") from exc

    session_enabled = params.get("__review_session") is True
    checkpoint_enabled = is_continue or session_enabled
    if is_continue and raw_template_prompt:
        logger.warning(
            "ai:llm_agent node %r received both continue_prompt and template_prompt; continue mode wins",
            node_id,
        )

    capability_rules: list[Any] = []
    capability_skills: list[Any] = []
    try:
        if not is_continue:
            capability_rules = load_capability_rules(capability_groups, user_id=user_id)
        capability_skills = load_capability_skills(capability_groups, user_id=user_id)
    except (CapabilityContentError, CapabilityGroupError) as exc:
        raise WorkflowExecutionError(f"node '{node_id or 'ai:llm_agent'}': {exc}") from exc

    checkpoint_thread_id: str | None = None
    if checkpoint_enabled:
        checkpointer = context.get("checkpointer")
        if checkpointer is None:
            raise WorkflowExecutionError(f"node '{node_id or 'ai:llm_agent'}': ai:llm_agent continue requires a checkpointer in runtime context (memory backend does not support session continuation)")
        if not thread_id:
            raise WorkflowExecutionError(f"node '{node_id or 'ai:llm_agent'}': ai:llm_agent continue requires a thread_id in runtime context")
        if not node_id:
            raise WorkflowExecutionError("node 'ai:llm_agent': ai:llm_agent continue requires a node_id to derive its session checkpoint thread")
        checkpoint_thread_prefix = context.get("ai_origin_thread_id") or thread_id
        checkpoint_thread_id = f"{checkpoint_thread_prefix}:wfai:{node_id}"

    if is_continue:
        system_prompt: str | None = None
        task_prompt = build_task_layer(str(continue_prompt), inputs)
    else:
        agent_config = load_agent_config(params.get("agent_name"), user_id=user_id) if params.get("agent_name") else None
        agent_skills = agent_config.skills if agent_config is not None else None
        buckets = build_ai_node_buckets(
            agent_name=params.get("agent_name"),
            capability_groups=capability_groups,
            template_prompt=str(raw_template_prompt),
            inputs=inputs,
            user_id=user_id,
            agent_skills=agent_skills,
            capability_rules=capability_rules,
            capability_skills=capability_skills,
        )
        if output_schema is not None:
            buckets["schema"] = schema_instruction(output_schema)
        task_prompt = buckets.get("task", "")
        system_prompt = "\n\n".join(buckets[name] for name in BUCKET_ORDER if name != "task" and buckets.get(name))

    preview_prompt = "\n\n".join(part for part in (system_prompt, task_prompt) if part)
    if compression is not None:
        estimated = estimate_tokens(system_prompt or "") + estimate_tokens(task_prompt)
        if estimated > compression.input_budget:
            raise WorkflowExecutionError(
                f"node '{node_id or 'ai:llm_agent'}': static prompt is ~{estimated} tokens, exceeding model '{compression.model_name}' input budget {compression.input_budget}; reduce capability rules or template_prompt"
            )

    node_tools = _resolve_node_tools(
        capability_groups,
        user_id=user_id,
        app_config=app_config,
        instance_repo=instance_repo,
        node_id=node_id,
    )
    if capability_skills:
        node_tools.append(build_read_capability_skill_tool(capability_skills))

    adapter = get_agent_adapter(runtime)
    from deerflow.workflow.agent_port import CAP_TOOLS, AgentTurnRequest, check_agent_capabilities

    required_capabilities = frozenset({CAP_TOOLS}) if node_tools else frozenset()
    try:
        check_agent_capabilities(adapter, required_capabilities)
    except ValueError as exc:
        raise WorkflowExecutionError(f"node '{node_id or 'ai:llm_agent'}': {exc}") from exc

    request = AgentTurnRequest(
        task=task_prompt,
        system_prompt=system_prompt,
        tools=node_tools,
        name=f"ai:{node_id}" if node_id else "ai:node",
        description=f"Execute AI workflow node '{node_id or '(unnamed)'}'",
        disallowed_tools=["task", "ask_clarification", "present_files"],
        checkpointer=checkpoint_enabled,
        checkpointer_instance=context.get("checkpointer") if checkpoint_enabled else None,
        allow_recursion=False,
        max_turns=50,
        token_budget=TokenBudgetConfig(enabled=False),
        model=model_name,
        delegation_depth=0,
        user_id=user_id,
        app_config=app_config,
        thread_id=thread_id,
        checkpoint_thread_id=checkpoint_thread_id,
        resume_checkpoint_id=None,
        required_capabilities=required_capabilities,
        context_compression=compression,
    )

    if output_schema is None:
        result = await adapter.execute(request)
        _check_subagent_completed(result, node_id)
        output: dict[str, Any] = {"out": getattr(result, "result", None)}
    else:
        result, output = await _run_structured_output(adapter, request, task_prompt, output_schema, node_id)
    output[PROMPT_RESULT_KEY] = preview_prompt
    token_usage = _aggregate_subagent_token_usage(getattr(result, "token_usage_records", None))
    if token_usage is not None:
        output[TOKEN_USAGE_RESULT_KEY] = token_usage
    stop_reason = getattr(result, "stop_reason", None)
    if stop_reason:
        output[STOP_REASON_RESULT_KEY] = stop_reason
    return output


def exec_prompt_preview(
    runtime: WorkflowRuntime,
    params: dict[str, Any],
    inputs: dict[str, Any],
) -> dict[str, Any]:
    """Expose the final prompt an AI node assembled (``ai:prompt_preview``).

    The AI executor publishes the full prompt on the reserved
    ``wf:<ai_node>:__prompt`` channel.  This node reads it back after the AI
    node has run (the incoming edge is ordering, not content), so a preview
    shows the real runtime prompt — including selected capability groups and
    injected memory/retrieval — rather than a stale template.
    """
    agent_node = params.get("agent_node")
    if not isinstance(agent_node, str) or not agent_node:
        raise WorkflowExecutionError(f"node '{params.get('node_id') or 'ai:prompt_preview'}': prompt preview requires an AI node id")
    prompt = runtime.state.get(f"wf:{agent_node}:__prompt")
    if prompt is None:
        # The AI node may have been skipped or replayed.  An empty preview is
        # more useful than failing an otherwise successful run.
        prompt = ""
    elif not isinstance(prompt, str):
        prompt = str(prompt)
    return {"prompt": prompt, "out": prompt}
