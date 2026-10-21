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
  A ``params.subworkflow`` (inline/template) makes the body a *declared*
  child graph instead of hand-drawn nodes: the compiler generates the body
  edge and the back-edge, feeds each round's input (the *ring*: the seed on
  round 1, the previous round's result afterwards) into the body's start
  port and writes the body's result port to the reserved
  ``wf:<loop_id>:__ring`` channel, so ``results``/``last``/``continue_on``
  work exactly as they do for an inline body.
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
import time
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
from deerflow.workflow.capability_group_nodes import (
    CapabilityGroupWiringError,
    is_capability_group_node,
    resolve_ai_capability_groups,
    validate_capability_group_wiring,
)
from deerflow.workflow.context_compression import ContextCompressionError, resolve_context_compression
from deerflow.workflow.failure_taxonomy import classify_failure
from deerflow.workflow.handoff import (
    DECISION_PORT as HANDOFF_DECISION_PORT,
)
from deerflow.workflow.handoff import (
    HANDOFF_COUNT_CHANNEL,
    HandoffError,
    parse_handoff,
)
from deerflow.workflow.handoff import (
    TARGET_PORT as HANDOFF_TARGET_PORT,
)
from deerflow.workflow.model_profiles import (
    ModelProfileError,
    collect_model_profile_ids,
    parse_model_profile_id,
    resolve_model_profile,
)
from deerflow.workflow.prompts import build_capability_layer, build_identity_layer, build_task_layer
from deerflow.workflow.reliability import (
    IDEMPOTENCY_PARAM,
    IdempotencyParamError,
    resolve_idempotency_key,
    validate_idempotency_param,
)
from deerflow.workflow.replay import MODE_RECORD as REPLAY_MODE_RECORD
from deerflow.workflow.replay import MODE_REPLAY as REPLAY_MODE_REPLAY
from deerflow.workflow.replay import REPLAY_CONTEXT_KEY
from deerflow.workflow.resource_access import ResourceAccessor
from deerflow.workflow.resource_locking import ResourceLockError, hold_resource_locks
from deerflow.workflow.review import (
    REVIEW_APPROVED_PORT,
    REVIEW_DECISION_APPROVED,
    REVIEW_DECISION_CHANNEL,
    REVIEW_DECISION_REJECTED,
    REVIEW_REJECTED_PORT,
    REVIEW_TARGET_PARAM,
    REVIEW_VISIT_CHANNEL,
    review_state_key,
)
from deerflow.workflow.schema import Edge, Node, NodeType, WorkflowDefinition
from deerflow.workflow.structured_output import OUTPUT_SCHEMA_PARAM, OUTPUT_SCHEMA_PORT
from deerflow.workflow.workflow_io import serialize, validate_definition

logger = logging.getLogger(__name__)

# Reserved state channel carrying the newest ring value of a ``flow:loop`` whose
# body is declared by ``params.subworkflow`` (the body's result port).  Engine
# bookkeeping, exactly like ``__count`` / ``__results``: it is not a
# declared port and never appears in a node event's ``output``.
LOOP_RING_CHANNEL = "__ring"

# Separator between a ``flow:loop`` id and its generated body node's id.  ``.`` is
# outside the definition-id grammar (``[A-Za-z0-9_-]``), so a generated name cannot
# collide with an authored node id, and it is not one of the two characters
# LangGraph reserves in node names (``:`` and ``|``).
LOOP_BODY_NODE_SEP = "."

# Node types whose ``params`` can carry a subworkflow spec that must be folded
# into the compile cache key (a template's content decides the compiled structure).
_SUBWORKFLOW_SPEC_NODE_TYPES = (NodeType.NESTED_SUBWORKFLOW, NodeType.FLOW_TRY, NodeType.FLOW_LOOP)


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


def parse_loop_body_spec(node: Node) -> dict[str, Any] | None:
    """Parse a ``flow:loop`` node's ``params["subworkflow"]`` body spec.

    Same spec vocabulary as ``nested:subworkflow`` / ``flow:try`` (see
    :func:`parse_subworkflow_spec`), with one subtraction: a loop body runs
    in-graph once per round, so ``mode: "delegate"`` is a compile error here (a
    delegated body is a one-shot task, not a body).  Returns ``None`` when the
    loop carries no ``subworkflow`` param — the node then keeps the inline,
    hand-drawn body it has always had.
    """
    spec = parse_subworkflow_spec(node)
    if spec is not None and spec.get("mode", "compile") != "compile":
        raise WorkflowCompileError(f"node '{node.id}': flow:loop body spec 'mode' must be 'compile' (a loop body runs in-graph every round; it cannot be delegated)")
    return spec


def _subworkflow_specs(node: Node) -> list[dict[str, Any]]:
    """Parse every subworkflow spec a node declares (its body, plus ``flow:try``'s finally block).

    Cache-key helper.  Malformed specs are skipped rather than raised: the real
    error is surfaced later, during expansion, and cache-key computation must
    never throw.
    """
    if node.type not in _SUBWORKFLOW_SPEC_NODE_TYPES:
        return []
    candidates = [node]
    finally_spec = node.params.get("finally_subworkflow")
    if node.type == NodeType.FLOW_TRY and finally_spec is not None:
        # ``parse_subworkflow_spec`` reads ``params["subworkflow"]``, so wrap the
        # finally block in a throwaway node — the same shape the compiler
        # synthesizes when it expands it.
        candidates.append(Node(id=f"{node.id}__finally", type=NodeType.NESTED_SUBWORKFLOW, params={"subworkflow": finally_spec}))
    specs: list[dict[str, Any]] = []
    for candidate in candidates:
        try:
            spec = parse_subworkflow_spec(candidate)
        except WorkflowCompileError:
            continue
        if spec is not None:
            specs.append(spec)
    return specs


