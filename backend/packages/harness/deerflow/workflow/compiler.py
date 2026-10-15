"""Workflow definition → LangGraph CompiledStateGraph compiler.

Compiles a validated ``WorkflowDefinition`` into a runnable LangGraph
``CompiledStateGraph``.  Depends only on ``deerflow.workflow.schema``,
``deerflow.workflow.workflow_io``, ``langgraph``, and stdlib — zero
app-layer dependency.

Key constraints:
- The dynamic ``TypedDict`` state schema MUST declare every output-port
  key (``wf:<node_id>:<port_name>``) because LangGraph silently drops
  writes to undeclared fields.
- ``flow:start`` / ``flow:end`` nodes are mapped to LangGraph ``START`` /
  ``END`` sentinels.
- ``flow:if`` / ``flow:switch`` conditional edges are compiled into
  ``add_conditional_edges`` with a route function that reads output
  ports from state and falls back to a mandatory default edge.
- ``flow:loop`` compiles to a counting executor with conditional back-edge
  to body entry + default exit edge.  State schema declares
  ``wf:<loop_id>:__count`` so LangGraph persists the iteration counter.
  C5 (正宗版) additionally aggregates each round's body output into the
  ``results`` output port (and ``last`` = the newest one) when the node
  declares them, and supports an optional data-driven early exit through
  ``params.continue_on`` (names a source-port on an incoming edge; a falsy
  value there exits the loop, bounded by ``iterations``).
- ``flow:parallel`` compiles to a pass-through node — multiple regular
  out edges produce LangGraph native fan-out parallelism.
- ``flow:try`` compiles natively (no executor): it expands ``params.subworkflow``
  (inline/template) as a child graph via the ``nested:subworkflow`` machinery,
  catches the body's failure (except LangGraph control-flow signals such as
  ``GraphInterrupt``), and writes ``error`` / ``error_message`` / ``error_type``
  so a downstream ``flow:if`` can route to a catch branch.  Optional
  ``params.finally_subworkflow`` runs in a ``finally`` block; ``on_error="fail"``
  restores abort-the-run behavior.
- Compile cache keys combine the definition hash *and* the set of
  registered ``NodeType`` values from ``CompileContext.executors``.
  Two calls with the same definition but different executor sets
  produce different compiled graphs.  The fingerprint is
  intentionally coarse (``NodeType`` set only, not per-executor
  identity) because callables cannot be reliably hashed and the
  T5 registry semantics map ``NodeType`` → executor globally.
"""

from __future__ import annotations

import asyncio
import copy
import hashlib
import inspect
import json
import logging
import re
import threading
from collections.abc import Awaitable, Callable
from dataclasses import dataclass, field
from typing import Annotated, Any, cast

from langgraph.config import get_config  # type: ignore[import-untyped]
from langgraph.errors import GraphBubbleUp, GraphInterrupt, GraphRecursionError
from langgraph.graph import END, START, StateGraph
from langgraph.graph.state import CompiledStateGraph

from deerflow.workflow.budgets import (
    ON_EXCEED_ABORT,
    RunBudget,
    aggregate_token_usage,
    evaluate_budget,
    parse_run_budget,
    usage_total,
)
from deerflow.workflow.budgets import BudgetError as _BudgetError
from deerflow.workflow.context_policy import CONTEXT_USAGE_RESULT_KEY
from deerflow.workflow.failure_taxonomy import classify_failure
from deerflow.workflow.preview import Previewer
from deerflow.workflow.prompts import build_capability_layer, build_identity_layer, build_task_layer
from deerflow.workflow.reliability import (
    IDEMPOTENCY_PARAM,
    RetryPolicy,
    RetryPolicyError,
    parse_retry_policy,
    resolve_idempotency_key,
    should_retry,
    validate_idempotency_param,
)
from deerflow.workflow.replay import MODE_RECORD as REPLAY_MODE_RECORD
from deerflow.workflow.replay import MODE_REPLAY as REPLAY_MODE_REPLAY
from deerflow.workflow.replay import REPLAY_CONTEXT_KEY
from deerflow.workflow.schema import Edge, Node, NodeType, WorkflowDefinition
from deerflow.workflow.workflow_io import serialize, validate_definition

logger = logging.getLogger(__name__)

# ── Public types ───────────────────────────────────────────────────────────


@dataclass
class WorkflowRuntime:
    """Per-node execution context injected by the compiler.

    Fields:
        context: The ``context`` dict from LangGraph's runnable config
            (caller-supplied per-run data — thread id, user id, secrets, etc.).
        config: The full LangGraph ``RunnableConfig`` dictionary.
        state: The current LangGraph state dict at the moment the node
            function is invoked.
    """

    context: dict[str, Any] = field(default_factory=dict)
    config: dict[str, Any] = field(default_factory=dict)
    state: dict[str, Any] = field(default_factory=dict)


# Executor contract (T5: three-parameter):
#   (runtime: WorkflowRuntime, params: dict, inputs: dict) → dict
# Supports both sync and async-returning implementations.
Executor = Callable[[WorkflowRuntime, dict[str, Any], dict[str, Any]], dict[str, Any] | Awaitable[dict[str, Any]]]


class WorkflowCompileError(ValueError):
    """Compile-time error — invalid definition, missing executor, no default if-branch, etc."""


def parse_subworkflow_spec(node: Node) -> dict[str, Any] | None:
    """Parse a ``nested:subworkflow`` node's ``params["subworkflow"]`` spec.

    Returns ``None`` when the node carries no ``subworkflow`` param — the node
    then falls back to the legacy executor path.  Otherwise returns a
    normalized spec dict:

    - ``{"type": "inline", "definition": {...}}`` — an inline sub-workflow,
      where ``definition`` is a ``WorkflowDefinition``-valid JSON dict.
    - ``{"type": "template", "template_id": "wf-xxx", "version": "0.1.0"}`` —
      a reference to a stored workflow template (``version`` omitted when absent).

    A ``"mode"`` key (``"compile"`` | ``"delegate"``) is accepted; it defaults
    to ``"compile"`` when absent.  ``"mode": "delegate"`` is only allowed for
    template references (it is returned on the normalized spec as
    ``"mode": "delegate"``); an inline spec with ``"mode": "delegate"`` is
    rejected.  The default (``"compile"`` / absent) keeps the exact T9
    normalized shape — the ``"mode"`` key is only added when ``"delegate"``.

    Raises :class:`WorkflowCompileError` (with the node id) for any malformed
    spec: non-dict value, unknown ``type``, unknown ``mode``, missing required
    fields, a ``definition`` that fails ``WorkflowDefinition.model_validate``,
    or both an inline ``definition`` and a ``template_id`` present at once.
    """
    spec = node.params.get("subworkflow")
    if spec is None:
        return None

    if not isinstance(spec, dict):
        raise WorkflowCompileError(f"node '{node.id}': subworkflow spec must be a dict, got {type(spec).__name__}")

    spec_type = spec.get("type")
    if spec_type not in ("inline", "template"):
        raise WorkflowCompileError(f"node '{node.id}': subworkflow spec 'type' must be 'inline' or 'template', got {spec_type!r}")

    mode = spec.get("mode", "compile")
    if mode not in ("compile", "delegate"):
        raise WorkflowCompileError(f"node '{node.id}': subworkflow spec 'mode' must be 'compile' or 'delegate', got {mode!r}")

    has_definition = "definition" in spec
    has_template_id = "template_id" in spec

    if spec_type == "inline":
        if mode == "delegate":
            raise WorkflowCompileError(f"node '{node.id}': delegate mode requires a template subworkflow reference, got inline")
        if has_template_id:
            raise WorkflowCompileError(f"node '{node.id}': subworkflow spec cannot combine inline 'definition' with 'template_id'")
        definition = spec.get("definition")
        if not isinstance(definition, dict):
            raise WorkflowCompileError(f"node '{node.id}': subworkflow inline spec requires a 'definition' dict")
        try:
            WorkflowDefinition.model_validate(definition)
        except Exception as exc:
            raise WorkflowCompileError(f"node '{node.id}': subworkflow inline 'definition' failed validation: {exc}") from exc
        return {"type": "inline", "definition": definition}

    # spec_type == "template"
    if has_definition:
        raise WorkflowCompileError(f"node '{node.id}': subworkflow spec cannot combine inline 'definition' with 'template_id'")
    template_id = spec.get("template_id")
    if not isinstance(template_id, str) or not template_id:
        raise WorkflowCompileError(f"node '{node.id}': subworkflow template spec requires a non-empty 'template_id' string")
    version = spec.get("version")
    if version is not None and not isinstance(version, str):
        raise WorkflowCompileError(f"node '{node.id}': subworkflow template 'version' must be a string")

    result: dict[str, Any] = {"type": "template", "template_id": template_id}
    if version is not None:
        result["version"] = version
    if mode == "delegate":
        result["mode"] = mode
    return result


class WorkflowRouteError(RuntimeError):
    """Execution-time error — conditional edge with no matching condition and no default edge."""


@dataclass
class CompileContext:
    """Compilation context holding the executor registry and subgraph expansion.

    Each ``NodeType`` that appears in the workflow must have a registered
    ``Executor`` callable, otherwise compilation raises
    :class:`WorkflowCompileError`.

    Fields:
        executors: ``NodeType`` → executor callable registry.
        previews: ``NodeType`` → previewer callable registry (N10).  A node
            whose type has a previewer can carry ``params.require_approval``
            and will suspend for human confirmation before executing.  Kept as
            plain callables (not registry objects) so the compiler never
            imports :mod:`deerflow.workflow.registry` — which imports this
            module — and no import cycle forms.
        idempotent_by_type: ``NodeType`` → whether repeated execution is safe.
            The compiler reads this to gate ``params.retry`` (N14 §24.7): a
            retry is allowed only on an idempotent node type.  Kept as a plain
            mapping so the compiler never imports the registry.
        checkpointer: Optional LangGraph checkpointer for the top-level graph.
            Subgraphs are always compiled with ``checkpointer=None`` so their
            channels never pollute the parent thread checkpoint.
        definition_resolver: Optional synchronous resolver
            ``(template_id, version) -> WorkflowDefinition | None`` used to
            expand ``nested:subworkflow`` template references.  Must be a
            pure in-memory lookup (no IO) — the compile path must stay
            loop-safe, and ``_cache_key`` also calls it outside any lock.
        max_nesting_depth: Maximum subgraph nesting depth (default 10).
            Deeper nesting raises :class:`WorkflowCompileError`.
        max_delegation_depth: Maximum runtime-delegation depth for
            ``nested:subworkflow`` nodes compiled in ``mode="delegate"``
            (default 3).  Delegation depth is read from the run-time context
            (``delegation_depth``) at node execution; reaching this bound
            raises :class:`WorkflowExecutionError`.
    """

    executors: dict[NodeType, Executor] = field(default_factory=dict)
    previews: dict[NodeType, Previewer] = field(default_factory=dict)
    idempotent_by_type: dict[NodeType, bool] = field(default_factory=dict)
    checkpointer: Any | None = None
    definition_resolver: Callable[[str, str | None], WorkflowDefinition | None] | None = None
    max_nesting_depth: int = 10
    max_delegation_depth: int = 3


