"""Lead Agent tools for workspace resource management and conversation undo."""

from __future__ import annotations

import asyncio
import contextvars
import json
from collections.abc import Awaitable, Callable
from typing import TYPE_CHECKING, Any

from langchain_core.tools import tool

from deerflow.tools.sync import _SYNC_TOOL_EXECUTOR
from deerflow.tools.types import Runtime

if TYPE_CHECKING:
    from deerflow.workspace import ChangeContext, WorkspaceResourceService


def _run_async(coro: Awaitable[Any]) -> Any:
    try:
        loop = asyncio.get_running_loop()
    except RuntimeError:
        loop = None
    if loop is not None and loop.is_running():
        captured = contextvars.copy_context()
        return _SYNC_TOOL_EXECUTOR.submit(captured.run, lambda: asyncio.run(coro)).result()
    return asyncio.run(coro)


async def _service(runtime: Runtime) -> WorkspaceResourceService:
    from deerflow.workspace.runtime import service_for_runtime

    return await service_for_runtime(runtime)


def _context(runtime: Runtime) -> dict[str, Any]:
    context = getattr(runtime, "context", None)
    return context if isinstance(context, dict) else {}


def _change_context(runtime: Runtime) -> ChangeContext:
    from deerflow.workspace.runtime import change_context_for_runtime

    return change_context_for_runtime(runtime)


async def _call(runtime: Runtime, operation: Callable[[WorkspaceResourceService], Awaitable[Any]]) -> Any:
    service = await _service(runtime)
    return await operation(service)


def _ok(result: Any) -> str:
    return json.dumps({"ok": True, "result": result}, ensure_ascii=False, separators=(",", ":"))


def _error(exc: Exception) -> str:
    from deerflow.workspace import (
        WorkspaceResourceConflict,
        WorkspaceResourceNotFound,
        WorkspaceResourceValidationError,
        WorkspaceUndoConflict,
        WorkspaceUndoEmpty,
    )

    if isinstance(exc, WorkspaceResourceValidationError):
        return json.dumps({"ok": False, "error": "validation_failed", "errors": exc.errors}, ensure_ascii=False, separators=(",", ":"))
    if isinstance(exc, WorkspaceUndoConflict):
        return json.dumps({"ok": False, "error": "undo_conflict", "conflicts": exc.conflicts}, ensure_ascii=False, separators=(",", ":"))
    if isinstance(exc, WorkspaceUndoEmpty):
        return json.dumps({"ok": False, "error": "nothing_to_undo", "message": str(exc)}, ensure_ascii=False, separators=(",", ":"))
    if isinstance(exc, WorkspaceResourceNotFound):
        return json.dumps({"ok": False, "error": "not_found", "message": str(exc)}, ensure_ascii=False, separators=(",", ":"))
    if isinstance(exc, WorkspaceResourceConflict):
        return json.dumps({"ok": False, "error": "conflict", "message": str(exc)}, ensure_ascii=False, separators=(",", ":"))
    return json.dumps({"ok": False, "error": "operation_failed", "message": f"{type(exc).__name__}: {exc}"}, ensure_ascii=False, separators=(",", ":"))


@tool(parse_docstring=True)
def workspace_catalog(
    section: str,
    runtime: Runtime,
    parent_id: str | None = None,
    query: str | None = None,
    limit: int = 20,
    cursor: str | None = None,
) -> str:
    """List workspace resources by category.

    Use ``section="index"`` first to get counts and folder/tool/provider groups.
    Then request one section for a paged list. Workflows can be filtered by
    ``parent_id``: a folder id, or ``"root"`` for uncategorized workflows.

    Args:
        section: One of index, workflows, workflow_folders, workbenches, tools, capability_groups, model_profiles, skills.
        parent_id: Optional parent folder id (or "root") for workflows/folders.
        query: Optional case-insensitive substring filter.
        limit: Page size, 1-100 (default 20).
        cursor: Opaque next_cursor returned by a previous call.
    """
    try:
        result = _run_async(
            _call(
                runtime,
                lambda service: service.catalog(section=section, parent_id=parent_id, query=query, limit=limit, cursor=cursor),
            )
        )
        return _ok(result)
    except Exception as exc:  # noqa: BLE001 - tool boundary
        return _error(exc)


@tool(parse_docstring=True)
def workspace_get(kind: str, resource_id: str, runtime: Runtime) -> str:
    """Read one workspace resource by kind and id.

    Kinds: workflow, workflow_folder, workbench, workbench_member, tool,
    capability_group, model_profile, skill. A workflow returns its full
    definition JSON; a workbench returns its members.

    Args:
        kind: Resource kind.
        resource_id: Resource id. A workbench_member id is "<workbench_id>:<definition_id>".
    """
    try:
        result = _run_async(_call(runtime, lambda service: service.get(kind=kind, resource_id=resource_id)))
        return _ok(result)
    except Exception as exc:  # noqa: BLE001 - tool boundary
        return _error(exc)