def _fold_template_digests(digest: Any, def_: WorkflowDefinition, resolver: Any, seen: set[tuple[str, str | None]]) -> None:
    """Fold the content of every referenced subworkflow template into *digest* (D9-6).

    Recursive: a template's *own* template references decide the parent graph's
    compiled structure too, so a change deep in the chain must invalidate the
    parent's cache entry.  ``seen`` guards against reference cycles (which are
    detected properly, with a real error, during expansion).
    """
    for node in def_.nodes:
        for spec in _subworkflow_specs(node):
            if spec["type"] != "template":
                continue
            key = (spec["template_id"], spec.get("version"))
            if key in seen:
                continue
            seen.add(key)
            child = resolver(spec["template_id"], spec.get("version"))
            if child is None:
                continue
            digest.update(b"\0template:" + serialize(child).encode())
            _fold_template_digests(digest, child, resolver, seen)


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
        previews: ``NodeType`` → previewer callable registry.  Kept for the
            read-only definition preview endpoint; the compiler itself does not
            execute previewers.  Plain callables (not registry objects) keep
            the compiler free of a registry import cycle.
        resource_accessors: ``NodeType`` → resource-access callable registry
            (N13).  The compiler derives automatic locks from the accessor
            after breakpoint gates and holds them for the executor call.
            Missing entries mean the node type declares no resources.
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
        model_profiles: User-owned model profiles keyed by profile id.  AI
            nodes reference one through ``params.model_profile``; the profile
            points at an actual configured model name.
        available_model_names: Actual model names from ``config.yaml``.  A
            profile whose target is absent fails compile/run loudly.
    """

    executors: dict[NodeType, Executor] = field(default_factory=dict)
    previews: dict[NodeType, Callable[..., Any]] = field(default_factory=dict)
    checkpointer: Any | None = None
    definition_resolver: Callable[[str, str | None], WorkflowDefinition | None] | None = None
    max_nesting_depth: int = 10
    max_delegation_depth: int = 3
    resource_accessors: dict[NodeType, ResourceAccessor] = field(default_factory=dict)
    model_profiles: dict[str, dict[str, Any]] = field(default_factory=dict)
    available_model_names: frozenset[str] = frozenset()
    model_context_windows: dict[str, int] = field(default_factory=dict)
    default_model_name: str | None = None


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
    if context is not None and context.resource_accessors:
        # A different accessor for the same node type can derive a different
        # lock set, so it must not reuse a compiled graph.  The cache is
        # process-local, so callable identity is the right fingerprint here.
        accessor_fp = "|".join(f"{t.value}:{id(fn)}" for t, fn in sorted(context.resource_accessors.items(), key=lambda item: item[0].value))
        digest.update(f"\0resource_accessors:{accessor_fp}".encode())
    if context is not None and context.checkpointer is not None:
        digest.update(f"\0checkpointer:{id(context.checkpointer)}".encode())
    if context is not None and context.definition_resolver is not None:
        _fold_template_digests(digest, def_, context.definition_resolver, set())
    if context is not None:
        referenced_profiles = sorted(collect_model_profile_ids(def_.model_dump(mode="json")))
        if referenced_profiles:
            parts: list[str] = []
            for profile_id in referenced_profiles:
                profile = context.model_profiles.get(profile_id)
                if profile is None:
                    parts.append(f"{profile_id}:missing")
                    continue
                target = profile.get("target_model")
                available = isinstance(target, str) and target in context.available_model_names
                parts.append(f"{profile_id}:{target}:{bool(profile.get('enabled', True))}:{available}")
            digest.update(f"\0model_profiles:{'|'.join(parts)}".encode())
        windows = "|".join(f"{name}:{size}" for name, size in sorted(context.model_context_windows.items()))
        digest.update(f"\0model_context_windows:{windows}\0default_model:{context.default_model_name or ''}".encode())
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
        if node.type == NodeType.FLOW_LOOP:
            fields[f"wf:{node.id}:__count"] = Any
            loop_ports = {port.name for port in node.outputs}
            if "results" in loop_ports or "last" in loop_ports:
                fields[f"wf:{node.id}:__results"] = Any
            if node.params.get("subworkflow") is not None:
                # A params-declared body feeds each round's result back through a
                # reserved channel instead of a drawn back-edge.
                fields[f"wf:{node.id}:{LOOP_RING_CHANNEL}"] = Any
        if node.type == NodeType.FLOW_HANDOFF:
            # §24.6a controlled dynamic handoff: reserved channel carrying how
            # often this node has routed within the run.  It is what the
            # executor's ``max_handoffs`` budget reads, and it is engine
            # bookkeeping — never a declared port.
            fields[f"wf:{node.id}:{HANDOFF_COUNT_CHANNEL}"] = Any
        if node.type == NodeType.DATA_SHARED:
            # N14 shared workspace: declare the ``wf:shared:<name>`` channel an
            # ``array``-policy variable needs a reducer for (parallel appends
            # merge instead of colliding); other policies use the default
            # LastValue channel (overwrite across steps, conflict within one).
            shared_name = node.params.get("name")
            if isinstance(shared_name, str) and shared_name:
                shared_key = f"{SHARED_CHANNEL_PREFIX}{shared_name}"
                fields[shared_key] = Annotated[list, _shared_array_reducer] if shared_policies.get(shared_name, "overwrite") == "array" else Any
        if node.type == NodeType.HUMAN_REVIEW:
            # Routing truth and per-visit identity for a review loop.  Both are
            # engine bookkeeping; the node event exposes only approved/rejected.
            fields[review_state_key(node.id, REVIEW_DECISION_CHANNEL)] = Any
            fields[review_state_key(node.id, REVIEW_VISIT_CHANNEL)] = Any
        # N14x: every node declares a reserved execution-duration channel so the
        # write in ``_make_node_fn`` persists into the final state → run.end
        # ``node_timings`` → get_workflow_run.  Declared for every node type
        # (not just AI), because a slow node is exactly what an operator wants
        # to find.
        fields[f"wf:{node.id}:__duration_ms"] = Any
        if node.type == NodeType.AI_LLM_AGENT:
            # Reserved observability channels: the sub-agent's aggregated token
            # usage (W1C) and, when a guardrail cap ended the run, its
            # ``stop_reason`` (N14 §24.5).  Both lifted from the executor
            # result's reserved keys by ``_make_node_fn``.  Declared here so
            # LangGraph persists the writes into the final state → run.end
            # content / get_workflow_run.
            fields[f"wf:{node.id}:__token_usage"] = Any
            fields[f"wf:{node.id}:__stop_reason"] = Any
            # Full assembled prompt for ``ai:prompt_preview``.  Always declared
            # so a preview node works even when the AI node was authored before
            # this feature.
            fields[f"wf:{node.id}:__prompt"] = Any
            # Reserved structured-output repair count (zero writes are omitted).
            fields[f"wf:{node.id}:__schema_repairs"] = Any
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


def _event_output(result: Any) -> dict[str, Any]:
    """The port-output view of a node's result for the ``completed`` event.

    Reserved engine channels (``wf:<node>:__token_usage``, ``__duration_ms``,
    …) are internal bookkeeping — they already reach operators
    through ``run.end`` aggregates (``token_usage`` / ``node_timings``) and
    ``get_workflow_run``.  Keeping them out of the node-lifecycle event keeps
    that payload about *what the node produced*.
    """
    if not isinstance(result, dict):
        return {}
    return {key: value for key, value in result.items() if not key.rsplit(":", 1)[-1].startswith("__")}


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
        _emit_node_event("completed", node_id, depth, output=_event_output(result))
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
    # Sync executors (bash/file/preview-adjacent helpers) may perform blocking
    # sandbox IO.  Never call them on the event loop: run them in a worker
    # thread.  Async executors are awaited directly.
    is_async = inspect.iscoroutinefunction(executor) or inspect.iscoroutinefunction(getattr(executor, "__call__", None))
    result: Any
    if is_async:
        result = await executor(runtime, params, inputs)
    else:
        result = await asyncio.to_thread(cast(Callable[..., Any], executor), runtime, params, inputs)
    if inspect.isawaitable(result):
        result = await cast(Awaitable[Any], result)
    return result


def _make_node_fn(
    node: Node,
    executor: Executor,
    incoming_edges: list[Edge],
    resource_accessor: ResourceAccessor | None = None,
    *,
    run_budget: RunBudget | None = None,
    capability_groups: list[str] | None = None,
    output_schema: dict[str, Any] | None = None,
    prompt_preview_agent: str | None = None,
    review_target: str | None = None,
    review_retry_target: bool = False,
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

    When the node requests an idempotency key (``params.idempotency``) it is
    injected into the executor params as ``__idempotency_key`` for the tool
    executors to forward.

    When *resource_accessor* is supplied, it runs after the breakpoint gate and
    its write accesses are held as cross-process locks around the executor call
    only; read-only accesses do not lock.

    ``review_target`` is the compiler-resolved target of a ``human:review``
    node's rejected edge.  It is injected into the executor params so the task
    snapshot can show which AI node will retry.
    """
    from deerflow.workflow.registry import WorkflowExecutionError  # deferred import — avoids module-level cycle

    # Every target input port has at most one incoming edge (validated at save
    # and compile time), so input resolution is a single state-key lookup.
    port_keys: dict[str, str] = {edge.target_port: f"wf:{edge.source}:{edge.source_port}" for edge in incoming_edges}

    def _resolve_input(state: dict[str, Any], port_name: str) -> Any:
        key = port_keys.get(port_name)
        if key is None:
            return state.get(f"wf:{node.id}:{port_name}")
        return state.get(key)

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
            executor_params.setdefault(
                "capability_groups",
                list(capability_groups) if capability_groups is not None else list(node.capability_groups),
            )
            executor_params.setdefault("node_id", node.id)
            if output_schema is not None:
                executor_params[OUTPUT_SCHEMA_PARAM] = output_schema
            if review_retry_target:
                # The first template turn must persist its session so a later
                # rejected review can continue the same conversation.
                executor_params["__review_session"] = True
        if node.type == NodeType.AI_PROMPT_PREVIEW:
            executor_params = dict(node.params)
            if prompt_preview_agent:
                executor_params.setdefault("agent_node", prompt_preview_agent)
            executor_params.setdefault("node_id", node.id)
        if node.type == NodeType.HUMAN_TASK:
            executor_params = dict(node.params)
            executor_params.setdefault("node_id", node.id)
            from deerflow.workflow.human_task_state import derive_output_spec  # deferred import — keeps the compiler's import graph free of a human-task cycle

            executor_params.setdefault("output_spec", derive_output_spec(node))
        if node.type == NodeType.HUMAN_REVIEW:
            executor_params = dict(node.params)
            executor_params.setdefault("node_id", node.id)
            executor_params.setdefault(REVIEW_TARGET_PARAM, review_target)
        if node.type == NodeType.FLOW_HANDOFF:
            # §24.6a: the handoff executor needs its own node id to read the
            # reserved handoff counter (its budget) — a definition cannot know
            # which run it is in, and there is no other channel for that.
            executor_params = dict(node.params)
            executor_params.setdefault("node_id", node.id)

        # §25 debugging: an explicit breakpoint suspends the node *before* it
        # executes, so an operator can inspect state and then resume (or skip).
        # Single-step mode (a run-level switch) does the same for **every** node.
        # A node that stepped is not paused again by its own breakpoint — one
        # pause per node visit.
        from deerflow.workflow.breakpoint import STEP_SNAPSHOT_KIND, breakpoint_requested, run_breakpoint, step_mode_requested

        paused = False
        if step_mode_requested(runtime_context):
            step_decision = await run_breakpoint(runtime, node_id=node.id, node_type=node.type.value, kind=STEP_SNAPSHOT_KIND)
            paused = True
            if step_decision.skipped:
                # Same contract as a skipped ``human:task``: continue with the
                # node's output ports unset.
                return {}
        if not paused and breakpoint_requested(executor_params):
            decision = await run_breakpoint(runtime, node_id=node.id, node_type=node.type.value)
            if decision.skipped:
                return {}

        # N14 §24.7: a node that asks for an idempotency key gets a stable one
        # (per run+node) injected for the tool executors to forward, so an
        # external system can dedupe repeated invocations.
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

        duration_ms: float | None = None
        if result is None:
            # N13: the compiler, not the author, owns resource locking.  The
            # accessor runs after the breakpoint gate (a pending human pause
            # must not hold a file lock) and only write access participates.
            accesses = tuple(resource_accessor(runtime, executor_params, inputs)) if resource_accessor is not None else ()
            try:
                async with hold_resource_locks(accesses):
                    # N14x: node timing.  Measured around the *work* segment
                    # only — human waits and lock waits are
                    # excluded, because none of them is node execution cost.
                    _started = time.perf_counter()
                    result = await _resolve_executor(executor, runtime, executor_params, inputs)
                    duration_ms = round((time.perf_counter() - _started) * 1000, 3)
                    if replay_session is not None and replay_mode == REPLAY_MODE_RECORD:
                        replay_session.record(node_id=node.id, node_type=node.type.value, inputs=inputs, outputs=result)
            except ResourceLockError as exc:
                raise WorkflowExecutionError(f"node '{node.id}': {exc}") from exc

        outputs: dict[str, Any] = {}
        for p in node.outputs:
            if p.name in result:
                outputs[f"wf:{node.id}:{p.name}"] = result[p.name]

        # Human review routes on a reserved decision channel, not on the
        # approved/rejected payload values: an approved value may legitimately
        # be None/empty, and routing must still select the approved branch.
        if node.type == NodeType.HUMAN_REVIEW:
            decision = result.get(REVIEW_DECISION_CHANNEL)
            if decision in (REVIEW_DECISION_APPROVED, REVIEW_DECISION_REJECTED):
                outputs[review_state_key(node.id, REVIEW_DECISION_CHANNEL)] = decision
            visit = result.get(REVIEW_VISIT_CHANNEL)
            if isinstance(visit, int) and not isinstance(visit, bool) and visit > 0:
                outputs[review_state_key(node.id, REVIEW_VISIT_CHANNEL)] = visit

        # N14x: every node reports how long its work took, on the reserved
        # channel declared in ``_build_state_schema``.  A replayed node writes
        # nothing — it did no work, and reporting ~0ms would be a lie that
        # makes a replay look like an instant real run.
        if duration_ms is not None:
            outputs[f"wf:{node.id}:__duration_ms"] = duration_ms

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
            # Full assembled prompt, consumed by an ``ai:prompt_preview`` node
            # rather than exposed as a declared output port.
            prompt = result.get("__workflow_prompt")
            if isinstance(prompt, str):
                outputs[f"wf:{node.id}:__prompt"] = prompt

        # N14 shared workspace: an executor may request writes to shared
        # variables through the reserved ``__shared_writes`` result key; lift
        # each onto its ``wf:shared:<name>`` channel (declared in
        # ``_build_state_schema``, reducer attached for ``array`` policy).
        shared_writes = result.get("__shared_writes")
        if isinstance(shared_writes, dict):
            for shared_name, shared_value in shared_writes.items():
                outputs[f"{SHARED_CHANNEL_PREFIX}{shared_name}"] = shared_value

        # §24.6a controlled dynamic handoff: the executor reports its cumulative
        # handoff count on the reserved channel declared in
        # ``_build_state_schema``.  That is what its own ``max_handoffs`` budget
        # reads on the next visit, so the count must round-trip through state
        # rather than living in the executor.
        if node.type == NodeType.FLOW_HANDOFF:
            handoff_count = result.get(HANDOFF_COUNT_CHANNEL)
            if isinstance(handoff_count, int) and not isinstance(handoff_count, bool):
                outputs[f"wf:{node.id}:{HANDOFF_COUNT_CHANNEL}"] = handoff_count

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