# ── Compile cache ──────────────────────────────────────────────────────────

_compile_cache: dict[str, CompiledStateGraph] = {}
_compile_cache_lock = threading.Lock()


def clear_compile_cache() -> None:
    """Clear the global compile cache (for testing and hot-reload scenarios)."""
    with _compile_cache_lock:
        _compile_cache.clear()


# ── Internal helpers ───────────────────────────────────────────────────────


def _cache_key(def_: WorkflowDefinition, context: CompileContext | None = None) -> str:
    """Deterministic cache key from the serialized definition and executor set.

    The key combines ``SHA-256(serialize(def_))`` with a fingerprint of
    the registered ``NodeType`` values from ``context.executors`` (sorted
    by value for determinism).  Granularity is deliberately at the
    ``NodeType`` set level — per-executor callable identity is not hashed
    because callables are not reliably hashable, and T5 registry
    semantics map ``NodeType`` → executor globally.

    Additionally (D9-6), the serialized content of every directly-referenced
    template subgraph is folded into the digest, so an update to a stored
    template invalidates the parent graph's cache entry.  The resolver is a
    synchronous in-memory lookup (no IO), and this function is only called
    *outside* ``_compile_cache_lock``.  Resolution failures (missing template,
    malformed spec) are skipped here — the real error is raised later, during
    expansion, so cache-key computation itself never throws.
    """
    digest = hashlib.sha256(serialize(def_).encode("utf-8"))
    if context is not None and context.executors:
        type_fp = "|".join(sorted(t.value for t in context.executors))
        digest.update(f"\0executors:{type_fp}".encode())
    if context is not None and context.previews:
        # The preview set decides whether a ``require_approval`` node is
        # approvable at compile time, so two contexts that differ only in
        # previewers must not share a cache entry.
        preview_fp = "|".join(sorted(t.value for t in context.previews))
        digest.update(f"\0previews:{preview_fp}".encode())
    if context is not None and context.idempotent_by_type:
        # Whether a node type is idempotent decides if ``params.retry`` is a
        # compile error (N14 §24.7), so an idempotency difference must not reuse
        # a cache entry.
        idem_fp = "|".join(f"{t.value}:{int(bool(v))}" for t, v in sorted(context.idempotent_by_type.items(), key=lambda kv: kv[0].value))
        digest.update(f"\0idempotent:{idem_fp}".encode())
    if context is not None and context.checkpointer is not None:
        digest.update(f"\0checkpointer:{id(context.checkpointer)}".encode())
    if context is not None and context.definition_resolver is not None:
        for node in def_.nodes:
            if node.type != NodeType.NESTED_SUBWORKFLOW:
                continue
            try:
                spec = parse_subworkflow_spec(node)
            except WorkflowCompileError:
                continue  # real error surfaces during expansion
            if spec is None or spec["type"] != "template":
                continue
            child = context.definition_resolver(spec["template_id"], spec.get("version"))
            if child is not None:
                digest.update(b"\0template:" + serialize(child).encode())
    return digest.hexdigest()


def _build_state_schema(def_: WorkflowDefinition) -> type:
    """Build a dynamic ``TypedDict`` whose fields cover every output port.

    Keys follow the convention ``wf:<node_id>:<port_name>``, all typed
    ``Any`` and optional (``total=False``).  LangGraph will only persist
    fields declared here — undeclared writes are silently dropped.

    Additionally, every ``flow:loop`` node gets a ``wf:<loop_id>:__count``
    field for the loop iteration counter, and — when it declares the ``results``
    / ``last`` output ports (C5) — a reserved ``wf:<loop_id>:__results`` field
    that accumulates each round's body output.
    """
    fields: dict[str, Any] = {}
    shared_policies: dict[str, str] = def_.metadata.shared or {}
    for node in def_.nodes:
        for port in node.outputs:
            fields[f"wf:{node.id}:{port.name}"] = Any
        if node.params.get("retry") is not None:
            # N14 §24.7 bounded retry: reserved channel carrying the number of
            # retries actually performed (declared only for a retry node).
            fields[f"wf:{node.id}:__retry"] = Any
        if node.type == NodeType.FLOW_LOOP:
            fields[f"wf:{node.id}:__count"] = Any
            loop_ports = {port.name for port in node.outputs}
            if "results" in loop_ports or "last" in loop_ports:
                fields[f"wf:{node.id}:__results"] = Any
        if node.type == NodeType.DATA_SHARED:
            # N14 shared workspace: declare the ``wf:shared:<name>`` channel an
            # ``array``-policy variable needs a reducer for (parallel appends
            # merge instead of colliding); other policies use the default
            # LastValue channel (overwrite across steps, conflict within one).
            shared_name = node.params.get("name")
            if isinstance(shared_name, str) and shared_name:
                shared_key = f"{SHARED_CHANNEL_PREFIX}{shared_name}"
                fields[shared_key] = Annotated[list, _shared_array_reducer] if shared_policies.get(shared_name, "overwrite") == "array" else Any
        if node.type == NodeType.AI_LLM_AGENT:
            # Reserved observability channels: the sub-agent's aggregated token
            # usage (W1C) and, when a guardrail cap ended the run, its
            # ``stop_reason`` (N14 §24.5).  Both lifted from the executor
            # result's reserved keys by ``_make_node_fn``.  Declared here so
            # LangGraph persists the writes into the final state → run.end
            # content / get_workflow_run.
            fields[f"wf:{node.id}:__token_usage"] = Any
            fields[f"wf:{node.id}:__stop_reason"] = Any
            if node.params.get("output_schema") is not None:
                # N14 §24.4 structured-output repair count.
                fields[f"wf:{node.id}:__schema_repairs"] = Any
            if node.params.get("context_policy") is not None:
                # N14 §24.3 per-bucket context usage (estimates + dropped buckets).
                fields[f"wf:{node.id}:__context_usage"] = Any
    # Create the TypedDict dynamically — total=False so all fields are optional.
    schema: type = type("WorkflowState", (dict,), {"__annotations__": fields, "__total__": False})
    return schema


def _emit_node_event(event_type: str, node_id: str, depth: int, **extra: Any) -> None:
    """Best-effort workflow node-lifecycle custom event (C2).

    Emitted only when the graph runs under a stream that includes the ``custom``
    mode (``graph.astream(..., stream_mode=["updates","custom"])``).  Outside such
    a context LangGraph yields a no-op writer, and a direct node-fn call has no
    runnable context at all — both are silent no-ops, so this never raises and
    never perturbs non-streaming execution (``ainvoke`` / ``astream_events``).
    """
    try:
        from langgraph.config import get_stream_writer

        writer = get_stream_writer()
    except Exception:
        return
    payload: dict[str, Any] = {"type": f"wf:node:{event_type}", "node_id": node_id, "depth": depth}
    payload.update(extra)
    try:
        writer(payload)
    except Exception:
        return


def _with_node_events(node_id: str, depth: int, fn: Callable[..., Any], node_type: NodeType | None = None) -> Callable[..., Any]:
    """Wrap a compiled-graph node fn to emit started / completed / failed events.

    ``depth`` is the subgraph nesting depth baked into this graph's compilation
    (0 = top-level), so the worker can filter out child-subgraph node events.
    On failure the event carries a stable ``error_class`` (N14 §24.9) alongside
    the raw ``error`` / ``error_type``.
    """

    async def _wrapped(state: dict[str, Any]) -> dict[str, Any]:
        _emit_node_event("started", node_id, depth)
        try:
            result = await fn(state)
        except Exception as exc:
            _emit_node_event("failed", node_id, depth, error=str(exc), error_type=type(exc).__name__, error_class=classify_failure(exc, node_type=node_type))
            raise
        _emit_node_event("completed", node_id, depth, output=result if isinstance(result, dict) else {})
        return result

    return _wrapped


async def _resolve_executor(
    executor: Executor,
    runtime: WorkflowRuntime,
    params: dict[str, Any],
    inputs: dict[str, Any],
) -> dict[str, Any]:
    """Call executor and ``await`` if the result is awaitable.

    Supports sync executors (return plain dict) and async executors
    (return coroutine / awaitable).
    """
    result = executor(runtime, params, inputs)
    if inspect.isawaitable(result):
        result = await result
    return result


