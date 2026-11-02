"""Built-in tools for generating and editing workflow definitions.

The model-driven definition generators (T17-5) drive a bounded LLM loop: they
build the generation/edit prompt, ask ``run_oneshot_llm`` for a JSON
``WorkflowDefinition``, leniently parse and structurally validate it, and retry
with error feedback (``<= 2`` retries = up to 3 attempts) before persisting.
Successful drafts are stamped with pending-review metadata and saved through
the harness persistence service; every failure collapses to a compact
``status="error"`` ``ToolMessage`` with a structured error list.

Harness-layer module: must never import from the app layer
(see tests/test_harness_boundary.py).
"""

from __future__ import annotations

import asyncio
import contextvars
import json
from collections.abc import Awaitable
from typing import Any

from langchain_core.messages import ToolMessage
from langchain_core.tools import tool
from langgraph.types import Command

from deerflow.runtime.user_context import resolve_runtime_user_id
from deerflow.tools.sync import _SYNC_TOOL_EXECUTOR
from deerflow.tools.types import Runtime

# Total LLM attempts per operation (initial call plus up to two retries).
_MAX_LLM_ATTEMPTS = 3

_JSON_PARSE_ERROR_MESSAGE = "输出必须是合法 JSON"

_EDIT_SYSTEM_INSTRUCTION = "你是一名工作流定义编辑器。只输出修改后的完整 WorkflowDefinition JSON 对象，不要输出解释性文字。"


@tool(parse_docstring=True)
def generate_workflow(prompt: str, runtime: Runtime) -> Command:
    """Generate a workflow definition draft from a natural-language prompt.

    Produces a workflow definition draft for review. The draft is NOT saved or
    applied: it becomes durable only after passing graph-structure validation.
    Review the returned ``pending_review`` items before persisting.

    Args:
        prompt: Natural-language description of the workflow to generate.
    """
    tool_call_id = runtime.tool_call_id
    try:
        result = _generate_definition(prompt, runtime)
    except Exception as exc:
        return _error_command("generate_workflow", tool_call_id, [_operation_error("generate_workflow", exc)])
    if not result.get("ok"):
        return _error_command("generate_workflow", tool_call_id, result.get("errors") or [])
    return _success_command("generate_workflow", tool_call_id, result)


@tool(parse_docstring=True)
def edit_workflow(definition_id: str, instruction: str, runtime: Runtime) -> Command:
    """Edit an existing workflow definition draft from a natural-language instruction.

    Produces a revised workflow definition draft for review. The draft is NOT
    saved or applied: it becomes durable only after passing graph-structure
    validation. Review the returned ``pending_review`` items before persisting.

    Args:
        definition_id: Identifier of the workflow definition to edit.
        instruction: Natural-language instruction describing the edit.
    """
    tool_call_id = runtime.tool_call_id
    try:
        result = _edit_definition(definition_id, instruction, runtime)
    except Exception as exc:
        return _error_command("edit_workflow", tool_call_id, [_operation_error("edit_workflow", exc)])
    if not result.get("ok"):
        return _error_command("edit_workflow", tool_call_id, result.get("errors") or [])
    return _success_command("edit_workflow", tool_call_id, result)


def _generate_definition(prompt: str, runtime: Runtime) -> dict:
    """Generate a workflow definition draft from *prompt*."""
    return _run_async(_generate_definition_async(prompt, runtime))


def _edit_definition(definition_id: str, instruction: str, runtime: Runtime) -> dict:
    """Edit a workflow definition draft, preserving the original definition id."""
    return _run_async(_edit_definition_async(definition_id, instruction, runtime))


async def _workspace_service_if_available(runtime: Runtime):
    """Use the journaled workspace service when a SQL engine is already live.

    The legacy generator path historically owned persistence directly. The
    Gateway now initializes the SQL engine before any tool runs, so production
    writes go through the journaled service. Lightweight unit/integration
    callers that never initialized the engine keep the old helper path.
    """
    from deerflow.persistence.engine import get_session_factory

    if get_session_factory() is None:
        return None
    from deerflow.workspace.runtime import service_for_runtime

    return await service_for_runtime(runtime)


# ── Async generators ─────────────────────────────────────────────────────────


async def _generate_definition_async(prompt: str, runtime: Runtime) -> dict:
    deps = _wave2_deps()
    user_id = resolve_runtime_user_id(runtime)
    app_config = deps["get_app_config"]()
    thread_id = _runtime_thread_id(runtime)
    system_instruction = deps["build_generate_prompt"](prompt)

    definition, feedback = await _retry_llm(
        deps,
        system_instruction=system_instruction,
        base_user_content=prompt,
        app_config=app_config,
        thread_id=thread_id,
        run_name="generate_workflow",
    )
    if definition is None:
        return {"ok": False, "errors": [_generation_error(message) for message in feedback]}

    definition = _with_pending_review(deps, definition)
    service = await _workspace_service_if_available(runtime)
    if service is None:
        saved = await deps["save_workflow_definition"](definition=definition, user_id=user_id, version=definition.version)
    else:
        from deerflow.workspace.runtime import change_context_for_runtime

        saved = await service.create_workflow(
            name=definition.name,
            definition=definition.model_dump(mode="json"),
            metadata=definition.metadata.model_dump(exclude_none=True),
            version=definition.version,
            change=change_context_for_runtime(runtime),
        )
    return {
        "ok": True,
        "definition_id": saved["id"],
        "definition": saved.get("definition", definition.model_dump(mode="json")),
        "pending_review": deps["collect_pending_review_nodes"](definition),
    }


