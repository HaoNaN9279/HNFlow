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
from deerflow.runtime.context_keys import APP_INSTANCE_REPO_CONTEXT_KEY
from deerflow.workflow.agent_port import get_agent_adapter
from deerflow.workflow.capability_skills import build_read_capability_skill_tool
from deerflow.workflow.compiler import WorkflowRuntime
from deerflow.workflow.context_policy import BUCKET_ORDER, CONTEXT_USAGE_RESULT_KEY, ContextPolicyError, apply_context_budget, parse_context_policy
from deerflow.workflow.knowledge import (
    KNOWLEDGE_STORE_CONTEXT_KEY,
    KnowledgeError,
    aquery,
    format_retrieval_block,
    parse_retrieval_params,
)
from deerflow.workflow.knowledge import render_query as render_retrieval_query
from deerflow.workflow.memory import (
    MEMORY_STORE_CONTEXT_KEY,
    MemoryPolicyError,
    acollect_memory,
    awrite_memory,
    format_memory_block,
    output_text,
    parse_memory_policy,
    render_query,
)
from deerflow.workflow.prompts import (
    TEMPLATE_PROMPT_PORT,
    append_template_prompt,
    build_ai_node_buckets,
    build_task_layer,
    build_template_prompt_layer,
)
from deerflow.workflow.registry import WorkflowExecutionError
from deerflow.workflow.routing import RoutingError, model_infos, parse_routing_policy, select_model

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