def _make_node_fn(
    node: Node,
    executor: Executor,
    incoming_edges: list[Edge],
    previewer: Previewer | None = None,
    *,
    idempotent: bool = False,
    run_budget: RunBudget | None = None,
) -> Callable[..., Any]:
    """Build an async node wrapper that reads inputs from state, calls the
    executor, and writes outputs back to state.

    Input port values are resolved from upstream nodes' output ports
    via the incoming edges: for each input port ``p`` of *node*, the
    first incoming edge whose ``target_port == p.name`` determines the
    state key ``wf:<source_node>:<source_port>`` to read.

    Missing upstream values produce ``None`` instead of ``KeyError``.
    Only output ports that the executor actually returned are written
    to state.

    When *previewer* is supplied and the node carries
    ``params.require_approval``, the node suspends for human approval before
    running and re-verifies the approved preview afterwards (N10, see
    :mod:`deerflow.workflow.approval`).

    When the node declares ``params.retry`` and *idempotent* is true, the
    executor call is retried up to the policy's bound with an optional backoff
    (N14 §24.7).  Retries wrap only the executor — the approval gate runs once,
    and a control-flow exception is never retried.  The retry count is written
    to the reserved ``wf:<node_id>:__retry`` channel.  When the node requests an
    idempotency key (``params.idempotency``) it is injected into the executor
    params as ``__idempotency_key`` for the tool executors to forward.
    """
    from deerflow.workflow.registry import WorkflowExecutionError  # deferred import — avoids module-level cycle

    # Parse the retry policy at build time (not per call).  Malformed shapes are
    # a compile-time error via ``_validate_retry``; a direct node-fn build in a
    # test is defended against here.
    retry_policy: RetryPolicy | None
    try:
        retry_policy = parse_retry_policy(node.params)
    except RetryPolicyError:
        retry_policy = None
    if retry_policy is not None and not idempotent:
        # Should never happen (compile-time validation rejects it); refuse to
        # silently retry a non-idempotent node.
        retry_policy = None

    # Build input-port → *ordered list* of upstream state keys from incoming
    # edges.  A list-per-port (rather than a single key) is what lets a fan-in
    # port fed by several parallel branches merge per ``params.merge`` (N13)
    # instead of silently keeping only the last edge (pre-N13 behavior).
    merge_raw = node.params.get("merge") or {}
    merge_policies: dict[str, str] = dict(merge_raw) if isinstance(merge_raw, dict) else {}
    port_keys: dict[str, list[str]] = {}
    for edge in incoming_edges:
        port_keys.setdefault(edge.target_port, []).append(f"wf:{edge.source}:{edge.source_port}")

    def _resolve_input(state: dict[str, Any], port_name: str) -> Any:
        keys = port_keys.get(port_name)
        if not keys:
            return state.get(f"wf:{node.id}:{port_name}")
        policy = merge_policies.get(port_name, "overwrite")
        if policy == "array":
            # Collect every upstream value that was actually produced, in edge
            # order.  A producer that never ran is skipped; none → empty list.
            return [state.get(k) for k in keys if k in state]
        if policy == "error":
            present = [k for k in keys if k in state and state.get(k) is not None]
            if len(present) > 1:
                raise WorkflowExecutionError(f"node '{node.id}': input port '{port_name}' received conflicting values from multiple branches {present} (merge policy 'error')")
            return state.get(present[0]) if present else None
        # ``overwrite`` (default): last edge wins, matching pre-N13 behavior.
        return state.get(keys[-1])

    async def _node_fn(state: dict[str, Any]) -> dict[str, Any]:
        inputs: dict[str, Any] = {}
        for p in node.inputs:
            inputs[p.name] = _resolve_input(state, p.name)

        # Build WorkflowRuntime from LangGraph's runnable config context.
        # get_config() is available inside LangGraph node execution.
        # Fall back to empty runtime when running outside a LangGraph
        # context (e.g. tests that invoke the node fn directly).
        # LangGraph moves a top-level ``config["context"]`` into
        # ``config["configurable"]["context"]`` before a node runs, so read
        # both locations (top-level first for forward-compatibility).
        runtime_context: dict[str, Any] = {}
        try:
            config = get_config()
            configurable = config.get("configurable", {}) or {}
            context = config.get("context") or configurable.get("context") or {}
            if isinstance(context, dict):
                runtime_context = context
            runtime = WorkflowRuntime(
                context=context,
                config=config,
                state=state,
            )
        except Exception:
            runtime = WorkflowRuntime(state=state)

        # AI nodes: inject identity / capability / id into the executor params
        # via a shallow copy so the original ``node.params`` definition is never
        # mutated.  Non-AI nodes pass ``node.params`` through unchanged.
        executor_params = node.params
        if node.type == NodeType.AI_LLM_AGENT:
            executor_params = dict(node.params)
            executor_params.setdefault("agent_name", node.agent_name)
            executor_params.setdefault("capability_groups", list(node.capability_groups))
            executor_params.setdefault("node_id", node.id)
        if node.type == NodeType.HUMAN_TASK:
            executor_params = dict(node.params)
            executor_params.setdefault("node_id", node.id)
            from deerflow.workflow.human_task_state import derive_output_spec  # deferred import — keeps the compiler's import graph free of a human-task cycle

            executor_params.setdefault("output_spec", derive_output_spec(node))

        # N10: human approval gate — preview the action, suspend, then verify the
        # approved preview is still fresh before letting the executor run.
        # Deferred imports: ``deerflow.workflow.approval`` imports the registry,
        # which imports this module — a module-level import would cycle.
        if previewer is not None:
            # Approvable (mutating) nodes get their own identity, exactly like
            # ``ai:llm_agent`` / ``human:task``: the previewer and the
            # compensation guard both need a stable node id, and neither can read
            # it off the definition once the executor is running.
            executor_params = dict(executor_params)
            executor_params.setdefault("node_id", node.id)
            executor_params.setdefault("node_type", node.type.value)

            from deerflow.workflow.approval import approval_required

            if approval_required(executor_params):
                from deerflow.workflow.approval import ON_REJECT_FAIL, on_reject_policy, run_approval

                decision = await run_approval(
                    runtime,
                    node_id=node.id,
                    node_type=node.type.value,
                    previewer=previewer,
                    params=executor_params,
                    inputs=inputs,
                )
                if not decision.approved:
                    note = f": {decision.note}" if decision.note else ""
                    if on_reject_policy(executor_params) == ON_REJECT_FAIL:
                        raise WorkflowExecutionError(f"node '{node.id}': rejected by the approver{note}")
                    # ``skip``: continue with the node's output ports unset,
                    # exactly like a skipped ``human:task``.
                    return {}

        # N14 §24.7: a node that asks for an idempotency key gets a stable one
        # (per run+node) injected for the tool executors to forward, so a retry
        # presents the same key and an external system can dedupe it.
        idempotency = resolve_idempotency_key(node.params, run_id=str(runtime_context.get("run_id") or ""), node_id=node.id)
        if idempotency is not None:
            executor_params = dict(executor_params)
            executor_params[IDEMPOTENCY_PARAM] = idempotency

        # N14 §24.11: a replay session on the run context can serve this node's
        # recorded result (replay mode) or capture it (record mode).  A replay
        # hit skips the executor entirely, so no live model/tool call happens.
        replay_session = runtime_context.get(REPLAY_CONTEXT_KEY) if isinstance(runtime_context, dict) else None
        replay_mode = getattr(replay_session, "mode", None)

        result: dict[str, Any] | None = None
        if replay_session is not None and replay_mode == REPLAY_MODE_REPLAY:
            result = replay_session.replay(node_id=node.id, node_type=node.type.value, inputs=inputs)

        attempt = 0
        if result is None:
            # N14 §24.7: bounded retry.  Only the executor call is retried (the
            # approval gate above ran once), and ``should_retry`` refuses to retry
            # a control-flow signal so an interrupt is never swallowed.
            while True:
                attempt += 1
                try:
                    result = await _resolve_executor(executor, runtime, executor_params, inputs)
                    break
                except Exception as exc:
                    if retry_policy is None or not should_retry(retry_policy, attempt=attempt, exc=exc, node_type=node.type):
                        raise
                    if retry_policy.backoff_seconds > 0:
                        await asyncio.sleep(retry_policy.backoff_seconds)
            if replay_session is not None and replay_mode == REPLAY_MODE_RECORD:
                replay_session.record(node_id=node.id, node_type=node.type.value, inputs=inputs, outputs=result)

        outputs: dict[str, Any] = {}
        for p in node.outputs:
            if p.name in result:
                outputs[f"wf:{node.id}:{p.name}"] = result[p.name]

        # AI nodes: surface the sub-agent's aggregated token usage on a
        # reserved state channel (declared in ``_build_state_schema``) instead
        # of a declared output port. ``exec_llm_agent`` returns the reserved
        # ``__workflow_token_usage`` key only when provider usage was observed,
        # so absent usage leaves no channel write.
        if node.type == NodeType.AI_LLM_AGENT:
            token_usage = result.get("__workflow_token_usage")
            if isinstance(token_usage, dict):
                outputs[f"wf:{node.id}:__token_usage"] = token_usage
            # N14 §24.5: only present when a guardrail cap ended the run.
            stop_reason = result.get("__stop_reason")
            if stop_reason is not None:
                outputs[f"wf:{node.id}:__stop_reason"] = stop_reason
            # N14 §24.4: repair count for a structured-output node.
            schema_repairs = result.get("__schema_repairs")
            if isinstance(schema_repairs, int) and not isinstance(schema_repairs, bool):
                outputs[f"wf:{node.id}:__schema_repairs"] = schema_repairs
            # N14 §24.3: per-bucket context usage, present only for a node that
            # declared a context_policy.
            context_usage = result.get(CONTEXT_USAGE_RESULT_KEY)
            if isinstance(context_usage, dict):
                outputs[f"wf:{node.id}:__context_usage"] = context_usage

        # N14 shared workspace: an executor may request writes to shared
        # variables through the reserved ``__shared_writes`` result key; lift
        # each onto its ``wf:shared:<name>`` channel (declared in
        # ``_build_state_schema``, reducer attached for ``array`` policy).
        shared_writes = result.get("__shared_writes")
        if isinstance(shared_writes, dict):
            for shared_name, shared_value in shared_writes.items():
                outputs[f"{SHARED_CHANNEL_PREFIX}{shared_name}"] = shared_value

        # N14 §24.7: surface how many retries the node needed (0 retries = no
        # write), on the reserved channel declared in ``_build_state_schema``.
        if attempt > 1:
            outputs[f"wf:{node.id}:__retry"] = attempt - 1

        # N14 §24.10: run-level budget.  Aggregate every node's reserved usage
        # channel in the current state plus this node's own usage, and act on the
        # policy.  ``abort`` fails the node so the run stops with an actionable
        # error; ``warn`` logs and continues.
        if run_budget is not None:
            totals = aggregate_token_usage(state)
            combined_total = usage_total(totals) + usage_total(outputs.get(f"wf:{node.id}:__token_usage"))
            decision = evaluate_budget(combined_total, run_budget)
            if decision.exceeded:
                if decision.action == ON_EXCEED_ABORT:
                    raise WorkflowExecutionError(f"node '{node.id}': run budget exceeded ({decision.observed} > {decision.limit} tokens); aborting")
                logger.warning("workflow run budget exceeded (%d > %d tokens) at node '%s'; continuing (on_exceed=warn)", decision.observed, decision.limit, node.id)

        return outputs

    return _node_fn


def _make_end_node_fn(node: Node, incoming_edges: list[Edge]) -> Callable[..., Any]:
    """Build a pass-through node fn for an ``flow:end`` node with output ports.

    A normal ``flow:end`` node has no output ports and maps directly to the
    LangGraph ``END`` sentinel.  A subworkflow-boundary ``flow:end`` node
    *does* declare output ports — those are the subgraph's external outputs.
    For such a node we register a real node function that forwards incoming
    input values to the output ports:

    - each output port reads the *same-named* input port's value;
    - otherwise, if the end node has exactly one input port, that single input
      feeds every output port (the common subgraph boundary shape);
    - otherwise the output port stays unset.

    State keys follow ``wf:<node_id>:<port_name>``, exactly like ``_make_node_fn``.
    """
    input_key_map: dict[str, str] = {}
    for edge in incoming_edges:
        input_key_map[edge.target_port] = f"wf:{edge.source}:{edge.source_port}"

    input_names = [p.name for p in node.inputs]

    async def _end_fn(state: dict[str, Any]) -> dict[str, Any]:
        outputs: dict[str, Any] = {}
        for p in node.outputs:
            key = input_key_map.get(p.name)
            if key is None and len(input_names) == 1:
                key = input_key_map.get(input_names[0])
            if key is not None:
                outputs[f"wf:{node.id}:{p.name}"] = state.get(key)
        return outputs

    return _end_fn


def _copy_on_write(value: Any) -> Any:
    """Shallow-copy a mutable container before it crosses a subgraph boundary.

    Copy-on-write (COW) contract:
    - ``dict`` → ``copy.copy(value)``; ``list`` → ``value.copy()``;
      ``set`` → ``value.copy()`` — the *top-level* container is replaced, so an
      in-place mutation by a subgraph node (e.g. a custom executor mutating its
      inputs) cannot pollute the parent state.
    - Nested objects inside the container stay **shared** by reference.  This is
      deliberately NOT ``copy.deepcopy`` — deep-copying large payloads (file
      bytes, big documents) would recreate exactly the copy cost this boundary
      exists to avoid.
    - Scalars / strings / ``None`` / immutables return the original value
      unchanged (zero-cost pass-through — they cannot be mutated in place).

    Callers must treat subgraph inputs as read-only at the top level; mutating a
    *nested* object shared with the parent remains an executor anti-pattern.
    """
    if isinstance(value, dict):
        return copy.copy(value)
    if isinstance(value, list):
        return value.copy()
    if isinstance(value, set):
        return value.copy()
    return value


