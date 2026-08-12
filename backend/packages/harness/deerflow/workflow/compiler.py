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
- ``flow:if`` conditional edges are compiled into
  ``add_conditional_edges`` with a route function that reads output
  ports from state and falls back to a mandatory default edge.
- ``flow:loop`` / ``flow:parallel`` are NOT implemented in v1.
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

from langgraph.graph import END, START, StateGraph
from langgraph.graph.state import CompiledStateGraph

from deerflow.workflow.schema import Edge, Node, NodeType, WorkflowDefinition
from deerflow.workflow.workflow_io import serialize, validate_definition

# ── Public types ───────────────────────────────────────────────────────────

# Executor contract:
#   (params: dict[str, Any], inputs: dict[port_name, value]) → dict[port_name, value]
# Supports both sync and async-returning implementations.
Executor = Callable[[dict[str, Any], dict[str, Any]], dict[str, Any] | Awaitable[dict[str, Any]]]


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
    return digest.hexdigest()


def _build_state_schema(def_: WorkflowDefinition) -> type:
    """Build a dynamic ``TypedDict`` whose fields cover every output port.

    Keys follow the convention ``wf:<node_id>:<port_name>``, all typed
    ``Any`` and optional (``total=False``).  LangGraph will only persist
    fields declared here — undeclared writes are silently dropped.
    """
    fields: dict[str, Any] = {}
    for node in def_.nodes:
        for port in node.outputs:
            fields[f"wf:{node.id}:{port.name}"] = Any
    # Create the TypedDict dynamically — total=False so all fields are optional.
    schema: type = type("WorkflowState", (dict,), {"__annotations__": fields, "__total__": False})
    return schema


async def _resolve_executor(
    executor: Executor,
    params: dict[str, Any],
    inputs: dict[str, Any],
) -> dict[str, Any]:
    """Call executor and ``await`` if the result is awaitable.

    Supports sync executors (return plain dict) and async executors
    (return coroutine / awaitable).
    """
    result = executor(params, inputs)
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

        result = await _resolve_executor(executor, node.params, inputs)

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
            raise WorkflowCompileError(f"node '{node.id}' type 'flow:loop' not yet supported by compiler v1 (T5/T9)")
        if node.type == NodeType.FLOW_PARALLEL:
            raise WorkflowCompileError(f"node '{node.id}' type 'flow:parallel' not yet supported by compiler v1 (T5/T9)")

        # Bind executor
        executor = ctx.executors.get(node.type)
        if executor is None:
            raise WorkflowCompileError(f"node '{node.id}' type '{node.type.value}' has no registered executor in CompileContext")

        node_fn = _make_node_fn(node, executor, incoming_edges.get(node.id, []))
        builder.add_node(node.id, node_fn)

    # ── 5. Process edges ──────────────────────────────────────────────
    # We do two passes:
    #   Pass A — regular edges (including start→X and X→end).
    #   Pass B — conditional edges (from flow:if nodes, collected and
    #            compiled as add_conditional_edges).

    # Pass A: regular edges
    for edge in def_.edges:
        source = edge.source
        target = edge.target

        # Edges from start node → LangGraph START
        if source == start_node_id:
            builder.add_edge(START, target)
            continue

        # Skip conditional edges — handled in Pass B
        if edge.condition is not None:
            # Only flow:if nodes support conditional edges
            src_type = node_map[source].type
            if src_type != NodeType.FLOW_IF:
                raise WorkflowCompileError(f"edge from '{source}' to '{target}' has condition '{edge.condition}' but source node type is '{src_type.value}' (only 'flow:if' supports conditional edges)")
            continue

        # Edges to end node → LangGraph END
        if target == end_node_id:
            builder.add_edge(source, END)
            continue

        # Ordinary edge
        builder.add_edge(source, target)

    # Pass B: conditional edges from if nodes
    for node in def_.nodes:
        if node.type != NodeType.FLOW_IF:
            continue

        if_id = node.id
        out_edges = [e for e in def_.edges if e.source == if_id]

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
                    raise WorkflowCompileError(f"if node '{if_id}' has multiple default edges (only one allowed)")
                default_target = END if edge.target == end_node_id else edge.target

        # Validate: if there are conditional edges, a default edge is required
        if cond_edges and default_target is None:
            raise WorkflowCompileError(f"if node '{if_id}' requires a default edge (no condition)")

        if not cond_edges:
            continue  # no conditional edges — regular edges already handled in Pass A

        # default_target is guaranteed non-None here (guarded above)
        _default: str = cast(str, default_target)

        # Build route function and path_map
        route_fn = _make_route_fn(node, cond_edges, _default)

        # path_map maps route_fn return values to LangGraph node names.
        # We use an identity mapping because route_fn returns target names directly.
        path_map: dict[str, str] = {}
        for _, target in cond_edges:
            path_map[target] = target
        path_map[_default] = _default

        builder.add_conditional_edges(if_id, route_fn, path_map)

    # ── 6. Compile ────────────────────────────────────────────────────
    compiled = builder.compile()

    # ── 7. Cache and return ───────────────────────────────────────────
    with _compile_cache_lock:
        _compile_cache[cache_key] = compiled

    return compiled