def _autonomy_settings(params: dict[str, Any]) -> tuple[int, Any]:
    """Resolve ``(max_turns, token_budget)`` from ``params.autonomy`` (N14 §24.5).

    ``template`` (or absent ``autonomy``) keeps the pre-§24.5 defaults:
    ``(50, None)`` — the ``SubagentConfig`` defaults.  ``bounded`` reads
    ``budgets.max_turns`` (default 50) and, when ``budgets.max_tokens`` is set, a
    ``TokenBudgetConfig`` override for this node's run.
    """
    autonomy = params.get("autonomy") or {}
    budgets = autonomy.get("budgets") or {}
    max_turns = int(budgets.get("max_turns", 50))
    token_budget = None
    if budgets.get("max_tokens") is not None:
        from deerflow.config.token_budget_config import TokenBudgetConfig

        token_budget = TokenBudgetConfig(enabled=True, max_tokens=int(budgets["max_tokens"]))
    return max_turns, token_budget


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
    """Execute an ``ai:llm_agent`` node through a sub-agent.

    Two modes, selected by ``inputs["continue_prompt"]``:

    **Template mode** (no / empty ``continue_prompt``) — the one-shot path:
    the system prompt is assembled from identity (``agent_name`` / default
    lead), capability (``capability_groups``, their rules, skill descriptions,
    and the custom agent's own skills), and task (the ``instruction`` template
    plus an optional runtime ``template_prompt``) — and handed to a
    ``SubagentExecutor`` (checkpointer disabled, recursion disabled).

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

    raw_template_prompt = inputs.get(TEMPLATE_PROMPT_PORT)
    if raw_template_prompt is not None and not isinstance(raw_template_prompt, str):
        raise WorkflowExecutionError(f"node '{node_id or 'ai:llm_agent'}': '{TEMPLATE_PROMPT_PORT}' input must be a string")
    template_prompt = raw_template_prompt or ""

    agent_name = params.get("agent_name")
    raw_groups = params.get("capability_groups") or []
    capability_groups = list(dict.fromkeys(str(item) for item in raw_groups if isinstance(item, str) and item))

    context = runtime.context
    user_id = context.get("user_id")
    app_config = context.get("app_config")
    instance_repo = context.get(APP_INSTANCE_REPO_CONTEXT_KEY)
    thread_id = context.get("thread_id")
    delegation_depth = context.get("delegation_depth", 0)
    memory_store = context.get(MEMORY_STORE_CONTEXT_KEY)
    knowledge_store = context.get(KNOWLEDGE_STORE_CONTEXT_KEY)

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
    if is_continue and template_prompt:
        logger.warning(
            "ai:llm_agent node %r received both continue_prompt and template_prompt; continue mode wins",
            node_id,
        )

    capability_rules: list[Any] = []
    capability_skills: list[Any] = []
    try:
        if not is_continue:
            capability_rules = load_capability_rules(capability_groups, user_id=user_id)
        # Continue mode does not re-assemble the system prompt, but it must still
        # expose the scoped reader so the model can load skill bodies on demand.
        capability_skills = load_capability_skills(capability_groups, user_id=user_id)
    except (CapabilityContentError, CapabilityGroupError) as exc:
        raise WorkflowExecutionError(f"node '{node_id or 'ai:llm_agent'}': {exc}") from exc

    # N14 §24.4 structured output: normalize the node's output contract up front
    # so a malformed schema fails loudly, and reject the unsupported combo with
    # session continuation.
    from deerflow.workflow.structured_output import (
        StructuredOutputError,
        parse_output_schema,
        schema_instruction,
    )

    try:
        output_schema = parse_output_schema(params)
    except StructuredOutputError as exc:
        raise WorkflowExecutionError(f"node '{node_id or 'ai:llm_agent'}': invalid output_schema: {exc}") from exc
    if output_schema is not None and is_continue:
        raise WorkflowExecutionError(f"node '{node_id or 'ai:llm_agent'}': output_schema is not supported with session continuation (continue mode)")

    # N14 §24.3 context policy: same fail-loud normalization as output_schema so a
    # malformed policy never silently no-ops.  Rejected with session continuation
    # for the same reason as output_schema — identity/capability/examples are
    # frozen in the session's first turn, so mounting them again would duplicate
    # them rather than augment the prompt.
    try:
        context_policy = parse_context_policy(params)
    except ContextPolicyError as exc:
        raise WorkflowExecutionError(f"node '{node_id or 'ai:llm_agent'}': invalid context_policy: {exc}") from exc
    if context_policy is not None and is_continue:
        raise WorkflowExecutionError(f"node '{node_id or 'ai:llm_agent'}': context_policy is not supported with session continuation (continue mode)")
    context_usage: dict[str, Any] | None = None

    # N14 §24.10 model routing: a node can prefer a local / cheap / high-quality
    # model.  Rejected with session continuation — the session was created under
    # one model, and switching mid-session would not reproduce deterministically.
    try:
        routing_policy = parse_routing_policy(params)
    except RoutingError as exc:
        raise WorkflowExecutionError(f"node '{node_id or 'ai:llm_agent'}': invalid model_policy: {exc}") from exc
    if routing_policy is not None and is_continue:
        raise WorkflowExecutionError(f"node '{node_id or 'ai:llm_agent'}': model_policy is not supported with session continuation (continue mode)")

    # N14 §24.1 node-level memory: same fail-loud parse; rejected with session
    # continuation (identity/capability/memory are frozen in the first turn).
    try:
        memory_policy = parse_memory_policy(params)
    except MemoryPolicyError as exc:
        raise WorkflowExecutionError(f"node '{node_id or 'ai:llm_agent'}': invalid memory: {exc}") from exc
    if memory_policy is not None and is_continue:
        raise WorkflowExecutionError(f"node '{node_id or 'ai:llm_agent'}': memory is not supported with session continuation (continue mode)")

    # N14 §24.2 knowledge retrieval: same fail-loud parse; rejected with continue.
    try:
        retrieval_policy = parse_retrieval_params(params)
    except KnowledgeError as exc:
        raise WorkflowExecutionError(f"node '{node_id or 'ai:llm_agent'}': invalid retrieval: {exc}") from exc
    if retrieval_policy is not None and is_continue:
        raise WorkflowExecutionError(f"node '{node_id or 'ai:llm_agent'}': retrieval is not supported with session continuation (continue mode)")

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

        # N14 §24.3: build the named buckets in the fixed order, then apply the
        # node's context budget.  The structured-output schema instruction is the
        # last bucket, so it is part of the non-truncatable scaffold.
        buckets = build_ai_node_buckets(
            agent_name=agent_name,
            capability_groups=capability_groups,
            instruction=instruction,
            inputs=inputs,
            user_id=user_id,
            agent_skills=agent_skills,
            policy=context_policy,
            capability_rules=capability_rules,
            capability_skills=capability_skills,
        )
        if output_schema is not None:
            buckets["schema"] = schema_instruction(output_schema)
        budget_result = apply_context_budget(buckets, context_policy.budget if context_policy else None)
        # The task bucket is the *user turn*; everything else is system context.
        # Sending the full assembled prompt as both the system message and the
        # HumanMessage duplicated every instruction (and doubled token cost).
        task_prompt = budget_result.buckets.get("task", "")
        system_prompt = "\n\n".join(budget_result.buckets[name] for name in BUCKET_ORDER if name != "task" and budget_result.buckets.get(name))
        if context_policy is not None:
            context_usage = budget_result.to_payload()

        # N14 §24.1: prepend the node's memory as a budgeted ``<memory>`` block.
        # A read failure degrades to no memory rather than failing the node (the
        # §24.1 "write/read failure does not block the main flow" rule).
        if memory_policy is not None and memory_store is not None:
            query = render_query(memory_policy.query, inputs, default=instruction)
            try:
                records = await acollect_memory(memory_store, memory_policy, query=query)
            except Exception:
                logger.warning("ai:llm_agent memory read failed; continuing without memory", exc_info=True)
                records = []
            block = format_memory_block(records, budget=memory_policy.inject_budget)
            if block:
                system_prompt = f"{block}\n\n{system_prompt}"

        # N14 §24.2: prepend retrieved knowledge (with citations) as a budgeted
        # ``<context>`` block.  A retrieval failure degrades to no context rather
        # than failing the node.
        if retrieval_policy is not None and knowledge_store is not None:
            rquery = render_retrieval_query(retrieval_policy.query, inputs, default=instruction)
            try:
                records = await aquery(knowledge_store, retrieval_policy, query=rquery)
            except Exception:
                logger.warning("ai:llm_agent knowledge retrieval failed; continuing without retrieval", exc_info=True)
                records = []
            block = format_retrieval_block(records, budget=retrieval_policy.ctx_budget)
            if block:
                system_prompt = f"{block}\n\n{system_prompt}"

    # Template mode may receive a runtime user turn from the dedicated
    # ``template_prompt`` input port.  Continue mode owns the user turn via
    # ``continue_prompt``; template_prompt is ignored there (continue wins).
    if not is_continue:
        task_prompt = append_template_prompt(task_prompt, build_template_prompt_layer(template_prompt, inputs))

    # Full text prompt the node actually sends: every system bucket (identity /
    # capability / examples / context / schema / memory / retrieval) plus the
    # task turn.  ``ai:prompt_preview`` reads this from the reserved channel.
    preview_prompt = "\n\n".join(part for part in (system_prompt, task_prompt) if part)

    # C1: assemble the node's real tool set from its capability groups' union of
    # ``allowed-tools`` (through the N1 tool gateway) instead of an empty list.
    node_tools = _resolve_node_tools(capability_groups, user_id=user_id, app_config=app_config, instance_repo=instance_repo, node_id=node_id)
    if capability_skills:
        node_tools.append(build_read_capability_skill_tool(capability_skills))

    # N14 §24.5: an explicit autonomy budget pins this node's hard limits.
    autonomy_max_turns, autonomy_token_budget = _autonomy_settings(params)

    # N14 §24.10: resolve the node's model from its routing policy against the
    # configured model metadata.  A privacy constraint that cannot be met (a
    # required local model that is not configured) fails the node loudly; it must
    # never silently fall back to a remote model.
    model_name = "inherit"
    if routing_policy is not None:
        try:
            selected_model = select_model(model_infos(getattr(app_config, "models", None)), routing_policy)
        except RoutingError as exc:
            raise WorkflowExecutionError(f"node '{node_id or 'ai:llm_agent'}': {exc}") from exc
        if selected_model is None:
            raise WorkflowExecutionError(f"node '{node_id or 'ai:llm_agent'}': model_policy is set but no models are configured")
        model_name = selected_model.name

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
        disallowed_tools=["ask_clarification", "present_files"],
        checkpointer=is_continue,
        checkpointer_instance=context.get("checkpointer") if is_continue else None,
        allow_recursion=False,
        max_turns=autonomy_max_turns,
        token_budget=autonomy_token_budget,
        model=model_name,
        delegation_depth=delegation_depth,
        user_id=user_id,
        app_config=app_config,
        thread_id=thread_id,
        checkpoint_thread_id=checkpoint_thread_id,
        resume_checkpoint_id=None,
        required_capabilities=required_capabilities,
    )

    if output_schema is None:
        result = await adapter.execute(request)
        _check_subagent_completed(result, node_id)
        output: dict[str, Any] = {"out": getattr(result, "result", None)}
    else:
        result, output = await _run_structured_output(adapter, request, task_prompt, output_schema, node_id)
    output[PROMPT_RESULT_KEY] = preview_prompt
    # Lift the sub-agent's aggregated token usage (input/output/total +
    # prompt-cache cache_read tokens) onto the reserved result key so the
    # compiler can expose it on a declared state channel.  Only present when
    # usage records exist — absent provider usage stays absent, not zero.
    token_usage = _aggregate_subagent_token_usage(getattr(result, "token_usage_records", None))
    if token_usage is not None:
        output[TOKEN_USAGE_RESULT_KEY] = token_usage
    # N14 §24.5: surface which guardrail cap (if any) ended the run so the node
    # is observable as capped rather than silently "completed".
    stop_reason = getattr(result, "stop_reason", None)
    if stop_reason:
        output[STOP_REASON_RESULT_KEY] = stop_reason
    # N14 §24.3: per-bucket context usage (estimates + what the budget dropped).
    # Only present when the node declared a context_policy — an untouched node
    # keeps the pre-§24.3 output shape (absent, never zero).
    if context_usage is not None:
        output[CONTEXT_USAGE_RESULT_KEY] = context_usage
    # N14 §24.1: write the node's output back into memory when declared.  A write
    # failure is logged and swallowed — it must never fail a successful node.
    if memory_policy is not None and memory_policy.write and memory_store is not None:
        try:
            await awrite_memory(memory_store, scope=memory_policy.write_scope, text=output_text(output), key=node_id)
        except Exception:
            logger.warning("ai:llm_agent memory write failed", exc_info=True)
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