def _make_subworkflow_node_fn(
    node: Node,
    child: CompiledStateGraph,
    child_start_id: str,
    child_end_id: str,
    incoming_edges: list[Edge],
) -> Callable[..., Any]:
    """Build the parent-graph node fn for an expanded ``nested:subworkflow`` node.

    The node function is an adapter between the parent and the subgraph:
    it reads parent-state inputs, builds the subgraph's initial state, invokes
    the subgraph manually, and writes the subgraph's outputs back to parent
    state — so parent and child state/channels stay fully isolated.

    Copy-on-write boundary: every value placed into the subgraph's initial
    state passes through :func:`_copy_on_write`, so the child never receives a
    reference to a parent-state container.  A child node that mutates its input
    in place (a custom executor anti-pattern) therefore cannot pollute the
    parent state.  Only the *top level* is copied — nested objects stay shared
    with the parent, and subgraph inputs are read-only at the top level by
    contract.
    """
    from deerflow.workflow.registry import WorkflowExecutionError  # deferred import — avoids module-level cycle

    input_key_map: dict[str, str] = {}
    for edge in incoming_edges:
        input_key_map[edge.target_port] = f"wf:{edge.source}:{edge.source_port}"

    mapping = node.params.get("mapping")
    map_inputs = (mapping or {}).get("inputs") or {}
    map_outputs = (mapping or {}).get("outputs") or {}

    async def _node_fn(state: dict[str, Any]) -> dict[str, Any]:
        # 1. Read this node's inputs from parent state (input_key_map mechanism).
        inputs: dict[str, Any] = {}
        for p in node.inputs:
            state_key = input_key_map.get(p.name, f"wf:{node.id}:{p.name}")
            inputs[p.name] = state.get(state_key)

        # 2. Build the subgraph's initial state from ``mapping.inputs``.
        #    A ``wf:``-prefixed value is a parent-state reference; a value
        #    matching one of this node's input ports resolves through the
        #    input_key_map read above; anything else is a literal passed
        #    through unchanged.  Every value crosses the boundary through
        #    ``_copy_on_write`` (COW): mutable top-level containers are
        #    shallow-copied so an in-place mutation by a child node cannot
        #    pollute the parent state, while nested objects stay shared.
        sub_input: dict[str, Any] = {}
        for child_port, parent_ref in map_inputs.items():
            if isinstance(parent_ref, str) and parent_ref.startswith("wf:"):
                sub_input[f"wf:{child_start_id}:{child_port}"] = _copy_on_write(state.get(parent_ref))
            elif isinstance(parent_ref, str) and parent_ref in inputs:
                sub_input[f"wf:{child_start_id}:{child_port}"] = _copy_on_write(inputs[parent_ref])
            else:
                sub_input[f"wf:{child_start_id}:{child_port}"] = _copy_on_write(parent_ref)

        # 3. Resolve the parent config (must be forwarded explicitly so the
        #    subgraph's nodes see context via get_config()).
        try:
            config = get_config()
        except Exception:
            config = {}

        # 4. Invoke the subgraph, wrapping failures with the node path.
        try:
            result = await child.ainvoke(sub_input, config)
        except Exception as exc:
            raise WorkflowExecutionError(f"{node.id} > {exc}") from exc

        # 5. Write subgraph outputs back to parent state.
        outputs: dict[str, Any] = {}
        for child_port, parent_port in map_outputs.items():
            outputs[f"wf:{node.id}:{parent_port}"] = result.get(f"wf:{child_end_id}:{child_port}")

        return outputs

    return _node_fn


def _control_flow_should_propagate(exc: BaseException, *, catch_recursion: bool) -> bool:
    """Return ``True`` when *exc* must escape a ``flow:try`` body unchanged.

    LangGraph signals control flow through ``GraphBubbleUp`` subclasses that use
    the exception channel as ordinary transport: ``GraphInterrupt`` carries a
    human-in-the-loop suspension and ``GraphRecursionError`` marks the recursion
    limit.  Swallowing either would break suspension/resume or hide a runaway
    graph, so they are never caught.  ``GraphRecursionError`` is the one
    exception — an author who opts in with ``catch_recursion=True`` may treat
    hitting the limit as a catchable failure.  ``asyncio.CancelledError`` is
    deliberately absent: it derives from ``BaseException`` and never reaches an
    ``except Exception`` clause.
    """
    if isinstance(exc, GraphInterrupt):
        return True
    if isinstance(exc, GraphRecursionError):
        return not catch_recursion
    if isinstance(exc, GraphBubbleUp):
        return True  # any other LangGraph control-flow signal (e.g. ParentCommand)
    return False


def _make_try_node_fn(
    node: Node,
    body: CompiledStateGraph,
    body_def: WorkflowDefinition,
    body_start_id: str,
    body_end_id: str,
    finally_graph: CompiledStateGraph | None,
    incoming_edges: list[Edge],
) -> Callable[..., Any]:
    """Build the parent-graph node fn for a ``flow:try`` node (N12).

    The protected body is a sub-workflow (``params.subworkflow``, inline or
    template) expanded by :func:`_expand_subworkflow` — the same machinery
    ``nested:subworkflow`` uses, so the body runs in an isolated child graph.
    The node invokes the body and:

    - on success, writes the mapped body outputs to their parent ports and
      ``error=False``;
    - on a caught failure, writes ``error=True`` / ``error_message`` /
      ``error_type`` and **continues** (the run does not abort), so a downstream
      ``flow:if`` can route to a catch branch;
    - ``on_error="fail"`` re-raises instead (today's abort-the-run behavior).

    LangGraph control-flow exceptions always propagate — see
    :func:`_control_flow_should_propagate`.

    An optional ``params.finally_subworkflow`` runs in a ``finally`` block, so it
    executes whether the body succeeded or failed.  It receives no injected
    inputs (a side-effect-only cleanup / notification step); its own outputs are
    discarded.
    """
    from deerflow.workflow.registry import WorkflowExecutionError  # deferred import — avoids module-level cycle

    input_key_map: dict[str, str] = {}
    for edge in incoming_edges:
        input_key_map[edge.target_port] = f"wf:{edge.source}:{edge.source_port}"

    mapping = node.params.get("mapping") or {}
    map_inputs = (mapping or {}).get("inputs") or {}
    map_outputs = (mapping or {}).get("outputs") or {}
    on_error = node.params.get("on_error", "catch")
    catch_recursion = bool(node.params.get("catch_recursion", False))

    async def _node_fn(state: dict[str, Any]) -> dict[str, Any]:
        inputs: dict[str, Any] = {}
        for p in node.inputs:
            state_key = input_key_map.get(p.name, f"wf:{node.id}:{p.name}")
            inputs[p.name] = state.get(state_key)

        # Build the body's initial state — same mapping semantics as
        # ``_make_subworkflow_node_fn`` (wf: reference / input port / literal),
        # every value crossing through ``_copy_on_write``.
        sub_input: dict[str, Any] = {}
        for child_port, parent_ref in map_inputs.items():
            if isinstance(parent_ref, str) and parent_ref.startswith("wf:"):
                sub_input[f"wf:{body_start_id}:{child_port}"] = _copy_on_write(state.get(parent_ref))
            elif isinstance(parent_ref, str) and parent_ref in inputs:
                sub_input[f"wf:{body_start_id}:{child_port}"] = _copy_on_write(inputs[parent_ref])
            else:
                sub_input[f"wf:{body_start_id}:{child_port}"] = _copy_on_write(parent_ref)

        try:
            config = get_config()
        except Exception:
            config = {}

        outputs: dict[str, Any] = {}
        try:
            result = await body.ainvoke(sub_input, config)
        except Exception as exc:  # noqa: BLE001 — catching is the whole point
            if _control_flow_should_propagate(exc, catch_recursion=catch_recursion):
                raise
            if on_error == "fail":
                if isinstance(exc, WorkflowExecutionError):
                    raise
                raise WorkflowExecutionError(f"node '{node.id}': try body failed: {exc}") from exc
            outputs[f"wf:{node.id}:error"] = True
            outputs[f"wf:{node.id}:error_message"] = str(exc)
            outputs[f"wf:{node.id}:error_type"] = type(exc).__name__
        else:
            for child_port, parent_port in map_outputs.items():
                outputs[f"wf:{node.id}:{parent_port}"] = result.get(f"wf:{body_end_id}:{child_port}")
            outputs[f"wf:{node.id}:error"] = False
        finally:
            if finally_graph is not None:
                await finally_graph.ainvoke({}, config)
        return outputs

    return _node_fn


