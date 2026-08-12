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
- ``flow:parallel`` compiles to a pass-through node — multiple regular
  out edges produce LangGraph native fan-out parallelism.
- Compile cache keys combine the definition hash *and* the set of
  registered ``NodeType`` values from ``CompileContext.executors``.
  Two calls with the same definition but different executor sets
  produce different compiled graphs.  The fingerprint is
  intentionally coarse (``NodeType`` set only, not per-executor
  identity) because callables cannot be reliably hashed and the
  T5 registry semantics map ``NodeType`` → executor globally.
"""

from __future__ import annotations

import hashlib
import inspect
import threading
from collections.abc import Awaitable, Callable
from dataclasses import dataclass, field
from typing import Any, cast

from langgraph.config import get_config  # type: ignore[import-untyped]
from langgraph.graph import END, START, StateGraph
from langgraph.graph.state import CompiledStateGraph

from deerflow.workflow.schema import Edge, Node, NodeType, WorkflowDefinition
from deerflow.workflow.workflow_io import serialize, validate_definition

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


class WorkflowRouteError(RuntimeError):
    """Execution-time error — conditional edge with no matching condition and no default edge."""


@dataclass
class CompileContext:
    """Compilation context holding the executor registry.

    Each ``NodeType`` that appears in the workflow must have a registered
    ``Executor`` callable, otherwise compilation raises
    :class:`WorkflowCompileError`.
    """

    executors: dict[NodeType, Executor] = field(default_factory=dict)
    checkpointer: Any | None = None


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
    """
    digest = hashlib.sha256(serialize(def_).encode("utf-8"))
    if context is not None and context.executors:
        type_fp = "|".join(sorted(t.value for t in context.executors))
        digest.update(f"\0executors:{type_fp}".encode())
    if context is not None and context.checkpointer is not None:
        digest.update(f"\0checkpointer:{id(context.checkpointer)}".encode())
    return digest.hexdigest()