async def _edit_definition_async(definition_id: str, instruction: str, runtime: Runtime) -> dict:
    deps = _wave2_deps()
    user_id = resolve_runtime_user_id(runtime)
    app_config = deps["get_app_config"]()
    thread_id = _runtime_thread_id(runtime)

    existing = await deps["get_workflow_definition"](user_id=user_id, definition_id=definition_id)
    if existing is None:
        raise deps["WorkflowDefinitionSaveError"](f"workflow definition '{definition_id}' not found for user '{user_id}'")
    existing_definition = deps["WorkflowDefinition"].model_validate(existing["definition"])
    skill_context = _resolve_skill_context(deps, existing_definition)

    base_user_content = deps["build_edit_prompt"](
        deps["serialize"](existing_definition),
        instruction,
        skill_context=skill_context or None,
    )
    definition, feedback = await _retry_llm(
        deps,
        system_instruction=_EDIT_SYSTEM_INSTRUCTION,
        base_user_content=base_user_content,
        app_config=app_config,
        thread_id=thread_id,
        run_name="edit_workflow",
    )
    if definition is None:
        return {"ok": False, "errors": [_generation_error(message) for message in feedback]}

    definition = _with_pending_review(deps, definition)
    service = await _workspace_service_if_available(runtime)
    if service is None:
        await deps["update_workflow_definition"](definition_id=definition_id, definition=definition, user_id=user_id, version=definition.version)
        saved_definition = definition.model_dump(mode="json")
    else:
        from deerflow.workspace.runtime import change_context_for_runtime

        existing_row = await service.get(kind="workflow", resource_id=definition_id)
        saved = await service.update_workflow(
            definition_id=definition_id,
            definition=definition.model_dump(mode="json"),
            metadata=definition.metadata.model_dump(exclude_none=True),
            version=definition.version,
            expected_updated_at=existing_row["resource"].get("updated_at"),
            change=change_context_for_runtime(runtime),
        )
        saved_definition = saved["definition"]
    return {
        "ok": True,
        "definition_id": definition_id,
        "definition": saved_definition,
        "pending_review": deps["collect_pending_review_nodes"](definition),
    }


async def _retry_llm(
    deps: dict[str, Any],
    *,
    system_instruction: str,
    base_user_content: str,
    app_config: Any,
    thread_id: str | None,
    run_name: str,
) -> tuple[Any, list[str]]:
    """Run the LLM round up to ``_MAX_LLM_ATTEMPTS`` times with error feedback.

    Returns ``(definition, [])`` on success or ``(None, errors)`` when every
    attempt produced invalid output, where *errors* is the last round's error
    list.
    """
    feedback: list[str] = []
    for _ in range(_MAX_LLM_ATTEMPTS):
        user_content = _append_retry_feedback(base_user_content, feedback)
        definition, errors = await _run_llm_round(
            deps,
            system_instruction=system_instruction,
            user_content=user_content,
            app_config=app_config,
            thread_id=thread_id,
            run_name=run_name,
        )
        if definition is not None:
            return definition, []
        feedback = errors
    return None, feedback


async def _run_llm_round(
    deps: dict[str, Any],
    *,
    system_instruction: str,
    user_content: str,
    app_config: Any,
    thread_id: str | None,
    run_name: str,
) -> tuple[Any, list[str]]:
    text = await deps["run_oneshot_llm"](
        system_instruction=system_instruction,
        user_content=user_content,
        run_name=run_name,
        app_config=app_config,
        thread_id=thread_id,
    )
    parsed = deps["parse_definition_json"](text)
    if parsed is None:
        return None, [_JSON_PARSE_ERROR_MESSAGE]
    errors = deps["validate_definition"](parsed)
    if errors:
        return None, errors
    return parsed, []


def _with_pending_review(deps: dict[str, Any], definition: Any) -> Any:
    """Return a copy whose metadata carries the pending-review node list."""
    return definition.model_copy(update={"metadata": deps["mark_pending_review"](definition)})


def _resolve_skill_context(deps: dict[str, Any], definition: Any) -> str:
    """Render resolved capability groups for the edit prompt; fail-open to ``""``."""
    try:
        storage = deps["get_or_new_skill_storage"]()
        skills = storage.load_skills(enabled_only=False)
        resolved = deps["collect_resolved_groups"](definition, deps["SkillCatalog"](skills=tuple(skills)))
        if not resolved:
            return ""
        return deps["build_skill_context"](resolved, tuple(skills))
    except Exception:  # noqa: BLE001 - fail-open by design
        return ""


# ── Lazy dependency loading ───────────────────────────────────────────────────