def _make_delegate_node_fn(
    node: Node,
    child_graph: CompiledStateGraph,
    child_def: WorkflowDefinition,
    child_start_id: str,
    child_end_id: str,
    incoming_edges: list[Edge],
    ctx: CompileContext,
) -> Callable[..., Any]:
    """Build the parent-graph node fn for a runtime-delegated subworkflow node.

    Unlike :func:`_make_subworkflow_node_fn` (compile-time expansion, which
    invokes the child graph directly in-graph), this adapter hands the
    sub-workflow to a one-shot sub-agent via
    :class:`deerflow.subagents.SubagentExecutor`.  The sub-agent is bound with
    the ``invoke_workflow`` tool (closing over the pre-compiled child graph)
    and instructed to execute it and return the structured output dict
    verbatim.  The node fn then parses that result and writes the child
    end-node outputs back to parent state.

    Requires ``ctx.checkpointer`` — a delegated sub-agent runs under an
    independent checkpoint namespace and cannot be checkpointed without a saver.
    """
    from deerflow.workflow.registry import WorkflowExecutionError  # deferred import — avoids module-level cycle

    input_key_map: dict[str, str] = {}
    for edge in incoming_edges:
        input_key_map[edge.target_port] = f"wf:{edge.source}:{edge.source_port}"

    mapping = node.params.get("mapping")
    map_inputs = (mapping or {}).get("inputs") or {}
    map_outputs = (mapping or {}).get("outputs") or {}

    child_start = next((n for n in child_def.nodes if n.type == NodeType.FLOW_START), None)
    child_end = next((n for n in child_def.nodes if n.type == NodeType.FLOW_END), None)
    start_ports = [p.name for p in child_start.outputs] if child_start is not None else []
    end_ports = [p.name for p in child_end.outputs] if child_end is not None else []

    max_depth = ctx.max_delegation_depth

    async def _node_fn(state: dict[str, Any]) -> dict[str, Any]:
        # Deferred imports: SubagentExecutor lives behind a lazy package export,
        # and importing it at module scope would pull the agent graph into the
        # workflow compiler's import path (a circular import).
        from deerflow.subagents import SubagentExecutor
        from deerflow.subagents.config import SubagentConfig
        from deerflow.workflow.delegate import build_invoke_workflow_tool

        # 1. Read this node's inputs from parent state (input_key_map mechanism).
        inputs: dict[str, Any] = {}
        for p in node.inputs:
            state_key = input_key_map.get(p.name, f"wf:{node.id}:{p.name}")
            inputs[p.name] = state.get(state_key)

        # Resolve the runtime context (LangGraph moves a top-level
        # ``config["context"]`` into ``config["configurable"]["context"]``).
        try:
            config = get_config()
            configurable = config.get("configurable", {}) or {}
            context = config.get("context") or configurable.get("context") or {}
            runtime = WorkflowRuntime(context=context, config=config, state=state)
        except Exception:
            runtime = WorkflowRuntime(state=state)
        context = runtime.context

        # 2. Delegation-depth guard (bounded by CompileContext.max_delegation_depth).
        depth = context.get("delegation_depth", 0)
        if depth >= max_depth:
            raise WorkflowExecutionError(f"delegation depth exceeded at node '{node.id}': max {max_depth}")

        # A delegated sub-agent is checkpoint-enabled, so it needs a saver.
        checkpointer = ctx.checkpointer
        if checkpointer is None:
            raise WorkflowExecutionError(f"node '{node.id}': delegate mode requires a checkpointer (CompileContext.checkpointer is None)")

        # 3. Build the one-shot sub-agent executor bound to the child graph.
        # Three-layer prompt assembly (T22): identity (agent_name binding) +
        # capability (capability_groups) + task (delegation instruction). The
        # instruction is built here (delegate nodes carry no ``instruction``
        # param) and passed straight into the task layer, so the original node
        # object is never mutated.
        instruction = (
            f"执行子工作流「{child_def.name}（{child_def.id}）」，"
            f"工作流输入端口：{', '.join(start_ports) or '（无）'}，"
            f"工作流输出端口：{', '.join(end_ports) or '（无）'}。"
            "使用 invoke_workflow 工具执行。工具会返回结构化输出 dict。请直接返回工具结果，不要编造内容。"
        )
        system_prompt = "\n\n".join(
            section
            for section in (
                build_identity_layer(node.agent_name, user_id=context.get("user_id")),
                build_capability_layer(node.capability_groups, agent_skills=None),
                build_task_layer(instruction, inputs),
            )
            if section
        )
        subagent_config = SubagentConfig(
            name=f"wf:{node.id}",
            description=f"Execute sub-workflow {child_def.id} via delegation",
            system_prompt=system_prompt,
            tools=None,
            disallowed_tools=["ask_clarification", "present_files"],
            checkpointer=True,
            allow_recursion=bool(node.params.get("allow_recursion", False)),
        )

        # 4. Bind the invoke_workflow tool (closing over the pre-compiled child).
        tools = [build_invoke_workflow_tool(child_graph, child_def, child_start_id, child_end_id)]

        checkpoint_thread_id = f"{context.get('thread_id', 'sub')}:wfsub:{node.id}"

        executor_kwargs: dict[str, Any] = {
            "config": subagent_config,
            "tools": tools,
            "checkpointer": checkpointer,
            "checkpoint_thread_id": checkpoint_thread_id,
            "delegation_depth": depth + 1,
        }
        if context.get("thread_id"):
            executor_kwargs["thread_id"] = context["thread_id"]
        for key in ("user_id", "run_id", "app_config"):
            if context.get(key) is not None:
                executor_kwargs[key] = context[key]

        executor = SubagentExecutor(**executor_kwargs)

        # 5. Build the delegation prompt from the resolved child inputs and run.
        sub_input: dict[str, Any] = {}
        for child_port, parent_ref in map_inputs.items():
            if isinstance(parent_ref, str) and parent_ref.startswith("wf:"):
                sub_input[child_port] = state.get(parent_ref)
            elif isinstance(parent_ref, str) and parent_ref in inputs:
                sub_input[child_port] = inputs[parent_ref]
            else:
                sub_input[child_port] = parent_ref

        prompt = f"执行子工作流「{child_def.name}」，输入如下：\n{json.dumps(sub_input, ensure_ascii=False, default=str)}\n使用 invoke_workflow 工具执行，并只返回工具输出的原始 JSON dict，不要添加任何额外说明。"

        result = await executor._aexecute(prompt)

        # Non-completed delegation → runtime failure (SubagentResult.status is a
        # SubagentStatus enum; compare by value so this module stays free of a
        # runtime import of the enum).
        status_value = getattr(result.status, "value", None)
        if status_value != "completed":
            error_detail = getattr(result, "error", None) or status_value or "unknown"
            raise WorkflowExecutionError(f"node '{node.id}': subagent delegation failed: {error_detail}")

        # 6. Parse the sub-agent's final text as the child's structured output.
        text = getattr(result, "result", None)
        parsed: dict[str, Any] = {}
        if isinstance(text, str):
            try:
                candidate = json.loads(text)
                if isinstance(candidate, dict):
                    parsed = candidate
            except (ValueError, TypeError):
                parsed = {}

        outputs: dict[str, Any] = {}
        if parsed:
            for child_port, parent_port in map_outputs.items():
                outputs[f"wf:{node.id}:{parent_port}"] = parsed.get(child_port)
        else:
            # Fallback: unparseable result → whole text lands on the first output port.
            if node.outputs:
                outputs[f"wf:{node.id}:{node.outputs[0].name}"] = text

        return outputs

    return _node_fn


def _validate_subworkflow_mapping(node: Node, child: WorkflowDefinition) -> None:
    """Validate a ``nested:subworkflow`` node's ``params.mapping`` against the child graph.

    Raises :class:`WorkflowCompileError` when a referenced port does not exist:

    - ``mapping.inputs`` child port names must exist in the child start node's
      *output* ports (subgraph inputs are injected as ``wf:<start>:<port>``,
      which ``_build_state_schema`` only declares for output ports).
    - ``mapping.outputs`` child port names must exist in the child end node's
      output ports.
    - ``mapping.outputs`` parent port names must be declared on the parent node's
      ``outputs`` — otherwise LangGraph silently drops the write.
    """
    mapping = node.params.get("mapping") or {}
    map_inputs = mapping.get("inputs") or {}
    map_outputs = mapping.get("outputs") or {}

    child_start = next((n for n in child.nodes if n.type == NodeType.FLOW_START), None)
    child_end = next((n for n in child.nodes if n.type == NodeType.FLOW_END), None)

    if child_start is not None:
        start_ports = {p.name for p in child_start.outputs}
        for child_port in map_inputs:
            if child_port not in start_ports:
                raise WorkflowCompileError(f"node '{node.id}': mapping input port '{child_port}' not found in subworkflow start node outputs (available: {sorted(start_ports)})")

    if child_end is not None:
        end_ports = {p.name for p in child_end.outputs}
        for child_port in map_outputs:
            if child_port not in end_ports:
                raise WorkflowCompileError(f"node '{node.id}': mapping output port '{child_port}' not found in subworkflow end node outputs (available: {sorted(end_ports)})")

    parent_ports = {p.name for p in node.outputs}
    for parent_port in map_outputs.values():
        if parent_port not in parent_ports:
            raise WorkflowCompileError(f"node '{node.id}': mapping output parent port '{parent_port}' not declared in node outputs (available: {sorted(parent_ports)})")


def _expand_subworkflow(
    node: Node,
    ctx: CompileContext,
    *,
    depth: int,
    visiting: set[str],
    chain_path: list[str],
) -> tuple[CompiledStateGraph, WorkflowDefinition]:
    """Recursively compile an inline/template subgraph for a ``nested:subworkflow`` node.

    Enforces nesting-depth limit and template reference-cycle detection before
    recursing, then compiles the child graph with ``checkpointer=None`` and the
    same executors/resolver/depth-limit as the parent context.

    Args:
        node: The ``nested:subworkflow`` node carrying a valid ``subworkflow`` spec.
        ctx: The current compile context.
        depth: Current nesting depth (1 for the top-level graph).
        visiting: ``template_id`` set currently on the expansion stack (cycle detection).
        chain_path: Node-id/template-id path from the top level, for error messages.

    Returns:
        A ``(compiled_child_graph, child_definition)`` pair.
    """
    spec = parse_subworkflow_spec(node)
    assert spec is not None, "caller must pass a node with a valid subworkflow spec"

    # ── Depth limit ─────────────────────────────────────────────────────
    if depth + 1 > ctx.max_nesting_depth:
        chain = " > ".join([*chain_path, node.id])
        raise WorkflowCompileError(f"subworkflow nesting depth exceeded: {chain} (max {ctx.max_nesting_depth})")

    # ── Resolve child definition (with cycle detection for templates) ──
    if spec["type"] == "inline":
        child = WorkflowDefinition.model_validate(spec["definition"])
        child_visiting = visiting  # inline is a value copy — no template_id to track
        child_chain = [*chain_path, node.id]
    else:  # template
        template_id = spec["template_id"]
        if template_id in visiting:
            chain = " → ".join([*chain_path, template_id])
            raise WorkflowCompileError(f"subworkflow reference cycle detected: {chain}")
        resolver = ctx.definition_resolver
        if resolver is None:
            raise WorkflowCompileError(f"node '{node.id}': cannot resolve subworkflow template '{template_id}' (no definition_resolver in CompileContext)")
        child = resolver(template_id, spec.get("version"))
        if child is None:
            raise WorkflowCompileError(f"node '{node.id}': subworkflow template '{template_id}' not found")
        child_visiting = visiting | {template_id}
        child_chain = [*chain_path, template_id]

    # ── Validate port mapping against the child graph ──────────────────
    _validate_subworkflow_mapping(node, child)

    # ── Recurse: child graph compiles with checkpointer=None ───────────
    child_ctx = CompileContext(
        executors=ctx.executors,
        previews=ctx.previews,
        checkpointer=None,
        definition_resolver=ctx.definition_resolver,
        max_nesting_depth=ctx.max_nesting_depth,
        max_delegation_depth=ctx.max_delegation_depth,
    )
    child_graph = _compile_impl(child, child_ctx, depth=depth + 1, visiting=child_visiting, chain_path=child_chain)
    return child_graph, child


def _validate_approval_nodes(def_: WorkflowDefinition, ctx: CompileContext) -> None:
    """Reject ``require_approval`` on node types that cannot describe themselves.

    An approvable node must have a previewer, otherwise the human would be asked
    to confirm an action nobody could describe.  Catching it here (rather than at
    execution time) fails the definition at save/compile, which is where the
    mistake actually is.  ``on_reject`` is validated here too for the same reason.
    """
    for node in def_.nodes:
        params = node.params or {}
        if params.get("require_approval") is not True:
            continue
        if node.type not in ctx.previews:
            raise WorkflowCompileError(f"node '{node.id}': require_approval is not supported for node type '{node.type.value}' (no previewer is registered for it)")
        on_reject = params.get("on_reject", "fail")
        if on_reject not in ("fail", "skip"):
            raise WorkflowCompileError(f"node '{node.id}': on_reject must be 'fail' or 'skip', got {on_reject!r}")


#: Fan-in merge policies accepted by ``params.merge`` (N13).
_MERGE_POLICIES: frozenset[str] = frozenset({"overwrite", "array", "error"})