def _resolve_loop_body_ports(node: Node, child: WorkflowDefinition) -> tuple[str | None, str | None]:
    """Resolve a ``flow:loop``'s ``params.seed_input`` / ``params.ring_port`` against its body.

    ``seed_input`` names the body start-node port that receives this round's input
    and ``ring_port`` names the body end-node port whose value becomes the next
    round's input (and the newest ``last`` / ``results`` entry).  Both default to
    ``"in"`` / ``"out"``, so an ordinary body needs no configuration.

    The two defaults are **optional by design**: a body that declares neither port
    is a legitimate "run this N times" body with no dataflow ring, and the loop
    then aggregates nothing.  An *explicitly* named port that does not exist is a
    typo the author intended something by, so it fails loudly instead of silently
    degrading to a body with no ring — the same split the rest of the compiler uses
    between a documented default and an expressed intent.
    """
    child_start = next((n for n in child.nodes if n.type == NodeType.FLOW_START), None)
    child_end = next((n for n in child.nodes if n.type == NodeType.FLOW_END), None)
    # Subgraph inputs are injected as ``wf:<start>:<port>``, which the state schema
    # only declares for the start node's *output* ports — the same convention
    # ``nested:subworkflow`` / ``flow:try`` mappings follow.
    start_ports = {p.name for p in child_start.outputs} if child_start is not None else set()
    end_ports = {p.name for p in child_end.outputs} if child_end is not None else set()

    raw_seed = node.params.get("seed_input")
    if raw_seed is None:
        seed_input = "in" if "in" in start_ports else None
    else:
        if not isinstance(raw_seed, str) or raw_seed not in start_ports:
            raise WorkflowCompileError(f"node '{node.id}': 'seed_input' port {raw_seed!r} not found in the loop body's start node outputs (available: {sorted(start_ports)})")
        seed_input = raw_seed

    raw_ring = node.params.get("ring_port")
    if raw_ring is None:
        ring_port = "out" if "out" in end_ports else None
    else:
        if not isinstance(raw_ring, str) or raw_ring not in end_ports:
            raise WorkflowCompileError(f"node '{node.id}': 'ring_port' port {raw_ring!r} not found in the loop body's end node outputs (available: {sorted(end_ports)})")
        ring_port = raw_ring

    return seed_input, ring_port


