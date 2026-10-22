"""Runtime adapters for workspace resource tools."""

from __future__ import annotations

from typing import Any

from deerflow.config.app_config import get_app_config
from deerflow.persistence.engine import get_session_factory, init_engine_from_config
from deerflow.runtime.user_context import resolve_runtime_user_id
from deerflow.workspace.service import ChangeContext, WorkspaceResourceService


async def service_for_runtime(runtime: Any) -> WorkspaceResourceService:
    """Build a user-scoped service from a LangGraph tool runtime."""
    session_factory = get_session_factory()
    if session_factory is None:
        await init_engine_from_config(get_app_config().database)
        session_factory = get_session_factory()
    if session_factory is None:
        raise RuntimeError("workspace resource tools require a SQL database backend (sqlite or postgres)")
    return WorkspaceResourceService(session_factory, user_id=resolve_runtime_user_id(runtime))


def change_context_for_runtime(runtime: Any) -> ChangeContext:
    """Return the conversation identity for a tool mutation."""
    context = getattr(runtime, "context", None)
    if not isinstance(context, dict):
        context = {}
    thread_id = context.get("thread_id")
    if not isinstance(thread_id, str) or not thread_id:
        raise RuntimeError("workspace resource changes require a thread_id in runtime context")
    run_id = context.get("run_id")
    return ChangeContext(
        user_id=resolve_runtime_user_id(runtime),
        thread_id=thread_id,
        run_id=run_id if isinstance(run_id, str) and run_id else None,
        tool_call_id=getattr(runtime, "tool_call_id", None),
    )


__all__ = ["change_context_for_runtime", "service_for_runtime"]