#: Shared-workspace (N14) vocabulary: variable-name grammar + write policies.
SHARED_CHANNEL_PREFIX = "wf:shared:"
_SHARED_NAME_PATTERN = re.compile(r"^[A-Za-z0-9_][A-Za-z0-9_.-]{0,63}$")
_SHARED_POLICIES: frozenset[str] = frozenset({"overwrite", "array", "conflict"})


def _shared_array_reducer(current: Any, update: Any) -> list[Any]:
    """Reducer for an ``array`` shared variable: concatenate into one list.

    LangGraph hands this ``(existing, incoming)``; either side may be a scalar
    (a single writer) or a list (a merged batch), and ``None``/missing counts as
    empty.  Never raises on scalar input, so one writer and a parallel burst go
    through the same reducer.
    """
    base = list(current) if isinstance(current, list) else ([] if current is None else [current])
    extra = list(update) if isinstance(update, list) else [update]
    return base + extra


def _validate_shared_nodes(def_: WorkflowDefinition) -> None:
    """Compile-time validation for the N14 shared workspace.

    Checks the global ``metadata.shared`` policy map and every ``data:shared``
    node's ``operation`` / ``name``.
    """
    for name, policy in (def_.metadata.shared or {}).items():
        if not isinstance(name, str) or not _SHARED_NAME_PATTERN.match(name):
            raise WorkflowCompileError(f"metadata.shared: invalid shared variable name {name!r}; expected {_SHARED_NAME_PATTERN.pattern!r}")
        if policy not in _SHARED_POLICIES:
            raise WorkflowCompileError(f"metadata.shared['{name}'] must be one of {sorted(_SHARED_POLICIES)}, got {policy!r}")

    for node in def_.nodes:
        if node.type != NodeType.DATA_SHARED:
            continue
        params = node.params or {}
        operation = params.get("operation")
        if operation not in ("read", "write", "append"):
            raise WorkflowCompileError(f"node '{node.id}': data:shared requires params.operation in ('read', 'write', 'append'), got {operation!r}")
        name = params.get("name")
        if not isinstance(name, str) or not _SHARED_NAME_PATTERN.match(name):
            raise WorkflowCompileError(f"node '{node.id}': data:shared requires a valid params.name; got {name!r}")


#: Autonomy vocabulary for ``ai:llm_agent`` ``params.autonomy`` (N14 §24.5).
_AUTONOMY_MODES: frozenset[str] = frozenset({"template", "bounded"})
_AUTONOMY_BUDGET_KEYS: frozenset[str] = frozenset({"max_turns", "max_tokens", "max_tool_calls"})


def _validate_autonomy(def_: WorkflowDefinition) -> None:
    """Compile-time validation for ``ai:llm_agent`` ``params.autonomy`` (N14 §24.5).

    ``mode`` must be ``template``/``bounded``; ``budgets`` may carry only
    ``max_turns``/``max_tokens`` (positive ints).  ``max_tool_calls`` has no
    engine mechanism yet, so it fails loud here rather than being silently
    ignored.
    """
    for node in def_.nodes:
        autonomy = (node.params or {}).get("autonomy")
        if autonomy is None:
            continue
        if node.type != NodeType.AI_LLM_AGENT:
            raise WorkflowCompileError(f"node '{node.id}': params.autonomy is only supported on 'ai:llm_agent' nodes")
        if not isinstance(autonomy, dict):
            raise WorkflowCompileError(f"node '{node.id}': params.autonomy must be an object")
        mode = autonomy.get("mode", "template")
        if mode not in _AUTONOMY_MODES:
            raise WorkflowCompileError(f"node '{node.id}': autonomy.mode must be one of {sorted(_AUTONOMY_MODES)}, got {mode!r}")

        budgets = autonomy.get("budgets")
        if budgets is None:
            continue
        if not isinstance(budgets, dict):
            raise WorkflowCompileError(f"node '{node.id}': autonomy.budgets must be an object")
        unknown = set(budgets) - _AUTONOMY_BUDGET_KEYS
        if unknown:
            raise WorkflowCompileError(f"node '{node.id}': autonomy.budgets has unknown keys {sorted(unknown)} (allowed: {sorted(_AUTONOMY_BUDGET_KEYS)})")
        if "max_tool_calls" in budgets:
            raise WorkflowCompileError(f"node '{node.id}': autonomy.budgets.max_tool_calls is not supported yet")
        for key in ("max_turns", "max_tokens"):
            if key in budgets:
                value = budgets[key]
                if not isinstance(value, int) or isinstance(value, bool) or value <= 0:
                    raise WorkflowCompileError(f"node '{node.id}': autonomy.budgets.{key} must be a positive integer, got {value!r}")


def _validate_output_schema(def_: WorkflowDefinition) -> None:
    """Compile-time binding validation for ``ai:llm_agent`` ``params.output_schema`` (N14 §24.4).

    The schema's fields must each map to a declared output port of the matching
    type — turning the runtime "the model output did not match the graph"
    surprise into a definition error at save/compile time.
    """
    from deerflow.workflow.structured_output import MAX_REPAIRS_LIMIT, SCHEMA_FIELD_TYPES, StructuredOutputError, parse_output_schema

    for node in def_.nodes:
        if (node.params or {}).get("output_schema") is None:
            continue
        if node.type != NodeType.AI_LLM_AGENT:
            raise WorkflowCompileError(f"node '{node.id}': params.output_schema is only supported on 'ai:llm_agent' nodes")
        try:
            schema = parse_output_schema(node.params)
        except StructuredOutputError as exc:
            raise WorkflowCompileError(f"node '{node.id}': invalid output_schema: {exc}") from exc
        if schema is None:  # pragma: no cover - guarded by the None check above
            continue

        ports = {p.name: p.type.value for p in node.outputs}
        for name, field_type in schema["fields"].items():
            if field_type not in SCHEMA_FIELD_TYPES:
                raise WorkflowCompileError(f"node '{node.id}': output_schema field '{name}' has unknown type {field_type!r} (allowed: {sorted(SCHEMA_FIELD_TYPES)})")
            if name not in ports:
                raise WorkflowCompileError(f"node '{node.id}': output_schema field '{name}' has no matching output port")
            if ports[name] != field_type:
                raise WorkflowCompileError(f"node '{node.id}': output_schema field '{name}' is {field_type} but output port '{name}' is {ports[name]}")
        for name in schema["required"]:
            if name not in schema["fields"]:
                raise WorkflowCompileError(f"node '{node.id}': output_schema.required names unknown field '{name}'")
        for name in schema["enum_values"]:
            if name not in schema["fields"]:
                raise WorkflowCompileError(f"node '{node.id}': output_schema.enum_values names unknown field '{name}'")
            if schema["fields"][name] != "enum":
                raise WorkflowCompileError(f"node '{node.id}': output_schema.enum_values['{name}'] requires an 'enum' field")
        if schema["max_repairs"] < 0 or schema["max_repairs"] > MAX_REPAIRS_LIMIT:
            raise WorkflowCompileError(f"node '{node.id}': output_schema.max_repairs must be between 0 and {MAX_REPAIRS_LIMIT}")


def _validate_context_policy(def_: WorkflowDefinition) -> None:
    """Compile-time validation for ``ai:llm_agent`` ``params.context_policy`` (N14 §24.3).

    Two things the runtime cannot check are checked here: the policy shape itself
    (delegated to the pure parser, so compile and runtime agree), and the port
    binding — every ``include`` name must be a declared **input** port of that
    node, turning "the mounted context was silently empty" into a definition
    error at save/compile time.
    """
    from deerflow.workflow.context_policy import ContextPolicyError, parse_context_policy

    for node in def_.nodes:
        if (node.params or {}).get("context_policy") is None:
            continue
        if node.type != NodeType.AI_LLM_AGENT:
            raise WorkflowCompileError(f"node '{node.id}': params.context_policy is only supported on 'ai:llm_agent' nodes")
        try:
            policy = parse_context_policy(node.params)
        except ContextPolicyError as exc:
            raise WorkflowCompileError(f"node '{node.id}': invalid context_policy: {exc}") from exc
        if policy is None:  # pragma: no cover - guarded by the None check above
            continue

        input_ports = {port.name for port in node.inputs}
        for name in policy.include:
            if name not in input_ports:
                raise WorkflowCompileError(f"node '{node.id}': context_policy.include names undeclared input port '{name}'")


def _validate_concurrency_params(def_: WorkflowDefinition) -> None:
    """Compile-time validation for the N13 ``params.merge`` / ``params.resource_lock``.

    Both are author-facing knobs on arbitrary nodes, so a typo'd port name,
    an unknown merge policy, or a lock name that cannot become a filename is
    reported here (definition compile) rather than silently ignored at runtime.
    """
    from deerflow.locks.file_lock import LOCK_NAME_PATTERN

    for node in def_.nodes:
        params = node.params or {}

        merge = params.get("merge")
        if merge is not None:
            if not isinstance(merge, dict):
                raise WorkflowCompileError(f"node '{node.id}': params.merge must be an object mapping input ports to one of {sorted(_MERGE_POLICIES)}")
            input_names = {p.name for p in node.inputs}
            for port, policy in merge.items():
                if port not in input_names:
                    raise WorkflowCompileError(f"node '{node.id}': params.merge references unknown input port '{port}' (available: {sorted(input_names)})")
                if policy not in _MERGE_POLICIES:
                    raise WorkflowCompileError(f"node '{node.id}': params.merge['{port}'] must be one of {sorted(_MERGE_POLICIES)}, got {policy!r}")

        lock_param = params.get("resource_lock")
        if lock_param is not None:
            if isinstance(lock_param, str):
                lock_names: tuple[Any, ...] = (lock_param,)
            elif isinstance(lock_param, (list, tuple)):
                lock_names = tuple(lock_param)
            else:
                raise WorkflowCompileError(f"node '{node.id}': params.resource_lock must be a string or a list of strings")
            for name in lock_names:
                if not isinstance(name, str) or not LOCK_NAME_PATTERN.match(name):
                    raise WorkflowCompileError(f"node '{node.id}': invalid resource_lock name {name!r}; expected {LOCK_NAME_PATTERN.pattern!r}")

        timeout = params.get("resource_lock_timeout")
        if timeout is not None:
            try:
                float(timeout)
            except (TypeError, ValueError) as exc:
                raise WorkflowCompileError(f"node '{node.id}': params.resource_lock_timeout must be a number, got {timeout!r}") from exc


def _validate_retry(def_: WorkflowDefinition, ctx: CompileContext) -> None:
    """Compile-time validation for the N14 §24.7 ``params.retry`` / ``params.idempotency``.

    A retry is only safe on an **idempotent** node type — retrying a
    non-idempotent node repeats its side effect.  The registered idempotency of
    each type reaches the compiler through ``ctx.idempotent_by_type`` (the
    registry owns the source of truth); an unregistered type (a compiler-native
    control-flow node) is treated as non-idempotent.  A malformed policy or an
    empty idempotency string is reported here rather than silently ignored.
    """
    for node in def_.nodes:
        params = node.params or {}
        try:
            validate_idempotency_param(params)
            policy = parse_retry_policy(params)
        except RetryPolicyError as exc:
            raise WorkflowCompileError(f"node '{node.id}': {exc}") from exc
        if policy is None:
            continue
        if not ctx.idempotent_by_type.get(node.type, False):
            raise WorkflowCompileError(f"node '{node.id}': params.retry is only allowed on idempotent node types; '{node.type.value}' is non-idempotent (retrying it would repeat its side effect)")