def _make_loop_body_node_fn(
    node: Node,
    body: CompiledStateGraph,
    body_start_id: str,
    body_end_id: str,
    *,
    seed_input: str | None,
    ring_port: str | None,
    map_outputs: dict[str, str],
    incoming_edges: list[Edge],
) -> Callable[..., Any]:
    """Build the parent-graph node fn for a generated ``flow:loop`` body node.

    One execution = one round.  The round's input (the *ring*: the seed the author
    wired into the loop's ``in`` port on round 1, the previous round's result
    afterwards) is injected into the body's start port ``seed_input`` — the same
    ``wf:<start>:<port>`` convention ``nested:subworkflow`` / ``flow:try`` use —
    the body runs in its own isolated child graph, and its end port ``ring_port``
    is written to the loop's reserved ring channel.  ``mapping.outputs`` maps
    further body end ports onto the loop's declared output ports, so a body can
    report more than the next round's input.

    LangGraph control-flow signals always propagate (see
    :func:`_control_flow_should_propagate`): an interrupt is transport, not a body
    failure, and turning it into a node error would break suspension outright.
    A genuine failure propagates too — the loop body is not a ``flow:try``; a body
    the author wants to tolerate belongs inside a ``flow:try``.
    """
    from deerflow.workflow.registry import WorkflowExecutionError  # deferred import — avoids module-level cycle

    ring_channel = f"wf:{node.id}:{LOOP_RING_CHANNEL}"
    seed_key_map: dict[str, str] = {}
    for edge in incoming_edges:
        seed_key_map[edge.target_port] = f"wf:{edge.source}:{edge.source_port}"
    mapping = node.params.get("mapping") or {}
    map_inputs = (mapping or {}).get("inputs") or {}

    async def _node_fn(state: dict[str, Any]) -> dict[str, Any]:
        # The ring: the previous round's result when there is one, else the seed.
        seed = state.get(seed_key_map.get("in", f"wf:{node.id}:in"))
        ring = state[ring_channel] if ring_channel in state else seed

        sub_input: dict[str, Any] = {}
        if seed_input is not None:
            sub_input[f"wf:{body_start_id}:{seed_input}"] = _copy_on_write(ring)
        for child_port, parent_ref in map_inputs.items():
            if isinstance(parent_ref, str) and parent_ref.startswith("wf:"):
                sub_input[f"wf:{body_start_id}:{child_port}"] = _copy_on_write(state.get(parent_ref))
            elif isinstance(parent_ref, str):
                # A bare name is one of the loop's own input ports (or ``in``):
                # resolve it through the loop's incoming-edge key map, the same way
                # ``_make_try_node_fn`` resolves its inputs.
                sub_input[f"wf:{body_start_id}:{child_port}"] = _copy_on_write(state.get(seed_key_map.get(parent_ref, f"wf:{node.id}:{parent_ref}")))
            else:
                sub_input[f"wf:{body_start_id}:{child_port}"] = _copy_on_write(parent_ref)

        try:
            config = get_config()
        except Exception:
            config = {}

        try:
            result = await body.ainvoke(sub_input, config)
        except Exception as exc:  # noqa: BLE001 — re-raised below unless it is control flow
            if _control_flow_should_propagate(exc, catch_recursion=False):
                raise
            raise WorkflowExecutionError(f"{node.id} > body > {exc}") from exc

        outputs: dict[str, Any] = {}
        if ring_port is not None:
            outputs[ring_channel] = result.get(f"wf:{body_end_id}:{ring_port}")
        for child_port, parent_port in map_outputs.items():
            outputs[f"wf:{node.id}:{parent_port}"] = result.get(f"wf:{body_end_id}:{child_port}")
        return outputs

    return _node_fn


def _register_loop_body_node(
    node: Node,
    ctx: CompileContext,
    *,
    depth: int,
    visiting: set[str],
    chain_path: list[str],
    incoming_edges: list[Edge],
    add_node: Callable[[str, Callable[..., Any]], None],
) -> tuple[str, frozenset[str]]:
    """Expand and register the generated body node of a ``flow:loop``.

    Returns ``(body_node_id, report_ports)`` where ``report_ports`` are the loop
    output ports that ``mapping.outputs`` makes the body write (Pass B resolves
    ``params.continue_on`` against them).

    The node id is ``<loop_id>.body`` — ``.`` is outside the definition-id grammar
    (``[A-Za-z0-9_-]``), so a generated name cannot collide with an authored node
    id, and it is not one of the two characters LangGraph reserves in node names
    (``:`` and ``|``).  It is registered **without** lifecycle events on
    purpose: it is an engine artifact, not a node the canvas knows, so a
    ``wf:node:*`` event naming it would map to nothing.  The loop's own started /
    completed / failed event already tells the story of the round; the body's node
    events keep their child-graph depth (≥ 1) and are filtered out exactly like
    any other expanded subgraph's.
    """
    body_spec = parse_loop_body_spec(node)
    assert body_spec is not None, "caller must pass a loop with a params-declared body"

    body_graph, body_def = _expand_subworkflow(node, ctx, depth=depth, visiting=visiting, chain_path=chain_path)
    body_start_id = next((n.id for n in body_def.nodes if n.type == NodeType.FLOW_START), "")
    body_end_id = next((n.id for n in body_def.nodes if n.type == NodeType.FLOW_END), "")
    seed_input, ring_port = _resolve_loop_body_ports(node, body_def)

    mapping = node.params.get("mapping") or {}
    map_outputs = (mapping or {}).get("outputs") or {}
    body_node_id = f"{node.id}{LOOP_BODY_NODE_SEP}body"
    body_fn = _make_loop_body_node_fn(
        node,
        body_graph,
        body_start_id,
        body_end_id,
        seed_input=seed_input,
        ring_port=ring_port,
        map_outputs=map_outputs,
        incoming_edges=incoming_edges,
    )
    add_node(body_node_id, body_fn)
    return body_node_id, frozenset(map_outputs.values())


