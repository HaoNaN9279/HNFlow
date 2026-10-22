"""Single assembly point for a workflow run's compile/runtime context.

The workflow runtime used to assemble these two contexts ad hoc: the worker
passed only ``build_context().executors`` into the compiler (dropping previewers
and resource accessors), and built ``config["context"]`` key by key without a
``user_id`` or a tool gateway.  That disabled automatic locks and produced
HumanTasks with an empty owner.

This module is the one place that knows how a workflow run is wired.  Both the
HTTP entry point and the conversation-side dispatch layer reach it through
``run_workflow``.
"""

from __future__ import annotations

import logging
from collections.abc import Callable
from typing import Any

from deerflow.runtime.context_keys import (
    APP_INSTANCE_REPO_CONTEXT_KEY,
    APP_RUNTIME_CONTEXT_KEY,
)
from deerflow.runtime.user_context import DEFAULT_USER_ID
from deerflow.workflow.compiler import CompileContext
from deerflow.workflow.schema import WorkflowDefinition

logger = logging.getLogger(__name__)


def build_workflow_compile_context(
    registry: Any,
    *,
    checkpointer: Any | None = None,
    definition_resolver: Callable[[str, str | None], WorkflowDefinition | None] | None = None,
    max_nesting_depth: int = 10,
    max_delegation_depth: int = 3,
    model_profiles: dict[str, dict[str, Any]] | None = None,
    available_model_names: frozenset[str] | None = None,
    model_context_windows: dict[str, int] | None = None,
    default_model_name: str | None = None,
) -> CompileContext:
    """Build a complete :class:`CompileContext` from an executor registry.

    The registry is the source of truth for the compile-time facts: executors,
    human-task identity and resource accessors (automatic locks).
    Callers must not reach into ``build_context().executors`` themselves.
    """
    built = registry.build_context()
    return CompileContext(
        executors=dict(built.executors),
        previews=dict(built.previews),
        resource_accessors=dict(built.resource_accessors),
        checkpointer=checkpointer,
        definition_resolver=definition_resolver,
        max_nesting_depth=max_nesting_depth,
        max_delegation_depth=max_delegation_depth,
        model_profiles=dict(model_profiles or {}),
        available_model_names=frozenset(available_model_names or ()),
        model_context_windows=dict(model_context_windows or {}),
        default_model_name=default_model_name,
    )


def _resolve_tool_gateway(
    *,
    app_config: Any,
    instance_repo: Any,
    user_id: str,
) -> Any | None:
    """Build the default gateway lazily, fail-open.

    ``tool:invoke`` needs a gateway in runtime context.  Building it per run is
    cheap for the common no-MCP case (providers are constructed, MCP tools are
    cached) and keeps the run's tool set aligned with the run's admission
    configuration.  A construction failure leaves the key absent so ``tool:invoke``
    reports the explicit "no tool_gateway" error instead of running with a
    different tool set.
    """
    if app_config is None:
        return None
    try:
        from deerflow.workflow.tool_gateway import build_default_tool_gateway

        return build_default_tool_gateway(
            app_config=app_config,
            instance_repo=instance_repo,
            user_id=user_id,
        )
    except Exception:  # noqa: BLE001 - optional provider construction must not fail the run
        logger.warning("Failed to build the workflow tool gateway; tool:invoke stays unavailable", exc_info=True)
        return None


def build_workflow_runtime_context(
    *,
    record: Any,
    run_ctx: Any,
    human_task_repo: Any | None = None,
    workflow_undo_repo: Any | None = None,
    origin_run_id: str | None = None,
    debug_step: bool = False,
    tool_gateway: Any | None = None,
    agent_adapter: Any | None = None,
    notifier: Any | None = None,
    model_profiles: dict[str, dict[str, Any]] | None = None,
    extra: dict[str, Any] | None = None,
) -> dict[str, Any]:
    """Build ``config['context']`` for a workflow run.

    Contract:

    - ``user_id`` is always the run owner (never an empty string). Human tasks,
      reviews, memory/knowledge scopes and per-user skill resolution all read
      it.
    - ``run_id`` is the *origin* run id on a resume, so human-task idempotency
      reuses the original row.
    - ``tool_gateway`` is present whenever an app config is available.
    - ``app`` session/instance wiring is present whenever the run context has it.
    """
    app_config = getattr(run_ctx, "app_config", None)
    user_id = str(getattr(record, "user_id", None) or DEFAULT_USER_ID)

    context: dict[str, Any] = {
        "app_config": app_config,
        "thread_id": record.thread_id,
        "run_id": origin_run_id or record.run_id,
        "user_id": user_id,
        "delegation_depth": 0,
        "checkpointer": getattr(run_ctx, "checkpointer", None),
        "human_task_repo": human_task_repo,
    }
    if workflow_undo_repo is not None:
        from deerflow.workflow.compensation import UNDO_REPO_CONTEXT_KEY

        context[UNDO_REPO_CONTEXT_KEY] = workflow_undo_repo

    instance_repo = getattr(run_ctx, "app_instance_repo", None)
    if instance_repo is not None:
        context[APP_INSTANCE_REPO_CONTEXT_KEY] = instance_repo
    try:
        from deerflow.apps.session import get_session_manager

        context[APP_RUNTIME_CONTEXT_KEY] = get_session_manager()
    except Exception:  # noqa: BLE001 - local apps are optional
        logger.debug("No app session manager available for workflow runtime", exc_info=True)

    if tool_gateway is None:
        tool_gateway = _resolve_tool_gateway(
            app_config=app_config,
            instance_repo=instance_repo,
            user_id=user_id,
        )
    if tool_gateway is not None:
        context["tool_gateway"] = tool_gateway

    if agent_adapter is None:
        agent_adapter = getattr(run_ctx, "agent_adapter", None)
    if agent_adapter is not None:
        from deerflow.workflow.agent_port import AGENT_ADAPTER_CONTEXT_KEY

        context[AGENT_ADAPTER_CONTEXT_KEY] = agent_adapter

    if notifier is not None:
        context["notifier"] = notifier
    if model_profiles is not None:
        from deerflow.workflow.model_profiles import MODEL_PROFILES_CONTEXT_KEY

        context[MODEL_PROFILES_CONTEXT_KEY] = model_profiles

    if debug_step:
        from deerflow.workflow.debug_step import DEBUG_STEP_CONTEXT_KEY

        context[DEBUG_STEP_CONTEXT_KEY] = True

    if extra:
        # Caller-supplied keys are additive, but never allowed to replace the
        # ownership-critical keys assembled above.
        for key, value in extra.items():
            context.setdefault(key, value)
    return context


__all__ = [
    "build_workflow_compile_context",
    "build_workflow_runtime_context",
]