def _validate_run_budget(def_: WorkflowDefinition) -> None:
    """Compile-time validation for the N14 §24.10 ``metadata.budget``."""
    try:
        parse_run_budget(def_.metadata.model_dump())
    except _BudgetError as exc:
        raise WorkflowCompileError(f"metadata.budget: {exc}") from exc


def _resource_lock_names(node: Node) -> tuple[str, ...]:
    """Extract the (validated) ``params.resource_lock`` names for *node*."""
    raw = node.params.get("resource_lock")
    if raw is None:
        return ()
    if isinstance(raw, str):
        return (raw,)
    if isinstance(raw, (list, tuple)):
        return tuple(str(x) for x in raw)
    return ()


def _maybe_wrap_resource_lock(node: Node, node_fn: Callable[..., Any]) -> Callable[..., Any]:
    """Wrap *node_fn* to hold ``params.resource_lock`` around its whole execution (N13).

    The N8 lock is reentrant via a ``threading.RLock`` whose acquire/release must
    happen on the **same thread**, and a blocking acquire must not run on the
    event loop (blocking-io gate).  So a dedicated holder thread takes the lock
    (single ``resource_lock`` or ``acquire_many``) and holds it until the node
    finishes; the event loop only waits on a handshake event.  A timeout surfaces
    as a ``WorkflowExecutionError`` naming the lock; the lock is released in a
    ``finally`` even when the node raises or is cancelled.
    """
    names = _resource_lock_names(node)
    if not names:
        return node_fn
    timeout = float(node.params.get("resource_lock_timeout", 60.0))
    node_id = node.id

    async def _locked(state: dict[str, Any]) -> dict[str, Any]:
        from deerflow.locks.file_lock import LockError, acquire_many, resource_lock

        acquired = threading.Event()
        release = threading.Event()
        errors: list[BaseException] = []

        def _holder() -> None:
            try:
                holder_ctx = resource_lock(names[0], timeout=timeout) if len(names) == 1 else acquire_many(names, timeout=timeout)
                with holder_ctx:
                    acquired.set()
                    release.wait()
            except BaseException as exc:  # noqa: BLE001 — surfaced to the awaiting node
                errors.append(exc)
                acquired.set()

        holder = threading.Thread(target=_holder, name=f"wf-lock-{node_id}", daemon=True)
        holder.start()
        try:
            await asyncio.to_thread(acquired.wait)
            if errors:
                from deerflow.workflow.registry import WorkflowExecutionError

                failure = errors[0]
                if isinstance(failure, LockError):
                    raise WorkflowExecutionError(f"node '{node_id}': resource lock {list(names)} unavailable: {failure}") from failure
                raise failure
            return await node_fn(state)
        finally:
            # Releases the holder's ``with`` block; the daemon thread then exits
            # on its own.  Deliberately not joined here: joining while the holder
            # is still waiting to acquire could block, and the lock is released
            # regardless as soon as the holder wakes.
            release.set()

    return _locked


def _make_route_fn(
    if_node: Node,
    conditional_edges: list[tuple[str, str]],  # [(condition_port, target), ...]
    default_target: str,
) -> Callable[[dict[str, Any]], str]:
    """Build a sync routing function for an ``flow:if`` node.

    The returned callable reads each condition port from state (keyed
    ``wf:<if_node_id>:<condition_port>``); the *first truthy* value
    determines the target node.  If none match, the default target is
    returned.

    Execution-time ``WorkflowRouteError`` is raised only when the
    default target is ``None`` (which should not happen after
    compile-time validation).
    """

    def _route(state: dict[str, Any]) -> str:
        for condition_port, target in conditional_edges:
            value = state.get(f"wf:{if_node.id}:{condition_port}")
            if value:
                return target
        if default_target is None:
            raise WorkflowRouteError(f"if node '{if_node.id}': no condition matched and no default edge configured")
        return default_target

    return _route


# ── Compile entry point ───────────────────────────────────────────────────


def compile_definition(
    def_: WorkflowDefinition,
    *,
    context: CompileContext | None = None,
) -> CompiledStateGraph:
    """Compile a ``WorkflowDefinition`` into a LangGraph ``CompiledStateGraph``.

    Args:
        def_: The workflow definition to compile.
        context: Optional :class:`CompileContext` carrying executor
            registrations, checkpointer, and subgraph resolver.  If ``None``,
            an empty context is used (which means every non-control-flow node
            will fail compilation unless executors are registered).

    Returns:
        A compiled LangGraph graph ready for ``ainvoke`` / ``astream``.

    Raises:
        WorkflowCompileError: The definition is invalid or a required
            executor is missing.
    """
    ctx = context or CompileContext()
    return _compile_impl(def_, ctx, depth=1, visiting=set(), chain_path=[])