def _resolve_loop_continue_key(
    node: Node,
    incoming_edges: list[Edge],
    *,
    body_mapped_ports: set[str],
    body_ring: str | None,
) -> str | None:
    """Resolve a ``flow:loop``'s ``params.continue_on`` to the state channel the route reads.

    Three legal spellings, tried in this order:

    1. the *source port* of one of the loop's incoming drawn edges — the classic
       inline-body dataflow ring (typically the body's back-edge port), read from
       that producer's channel;
    2. one of the loop's own output ports that a params-declared body writes
       (``mapping.outputs``, e.g. a body reporting ``needs_more``) — read from the
       loop's own channel;
    3. the params-declared body's result port (the ring) — read from the reserved
       ring channel.

    With a params-declared body the legal names are exactly known, so an
    unresolvable ``continue_on`` is a **compile error**: a typo there would
    silently disable the early exit, and a loop that never exits early looks
    exactly like a loop that had no reason to.  Without a body spec the loop keeps
    the documented inline behaviour (an unmatched name is a no-op), because there
    the legal set is whatever edges the author happened to draw.
    """
    continue_on = node.params.get("continue_on")
    if not isinstance(continue_on, str) or not continue_on:
        return None
    for edge in incoming_edges:
        if edge.source_port == continue_on:
            return f"wf:{edge.source}:{edge.source_port}"
    if continue_on in body_mapped_ports:
        return f"wf:{node.id}:{continue_on}"
    if body_ring is not None and node.params.get("ring_port", "out") == continue_on:
        return f"wf:{node.id}:{LOOP_RING_CHANNEL}"
    if node.params.get("subworkflow") is not None:
        allowed = sorted({edge.source_port for edge in incoming_edges} | body_mapped_ports | ({node.params.get("ring_port", "out")} if body_ring is not None else set()))
        raise WorkflowCompileError(f"node '{node.id}': 'continue_on' names '{continue_on}', which is neither an incoming edge's source port nor one of the body's report ports (available: {allowed})")
    return None


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
        resource_accessors=ctx.resource_accessors,
        checkpointer=None,
        definition_resolver=ctx.definition_resolver,
        max_nesting_depth=ctx.max_nesting_depth,
        max_delegation_depth=ctx.max_delegation_depth,
        model_profiles=ctx.model_profiles,
        available_model_names=ctx.available_model_names,
        model_context_windows=ctx.model_context_windows,
        default_model_name=ctx.default_model_name,
    )
    child_graph = _compile_impl(child, child_ctx, depth=depth + 1, visiting=child_visiting, chain_path=child_chain)
    return child_graph, child


def _validate_model_profiles(def_: WorkflowDefinition, ctx: CompileContext) -> None:
    """Validate ``ai:llm_agent`` -> model-profile references at compile time.

    The profile is the middle layer and the target is the actual configured
    model.  Unknown/disabled profiles and missing targets fail here rather than
    at execution.
    """
    for node in def_.nodes:
        params = node.params or {}
        if "model_profile" not in params:
            continue
        if node.type != NodeType.AI_LLM_AGENT:
            raise WorkflowCompileError(f"node '{node.id}': params.model_profile is only supported on 'ai:llm_agent' nodes")
        try:
            profile_id = parse_model_profile_id(params)
            if profile_id is None:  # pragma: no cover - guarded by the membership check
                continue
            resolve_model_profile(profile_id, ctx.model_profiles, ctx.available_model_names)
        except ModelProfileError as exc:
            raise WorkflowCompileError(f"node '{node.id}': {exc}") from exc


def _validate_breakpoints(def_: WorkflowDefinition) -> None:
    """Reject ``params.breakpoint`` where it could never take effect (§25).

    A breakpoint pauses a node *before it runs*; ``flow:start`` / ``flow:end``
    are graph sentinels with no node function, so a breakpoint there would be
    silently ignored — exactly the failure mode this validator exists to stop.
    ``breakpoint`` must also be a real boolean (``"true"`` is a config typo, not
    a breakpoint).
    """
    for node in def_.nodes:
        params = node.params or {}
        if "breakpoint" not in params:
            continue
        if not isinstance(params.get("breakpoint"), bool):
            raise WorkflowCompileError(f"node '{node.id}': breakpoint must be a boolean, got {params.get('breakpoint')!r}")
        if params.get("breakpoint") is True and node.type in (NodeType.FLOW_START, NodeType.FLOW_END):
            raise WorkflowCompileError(f"node '{node.id}': breakpoint is not supported on '{node.type.value}' (the node never executes)")


def _validate_handoff(def_: WorkflowDefinition) -> None:
    """Validate every ``flow:handoff`` node (§24.6a) at compile time.

    A handoff's routing comes from ``params.candidates`` rather than from
    definition edges, so everything that would otherwise be caught by the
    generic edge validation has to be checked here — and fail-loud, because a
    candidate list that silently lost an entry would route a supervisor's choice
    somewhere the author never listed:

    * the declaration itself parses (non-empty, unique values, budget range);
    * every candidate names a node **in this definition** ("registered experts");
    * a candidate is never the graph sentinels or the handoff itself;
    * the ``decision`` input and ``target`` output are declared, since the
      executor and the route function rely on both;
    * no definition edge leaves the handoff — params are the single source of
      routing truth (a drawn edge would otherwise become a second, conflicting
      route).
    """
    node_map = {node.id: node for node in def_.nodes}
    for node in def_.nodes:
        if node.type != NodeType.FLOW_HANDOFF:
            if node.params.get("candidates") is not None or node.params.get("max_handoffs") is not None:
                raise WorkflowCompileError(f"node '{node.id}': 'candidates'/'max_handoffs' are only supported on 'flow:handoff' (got '{node.type.value}')")
            continue
        try:
            spec = parse_handoff(node.params)
        except HandoffError as exc:
            raise WorkflowCompileError(f"node '{node.id}': {exc}") from exc

        for candidate in spec.candidates:
            if candidate.node not in node_map:
                raise WorkflowCompileError(f"node '{node.id}': handoff candidate '{candidate.value}' targets unknown node '{candidate.node}' (a handoff can only route to a node in this definition)")
            if candidate.node == node.id:
                raise WorkflowCompileError(f"node '{node.id}': handoff candidate '{candidate.value}' targets the handoff itself")
            if node_map[candidate.node].type in (NodeType.FLOW_START, NodeType.FLOW_END):
                raise WorkflowCompileError(f"node '{node.id}': handoff candidate '{candidate.value}' targets '{candidate.node}' ({node_map[candidate.node].type.value}); route to an expert and gate completion with a separate 'flow:if'")

        input_names = {port.name for port in node.inputs}
        if HANDOFF_DECISION_PORT not in input_names:
            raise WorkflowCompileError(f"node '{node.id}': flow:handoff requires an input port named '{HANDOFF_DECISION_PORT}' (the supervisor's selection)")
        output_names = {port.name for port in node.outputs}
        if HANDOFF_TARGET_PORT not in output_names:
            raise WorkflowCompileError(f"node '{node.id}': flow:handoff requires an output port named '{HANDOFF_TARGET_PORT}' (the resolved expert)")

        for edge in def_.edges:
            if edge.source == node.id:
                raise WorkflowCompileError(f"node '{node.id}': flow:handoff routes through 'params.candidates'; edge '{edge.source}'→'{edge.target}' must be removed")


