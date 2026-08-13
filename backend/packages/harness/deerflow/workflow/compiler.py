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
import json
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
        # LangGraph moves a top-level ``config["context"]`` into
        # ``config["configurable"]["context"]`` before a node runs, so read
        # both locations (top-level first for forward-compatibility).
        try:
            config = get_config()
            configurable = config.get("configurable", {}) or {}
            context = config.get("context") or configurable.get("context") or {}
            runtime = WorkflowRuntime(
                context=context,
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
        #    through unchanged.
        sub_input: dict[str, Any] = {}
        for child_port, parent_ref in map_inputs.items():
            if isinstance(parent_ref, str) and parent_ref.startswith("wf:"):
                sub_input[f"wf:{child_start_id}:{child_port}"] = state.get(parent_ref)
            elif isinstance(parent_ref, str) and parent_ref in inputs:
                sub_input[f"wf:{child_start_id}:{child_port}"] = inputs[parent_ref]
            else:
                sub_input[f"wf:{child_start_id}:{child_port}"] = parent_ref

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
        system_prompt = (
            f"你是一个工作流执行代理。你的任务是执行子工作流「{child_def.name}（{child_def.id}）」。\n"
            f"工作流输入端口：{', '.join(start_ports) or '（无）'}\n"
            f"工作流输出端口：{', '.join(end_ports) or '（无）'}\n"
            "使用 invoke_workflow 工具执行。工具会返回结构化输出 dict。请直接返回工具结果，不要编造内容。"
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
        checkpointer=None,
        definition_resolver=ctx.definition_resolver,
        max_nesting_depth=ctx.max_nesting_depth,
        max_delegation_depth=ctx.max_delegation_depth,
    )
    child_graph = _compile_impl(child, child_ctx, depth=depth + 1, visiting=child_visiting, chain_path=child_chain)
    return child_graph, child


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
            if node.outputs:
                # Subworkflow-boundary end node: it declares output ports, so
                # register a pass-through node fn to forward inputs to outputs.
                end_fn = _make_end_node_fn(node, incoming_edges.get(node.id, []))
                builder.add_node(node.id, end_fn)
            continue  # normal end node → LangGraph END, no add_node

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
                    builder.add_node(node.id, node_fn)
                    continue
                # Compile-time subgraph expansion (inline/template reference).
                node_fn = _make_subworkflow_node_fn(node, child_graph, child_start_id, child_end_id, incoming_edges.get(node.id, []))
                builder.add_node(node.id, node_fn)
                continue
            # No subworkflow spec → fall through to the legacy executor path.

        # Bind executor (for non-control-flow nodes including FLOW_WAIT)
        executor = ctx.executors.get(node.type)
        if executor is None:
            raise WorkflowCompileError(f"node '{node.id}' type '{node.type.value}' has no registered executor in CompileContext")

        node_fn = _make_node_fn(node, executor, incoming_edges.get(node.id, []))
        builder.add_node(node.id, node_fn)

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