def _compile_impl(
    def_: WorkflowDefinition,
    ctx: CompileContext,
    *,
    depth: int,
    visiting: set[str],
    chain_path: list[str],
) -> CompiledStateGraph:
    """Recursive implementation of :func:`compile_definition`.

    Carries the subgraph-expansion state (``depth`` / ``visiting`` /
    ``chain_path``) explicitly so nested ``compile_definition`` calls share
    cycle/depth tracking without any mutable context.  The cache lookup and
    store are each scoped to a single ``with _compile_cache_lock`` block that
    never spans compilation, so recursive subgraph compilation (which happens
    outside the lock) cannot dead-lock the non-reentrant ``threading.Lock``.
    """

    # ── Cache hit? ─────────────────────────────────────────────────────
    cache_key = _cache_key(def_, ctx)
    with _compile_cache_lock:
        cached = _compile_cache.get(cache_key)
        if cached is not None:
            return cached

    # ── 1. Validate the definition first ───────────────────────────────
    errors = validate_definition(def_)
    if errors:
        raise WorkflowCompileError("workflow validation failed:\n" + "\n".join(errors))
    _validate_approval_nodes(def_, ctx)
    _validate_concurrency_params(def_)
    _validate_shared_nodes(def_)
    _validate_autonomy(def_)
    _validate_output_schema(def_)
    _validate_context_policy(def_)
    _validate_retry(def_, ctx)
    _validate_run_budget(def_)
    run_budget = parse_run_budget(def_.metadata.model_dump())

    # ── 2. Build dynamic state schema ──────────────────────────────────
    state_schema = _build_state_schema(def_)

    # ── 3. Create StateGraph builder ───────────────────────────────────
    builder = StateGraph(state_schema)

    def _register(node_id: str, node_fn: Callable[..., Any]) -> None:
        """Register a node wrapped with lifecycle custom-event emission (C2).

        ``_compile_impl``'s ``depth`` starts at 1 for the top-level graph, so the
        event depth is ``depth - 1`` (0 = top level) — the value the worker uses
        to filter out child-subgraph node events.

        A node declaring ``params.resource_lock`` (N13) is additionally wrapped so
        its whole execution holds the cross-process lock; the wrap is a no-op
        otherwise.
        """
        node = node_map.get(node_id)
        if node is not None:
            node_fn = _maybe_wrap_resource_lock(node, node_fn)
        builder.add_node(node_id, _with_node_events(node_id, depth - 1, node_fn, node.type if node is not None else None))

    # Build lookup maps
    node_map: dict[str, Node] = {n.id: n for n in def_.nodes}
    start_node_id: str | None = None
    end_node_id: str | None = None

    # Build incoming-edges index for input resolution
    incoming_edges: dict[str, list[Edge]] = {n.id: [] for n in def_.nodes}
    for edge in def_.edges:
        incoming_edges[edge.target].append(edge)

    # ── 4. Register nodes ─────────────────────────────────────────────
    for node in def_.nodes:
        if node.type == NodeType.FLOW_START:
            start_node_id = node.id
            continue  # start node → LangGraph START, no add_node
        if node.type == NodeType.FLOW_END:
            end_node_id = node.id
            if node.outputs:
                # Subworkflow-boundary end node: it declares output ports, so
                # register a pass-through node fn to forward inputs to outputs.
                end_fn = _make_end_node_fn(node, incoming_edges.get(node.id, []))
                _register(node.id, end_fn)
            continue  # normal end node → LangGraph END, no add_node

        if node.type == NodeType.FLOW_LOOP:
            # Loop node: register a counting executor that reads/writes
            # wf:<loop_id>:__count in state and writes the declared
            # ``iteration`` / ``out`` output ports (the frontend catalog
            # declares both).  ``iteration`` mirrors the counter (current
            # round = count + 1); ``out`` pass-throughs the ``in`` input
            # port value resolved via the same incoming-edge key map as
            # ``_make_node_fn``.  Missing upstream (no ``in`` edge or the
            # producer never ran) yields ``None`` instead of an error.
            loop_id = node.id
            # Build the input-port → state-key mapping from incoming edges.
            # A tuple of pairs keeps the closure default immutable (B006).
            loop_in_edges: tuple[tuple[str, str], ...] = tuple((edge.target_port, f"wf:{edge.source}:{edge.source_port}") for edge in incoming_edges.get(node.id, []))
            # Declared output-port names — the aggregation writes ``results`` /
            # ``last`` only when the node actually declares them (C5).
            loop_out_ports: frozenset[str] = frozenset(port.name for port in node.outputs)

            async def _loop_node_fn(
                state: dict[str, Any],
                *,
                _lid: str = loop_id,
                _in_edges: tuple[tuple[str, str], ...] = loop_in_edges,
                _out_ports: frozenset[str] = loop_out_ports,
            ) -> dict[str, Any]:
                count_key = f"wf:{_lid}:__count"
                current: int = state.get(count_key, 0)
                iteration = current + 1
                outputs: dict[str, Any] = {count_key: iteration}
                # iteration output port — mirrors the counter every round.
                outputs[f"wf:{_lid}:iteration"] = iteration
                # out = in pass-through: resolve the ``in`` port's upstream
                # state key from incoming edges (last matching edge wins,
                # exactly like ``_make_node_fn``'s dict key map).  Missing
                # upstream yields None instead of raising.
                in_state_key: str | None = None
                for port, key in _in_edges:
                    if port == "in":
                        in_state_key = key
                in_value = state.get(in_state_key) if in_state_key is not None else None
                outputs[f"wf:{_lid}:out"] = in_value
                # C5 aggregation: from round 2 on, the loop fn sees the previous
                # round's body output on its ``in`` port (the dataflow ring), so
                # collect those into ``results`` in iteration order and expose
                # ``last``.  The seed value (round 1) is not a body output and is
                # not collected.  Accumulation lives on a reserved channel so a
                # node declaring only ``last`` still gets the full history.
                if "results" in _out_ports or "last" in _out_ports:
                    acc_key = f"wf:{_lid}:__results"
                    prior = state.get(acc_key)
                    results: list[Any] = list(prior) if isinstance(prior, list) else []
                    if current >= 1:
                        results.append(in_value)
                    outputs[acc_key] = results
                    if "results" in _out_ports:
                        outputs[f"wf:{_lid}:results"] = results
                    if "last" in _out_ports:
                        outputs[f"wf:{_lid}:last"] = results[-1] if results else None
                return outputs

            _register(node.id, _loop_node_fn)
            continue

        if node.type == NodeType.FLOW_PARALLEL:
            # Parallel node: pass-through executor — inputs go straight to
            # outputs; LangGraph's native fan-out from multiple regular
            # out edges handles the parallelism.
            async def _parallel_node_fn(state: dict[str, Any]) -> dict[str, Any]:  # noqa: ARG001
                return {}

            _register(node.id, _parallel_node_fn)
            continue

        if node.type == NodeType.FLOW_SWITCH:
            # FLOW_SWITCH is a routing node — if CompileContext provides
            # an executor use it (custom branch selection); otherwise
            # register a built-in pass-through (output ports stay unset,
            # route always falls through to default).
            executor = ctx.executors.get(node.type)
            if executor is not None:
                node_fn = _make_node_fn(node, executor, incoming_edges.get(node.id, []), ctx.previews.get(node.type), idempotent=ctx.idempotent_by_type.get(node.type, False), run_budget=run_budget)
                _register(node.id, node_fn)
            else:

                async def _switch_builtin(state: dict[str, Any]) -> dict[str, Any]:  # noqa: ARG001
                    return {}

                _register(node.id, _switch_builtin)
            continue

        if node.type == NodeType.FLOW_WAIT:
            # FLOW_WAIT is a normal node that gets resolved via executor
            # lookup (T5-3 registers the actual wait executor).
            pass

        if node.type == NodeType.FLOW_TRY:
            # N12: a protected sub-workflow body.  Reuse the nested-subworkflow
            # expansion machinery (inline/template spec + mapping); the node fn
            # catches the body's failure and surfaces it on ``error`` ports so a
            # downstream ``flow:if`` can route to a catch branch.  Compiler-native
            # (no registry executor), exactly like ``flow:loop`` / ``flow:parallel``.
            if parse_subworkflow_spec(node) is None:
                raise WorkflowCompileError(f"node '{node.id}': flow:try requires a 'subworkflow' body spec")
            body_graph, body_def = _expand_subworkflow(node, ctx, depth=depth, visiting=visiting, chain_path=chain_path)
            body_start_id = next((n.id for n in body_def.nodes if n.type == NodeType.FLOW_START), "")
            body_end_id = next((n.id for n in body_def.nodes if n.type == NodeType.FLOW_END), "")

            finally_graph: CompiledStateGraph | None = None
            finally_spec = node.params.get("finally_subworkflow")
            if finally_spec is not None:
                # Synthesize an inline subworkflow node so the finally block rides
                # the same expansion + mapping-validation path.  No mapping:
                # finally is a side-effect-only cleanup step.
                finally_node = Node(id=f"{node.id}__finally", type=NodeType.NESTED_SUBWORKFLOW, params={"subworkflow": finally_spec})
                finally_graph, _finally_def = _expand_subworkflow(finally_node, ctx, depth=depth, visiting=visiting, chain_path=chain_path)

            node_fn = _make_try_node_fn(node, body_graph, body_def, body_start_id, body_end_id, finally_graph, incoming_edges.get(node.id, []))
            _register(node.id, node_fn)
            continue

        if node.type == NodeType.NESTED_SUBWORKFLOW:
            spec = parse_subworkflow_spec(node)
            if spec is not None:
                # Pre-compile the child graph for both delegation and expansion.
                child_graph, child_def = _expand_subworkflow(node, ctx, depth=depth, visiting=visiting, chain_path=chain_path)
                child_start_id = next((n.id for n in child_def.nodes if n.type == NodeType.FLOW_START), "")
                child_end_id = next((n.id for n in child_def.nodes if n.type == NodeType.FLOW_END), "")
                if spec.get("mode") == "delegate":
                    # Runtime delegation: bind a delegation node fn that executes
                    # the child through a sub-agent instead of expanding it in-graph.
                    node_fn = _make_delegate_node_fn(node, child_graph, child_def, child_start_id, child_end_id, incoming_edges.get(node.id, []), ctx)
                    _register(node.id, node_fn)
                    continue
                # Compile-time subgraph expansion (inline/template reference).
                node_fn = _make_subworkflow_node_fn(node, child_graph, child_start_id, child_end_id, incoming_edges.get(node.id, []))
                _register(node.id, node_fn)
                continue
            # No subworkflow spec → fall through to the legacy executor path.

        # Bind executor (for non-control-flow nodes including FLOW_WAIT)
        executor = ctx.executors.get(node.type)
        if executor is None:
            raise WorkflowCompileError(f"node '{node.id}' type '{node.type.value}' has no registered executor in CompileContext")

        node_fn = _make_node_fn(node, executor, incoming_edges.get(node.id, []), ctx.previews.get(node.type), idempotent=ctx.idempotent_by_type.get(node.type, False), run_budget=run_budget)
        _register(node.id, node_fn)

    # Determine whether the end node is a registered pass-through (subgraph
    # boundary) — in that case edges must route *into* it rather than to END.
    end_node = node_map.get(end_node_id) if end_node_id is not None else None
    end_has_outputs = bool(end_node is not None and end_node.outputs)

    def _end_target(target: str) -> Any:
        if target == end_node_id:
            return end_node_id if end_has_outputs else END
        return target

    # ── 5. Process edges ──────────────────────────────────────────────
    # We do two passes:
    #   Pass A — regular edges (including start→X and X→end).
    #   Pass B — conditional edges (from flow:if / flow:switch / flow:loop
    #            nodes — collected and compiled as add_conditional_edges).

    # Pass A: regular edges
    for edge in def_.edges:
        source = edge.source
        target = edge.target

        # Edges from start node → LangGraph START
        if source == start_node_id:
            builder.add_edge(START, target)
            continue

        # All edges from conditional nodes (if / switch / loop) are
        # handled in Pass B — both conditional AND default edges.
        # Adding the default edge here would unconditionally fire the
        # default target alongside any routed branch.
        src_node = node_map[source]
        if src_node.type in (NodeType.FLOW_IF, NodeType.FLOW_SWITCH, NodeType.FLOW_LOOP):
            continue

        # Non-conditional source node: conditional edges are NOT allowed.
        if edge.condition is not None:
            raise WorkflowCompileError(f"edge from '{source}' to '{target}' has condition '{edge.condition}' but source node type is '{src_node.type.value}' (only 'flow:if', 'flow:switch', 'flow:loop' support conditional edges)")

        # Edges to end node → LangGraph END (or the pass-through end node)
        if target == end_node_id:
            builder.add_edge(source, _end_target(target))
            continue

        # Ordinary edge
        builder.add_edge(source, target)

    # Pass B: conditional edges from if / switch / loop nodes
    for node in def_.nodes:
        if node.type not in (NodeType.FLOW_IF, NodeType.FLOW_SWITCH, NodeType.FLOW_LOOP):
            continue

        cond_id = node.id
        out_edges = [e for e in def_.edges if e.source == cond_id]

        cond_edges: list[tuple[str, str]] = []  # [(condition_port, target), ...]
        default_target: str | None = None

        for edge in out_edges:
            if edge.condition is not None:
                # Conditional edge — target could be a regular node or end
                target = _end_target(edge.target)
                cond_edges.append((edge.condition, target))
            else:
                # Default (unconditional) edge
                if default_target is not None:
                    raise WorkflowCompileError(f"conditional node '{cond_id}' has multiple default edges (only one allowed)")
                default_target = _end_target(edge.target)

        # Validate: if there are conditional edges, a default edge is required
        if cond_edges and default_target is None:
            raise WorkflowCompileError(f"conditional node '{cond_id}' requires a default edge (no condition)")

        if not cond_edges:
            continue  # no conditional edges — regular edges already handled in Pass A

        # default_target is guaranteed non-None here (guarded above)
        _default: str = cast(str, default_target)

        # For loop nodes: build a route function that (a) compares the
        # iteration counter against the configured ``iterations`` and (b)
        # honours an optional data-driven early exit via ``params.continue_on``.
        if node.type == NodeType.FLOW_LOOP:
            loop_id = node.id
            max_iterations: int = node.params.get("iterations", 1)

            # C5: ``continue_on`` names a source-port on one of the loop's
            # incoming edges (typically the body back-edge).  The route reads
            # ``wf:<source>:<port>`` and exits when that value is falsy.  The
            # check only applies from round 2 on, and an *absent* key means "no
            # opinion" (keep looping) — so a signal the body has not produced
            # yet cannot cut the loop short on round 1.  ``iterations`` stays a
            # hard ceiling regardless.  A ``continue_on`` naming no edge is a
            # safe no-op (count-only loop).
            continue_on = node.params.get("continue_on")
            continue_key: str | None = None
            if isinstance(continue_on, str) and continue_on:
                for edge in incoming_edges.get(node.id, []):
                    if edge.source_port == continue_on:
                        continue_key = f"wf:{edge.source}:{edge.source_port}"

            def _make_loop_route(
                lid: str,
                max_it: int,
                conds: list[tuple[str, str]],
                dflt: str,
                cont_key: str | None,
            ) -> Callable[[dict[str, Any]], str]:
                def _route(state: dict[str, Any]) -> str:
                    count = state.get(f"wf:{lid}:__count", 0)
                    if count <= max_it:
                        if cont_key is not None and count >= 1 and cont_key in state and not state.get(cont_key):
                            return dflt
                        # Route to the body entry (the conditional edge target)
                        for _condition_port, body_target in conds:
                            return body_target
                    return dflt

                return _route

            loop_route = _make_loop_route(loop_id, max_iterations, cond_edges, _default, continue_key)
            path_map: dict[str, str] = {}
            for _, target in cond_edges:
                path_map[target] = target
            path_map[_default] = _default
            builder.add_conditional_edges(cond_id, loop_route, path_map)
            continue

        # Build route function and path_map for if / switch nodes
        route_fn = _make_route_fn(node, cond_edges, _default)

        # path_map maps route_fn return values to LangGraph node names.
        # We use an identity mapping because route_fn returns target names directly.
        path_map = {}
        for _, target in cond_edges:
            path_map[target] = target
        path_map[_default] = _default

        builder.add_conditional_edges(cond_id, route_fn, path_map)

    # If the end node is a registered pass-through (subgraph boundary), connect
    # it to the END sentinel after all regular/conditional edges.
    if end_has_outputs and end_node_id is not None:
        builder.add_edge(end_node_id, END)

    # ── 6. Compile ────────────────────────────────────────────────────
    compiled = builder.compile(checkpointer=ctx.checkpointer)

    # ── 7. Cache and return ───────────────────────────────────────────
    with _compile_cache_lock:
        _compile_cache[cache_key] = compiled

    return compiled