@tool(parse_docstring=True)
def workflow_manage(
    action: str,
    runtime: Runtime,
    name: str | None = None,
    folder_id: str | None = None,
    definition_id: str | None = None,
    expected_updated_at: str | None = None,
    definition: dict[str, Any] | None = None,
    operations: list[dict[str, Any]] | None = None,
    metadata: dict[str, Any] | None = None,
    version: str | None = None,
    revision_id: str | None = None,
    confirm: bool = False,
) -> str:
    """Create, edit, move, delete, or inspect workflow definitions and folders.

    Actions:
    - create_folder: name, parent_id via folder_id.
    - update_folder: folder_id, name, folder_id as new parent (empty string moves to root).
    - delete_folder: folder_id, confirm=true.
    - create: name, definition, folder_id, metadata, version.
    - update: definition_id, name, folder_id, definition, metadata, version, expected_updated_at.
    - patch: definition_id, operations, expected_updated_at.
    - move: definition_id, folder_id, expected_updated_at.
    - delete: definition_id, expected_updated_at, confirm=true.
    - list_revisions: definition_id.
    - restore_revision: definition_id, revision_id.

    Patch operations: add_node, update_node, remove_node, add_edge,
    update_edge, remove_edge, set_metadata, set_name, set_version.

    Args:
        action: Operation name listed above.
        name: Workflow or folder name.
        folder_id: Target folder id, or empty string for root.
        definition_id: Workflow definition id.
        expected_updated_at: Optimistic token returned by workspace_get.
        definition: Full WorkflowDefinition JSON for create/update.
        operations: Structured workflow patch operations.
        metadata: Workflow metadata override.
        version: Workflow version string.
        revision_id: Revision id for restore_revision.
        confirm: Required true for delete actions.
    """
    try:
        from deerflow.workspace import WorkspaceResourceValidationError

        change = _change_context(runtime)
        target_folder = None if folder_id == "" else folder_id

        async def operation(service: WorkspaceResourceService) -> Any:
            if action == "create_folder":
                if not name:
                    raise WorkspaceResourceValidationError(["create_folder requires name"])
                return await service.create_folder(name=name, parent_id=target_folder, change=change)
            if action == "update_folder":
                if not definition_id:
                    raise WorkspaceResourceValidationError(["update_folder requires folder_id in definition_id"])
                return await service.update_folder(
                    folder_id=definition_id,
                    name=name,
                    parent_id=target_folder,
                    parent_id_set=folder_id is not None,
                    expected_updated_at=expected_updated_at,
                    change=change,
                )
            if action == "delete_folder":
                if not definition_id:
                    raise WorkspaceResourceValidationError(["delete_folder requires folder_id in definition_id"])
                return await service.delete_folder(
                    folder_id=definition_id,
                    expected_updated_at=expected_updated_at,
                    confirm=confirm,
                    change=change,
                )
            if action == "create":
                if definition is None:
                    raise WorkspaceResourceValidationError(["create requires definition"])
                return await service.create_workflow(
                    name=name or str(definition.get("name") or "Workflow"),
                    definition=definition,
                    folder_id=target_folder,
                    metadata=metadata,
                    version=version or str(definition.get("version") or "0.1.0"),
                    change=change,
                )
            if action in {"update", "patch", "move"}:
                if not definition_id:
                    raise WorkspaceResourceValidationError([f"{action} requires definition_id"])
                return await service.update_workflow(
                    definition_id=definition_id,
                    name=name,
                    definition=definition,
                    operations=operations,
                    folder_id=target_folder,
                    folder_id_set=action == "move" or folder_id is not None,
                    metadata=metadata,
                    version=version,
                    expected_updated_at=expected_updated_at,
                    change=change,
                )
            if action == "delete":
                if not definition_id:
                    raise WorkspaceResourceValidationError(["delete requires definition_id"])
                return await service.delete_workflow(
                    definition_id=definition_id,
                    expected_updated_at=expected_updated_at,
                    confirm=confirm,
                    change=change,
                )
            if action == "list_revisions":
                if not definition_id:
                    raise WorkspaceResourceValidationError(["list_revisions requires definition_id"])
                return await service.list_workflow_revisions(definition_id=definition_id)
            if action == "restore_revision":
                if not definition_id or not revision_id:
                    raise WorkspaceResourceValidationError(["restore_revision requires definition_id and revision_id"])
                return await service.restore_workflow_revision(definition_id=definition_id, revision_id=revision_id, change=change)
            raise WorkspaceResourceValidationError([f"unknown workflow action {action!r}"])

        return _ok(_run_async(_call(runtime, operation)))
    except Exception as exc:  # noqa: BLE001 - tool boundary
        return _error(exc)


@tool(parse_docstring=True)
def workspace_undo(action: str, runtime: Runtime, change_id: str | None = None, dry_run: bool = False) -> str:
    """Inspect or undo resource changes made by the Lead Agent in this conversation.

    ``action="list"`` returns the change history and the latest undoable group.
    ``action="undo"`` reverts the latest completed run's resource changes in
    reverse order. Omit change_id for the latest group. Undo is all-or-nothing:
    if a resource changed outside the agent, nothing is reverted.

    Args:
        action: "list" or "undo".
        change_id: Optional specific change id to select its run group.
        dry_run: For undo, report the plan without changing anything.
    """
    try:
        from deerflow.workspace import WorkspaceResourceError, WorkspaceResourceValidationError

        context = _context(runtime)
        thread_id = context.get("thread_id")
        if not isinstance(thread_id, str) or not thread_id:
            raise WorkspaceResourceError("workspace undo requires a thread_id in runtime context")

        async def operation(service: WorkspaceResourceService) -> Any:
            if action == "list":
                return await service.list_changes(thread_id=thread_id)
            if action == "undo":
                return await service.undo(thread_id=thread_id, change_id=change_id, dry_run=dry_run)
            raise WorkspaceResourceValidationError([f"unknown undo action {action!r}"])

        return _ok(_run_async(_call(runtime, operation)))
    except Exception as exc:  # noqa: BLE001 - tool boundary
        return _error(exc)


WORKSPACE_TOOLS = [
    workspace_catalog,
    workspace_get,
    workflow_manage,
    workspace_undo,
]

__all__ = [
    "WORKSPACE_TOOLS",
    "workspace_catalog",
    "workspace_get",
    "workspace_undo",
    "workflow_manage",
]
