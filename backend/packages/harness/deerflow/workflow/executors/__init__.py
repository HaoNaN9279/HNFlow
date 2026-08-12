"""Workflow executor registry — built-in node-type executors.

Exports individual executor functions and :func:`build_default_registry`
which returns a fully-populated :class:`ExecutorRegistry` with real
executor implementations for every supported ``NodeType``.

``WorkflowExecutionError`` is re-exported from :mod:`deerflow.workflow.registry`
(sole definition point).
"""

from __future__ import annotations

# ── Re-export WorkflowExecutionError (sole definition in registry.py) ────────
from deerflow.workflow.registry import (  # noqa: E402
    ExecutorRegistration,
    ExecutorRegistry,
    WorkflowExecutionError,
    crash_confirm_required,
)
from deerflow.workflow.schema import NodeType  # noqa: E402

# ── Import public executor functions ─────────────────────────────────────────
from .ai import exec_llm_agent  # noqa: E402
from .data import exec_assign, exec_convert, exec_file, exec_json, exec_regex  # noqa: E402
from .flow import exec_if, exec_switch, exec_wait  # noqa: E402
from .human import exec_human_task  # noqa: E402
from .tool import exec_bash, exec_http, exec_log, exec_nested_subworkflow, exec_notify  # noqa: E402

# ── Default registry assembly ────────────────────────────────────────────────


def build_default_registry() -> ExecutorRegistry:
    """Build a fully-populated executor registry with real implementations.

    Every ``NodeType`` that requires a runtime executor receives its
    built-in implementation.  Placeholder types (``ai:llm_agent``,
    ``human:task``, ``tool:notify``, ``nested:subworkflow``) raise
    ``WorkflowExecutionError`` or ``NotImplementedError`` at call time.

    Returns:
        An :class:`ExecutorRegistry` ready for
        :meth:`ExecutorRegistry.build_context`.
    """
    reg = ExecutorRegistry()

    # ── Flow-control ─────────────────────────────────────────────────────
    reg.register(ExecutorRegistration(node_type=NodeType.FLOW_IF, executor=exec_if, idempotent=True, description="Conditional branch evaluator"))
    reg.register(ExecutorRegistration(node_type=NodeType.FLOW_SWITCH, executor=exec_switch, idempotent=True, description="Multi-case switch evaluator"))
    reg.register(ExecutorRegistration(node_type=NodeType.FLOW_WAIT, executor=exec_wait, idempotent=True, description="Delay / sleep executor"))

    # ── Data transformation ───────────────────────────────────────────────
    reg.register(ExecutorRegistration(node_type=NodeType.DATA_ASSIGN, executor=exec_assign, idempotent=True, description="Static assignment or passthrough"))
    reg.register(ExecutorRegistration(node_type=NodeType.DATA_CONVERT, executor=exec_convert, idempotent=True, description="Type conversion executor"))
    reg.register(ExecutorRegistration(node_type=NodeType.DATA_FILE, executor=exec_file, idempotent=True, description="File read / write executor (sandboxed)"))
    reg.register(ExecutorRegistration(node_type=NodeType.DATA_JSON, executor=exec_json, idempotent=True, description="JSON stringify / parse executor"))
    reg.register(ExecutorRegistration(node_type=NodeType.DATA_REGEX, executor=exec_regex, idempotent=True, description="Regex search executor"))

    # ── External tools ────────────────────────────────────────────────────
    reg.register(
        ExecutorRegistration(
            node_type=NodeType.TOOL_BASH,
            executor=exec_bash,
            idempotent=False,
            requires_confirmation=True,
            description="Shell command executor (sandboxed)",
        )
    )
    reg.register(
        ExecutorRegistration(
            node_type=NodeType.TOOL_HTTP,
            executor=exec_http,
            idempotent=False,
            requires_confirmation=True,
            description="HTTP request executor",
        )
    )
    reg.register(ExecutorRegistration(node_type=NodeType.TOOL_LOG, executor=exec_log, idempotent=True, description="Logging executor"))
    reg.register(ExecutorRegistration(node_type=NodeType.TOOL_NOTIFY, executor=exec_notify, idempotent=True, description="Notification executor (T10 placeholder)"))

    # ── AI ────────────────────────────────────────────────────────────────
    reg.register(
        ExecutorRegistration(
            node_type=NodeType.AI_LLM_AGENT,
            executor=exec_llm_agent,
            idempotent=False,
            requires_confirmation=True,
            description="LLM agent executor (T6 placeholder)",
        )
    )

    # ── Human interaction ─────────────────────────────────────────────────
    reg.register(ExecutorRegistration(node_type=NodeType.HUMAN_TASK, executor=exec_human_task, idempotent=False, description="Human task executor (T10 placeholder)"))

    # ── Composition ───────────────────────────────────────────────────────
    reg.register(ExecutorRegistration(node_type=NodeType.NESTED_SUBWORKFLOW, executor=exec_nested_subworkflow, idempotent=False, description="Nested subworkflow executor (T10 placeholder)"))

    return reg


__all__ = [
    "WorkflowExecutionError",
    "ExecutorRegistration",
    "ExecutorRegistry",
    "crash_confirm_required",
    "build_default_registry",
    # Data
    "exec_assign",
    "exec_convert",
    "exec_file",
    "exec_json",
    "exec_regex",
    # Flow
    "exec_if",
    "exec_wait",
    "exec_switch",
    # Tool
    "exec_bash",
    "exec_http",
    "exec_log",
    "exec_notify",
    "exec_nested_subworkflow",
    # AI
    "exec_llm_agent",
    # Human
    "exec_human_task",
]