def _validate_loop_bodies(def_: WorkflowDefinition) -> None:
    """Validate ``flow:loop`` nodes that declare a ``params.subworkflow`` body.

    A params-declared body is the single source of the loop's *body* routing, the
    same way a handoff's candidate list is the single source of its routing: the
    compiler generates the body edge and the back-edge, so a drawn conditional
    out-edge would be a second, conflicting answer to "which body runs?" — there
    is no sensible way to merge the two.

    The loop still needs somewhere to go when it finishes, so exactly one
    unconditioned out-edge is required: that is the exit.  Zero exits compiles a
    loop with no way out, and two make the exit ambiguous; both are errors rather
    than an arbitrary winner.
    """
    for node in def_.nodes:
        if node.type != NodeType.FLOW_LOOP or node.params.get("subworkflow") is None:
            continue
        out_edges = [edge for edge in def_.edges if edge.source == node.id]
        conditional = [edge for edge in out_edges if edge.condition is not None]
        defaults = [edge for edge in out_edges if edge.condition is None]
        if conditional:
            targets = sorted({edge.target for edge in conditional})
            raise WorkflowCompileError(f"node '{node.id}': flow:loop with a 'subworkflow' body must not draw conditional out-edges — the body is declared by params (found {len(conditional)} conditional edge(s) to {targets})")
        if not defaults:
            raise WorkflowCompileError(f"node '{node.id}': flow:loop with a 'subworkflow' body requires exactly one unconditioned exit edge; found none")
        if len(defaults) > 1:
            targets = sorted({edge.target for edge in defaults})
            raise WorkflowCompileError(f"node '{node.id}': flow:loop with a 'subworkflow' body has multiple exit edges {targets}; exactly one is allowed")


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


def _incoming_edges_for(node_id: str, edges: list[Edge]) -> list[Edge]:
    return [edge for edge in edges if edge.target == node_id]


def _resolve_ai_output_schema(
    node: Node,
    incoming_edges: list[Edge],
    node_map: dict[str, Node],
) -> dict[str, Any] | None:
    """Resolve an AI node's schema from its single ``output_schema`` input."""
    from deerflow.workflow.structured_output import StructuredOutputError, parse_output_schema

    schema_edges = [edge for edge in incoming_edges if edge.target_port == OUTPUT_SCHEMA_PORT]
    if not schema_edges:
        return None
    if len(schema_edges) > 1:  # validate_definition also rejects this
        raise WorkflowCompileError(f"node '{node.id}': input port '{OUTPUT_SCHEMA_PORT}' has multiple incoming edges")
    edge = schema_edges[0]
    source = node_map.get(edge.source)
    if source is None or source.type != NodeType.DATA_SCHEMA:
        raise WorkflowCompileError(f"node '{node.id}': '{OUTPUT_SCHEMA_PORT}' must come from a data:schema node")
    try:
        return parse_output_schema((source.params or {}).get("schema"))
    except StructuredOutputError as exc:
        raise WorkflowCompileError(f"node '{source.id}': invalid schema: {exc}") from exc


def _validate_output_schemas(def_: WorkflowDefinition) -> None:
    """Validate every AI node's static schema against its declared output ports."""
    from deerflow.workflow.structured_output import MAX_REPAIRS_LIMIT, SCHEMA_FIELD_TYPES

    node_map = {node.id: node for node in def_.nodes}
    for node in def_.nodes:
        if node.type != NodeType.AI_LLM_AGENT:
            continue
        schema = _resolve_ai_output_schema(node, _incoming_edges_for(node.id, def_.edges), node_map)
        if schema is None:
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


def _validate_ai_context_windows(def_: WorkflowDefinition, ctx: CompileContext) -> None:
    """Fail save/compile when an AI node's selected model has no context_window."""
    from deerflow.workflow.model_profiles import ModelProfileError, parse_model_profile_id, resolve_model_profile

    if ctx.default_model_name is None:
        return
    for node in def_.nodes:
        if node.type != NodeType.AI_LLM_AGENT:
            continue
        try:
            profile_id = parse_model_profile_id(node.params)
            if profile_id is not None:
                target = resolve_model_profile(profile_id, ctx.model_profiles, ctx.available_model_names)
            else:
                target = ctx.default_model_name
        except ModelProfileError as exc:
            raise WorkflowCompileError(f"node '{node.id}': {exc}") from exc
        if not target:
            raise WorkflowCompileError(f"node '{node.id}': no model is configured for this AI node")
        if target not in ctx.model_context_windows:
            raise WorkflowCompileError(f"node '{node.id}': model '{target}' has no context_window; set it in config.yaml models[]")
        try:
            resolve_context_compression(target, [type("_M", (), {"name": target, "context_window": ctx.model_context_windows[target]})()])
        except ContextCompressionError as exc:
            raise WorkflowCompileError(f"node '{node.id}': {exc}") from exc


def _reject_removed_ai_params(def_: WorkflowDefinition) -> None:
    """Reject legacy author-facing params removed from the AI node contract."""
    removed = ("autonomy", "context_policy", "memory", "retrieval", "model_policy", "merge", "output_schema")
    for node in def_.nodes:
        for key in removed:
            if (node.params or {}).get(key) is not None:
                raise WorkflowCompileError(f"node '{node.id}': params.{key} is no longer supported; migrate the workflow to the current AI node contract")


def _infer_prompt_preview_agent(
    node: Node,
    node_map: dict[str, Node],
    edges: list[Edge],
) -> str | None:
    """Resolve the AI node a prompt-preview node reads.

    An explicit ``params.agent_node`` wins and must name an ``ai:llm_agent``
    node.  Otherwise exactly one incoming AI edge is used; zero or several
    candidates are a compile error (an ambiguous preview would silently show
    the wrong prompt).
    """
    configured = node.params.get("agent_node")
    if configured is not None:
        if not isinstance(configured, str) or not configured:
            raise WorkflowCompileError(f"node '{node.id}': params.agent_node must be a non-empty AI node id")
        target = node_map.get(configured)
        if target is None:
            raise WorkflowCompileError(f"node '{node.id}': params.agent_node '{configured}' not found")
        if target.type != NodeType.AI_LLM_AGENT:
            raise WorkflowCompileError(f"node '{node.id}': params.agent_node '{configured}' is not an ai:llm_agent node")
        return configured

    candidates: list[str] = []
    for edge in edges:
        if edge.target != node.id:
            continue
        source = node_map.get(edge.source)
        if source is not None and source.type == NodeType.AI_LLM_AGENT:
            candidates.append(source.id)
    candidates = list(dict.fromkeys(candidates))
    if len(candidates) == 1:
        return candidates[0]
    if not candidates:
        raise WorkflowCompileError(f"node '{node.id}': prompt preview needs params.agent_node or an incoming edge from an ai:llm_agent node")
    raise WorkflowCompileError(f"node '{node.id}': prompt preview has multiple AI sources {candidates}; set params.agent_node explicitly")