def _build_state_schema(def_: WorkflowDefinition) -> type:
    """Build a dynamic ``TypedDict`` whose fields cover every output port.

    Keys follow the convention ``wf:<node_id>:<port_name>``, all typed
    ``Any`` and optional (``total=False``).  LangGraph will only persist
    fields declared here — undeclared writes are silently dropped.

    Additionally, every ``flow:loop`` node gets a ``wf:<loop_id>:__count``
    field for the loop iteration counter.
    """
    fields: dict[str, Any] = {}
    for node in def_.nodes:
        for port in node.outputs:
            fields[f"wf:{node.id}:{port.name}"] = Any
        if node.type == NodeType.FLOW_LOOP:
            fields[f"wf:{node.id}:__count"] = Any
    # Create the TypedDict dynamically — total=False so all fields are optional.
    schema: type = type("WorkflowState", (dict,), {"__annotations__": fields, "__total__": False})
    return schema


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
    """
    # Build input-port → state-key mapping from incoming edges
    input_key_map: dict[str, str] = {}
    for edge in incoming_edges:
        input_key_map[edge.target_port] = f"wf:{edge.source}:{edge.source_port}"

    async def _node_fn(state: dict[str, Any]) -> dict[str, Any]:
        inputs: dict[str, Any] = {}
        for p in node.inputs:
            state_key = input_key_map.get(p.name, f"wf:{node.id}:{p.name}")
            inputs[p.name] = state.get(state_key)

        # Build WorkflowRuntime from LangGraph's runnable config context.
        # get_config() is available inside LangGraph node execution.
        # Fall back to empty runtime when running outside a LangGraph
        # context (e.g. tests that invoke the node fn directly).
        try:
            config = get_config()
            runtime = WorkflowRuntime(
                context=config.get("context", {}),
                config=config,
                state=state,
            )
        except Exception:
            runtime = WorkflowRuntime(state=state)

        result = await _resolve_executor(executor, runtime, node.params, inputs)

        outputs: dict[str, Any] = {}
        for p in node.outputs:
            if p.name in result:
                outputs[f"wf:{node.id}:{p.name}"] = result[p.name]

        return outputs

    return _node_fn


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
            registrations and overrides.  If ``None``, an empty context
            is used (which means every non-control-flow node will fail
            compilation unless executors are registered).

    Returns:
        A compiled LangGraph graph ready for ``ainvoke`` / ``astream``.

    Raises:
        WorkflowCompileError: The definition is invalid or a required
            executor is missing.
    """
    ctx = context or CompileContext()

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

    # ── 2. Build dynamic state schema ──────────────────────────────────
    state_schema = _build_state_schema(def_)

    # ── 3. Create StateGraph builder ───────────────────────────────────
    builder = StateGraph(state_schema)

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
            continue  # end node → LangGraph END, no add_node

        if node.type == NodeType.FLOW_LOOP:
            # Loop node: register a counting executor that reads/writes
            # wf:<loop_id>:__count in state and outputs nothing (or empty).
            loop_id = node.id
            iterations = node.params.get("iterations", 1)

            async def _loop_node_fn(state: dict[str, Any], *, _lid: str = loop_id, _max: int = iterations) -> dict[str, Any]:
                count_key = f"wf:{_lid}:__count"
                current: int = state.get(count_key, 0)
                return {count_key: current + 1}

            builder.add_node(node.id, _loop_node_fn)
            continue

        if node.type == NodeType.FLOW_PARALLEL:
            # Parallel node: pass-through executor — inputs go straight to
            # outputs; LangGraph's native fan-out from multiple regular
            # out edges handles the parallelism.
            async def _parallel_node_fn(state: dict[str, Any]) -> dict[str, Any]:  # noqa: ARG001
                return {}

            builder.add_node(node.id, _parallel_node_fn)
            continue

        if node.type == NodeType.FLOW_SWITCH:
            # FLOW_SWITCH is a routing node — if CompileContext provides
            # an executor use it (custom branch selection); otherwise
            # register a built-in pass-through (output ports stay unset,
            # route always falls through to default).
            executor = ctx.executors.get(node.type)
            if executor is not None:
                node_fn = _make_node_fn(node, executor, incoming_edges.get(node.id, []))
                builder.add_node(node.id, node_fn)
            else:

                async def _switch_builtin(state: dict[str, Any]) -> dict[str, Any]:  # noqa: ARG001
                    return {}

                builder.add_node(node.id, _switch_builtin)
            continue

        if node.type == NodeType.FLOW_WAIT:
            # FLOW_WAIT is a normal node that gets resolved via executor
            # lookup (T5-3 registers the actual wait executor).
            pass

        # Bind executor (for non-control-flow nodes including FLOW_WAIT)
        executor = ctx.executors.get(node.type)
        if executor is None:
            raise WorkflowCompileError(f"node '{node.id}' type '{node.type.value}' has no registered executor in CompileContext")

        node_fn = _make_node_fn(node, executor, incoming_edges.get(node.id, []))
        builder.add_node(node.id, node_fn)

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

        # Edges to end node → LangGraph END
        if target == end_node_id:
            builder.add_edge(source, END)
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
                target = END if edge.target == end_node_id else edge.target
                cond_edges.append((edge.condition, target))
            else:
                # Default (unconditional) edge
                if default_target is not None:
                    raise WorkflowCompileError(f"conditional node '{cond_id}' has multiple default edges (only one allowed)")
                default_target = END if edge.target == end_node_id else edge.target

        # Validate: if there are conditional edges, a default edge is required
        if cond_edges and default_target is None:
            raise WorkflowCompileError(f"conditional node '{cond_id}' requires a default edge (no condition)")

        if not cond_edges:
            continue  # no conditional edges — regular edges already handled in Pass A

        # default_target is guaranteed non-None here (guarded above)
        _default: str = cast(str, default_target)

        # For loop nodes: build a route function that compares the
        # iteration counter against the configured ``iterations``.
        if node.type == NodeType.FLOW_LOOP:
            loop_id = node.id
            max_iterations: int = node.params.get("iterations", 1)

            def _make_loop_route(
                lid: str,
                max_it: int,
                conds: list[tuple[str, str]],
                dflt: str,
            ) -> Callable[[dict[str, Any]], str]:
                def _route(state: dict[str, Any]) -> str:
                    count = state.get(f"wf:{lid}:__count", 0)
                    if count <= max_it:
                        # Route to the body entry (the conditional edge target)
                        for _condition_port, body_target in conds:
                            return body_target
                    return dflt

                return _route

            loop_route = _make_loop_route(loop_id, max_iterations, cond_edges, _default)
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

    # ── 6. Compile ────────────────────────────────────────────────────
    compiled = builder.compile(checkpointer=ctx.checkpointer)

    # ── 7. Cache and return ───────────────────────────────────────────
    with _compile_cache_lock:
        _compile_cache[cache_key] = compiled

    return compiled