def _wave2_deps() -> dict[str, Any]:
    """Load the workflow/persistence modules on first use (import-cycle break).

    ``deerflow.workflow``'s package ``__init__`` eagerly imports the executor
    registry, which reaches back into ``deerflow.tools`` (through the sandbox
    tool types). A module-scope import here would therefore deadlock while
    ``deerflow.tools.builtins`` is still initializing; importing lazily on
    every call breaks the cycle and stays cheap (module cache) while keeping
    the resolved names live (so tests can patch the source modules).
    """
    from deerflow.config.app_config import get_app_config
    from deerflow.persistence.workflow_definitions.service import (
        WorkflowDefinitionSaveError,
        get_workflow_definition,
        save_workflow_definition,
        update_workflow_definition,
    )
    from deerflow.skills.catalog import SkillCatalog
    from deerflow.skills.storage import get_or_new_skill_storage
    from deerflow.utils.oneshot_llm import run_oneshot_llm
    from deerflow.workflow.danger import collect_pending_review_nodes, mark_pending_review
    from deerflow.workflow.generation_prompts import (
        build_edit_prompt,
        build_generate_prompt,
        build_skill_context,
        parse_definition_json,
    )
    from deerflow.workflow.schema import WorkflowDefinition, collect_resolved_groups
    from deerflow.workflow.workflow_io import serialize, validate_definition

    return {
        "WorkflowDefinitionSaveError": WorkflowDefinitionSaveError,
        "get_app_config": get_app_config,
        "get_workflow_definition": get_workflow_definition,
        "save_workflow_definition": save_workflow_definition,
        "update_workflow_definition": update_workflow_definition,
        "SkillCatalog": SkillCatalog,
        "get_or_new_skill_storage": get_or_new_skill_storage,
        "run_oneshot_llm": run_oneshot_llm,
        "collect_pending_review_nodes": collect_pending_review_nodes,
        "mark_pending_review": mark_pending_review,
        "build_edit_prompt": build_edit_prompt,
        "build_generate_prompt": build_generate_prompt,
        "build_skill_context": build_skill_context,
        "parse_definition_json": parse_definition_json,
        "WorkflowDefinition": WorkflowDefinition,
        "collect_resolved_groups": collect_resolved_groups,
        "serialize": serialize,
        "validate_definition": validate_definition,
    }


# ── Sync bridge and small helpers ────────────────────────────────────────────


def _run_async(coro: Awaitable[Any]) -> Any:
    """Run an async helper from a synchronous tool context.

    Mirrors ``deerflow.tools.sync.make_sync_tool_wrapper``: a fresh event loop
    drives the coroutine directly, or the shared tool executor when a loop is
    already running (LangGraph may dispatch sync tools from the async path).
    """
    try:
        loop = asyncio.get_running_loop()
    except RuntimeError:
        loop = None
    if loop is not None and loop.is_running():
        captured = contextvars.copy_context()
        return _SYNC_TOOL_EXECUTOR.submit(captured.run, lambda: asyncio.run(coro)).result()
    return asyncio.run(coro)


def _runtime_thread_id(runtime: Runtime) -> str | None:
    context = getattr(runtime, "context", None)
    if isinstance(context, dict):
        thread_id = context.get("thread_id")
        if isinstance(thread_id, str) and thread_id:
            return thread_id
    return None


def _append_retry_feedback(base: str, errors: list[str]) -> str:
    if not errors:
        return base
    lines = "\n".join(f"- {error}" for error in errors)
    return f"{base}\n\n上次输出无效，请修正后重新输出完整 JSON：\n{lines}"


def _generation_error(message: str) -> dict:
    return {"code": "workflow_generation_failed", "message": message}


def _success_command(tool_name: str, tool_call_id: str, result: dict) -> Command:
    """Build the compact success ToolMessage payload for a workflow operation."""
    payload = {
        "ok": True,
        "definition_id": result.get("definition_id"),
        "definition": result.get("definition", {}),
        "pending_review": result.get("pending_review", []),
    }
    return Command(
        update={
            "messages": [
                ToolMessage(
                    content=json.dumps(payload, ensure_ascii=False, separators=(",", ":")),
                    tool_call_id=tool_call_id,
                    name=tool_name,
                )
            ]
        }
    )


def _error_command(tool_name: str, tool_call_id: str, errors: list[dict]) -> Command:
    """Build the compact error ToolMessage payload for a workflow operation."""
    payload = {"ok": False, "errors": errors}
    return Command(
        update={
            "messages": [
                ToolMessage(
                    content=json.dumps(payload, ensure_ascii=False, separators=(",", ":")),
                    tool_call_id=tool_call_id,
                    name=tool_name,
                    status="error",
                )
            ]
        }
    )


def _operation_error(tool_name: str, exc: Exception) -> dict:
    """Convert an operation failure into one structured error entry."""
    if isinstance(exc, NotImplementedError):
        return {"code": "not_wired", "message": f"{tool_name} not yet wired: {exc}"}
    return {"code": "workflow_operation_failed", "message": f"{tool_name} failed: {type(exc).__name__}: {exc}"}