def _validate_prompt_preview(def_: WorkflowDefinition) -> None:
    """Validate ``ai:prompt_preview`` targets at compile time."""
    node_map = {node.id: node for node in def_.nodes}
    for node in def_.nodes:
        if node.type != NodeType.AI_PROMPT_PREVIEW:
            continue
        _infer_prompt_preview_agent(node, node_map, def_.edges)


def _validate_idempotency(def_: WorkflowDefinition) -> None:
    """Compile-time validation for ``params.idempotency`` shape."""
    for node in def_.nodes:
        params = node.params or {}
        try:
            validate_idempotency_param(params)
        except IdempotencyParamError as exc:
            raise WorkflowCompileError(f"node '{node.id}': {exc}") from exc


def _validate_run_budget(def_: WorkflowDefinition) -> None:
    """Compile-time validation for the N14 §24.10 ``metadata.budget``."""
    try:
        parse_run_budget(def_.metadata.model_dump())
    except _BudgetError as exc:
        raise WorkflowCompileError(f"metadata.budget: {exc}") from exc


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
            key = f"wf:{if_node.id}:{condition_port}"
            # Presence, not truthiness: a selected branch may legitimately carry
            # 0 / "" / False.  The executor writes the unselected branch as None.
            if key in state and state.get(key) is not None:
                return target
        if default_target is None:
            raise WorkflowRouteError(f"if node '{if_node.id}': no condition matched and no default edge configured")
        return default_target

    return _route


# ── Compile entry point ───────────────────────────────────────────────────


def _make_review_route_fn(node_id: str, approved_target: str, rejected_target: str) -> Callable[[dict[str, Any]], str]:
    """Route a ``human:review`` node by its reserved decision channel.

    The payload on ``approved`` may legitimately be ``None`` (an upstream node
    produced no value), so routing on port presence would lose the approved
    branch.  The executor writes the explicit decision instead.
    """

    def _route(state: dict[str, Any]) -> str:
        decision = state.get(review_state_key(node_id, REVIEW_DECISION_CHANNEL))
        if decision == REVIEW_DECISION_APPROVED:
            return approved_target
        if decision == REVIEW_DECISION_REJECTED:
            return rejected_target
        raise WorkflowRouteError(f"review node '{node_id}': no valid decision (got {decision!r})")

    return _route


