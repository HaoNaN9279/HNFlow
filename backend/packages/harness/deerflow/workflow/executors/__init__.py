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
from .ai import exec_llm_agent, exec_prompt_preview  # noqa: E402
from .asset import exec_asset, preview_asset  # noqa: E402
from .data import exec_assign, exec_convert, exec_file, exec_json, exec_regex, exec_shared, preview_file  # noqa: E402
from .flow import exec_handoff, exec_if, exec_switch, exec_wait  # noqa: E402
from .human import exec_human_task  # noqa: E402
from .knowledge import exec_knowledge  # noqa: E402
from .local_app import exec_app_collect, exec_app_launch, exec_app_script, exec_app_wait, preview_app_launch, preview_app_script  # noqa: E402
from .tool import exec_bash, exec_http, exec_log, exec_nested_subworkflow, exec_notify, exec_tool_invoke  # noqa: E402

# ── Default registry assembly ────────────────────────────────────────────────


def build_default_registry() -> ExecutorRegistry:
    """Build a fully-populated executor registry with real implementations.

    Every ``NodeType`` that requires a runtime executor receives its built-in
    implementation.  ``nested:subworkflow`` falls through to
    :func:`exec_nested_subworkflow` only when a node carries no
    ``params.subworkflow`` spec; a spec'd node is handled by the compiler's
    expansion/delegation path instead.

    Returns:
        An :class:`ExecutorRegistry` ready for
        :meth:`ExecutorRegistry.build_context`.
    """
    reg = ExecutorRegistry()

    # ── Flow-control ─────────────────────────────────────────────────────
    reg.register(ExecutorRegistration(node_type=NodeType.FLOW_IF, executor=exec_if, idempotent=True, description="Conditional branch evaluator"))
    reg.register(ExecutorRegistration(node_type=NodeType.FLOW_SWITCH, executor=exec_switch, idempotent=True, description="Multi-case switch evaluator"))
    # §24.6a controlled dynamic handoff: routes to a whitelisted expert node and
    # fails on a selection outside it.  Idempotent — the executor only maps a
    # value onto a declared candidate (the run budget it counts is carried by
    # state, so it cannot be double-spent).
    reg.register(ExecutorRegistration(node_type=NodeType.FLOW_HANDOFF, executor=exec_handoff, idempotent=True, description="Controlled dynamic handoff router (whitelisted experts, budgeted)"))
    reg.register(ExecutorRegistration(node_type=NodeType.FLOW_WAIT, executor=exec_wait, idempotent=True, description="Delay / sleep executor"))

    # ── Data transformation ───────────────────────────────────────────────
    reg.register(ExecutorRegistration(node_type=NodeType.DATA_ASSIGN, executor=exec_assign, idempotent=True, description="Static assignment or passthrough"))
    reg.register(ExecutorRegistration(node_type=NodeType.DATA_CONVERT, executor=exec_convert, idempotent=True, description="Type conversion executor"))
    reg.register(ExecutorRegistration(node_type=NodeType.DATA_FILE, executor=exec_file, idempotent=True, description="File read / write executor (sandboxed)", preview=preview_file))
    reg.register(ExecutorRegistration(node_type=NodeType.DATA_ASSET, executor=exec_asset, idempotent=True, description="Asset inspect / import / export / convert executor (N9)", preview=preview_asset))
    reg.register(ExecutorRegistration(node_type=NodeType.DATA_SHARED, executor=exec_shared, idempotent=True, description="Shared workspace read / write / append executor (N14)"))
    reg.register(ExecutorRegistration(node_type=NodeType.DATA_KNOWLEDGE, executor=exec_knowledge, idempotent=True, description="Knowledge ingest / retrieve executor (N14)"))
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
    reg.register(ExecutorRegistration(node_type=NodeType.TOOL_NOTIFY, executor=exec_notify, idempotent=True, description="User-facing notification executor"))
    # §25 工具节点化: call one gateway tool directly (no model turn).  Non-idempotent
    # by construction — the resolved tool may write files, drive a local
    # application, or perform network IO — so it is crash-confirm gated like
    # bash/http.
    reg.register(
        ExecutorRegistration(
            node_type=NodeType.TOOL_INVOKE,
            executor=exec_tool_invoke,
            idempotent=False,
            requires_confirmation=True,
            description="Direct gateway tool invocation executor (crash-confirm gated)",
        )
    )

    # ── AI ────────────────────────────────────────────────────────────────
    # AI nodes are non-idempotent (a re-run consumes tokens and may re-act with
    # tools) but, unlike bash/http, they are *not* crash-confirm gated: the
    # bounded autonomous loop plus the interrupt/HumanTask path is the
    # confirmation boundary (dev plan C10, §7.3 / §12.4).  ``requires_confirmation``
    # stays False so ``crash_confirm_required`` == {bash, http} is the single
    # source of truth for the executor-level crash-confirm gate.
    reg.register(
        ExecutorRegistration(
            node_type=NodeType.AI_LLM_AGENT,
            executor=exec_llm_agent,
            idempotent=False,
            requires_confirmation=False,
            description="LLM agent executor (three-layer prompt + capability tools)",
        )
    )
    # The prompt preview node is a real idempotent read of the AI node's
    # reserved prompt.
    reg.register(
        ExecutorRegistration(
            node_type=NodeType.AI_PROMPT_PREVIEW,
            executor=exec_prompt_preview,
            idempotent=True,
            description="Full prompt preview for an ai:llm_agent node",
        )
    )

    # ── Human interaction ─────────────────────────────────────────────────
    # A human task suspends the graph; the interrupt itself is the confirmation
    # boundary, so no crash-confirm gate is applied.
    reg.register(ExecutorRegistration(node_type=NodeType.HUMAN_TASK, executor=exec_human_task, idempotent=False, description="Human task executor (interrupt / HumanTask)"))

    # ── Local professional software (N5) ──────────────────────────────────
    # launch/script start a process / mutate in-app state → non-idempotent and
    # crash-confirm gated (host-side execution, deliberate sandbox exception).
    reg.register(ExecutorRegistration(node_type=NodeType.APP_LAUNCH, executor=exec_app_launch, idempotent=False, requires_confirmation=True, description="Local application launch / attach executor", preview=preview_app_launch))
    reg.register(ExecutorRegistration(node_type=NodeType.APP_SCRIPT, executor=exec_app_script, idempotent=False, requires_confirmation=True, description="Local application script executor", preview=preview_app_script))
    reg.register(ExecutorRegistration(node_type=NodeType.APP_WAIT, executor=exec_app_wait, idempotent=True, description="Local application wait executor"))
    reg.register(ExecutorRegistration(node_type=NodeType.APP_COLLECT, executor=exec_app_collect, idempotent=True, description="Local application artifact collect executor"))

    # ── Composition ───────────────────────────────────────────────────────
    reg.register(ExecutorRegistration(node_type=NodeType.NESTED_SUBWORKFLOW, executor=exec_nested_subworkflow, idempotent=False, description="Nested subworkflow executor (compile / delegate expansion)"))

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
    "exec_shared",
    "preview_file",
    # Assets (N9)
    "exec_asset",
    "preview_asset",
    # Flow
    "exec_if",
    "exec_wait",
    "exec_switch",
    "exec_handoff",
    # Tool
    "exec_bash",
    "exec_http",
    "exec_log",
    "exec_notify",
    "exec_tool_invoke",
    "exec_nested_subworkflow",
    # AI
    "exec_llm_agent",
    "exec_prompt_preview",
    # Human
    "exec_human_task",
    # Local apps (N5)
    "exec_app_launch",
    "exec_app_script",
    "exec_app_wait",
    "exec_app_collect",
    "preview_app_launch",
    "preview_app_script",
]
