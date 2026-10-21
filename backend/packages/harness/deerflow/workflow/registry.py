"""Workflow executor registry — type-safe registration and lookup.

Provides:
- :class:`ExecutorRegistration`: bundles a node-type with its executor and
  metadata (idempotency, confirmation requirement, description, previewer).
- :class:`ExecutorRegistry`: thread-safe key-value store keyed by
  ``NodeType``; converts to :class:`CompileContext` for the compiler.
- :func:`build_default_registry`: public entry point lives in
  :mod:`deerflow.workflow.executors` — returns a fully-populated registry
  with real executor implementations.  This module provides the skeleton
  :func:`_build_placeholder_registry` for isolated testing.
- :class:`WorkflowExecutionError`: runtime error raised by executors.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any

from deerflow.workflow.compiler import CompileContext, Executor, WorkflowRuntime
from deerflow.workflow.preview import Previewer
from deerflow.workflow.schema import NodeType

# ── Public types ───────────────────────────────────────────────────────────


class WorkflowExecutionError(RuntimeError):
    """Execution-time error raised by workflow node executors.

    Caught by the T6 worker to translate a failed node into a
    terminal run status.  Distinct from :class:`WorkflowCompileError`
    (compile-time) and :class:`WorkflowRouteError` (routing-time).
    """


@dataclass
class ExecutorRegistration:
    """One registered executor, keyed by its ``node_type``.

    Fields:
        node_type: The ``NodeType`` this executor handles.
        executor: The three-parameter executor callable
            ``(runtime, params, inputs) → dict``.
        idempotent: ``True`` when repeated execution with the same
            inputs produces the same side-effects.  Non-idempotent
            nodes (bash, http) require crash-confirmation.
        description: Human-readable summary.
        requires_confirmation: When ``True`` the executor must check
            ``params.crash_confirm`` before executing.  Default
            ``True`` for non-idempotent types (bash, http).
        preview: Optional previewer (N10) describing this node type's
            mutation *before* it runs.  Registering one makes the node
            type **approvable**: a node with ``params.require_approval``
            suspends for human confirmation, and its effect is described
            by this callable.  ``None`` means the type has nothing
            previewable (read-only or control-flow nodes), so
            ``require_approval`` on it is a configuration error.
    """

    node_type: NodeType
    executor: Executor
    idempotent: bool = False
    description: str | None = None
    requires_confirmation: bool = False
    preview: Previewer | None = None


# ── Registry ──────────────────────────────────────────────────────────────


class ExecutorRegistry:
    """Type-safe executor registry keyed by :class:`NodeType`.

    Typical usage::

        registry = build_default_registry()
        registry.register(ExecutorRegistration(...))
        ctx = registry.build_context()
        graph = compile_definition(def_, context=ctx)
    """

    def __init__(self) -> None:
        self._registrations: dict[NodeType, ExecutorRegistration] = {}

    # -- mutations --

    def register(self, registration: ExecutorRegistration) -> None:
        """Register an executor for a node type.

        Raises:
            ValueError: If an executor for *registration.node_type* is
                already registered — use ``get()`` + replace semantics
                if override is intended (T5-3 pattern).
        """
        if registration.node_type in self._registrations:
            raise ValueError(f"Executor for node type '{registration.node_type.value}' is already registered. Use get() to inspect the existing registration before replacing.")
        self._registrations[registration.node_type] = registration

    # -- queries --

    def get(self, node_type: NodeType) -> ExecutorRegistration | None:
        """Look up the registration for *node_type*, or ``None``."""
        return self._registrations.get(node_type)

    def keys(self) -> list[NodeType]:
        """Return all registered ``NodeType`` keys (insertion order, Python 3.7+)."""
        return list(self._registrations.keys())

    # -- magic --

    def __len__(self) -> int:
        return len(self._registrations)

    def __contains__(self, node_type: NodeType) -> bool:
        return node_type in self._registrations

    # -- build --

    def build_context(self) -> CompileContext:
        """Convert registered executors into a :class:`CompileContext`.

        The returned context is ready to pass to
        :func:`deerflow.workflow.compile_definition`.  Registered previewers
        (N10) travel alongside the executors so the compiler can gate
        ``params.require_approval`` nodes without importing this registry.
        """
        executors: dict[NodeType, Executor] = {nt: reg.executor for nt, reg in self._registrations.items()}
        previews: dict[NodeType, Previewer] = {nt: reg.preview for nt, reg in self._registrations.items() if reg.preview is not None}
        return CompileContext(executors=executors, previews=previews)


# ── Helpers ────────────────────────────────────────────────────────────────


# Node types whose side-effects are inherently non-idempotent.
# D6 (plan): bash and http are the canonical non-idempotent types; the local
# application launch/script nodes (N5) join them — they start a process or
# mutate in-app state.
_NON_IDEMPOTENT_TYPES: frozenset[NodeType] = frozenset(
    {
        NodeType.TOOL_BASH,
        NodeType.TOOL_HTTP,
        # §25 工具节点化: the resolved tool may be bash/app/HTTP, so a direct
        # invocation is non-idempotent by construction (and therefore
        # crash-confirm gated).
        NodeType.TOOL_INVOKE,
        NodeType.APP_LAUNCH,
        NodeType.APP_SCRIPT,
    }
)


def crash_confirm_required(node_type: NodeType) -> bool:
    """Return ``True`` if *node_type* typically requires crash-confirmation.

    Currently driven by the hard-coded non-idempotent set (bash, http).
    The T5-3 executors check ``params.crash_confirm`` at execution time;
    this helper is a static convenience for pre-flight and tooling checks.
    """
    return node_type in _NON_IDEMPOTENT_TYPES


# ── Default registry skeleton ─────────────────────────────────────────────


def _make_placeholder(node_type: NodeType) -> Executor:
    """Return an executor that raises ``NotImplementedError``.

    Placeholder executors are registered for every node-type that needs
    an executor but has not been implemented yet (T5-3 supplies the real
    implementations).
    """

    def _placeholder(
        runtime: WorkflowRuntime,
        params: dict[str, Any],
        inputs: dict[str, Any],
    ) -> dict[str, Any]:
        raise NotImplementedError(f"Executor for '{node_type.value}' not yet implemented (T5-3 pending)")

    return _placeholder


def _build_placeholder_registry() -> ExecutorRegistry:
    """Build a skeleton registry with placeholder executors (internal).

    Every ``NodeType`` that requires an executor (everything except
    the control-flow types handled natively by the compiler:
    ``flow:start``, ``flow:end``, ``flow:loop``, ``flow:parallel``,
    ``flow:try``)
    gets a placeholder that raises ``NotImplementedError``.

    The public entry point is :func:`deerflow.workflow.executors.build_default_registry`
    which returns a registry populated with real executor implementations.
    This skeleton exists for isolated testing of the registry plumbing.
    """
    registry = ExecutorRegistry()

    # ── Types that need executors ─────────────────────────────────────
    _needs_executor: list[tuple[NodeType, str | None]] = [
        # Flow control (routing / delay)
        (NodeType.FLOW_IF, "Conditional branch executor"),
        (NodeType.FLOW_SWITCH, "Multi-case switch executor"),
        (NodeType.FLOW_HANDOFF, "Controlled dynamic handoff router (N14)"),
        (NodeType.FLOW_WAIT, "Delay / sleep executor"),
        # Data transformation
        (NodeType.DATA_ASSIGN, "Static assignment or passthrough"),
        (NodeType.DATA_CONVERT, "Type conversion executor"),
        (NodeType.DATA_FILE, "File read / write executor"),
        (NodeType.DATA_ASSET, "Asset inspect / import / export / convert executor"),
        (NodeType.DATA_JSON, "JSON stringify / parse executor"),
        (NodeType.DATA_REGEX, "Regex search / replace executor"),
        # External tools
        (NodeType.TOOL_BASH, "Shell command executor (sandboxed)"),
        (NodeType.TOOL_HTTP, "HTTP request executor"),
        (NodeType.TOOL_NOTIFY, "Notification executor"),
        (NodeType.TOOL_LOG, "Logging executor"),
        # AI
        (NodeType.AI_LLM_AGENT, "LLM agent executor (T6)"),
        (NodeType.AI_PROMPT_PREVIEW, "Full prompt preview for an AI node"),
        # Local professional software (N5)
        (NodeType.APP_LAUNCH, "Local application launch / attach executor"),
        (NodeType.APP_SCRIPT, "Local application script executor"),
        (NodeType.APP_WAIT, "Local application wait executor"),
        (NodeType.APP_COLLECT, "Local application artifact collect executor"),
        # Human interaction
        (NodeType.HUMAN_TASK, "Human task executor (T9)"),
        # Composition
        (NodeType.NESTED_SUBWORKFLOW, "Nested subworkflow executor (T10)"),
    ]

    for node_type, description in _needs_executor:
        idempotent = node_type not in _NON_IDEMPOTENT_TYPES
        requires_confirmation = node_type in _NON_IDEMPOTENT_TYPES
        registry.register(
            ExecutorRegistration(
                node_type=node_type,
                executor=_make_placeholder(node_type),
                idempotent=idempotent,
                description=description,
                requires_confirmation=requires_confirmation,
            )
        )

    return registry