def _make_handoff_route_fn(node_id: str, targets: tuple[str, ...]) -> Callable[[dict[str, Any]], str]:
    """Build the routing function for a ``flow:handoff`` node (§24.6a).

    The executor writes the resolved expert id to ``wf:<node>:target``; the
    route returns it.  Unlike ``flow:switch`` there is deliberately **no**
    default: an unset target (the executor never ran, e.g. a node that was
    skipped) or a target outside the whitelist is a ``WorkflowRouteError``
    rather than a silent route — running an expert the supervisor did not pick
    is exactly the failure this primitive exists to prevent.
    """

    def _route(state: dict[str, Any]) -> str:
        target = state.get(f"wf:{node_id}:{HANDOFF_TARGET_PORT}")
        if isinstance(target, str) and target in targets:
            return target
        raise WorkflowRouteError(f"handoff node '{node_id}': no valid expert selected (got {target!r}; registered: {list(targets)})")

    return _route


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
    _validate_breakpoints(def_)
    _validate_handoff(def_)
    _validate_loop_bodies(def_)
    _validate_shared_nodes(def_)
    _reject_removed_ai_params(def_)
    _validate_model_profiles(def_, ctx)
    _validate_output_schemas(def_)
    _validate_ai_context_windows(def_, ctx)
    _validate_prompt_preview(def_)
    try:
        validate_capability_group_wiring(def_)
    except CapabilityGroupWiringError as exc:
        raise WorkflowCompileError(str(exc)) from exc
    _validate_idempotency(def_)
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

        Automatic resource locks (N13) are applied inside ``_make_node_fn``,
        after the breakpoint gate, so they do not need a wrapper here.
        """
        node = node_map.get(node_id)
        builder.add_node(node_id, _with_node_events(node_id, depth - 1, node_fn, node.type if node is not None else None))

    # Build lookup maps
    node_map: dict[str, Node] = {n.id: n for n in def_.nodes}
    start_node_id: str | None = None
    end_node_id: str | None = None

    # Capability-group selectors are compile-time wiring only. Their edges are
    # resolved into the AI node's params and must not become runtime graph edges
    # (a selector would otherwise need scheduling, and the AI node would gain a
    # second incoming edge / fan-in).
    config_node_ids = {node.id for node in def_.nodes if is_capability_group_node(node) or node.type == NodeType.DATA_SCHEMA}
    runtime_edges: list[Edge] = [edge for edge in def_.edges if edge.source not in config_node_ids and edge.target not in config_node_ids]

    # Build incoming-edges index for input resolution
    incoming_edges: dict[str, list[Edge]] = {n.id: [] for n in def_.nodes}
    for edge in runtime_edges:
        incoming_edges[edge.target].append(edge)

    # ``flow:loop`` id → (generated body node id, the loop output ports that body
    # writes), for loops whose body is declared by ``params.subworkflow``.
    # Filled in Pass A, consumed in Pass B.
    loop_bodies: dict[str, tuple[str, frozenset[str]]] = {}

    # A rejected review edge points at an AI node whose first template turn must
    # persist a session so the retry can continue it.  The same target id also
    # tells the review executor which node the task snapshot describes.
    review_targets = {edge.target for edge in runtime_edges if edge.source_port == REVIEW_REJECTED_PORT and node_map.get(edge.source) is not None and node_map[edge.source].type == NodeType.HUMAN_REVIEW}

    def _make_standard_node_fn(node: Node, executor: Executor) -> Callable[..., Any]:
        capability_groups: list[str] | None = None
        output_schema: dict[str, Any] | None = None
        if node.type == NodeType.AI_LLM_AGENT:
            try:
                capability_groups = resolve_ai_capability_groups(def_, node)
            except CapabilityGroupWiringError as exc:
                raise WorkflowCompileError(str(exc)) from exc
            output_schema = _resolve_ai_output_schema(node, _incoming_edges_for(node.id, def_.edges), node_map)
        prompt_preview_agent: str | None = None
        if node.type == NodeType.AI_PROMPT_PREVIEW:
            prompt_preview_agent = _infer_prompt_preview_agent(node, node_map, def_.edges)
        review_target = None
        if node.type == NodeType.HUMAN_REVIEW:
            review_target = next((edge.target for edge in runtime_edges if edge.source == node.id and edge.source_port == REVIEW_REJECTED_PORT), None)
        return _make_node_fn(
            node,
            executor,
            incoming_edges.get(node.id, []),
            ctx.resource_accessors.get(node.type),
            run_budget=run_budget,
            capability_groups=capability_groups,
            output_schema=output_schema,
            prompt_preview_agent=prompt_preview_agent,
            review_target=review_target,
            review_retry_target=node.id in review_targets,
        )

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

        if is_capability_group_node(node) or node.type == NodeType.DATA_SCHEMA:
            # Authoring-only: resolved into AI params and stripped from edges.
            continue

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

            # A params-declared body (validated in ``_validate_loop_bodies``) makes
            # the body a generated child-graph node; the loop then reads each
            # round's input from the reserved ring channel instead of a drawn
            # back-edge.
            ring_key: str | None = None
            if parse_loop_body_spec(node) is not None:
                ring_key = f"wf:{node.id}:{LOOP_RING_CHANNEL}"

            async def _loop_node_fn(
                state: dict[str, Any],
                *,
                _lid: str = loop_id,
                _in_edges: tuple[tuple[str, str], ...] = loop_in_edges,
                _out_ports: frozenset[str] = loop_out_ports,
                _ring_key: str | None = ring_key,
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
                # From round 2 on a params-declared body has fed the previous
                # round's result back through the reserved ring channel, which is
                # this round's input — the drawn back-edge's role, played by the
                # engine instead of by an edge.  A body that produces no ring value
                # (no declared result port) never sets the channel, so this stays
                # false for every round and the loop is a pure "run N times" body.
                ring_present = _ring_key is not None and current >= 1 and _ring_key in state
                if ring_present and _ring_key is not None:
                    in_value = state.get(_ring_key)
                else:
                    in_value = state.get(in_state_key) if in_state_key is not None else None
                outputs[f"wf:{_lid}:out"] = in_value
                # C5 aggregation: collect each round's *body output* into ``results``
                # in iteration order and expose ``last``.  The seed value (round 1)
                # is not a body output and is not collected; for a params-declared
                # body the round's output exists exactly when the body wrote its
                # ring value — so a ringless body aggregates nothing instead of
                # reporting the seed once per round as if it had produced it.
                # Accumulation lives on a reserved channel so a node declaring only
                # ``last`` still gets the full history.
                if "results" in _out_ports or "last" in _out_ports:
                    acc_key = f"wf:{_lid}:__results"
                    prior = state.get(acc_key)
                    results: list[Any] = list(prior) if isinstance(prior, list) else []
                    if ring_present or (_ring_key is None and current >= 1):
                        results.append(in_value)
                    outputs[acc_key] = results
                    if "results" in _out_ports:
                        outputs[f"wf:{_lid}:results"] = results
                    if "last" in _out_ports:
                        outputs[f"wf:{_lid}:last"] = results[-1] if results else None
                return outputs

            _register(node.id, _loop_node_fn)
            if ring_key is not None:
                # Expand + register the generated body node, and remember it for
                # Pass B (which wires the loop's conditional edge to it).
                body_node_id, body_report_ports = _register_loop_body_node(node, ctx, depth=depth, visiting=visiting, chain_path=chain_path, incoming_edges=incoming_edges.get(node.id, []), add_node=builder.add_node)
                loop_bodies[node.id] = (body_node_id, body_report_ports)
                builder.add_edge(body_node_id, node.id)  # generated back-edge
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
                node_fn = _make_standard_node_fn(node, executor)
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

        node_fn = _make_standard_node_fn(node, executor)
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
    for edge in runtime_edges:
        source = edge.source
        target = edge.target

        # Edges from start node → LangGraph START.  A direct start→end graph is
        # legal, so the target still goes through ``_end_target`` (END sentinel
        # or the pass-through end node).
        if source == start_node_id:
            builder.add_edge(START, _end_target(target))
            continue

        # All edges from conditional nodes (if / switch / loop / handoff) are
        # handled in Pass B — both conditional AND default edges.
        # Adding the default edge here would unconditionally fire the
        # default target alongside any routed branch.
        src_node = node_map[source]
        if src_node.type in (NodeType.FLOW_IF, NodeType.FLOW_SWITCH, NodeType.FLOW_LOOP, NodeType.FLOW_HANDOFF, NodeType.HUMAN_REVIEW):
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

    # Pass B: conditional edges from if / switch / loop / handoff nodes
    for node in def_.nodes:
        if node.type not in (NodeType.FLOW_IF, NodeType.FLOW_SWITCH, NodeType.FLOW_LOOP, NodeType.FLOW_HANDOFF, NodeType.HUMAN_REVIEW):
            continue

        cond_id = node.id

        if node.type == NodeType.HUMAN_REVIEW:
            approved = next(edge for edge in runtime_edges if edge.source == cond_id and edge.source_port == REVIEW_APPROVED_PORT)
            rejected = next(edge for edge in runtime_edges if edge.source == cond_id and edge.source_port == REVIEW_REJECTED_PORT)
            approved_target = _end_target(approved.target)
            rejected_target = _end_target(rejected.target)
            builder.add_conditional_edges(
                cond_id,
                _make_review_route_fn(cond_id, approved.target, rejected.target),
                {approved.target: approved_target, rejected.target: rejected_target},
            )
            continue

        # §24.6a: a handoff's routes come from ``params.candidates`` (validated
        # in ``_validate_handoff``), not from definition edges — the candidate
        # list is the single source of routing truth, so it has no default edge
        # and no drawn edges to interpret.
        if node.type == NodeType.FLOW_HANDOFF:
            spec = parse_handoff(node.params)
            targets = spec.targets()
            handoff_path_map = {target: target for target in targets}
            builder.add_conditional_edges(cond_id, _make_handoff_route_fn(cond_id, targets), handoff_path_map)
            continue

        out_edges = [e for e in runtime_edges if e.source == cond_id]

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

        # A ``flow:loop`` with a params-declared body has *no* drawn conditional
        # edge (validated in ``_validate_loop_bodies``): its body edge is the one
        # the compiler generates, so it must be wired here — before the "no
        # conditional edges → nothing to do" early-out that would otherwise leave
        # the loop with no outgoing edge at all.
        body = loop_bodies.get(cond_id)
        if body is not None:
            body_node_id = body[0]
            _body_default: str = cast(str, default_target)
            continue_key = _resolve_loop_continue_key(node, incoming_edges.get(node.id, []), body_mapped_ports=set(body[1]), body_ring=LOOP_RING_CHANNEL)

            def _make_body_route(lid: str, max_it: int, body_target: str, dflt: str, cont_key: str | None) -> Callable[[dict[str, Any]], str]:
                def _route(state: dict[str, Any]) -> str:
                    count = state.get(f"wf:{lid}:__count", 0)
                    if count <= max_it:
                        if cont_key is not None and count >= 1 and cont_key in state and not state.get(cont_key):
                            return dflt
                        return body_target
                    return dflt

                return _route

            builder.add_conditional_edges(cond_id, _make_body_route(cond_id, node.params.get("iterations", 1), body_node_id, _body_default, continue_key), {body_node_id: body_node_id, _body_default: _body_default})
            continue

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
            # safe no-op (count-only loop) — unless the loop has a
            # params-declared body, whose routing was already wired above (the
            # legal names are known exactly there, so an unmatched one is a
            # compile error caught in that branch).
            continue_key = _resolve_loop_continue_key(node, incoming_edges.get(loop_id, []), body_mapped_ports=set(), body_ring=None)

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
