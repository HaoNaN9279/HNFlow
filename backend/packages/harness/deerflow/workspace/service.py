"""User-scoped workspace resource management for the Lead Agent.

This module is the single write path used by the Lead Agent's workspace tools.
It owns three concerns that used to be split across the Gateway routes:

- resource catalog / CRUD across workflows, folders, workbenches and members;
- structural + semantic validation before a workflow is persisted;
- an undo journal that snapshots each mutation so a conversation can revert the
  whole resource change-set later.

The module lives in the harness layer and deliberately never imports ``app.*``.
"""

from __future__ import annotations

import asyncio
import copy
import hashlib
import json
from collections import Counter
from dataclasses import dataclass
from datetime import UTC, datetime
from typing import Any
from uuid import uuid4

from sqlalchemy import delete, func, select
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from deerflow.capability_groups import discover_capability_groups
from deerflow.config import get_app_config
from deerflow.persistence.model_profiles.model import ModelProfileRow
from deerflow.persistence.workflow_definitions.model import WorkflowDefinitionRow
from deerflow.persistence.workflow_definitions.revision_model import WorkflowDefinitionRevisionRow
from deerflow.persistence.workflow_definitions.service import _resolve_workflow_metadata
from deerflow.persistence.workflow_folders.model import WorkflowFolderRow
from deerflow.persistence.workflow_workbenches.model import WorkflowWorkbenchMemberRow, WorkflowWorkbenchRow
from deerflow.persistence.workspace_changes.model import WorkspaceChangeRow
from deerflow.utils.time import coerce_iso
from deerflow.workflow.compiler import WorkflowCompileError, compile_definition
from deerflow.workflow.definition_evals import (
    DefinitionEvalError,
    definition_has_evals,
    eval_gate_errors,
    evaluate_definition_evals,
    parse_definition_evals,
)
from deerflow.workflow.dependency_graph import find_dependency_cycles
from deerflow.workflow.executors import build_default_registry
from deerflow.workflow.model_profiles import collect_model_profile_ids, model_names
from deerflow.workflow.runtime_context import build_workflow_compile_context
from deerflow.workflow.schema import WorkflowDefinition, validate_capability_tool_refs
from deerflow.workflow.workflow_io import SCHEMA_VERSION, validate_definition

RESOURCE_WORKFLOW = "workflow"
RESOURCE_FOLDER = "workflow_folder"
RESOURCE_WORKBENCH = "workbench"
RESOURCE_MEMBER = "workbench_member"
RESOURCE_KINDS = frozenset({RESOURCE_WORKFLOW, RESOURCE_FOLDER, RESOURCE_WORKBENCH, RESOURCE_MEMBER})

_CATALOG_SECTIONS = frozenset(
    {
        "index",
        "workflows",
        "workflow_folders",
        "workbenches",
        "tools",
        "capability_groups",
        "model_profiles",
        "skills",
    }
)


class WorkspaceResourceError(RuntimeError):
    """Base class for a resource operation that cannot be performed."""


class WorkspaceResourceNotFound(WorkspaceResourceError):
    """The caller does not own the requested resource."""


class WorkspaceResourceConflict(WorkspaceResourceError):
    """A unique-name, revision, or state precondition failed."""


class WorkspaceResourceValidationError(WorkspaceResourceError):
    """A workflow definition or payload failed validation."""

    def __init__(self, errors: list[str]) -> None:
        self.errors = errors
        super().__init__("; ".join(errors))


class WorkspaceUndoConflict(WorkspaceResourceError):
    """One or more resources changed after the agent's mutation."""

    def __init__(self, conflicts: list[dict[str, Any]]) -> None:
        self.conflicts = conflicts
        super().__init__("resource changed outside the agent: " + "; ".join(item["detail"] for item in conflicts))


class WorkspaceUndoEmpty(WorkspaceResourceError):
    """There is no applied change-set left to undo."""


@dataclass(frozen=True)
class ChangeContext:
    """Identity that ties one mutation to a conversation turn."""

    user_id: str
    thread_id: str
    run_id: str | None = None
    tool_call_id: str | None = None


def _iso(value: Any) -> Any:
    if isinstance(value, datetime):
        return coerce_iso(value)
    if isinstance(value, dict):
        return {str(key): _iso(item) for key, item in value.items()}
    if isinstance(value, list):
        return [_iso(item) for item in value]
    return value


def _row_dict(row: Any) -> dict[str, Any]:
    data = row.to_dict()
    if "def_metadata" in data:
        data["metadata"] = data.pop("def_metadata")
    return _iso(data)


def _to_datetime(value: Any) -> datetime | None:
    if value is None:
        return None
    if isinstance(value, datetime):
        return value
    if isinstance(value, str):
        try:
            return datetime.fromisoformat(value)
        except ValueError:
            return None
    return None


def _content_hash(value: Any) -> str:
    payload = json.dumps(value, sort_keys=True, ensure_ascii=False, separators=(",", ":"))
    return hashlib.sha256(payload.encode("utf-8")).hexdigest()


def _matches_query(item: dict[str, Any], query: str | None) -> bool:
    if not query:
        return True
    needle = query.casefold()
    for key in ("id", "name", "display_name", "description", "provider", "category"):
        value = item.get(key)
        if isinstance(value, str) and needle in value.casefold():
            return True
    return False


def _clamp_limit(value: Any, *, default: int = 20, maximum: int = 100) -> int:
    try:
        parsed = int(value)
    except (TypeError, ValueError):
        return default
    return max(1, min(maximum, parsed))


def _page(items: list[dict[str, Any]], *, limit: Any, cursor: Any) -> dict[str, Any]:
    size = _clamp_limit(limit)
    try:
        offset = max(0, int(cursor)) if cursor not in (None, "") else 0
    except (TypeError, ValueError):
        offset = 0
    page = items[offset : offset + size]
    next_cursor = str(offset + size) if offset + size < len(items) else None
    return {"items": page, "next_cursor": next_cursor, "total": len(items)}


def _workflow_summary(row: WorkflowDefinitionRow) -> dict[str, Any]:
    definition = row.definition if isinstance(row.definition, dict) else {}
    nodes = definition.get("nodes")
    edges = definition.get("edges")
    return {
        "id": row.id,
        "name": row.name,
        "version": row.version,
        "folder_id": row.folder_id,
        "schema_version": row.schema_version,
        "node_count": len(nodes) if isinstance(nodes, list) else 0,
        "edge_count": len(edges) if isinstance(edges, list) else 0,
        "updated_at": coerce_iso(row.updated_at),
        "created_at": coerce_iso(row.created_at),
    }


def _workflow_token(row: WorkflowDefinitionRow) -> str:
    return str(coerce_iso(row.updated_at))


def _folder_token(row: WorkflowFolderRow) -> str:
    return str(coerce_iso(row.updated_at))


def _workbench_token(row: WorkflowWorkbenchRow) -> str:
    return str(row.revision)


def _member_token(row: WorkflowWorkbenchMemberRow) -> str:
    return f"{row.workbench_id}:{row.definition_id}:{row.order_index}:{_content_hash(row.settings)}"


class WorkspaceResourceService:
    """One user's catalog, mutations, and undo journal."""

    def __init__(self, session_factory: async_sessionmaker[AsyncSession], *, user_id: str) -> None:
        self._sf = session_factory
        self._user_id = user_id

    # ── catalog ──────────────────────────────────────────────────────────────

    async def catalog(
        self,
        *,
        section: str = "index",
        parent_id: str | None = None,
        query: str | None = None,
        limit: Any = 20,
        cursor: Any = None,
    ) -> dict[str, Any]:
        if section not in _CATALOG_SECTIONS:
            raise WorkspaceResourceValidationError([f"unknown catalog section {section!r}; expected one of {sorted(_CATALOG_SECTIONS)}"])
        async with self._sf() as session:
            return await self._catalog_with_session(session, section=section, parent_id=parent_id, query=query, limit=limit, cursor=cursor)

    async def _catalog_with_session(
        self,
        session: AsyncSession,
        *,
        section: str,
        parent_id: str | None,
        query: str | None,
        limit: Any,
        cursor: Any,
    ) -> dict[str, Any]:
        workflows = await self._list_workflow_rows(session)
        folders = await self._list_folder_rows(session)
        workbenches = await self._list_workbench_rows(session)
        if section == "index":
            return {"index": await self._build_index(session, workflows=workflows, folders=folders, workbenches=workbenches)}
        if section == "workflows":
            items = [_workflow_summary(row) for row in workflows]
            if parent_id is not None:
                wanted = None if parent_id in {"root", ""} else parent_id
                items = [item for item in items if item.get("folder_id") == wanted]
            items = [item for item in items if _matches_query(item, query)]
            return {"section": section, **_page(items, limit=limit, cursor=cursor)}
        if section == "workflow_folders":
            items = [self._folder_item(row) for row in folders]
            if parent_id is not None:
                wanted = None if parent_id in {"root", ""} else parent_id
                items = [item for item in items if item.get("parent_id") == wanted]
            items = [item for item in items if _matches_query(item, query)]
            return {"section": section, **_page(items, limit=limit, cursor=cursor)}
        if section == "workbenches":
            items = [self._workbench_item(row, len(await self._list_member_rows(session, row.id))) for row in workbenches]
            items = [item for item in items if _matches_query(item, query)]
            return {"section": section, **_page(items, limit=limit, cursor=cursor)}
        if section == "tools":
            items = await self._tool_items()
            items = [item for item in items if _matches_query(item, query)]
            return {"section": section, **_page(items, limit=limit, cursor=cursor)}
        if section == "capability_groups":
            items = await self._capability_group_items()
            items = [item for item in items if _matches_query(item, query)]
            return {"section": section, **_page(items, limit=limit, cursor=cursor)}
        if section == "model_profiles":
            items = await self._model_profile_items(session)
            items = [item for item in items if _matches_query(item, query)]
            return {"section": section, **_page(items, limit=limit, cursor=cursor)}
        if section == "skills":
            items = await self._skill_items()
            items = [item for item in items if _matches_query(item, query)]
            return {"section": section, **_page(items, limit=limit, cursor=cursor)}
        raise WorkspaceResourceValidationError([f"unsupported catalog section {section!r}"])

    async def _build_index(
        self,
        session: AsyncSession,
        *,
        workflows: list[WorkflowDefinitionRow],
        folders: list[WorkflowFolderRow],
        workbenches: list[WorkflowWorkbenchRow],
    ) -> dict[str, Any]:
        folder_counts = Counter(row.folder_id for row in workflows)
        folder_rows = [{"id": row.id, "name": row.name, "parent_id": row.parent_id, "workflow_count": folder_counts.get(row.id, 0)} for row in folders]
        tools = await self._tool_items()
        groups = await self._capability_group_items()
        profiles = await self._model_profile_items(session)
        skills = await self._skill_items()
        return {
            "workflows": {
                "count": len(workflows),
                "root_count": folder_counts.get(None, 0),
                "folders": folder_rows,
            },
            "workbenches": {"count": len(workbenches)},
            "tools": {
                "count": len(tools),
                "providers": dict(Counter(str(item.get("provider")) for item in tools)),
            },
            "capability_groups": {
                "count": len(groups),
                "sources": dict(Counter(str(item.get("source")) for item in groups)),
            },
            "model_profiles": {
                "count": len(profiles),
                "enabled_count": sum(1 for item in profiles if item.get("enabled")),
                "available_count": sum(1 for item in profiles if item.get("available")),
            },
            "skills": {
                "count": len(skills),
                "enabled_count": sum(1 for item in skills if item.get("enabled")),
            },
        }

    async def get(self, *, kind: str, resource_id: str) -> dict[str, Any]:
        async with self._sf() as session:
            if kind == RESOURCE_WORKFLOW:
                row = await self._require_workflow(session, resource_id)
                return {"kind": kind, "resource": _row_dict(row)}
            if kind == RESOURCE_FOLDER:
                row = await self._require_folder(session, resource_id)
                return {"kind": kind, "resource": _row_dict(row)}
            if kind == RESOURCE_WORKBENCH:
                row = await self._require_workbench(session, resource_id)
                resource = _row_dict(row)
                resource["members"] = [_row_dict(member) for member in await self._list_member_rows(session, resource_id)]
                return {"kind": kind, "resource": resource}
            if kind == RESOURCE_MEMBER:
                workbench_id, separator, definition_id = resource_id.partition(":")
                if not separator:
                    raise WorkspaceResourceValidationError(["workbench_member id must be '<workbench_id>:<definition_id>'"])
                member = await self._get_member_row(session, workbench_id, definition_id)
                if member is None:
                    raise WorkspaceResourceNotFound(f"workbench member {resource_id!r} not found")
                return {"kind": kind, "resource": _row_dict(member)}
            if kind == "tool":
                for item in await self._tool_items():
                    if item.get("id") == resource_id:
                        return {"kind": kind, "resource": item}
                raise WorkspaceResourceNotFound(f"tool {resource_id!r} not found")
            if kind == "capability_group":
                for item in await self._capability_group_items():
                    if item.get("name") == resource_id or item.get("guid") == resource_id:
                        return {"kind": kind, "resource": item}
                raise WorkspaceResourceNotFound(f"capability group {resource_id!r} not found")
            if kind == "model_profile":
                row = await session.get(ModelProfileRow, resource_id)
                if row is None or row.user_id != self._user_id:
                    raise WorkspaceResourceNotFound(f"model profile {resource_id!r} not found")
                return {"kind": kind, "resource": _row_dict(row)}
            if kind == "skill":
                for item in await self._skill_items():
                    if item.get("name") == resource_id:
                        return {"kind": kind, "resource": item}
                raise WorkspaceResourceNotFound(f"skill {resource_id!r} not found")
            raise WorkspaceResourceValidationError([f"unknown resource kind {kind!r}"])

    # ── workflow operations ─────────────────────────────────────────────────

    async def create_workflow(
        self,
        *,
        name: str,
        definition: dict[str, Any],
        folder_id: str | None = None,
        metadata: dict[str, Any] | None = None,
        version: str = "0.1.0",
        change: ChangeContext | None = None,
    ) -> dict[str, Any]:
        async with self._sf() as session, session.begin():
            raw = copy.deepcopy(definition)
            if not raw.get("id"):
                raw["id"] = f"wf-{uuid4().hex}"
            try:
                model = WorkflowDefinition.model_validate(raw)
            except Exception as exc:
                raise WorkspaceResourceValidationError([f"invalid workflow definition: {exc}"]) from exc
            if await session.get(WorkflowDefinitionRow, model.id) is not None:
                raise WorkspaceResourceConflict(f"workflow id {model.id!r} already exists")
            await self._require_folder_optional(session, folder_id)
            await self._validate_workflow_for_save(session, model, workflow_id=model.id)
            resolved_metadata = _resolve_workflow_metadata(model, metadata if metadata is not None else model.metadata.model_dump(exclude_none=True))
            now = datetime.now(UTC)
            row = WorkflowDefinitionRow(
                id=model.id,
                user_id=self._user_id,
                folder_id=folder_id,
                name=name or model.name,
                schema_version=SCHEMA_VERSION,
                definition=model.model_dump(mode="json"),
                def_metadata=resolved_metadata,
                version=version,
                resolved_at=now,
                created_at=now,
                updated_at=now,
            )
            session.add(row)
            session.add(
                WorkflowDefinitionRevisionRow(
                    id=f"wfr-{uuid4().hex}",
                    definition_id=model.id,
                    user_id=self._user_id,
                    revision=1,
                    content_hash=_content_hash(row.definition),
                    schema_version=SCHEMA_VERSION,
                    definition=row.definition,
                    def_metadata=row.def_metadata,
                    version=row.version,
                    created_at=now,
                )
            )
            await session.flush()
            await self._record_change(
                session,
                change,
                kind=RESOURCE_WORKFLOW,
                resource_id=model.id,
                parent_id=folder_id,
                action="create",
                before=None,
                after=await self._snapshot_workflow(session, model.id),
                before_token=None,
                after_token=_workflow_token(row),
            )
            await session.flush()
            return _row_dict(row)

    async def update_workflow(
        self,
        *,
        definition_id: str,
        name: str | None = None,
        definition: dict[str, Any] | None = None,
        operations: list[dict[str, Any]] | None = None,
        folder_id: str | None = None,
        folder_id_set: bool = False,
        metadata: dict[str, Any] | None = None,
        version: str | None = None,
        expected_updated_at: str | None = None,
        change: ChangeContext | None = None,
    ) -> dict[str, Any]:
        async with self._sf() as session, session.begin():
            row = await self._require_workflow(session, definition_id)
            self._check_token(expected_updated_at, _workflow_token(row), "workflow")
            before = await self._snapshot_workflow(session, definition_id)
            definition_changed = False
            if operations is not None:
                if not isinstance(operations, list) or not operations:
                    raise WorkspaceResourceValidationError(["operations must be a non-empty list"])
                definition = self._apply_definition_ops(copy.deepcopy(row.definition), operations)
            if definition is not None:
                raw = copy.deepcopy(definition)
                raw["id"] = definition_id
                try:
                    model = WorkflowDefinition.model_validate(raw)
                except Exception as exc:
                    raise WorkspaceResourceValidationError([f"invalid workflow definition: {exc}"]) from exc
                await self._validate_workflow_for_save(session, model, workflow_id=definition_id)
                base_meta = metadata if metadata is not None else (row.def_metadata or {})
                row.definition = model.model_dump(mode="json")
                row.def_metadata = _resolve_workflow_metadata(model, base_meta)
                row.schema_version = SCHEMA_VERSION
                row.resolved_at = datetime.now(UTC)
                row.name = name or model.name
                row.version = version or model.version
                definition_changed = True
            else:
                if name is not None:
                    row.name = name
                if metadata is not None:
                    row.def_metadata = metadata
                if version is not None:
                    row.version = version
            if folder_id_set:
                await self._require_folder_optional(session, folder_id)
                row.folder_id = folder_id
            row.updated_at = datetime.now(UTC)
            if definition_changed:
                latest = await session.scalar(select(func.coalesce(func.max(WorkflowDefinitionRevisionRow.revision), 0)).where(WorkflowDefinitionRevisionRow.definition_id == definition_id))
                session.add(
                    WorkflowDefinitionRevisionRow(
                        id=f"wfr-{uuid4().hex}",
                        definition_id=definition_id,
                        user_id=self._user_id,
                        revision=int(latest or 0) + 1,
                        content_hash=_content_hash(before["row"]["definition"]),
                        schema_version=int(before["row"]["schema_version"]),
                        definition=before["row"]["definition"],
                        def_metadata=before["row"]["metadata"],
                        version=str(before["row"]["version"]),
                        created_at=row.updated_at,
                    )
                )
            await session.flush()
            await self._record_change(
                session,
                change,
                kind=RESOURCE_WORKFLOW,
                resource_id=definition_id,
                parent_id=row.folder_id,
                action="update",
                before=before,
                after=await self._snapshot_workflow(session, definition_id),
                before_token=_workflow_token_from_snapshot(before),
                after_token=_workflow_token(row),
            )
            await session.flush()
            return _row_dict(row)

    async def delete_workflow(
        self,
        *,
        definition_id: str,
        expected_updated_at: str | None = None,
        confirm: bool = False,
        change: ChangeContext | None = None,
    ) -> dict[str, Any]:
        if not confirm:
            raise WorkspaceResourceValidationError([f"delete workflow {definition_id!r} requires confirm=true"])
        async with self._sf() as session, session.begin():
            row = await self._require_workflow(session, definition_id)
            self._check_token(expected_updated_at, _workflow_token(row), "workflow")
            before = await self._snapshot_workflow(session, definition_id)
            await session.execute(delete(WorkflowWorkbenchMemberRow).where(WorkflowWorkbenchMemberRow.definition_id == definition_id))
            await session.execute(delete(WorkflowDefinitionRevisionRow).where(WorkflowDefinitionRevisionRow.definition_id == definition_id))
            await session.delete(row)
            await session.flush()
            await self._record_change(
                session,
                change,
                kind=RESOURCE_WORKFLOW,
                resource_id=definition_id,
                parent_id=before["row"].get("folder_id"),
                action="delete",
                before=before,
                after=None,
                before_token=_workflow_token_from_snapshot(before),
                after_token=None,
            )
            await session.flush()
            return {"id": definition_id, "deleted": True}

    async def list_workflow_revisions(self, *, definition_id: str) -> list[dict[str, Any]]:
        async with self._sf() as session:
            await self._require_workflow(session, definition_id)
            rows = (
                (
                    await session.execute(
                        select(WorkflowDefinitionRevisionRow)
                        .where(
                            WorkflowDefinitionRevisionRow.definition_id == definition_id,
                            WorkflowDefinitionRevisionRow.user_id == self._user_id,
                        )
                        .order_by(WorkflowDefinitionRevisionRow.revision.desc())
                    )
                )
                .scalars()
                .all()
            )
            return [_row_dict(row) for row in rows]

    async def restore_workflow_revision(
        self,
        *,
        definition_id: str,
        revision_id: str,
        change: ChangeContext | None = None,
    ) -> dict[str, Any]:
        async with self._sf() as session, session.begin():
            row = await self._require_workflow(session, definition_id)
            revision = await session.get(WorkflowDefinitionRevisionRow, revision_id)
            if revision is None or revision.definition_id != definition_id or revision.user_id != self._user_id:
                raise WorkspaceResourceNotFound(f"workflow revision {revision_id!r} not found")
            before = await self._snapshot_workflow(session, definition_id)
            model = WorkflowDefinition.model_validate(revision.definition)
            await self._validate_workflow_for_save(session, model, workflow_id=definition_id)
            row.definition = model.model_dump(mode="json")
            row.name = model.name
            row.version = revision.version
            row.def_metadata = revision.def_metadata or {}
            row.schema_version = SCHEMA_VERSION
            row.resolved_at = datetime.now(UTC)
            row.updated_at = datetime.now(UTC)
            latest = await session.scalar(select(func.coalesce(func.max(WorkflowDefinitionRevisionRow.revision), 0)).where(WorkflowDefinitionRevisionRow.definition_id == definition_id))
            session.add(
                WorkflowDefinitionRevisionRow(
                    id=f"wfr-{uuid4().hex}",
                    definition_id=definition_id,
                    user_id=self._user_id,
                    revision=int(latest or 0) + 1,
                    content_hash=_content_hash(before["row"]["definition"]),
                    schema_version=int(before["row"]["schema_version"]),
                    definition=before["row"]["definition"],
                    def_metadata=before["row"]["metadata"],
                    version=str(before["row"]["version"]),
                    created_at=row.updated_at,
                )
            )
            await session.flush()
            await self._record_change(
                session,
                change,
                kind=RESOURCE_WORKFLOW,
                resource_id=definition_id,
                parent_id=row.folder_id,
                action="update",
                before=before,
                after=await self._snapshot_workflow(session, definition_id),
                before_token=_workflow_token_from_snapshot(before),
                after_token=_workflow_token(row),
            )
            await session.flush()
            return _row_dict(row)

    # ── folder operations ────────────────────────────────────────────────────

    async def create_folder(self, *, name: str, parent_id: str | None = None, change: ChangeContext | None = None) -> dict[str, Any]:
        async with self._sf() as session, session.begin():
            await self._require_folder_optional(session, parent_id)
            await self._require_unique_folder(session, parent_id=parent_id, name=name)
            max_order = await session.scalar(
                select(func.coalesce(func.max(WorkflowFolderRow.order_index), -1)).where(
                    WorkflowFolderRow.user_id == self._user_id,
                    WorkflowFolderRow.parent_id.is_(None) if parent_id is None else WorkflowFolderRow.parent_id == parent_id,
                )
            )
            now = datetime.now(UTC)
            row = WorkflowFolderRow(
                id=f"wfdir-{uuid4().hex}",
                user_id=self._user_id,
                name=name,
                parent_id=parent_id,
                order_index=(0 if max_order is None else int(max_order) + 1),
                created_at=now,
                updated_at=now,
            )
            session.add(row)
            await session.flush()
            await self._record_change(
                session,
                change,
                kind=RESOURCE_FOLDER,
                resource_id=row.id,
                parent_id=parent_id,
                action="create",
                before=None,
                after=_row_dict(row),
                before_token=None,
                after_token=_folder_token(row),
            )
            await session.flush()
            return _row_dict(row)

    async def update_folder(
        self,
        *,
        folder_id: str,
        name: str | None = None,
        parent_id: str | None = None,
        parent_id_set: bool = False,
        expected_updated_at: str | None = None,
        change: ChangeContext | None = None,
    ) -> dict[str, Any]:
        async with self._sf() as session, session.begin():
            row = await self._require_folder(session, folder_id)
            self._check_token(expected_updated_at, _folder_token(row), "folder")
            before = _row_dict(row)
            next_parent = parent_id if parent_id_set else row.parent_id
            if next_parent == folder_id:
                raise WorkspaceResourceConflict("A folder cannot be its own parent")
            await self._require_folder_optional(session, next_parent)
            if next_parent is not None:
                await self._require_not_descendant(session, folder_id=folder_id, parent_id=next_parent)
            next_name = name if name is not None else row.name
            await self._require_unique_folder(session, parent_id=next_parent, name=next_name, exclude_id=folder_id)
            row.name = next_name
            row.parent_id = next_parent
            row.updated_at = datetime.now(UTC)
            await session.flush()
            await self._record_change(
                session,
                change,
                kind=RESOURCE_FOLDER,
                resource_id=folder_id,
                parent_id=next_parent,
                action="update",
                before=before,
                after=_row_dict(row),
                before_token=_folder_token_from_snapshot(before),
                after_token=_folder_token(row),
            )
            await session.flush()
            return _row_dict(row)

    async def delete_folder(
        self,
        *,
        folder_id: str,
        expected_updated_at: str | None = None,
        confirm: bool = False,
        change: ChangeContext | None = None,
    ) -> dict[str, Any]:
        if not confirm:
            raise WorkspaceResourceValidationError([f"delete folder {folder_id!r} requires confirm=true"])
        async with self._sf() as session, session.begin():
            row = await self._require_folder(session, folder_id)
            self._check_token(expected_updated_at, _folder_token(row), "folder")
            child = await session.scalar(select(WorkflowFolderRow.id).where(WorkflowFolderRow.user_id == self._user_id, WorkflowFolderRow.parent_id == folder_id).limit(1))
            workflow = await session.scalar(select(WorkflowDefinitionRow.id).where(WorkflowDefinitionRow.user_id == self._user_id, WorkflowDefinitionRow.folder_id == folder_id).limit(1))
            if child is not None or workflow is not None:
                raise WorkspaceResourceConflict("Folder is not empty; move or delete its contents first")
            before = _row_dict(row)
            await session.delete(row)
            await session.flush()
            await self._record_change(
                session,
                change,
                kind=RESOURCE_FOLDER,
                resource_id=folder_id,
                parent_id=before.get("parent_id"),
                action="delete",
                before=before,
                after=None,
                before_token=_folder_token_from_snapshot(before),
                after_token=None,
            )
            await session.flush()
            return {"id": folder_id, "deleted": True}

    # ── workbench operations ─────────────────────────────────────────────────

    async def create_workbench(
        self,
        *,
        name: str,
        description: str = "",
        layout: dict[str, Any] | None = None,
        settings: dict[str, Any] | None = None,
        change: ChangeContext | None = None,
    ) -> dict[str, Any]:
        raise WorkspaceResourceValidationError(["workbench management moved to file-backed projects; use the project workbench API"])

    async def update_workbench(
        self,
        *,
        workbench_id: str,
        name: str | None = None,
        description: str | None = None,
        layout: dict[str, Any] | None = None,
        settings: dict[str, Any] | None = None,
        expected_revision: int | None = None,
        change: ChangeContext | None = None,
    ) -> dict[str, Any]:
        async with self._sf() as session, session.begin():
            row = await self._require_workbench(session, workbench_id)
            self._reject_file_managed_workbench(row)
            if expected_revision is not None and row.revision != expected_revision:
                raise WorkspaceResourceConflict(f"Workbench revision {expected_revision} is stale (current {row.revision})")
            before = await self._snapshot_workbench(session, workbench_id)
            if name is not None:
                row.name = name
            if description is not None:
                row.description = description
            if layout is not None:
                row.layout = layout
            if settings is not None:
                row.settings = settings
            row.revision += 1
            row.updated_at = datetime.now(UTC)
            await session.flush()
            await self._record_change(
                session,
                change,
                kind=RESOURCE_WORKBENCH,
                resource_id=workbench_id,
                parent_id=None,
                action="update",
                before=before,
                after=await self._snapshot_workbench(session, workbench_id),
                before_token=_workbench_token_from_snapshot(before),
                after_token=_workbench_token(row),
            )
            await session.flush()
            return _row_dict(row)

    async def delete_workbench(
        self,
        *,
        workbench_id: str,
        expected_revision: int | None = None,
        confirm: bool = False,
        change: ChangeContext | None = None,
    ) -> dict[str, Any]:
        if not confirm:
            raise WorkspaceResourceValidationError([f"delete workbench {workbench_id!r} requires confirm=true"])
        async with self._sf() as session, session.begin():
            row = await self._require_workbench(session, workbench_id)
            self._reject_file_managed_workbench(row)
            if expected_revision is not None and row.revision != expected_revision:
                raise WorkspaceResourceConflict(f"Workbench revision {expected_revision} is stale (current {row.revision})")
            before = await self._snapshot_workbench(session, workbench_id)
            await session.execute(delete(WorkflowWorkbenchMemberRow).where(WorkflowWorkbenchMemberRow.workbench_id == workbench_id))
            await session.delete(row)
            await session.flush()
            await self._record_change(
                session,
                change,
                kind=RESOURCE_WORKBENCH,
                resource_id=workbench_id,
                parent_id=None,
                action="delete",
                before=before,
                after=None,
                before_token=_workbench_token_from_snapshot(before),
                after_token=None,
            )
            await session.flush()
            return {"id": workbench_id, "deleted": True}

    async def add_workbench_member(
        self,
        *,
        workbench_id: str,
        definition_id: str,
        settings: dict[str, Any] | None = None,
        change: ChangeContext | None = None,
    ) -> dict[str, Any]:
        async with self._sf() as session, session.begin():
            workbench = await self._require_workbench(session, workbench_id)
            self._reject_file_managed_workbench(workbench)
            await self._require_workflow(session, definition_id)
            existing = await self._get_member_row(session, workbench_id, definition_id)
            if existing is not None:
                raise WorkspaceResourceConflict("Workflow is already a member of this workbench")
            max_order = await session.scalar(select(func.coalesce(func.max(WorkflowWorkbenchMemberRow.order_index), -1)).where(WorkflowWorkbenchMemberRow.workbench_id == workbench_id))
            row = WorkflowWorkbenchMemberRow(
                id=f"wbm-{uuid4().hex}",
                workbench_id=workbench_id,
                definition_id=definition_id,
                order_index=(0 if max_order is None else int(max_order) + 1),
                settings=settings if settings is not None else {},
                created_at=datetime.now(UTC),
            )
            session.add(row)
            workbench.updated_at = datetime.now(UTC)
            await session.flush()
            await self._record_change(
                session,
                change,
                kind=RESOURCE_MEMBER,
                resource_id=definition_id,
                parent_id=workbench_id,
                action="add_member",
                before=None,
                after=_row_dict(row),
                before_token=None,
                after_token=_member_token(row),
            )
            await session.flush()
            return _row_dict(row)

    async def remove_workbench_member(
        self,
        *,
        workbench_id: str,
        definition_id: str,
        change: ChangeContext | None = None,
    ) -> dict[str, Any]:
        async with self._sf() as session, session.begin():
            workbench = await self._require_workbench(session, workbench_id)
            self._reject_file_managed_workbench(workbench)
            row = await self._get_member_row(session, workbench_id, definition_id)
            if row is None:
                raise WorkspaceResourceNotFound("Workbench member not found")
            before = _row_dict(row)
            await session.delete(row)
            workbench.updated_at = datetime.now(UTC)
            await session.flush()
            await self._record_change(
                session,
                change,
                kind=RESOURCE_MEMBER,
                resource_id=definition_id,
                parent_id=workbench_id,
                action="remove_member",
                before=before,
                after=None,
                before_token=_member_token_from_snapshot(before),
                after_token=None,
            )
            await session.flush()
            return {"workbench_id": workbench_id, "definition_id": definition_id, "removed": True}

    async def reorder_workbench_members(
        self,
        *,
        workbench_id: str,
        definition_ids: list[str],
        change: ChangeContext | None = None,
    ) -> list[dict[str, Any]]:
        async with self._sf() as session, session.begin():
            workbench = await self._require_workbench(session, workbench_id)
            self._reject_file_managed_workbench(workbench)
            rows = await self._list_member_rows(session, workbench_id)
            before = [_row_dict(row) for row in rows]
            by_id = {row.definition_id: row for row in rows}
            if set(definition_ids) != set(by_id):
                raise WorkspaceResourceValidationError(["definition_ids must contain every current member exactly once"])
            for index, definition_id in enumerate(definition_ids):
                by_id[definition_id].order_index = index
            workbench.updated_at = datetime.now(UTC)
            await session.flush()
            after = [_row_dict(row) for row in await self._list_member_rows(session, workbench_id)]
            await self._record_change(
                session,
                change,
                kind=RESOURCE_WORKBENCH,
                resource_id=workbench_id,
                parent_id=None,
                action="reorder_members",
                before={"members": before},
                after={"members": after},
                before_token=_content_hash(before),
                after_token=_content_hash(after),
            )
            await session.flush()
            return after

    # ── change journal / undo ────────────────────────────────────────────────

    async def list_changes(self, *, thread_id: str, limit: int = 50) -> dict[str, Any]:
        async with self._sf() as session:
            rows = (
                (await session.execute(select(WorkspaceChangeRow).where(WorkspaceChangeRow.user_id == self._user_id, WorkspaceChangeRow.thread_id == thread_id).order_by(WorkspaceChangeRow.seq.desc()).limit(_clamp_limit(limit, default=50))))
                .scalars()
                .all()
            )
            items = [self._change_item(row) for row in rows]
            undoable = await self._latest_undoable_group(session, thread_id=thread_id)
            return {
                "changes": items,
                "undoable": {
                    "run_id": undoable[0].run_id if undoable else None,
                    "count": len(undoable),
                    "resources": [self._change_item(row) for row in reversed(undoable)],
                },
            }

    async def undo(self, *, thread_id: str, change_id: str | None = None, dry_run: bool = False) -> dict[str, Any]:
        async with self._sf() as session, session.begin():
            rows = await self._undo_group(session, thread_id=thread_id, change_id=change_id)
            if not rows:
                raise WorkspaceUndoEmpty("no applied resource changes to undo in this conversation")
            conflicts = await self._preflight_undo(session, rows)
            if conflicts:
                raise WorkspaceUndoConflict(conflicts)
            if dry_run:
                return {
                    "dry_run": True,
                    "run_id": rows[0].run_id,
                    "count": len(rows),
                    "resources": [self._change_item(row) for row in reversed(rows)],
                }
            undone: list[dict[str, Any]] = []
            for row in reversed(rows):
                await self._apply_undo(session, row)
                row.status = "undone"
                row.undone_at = datetime.now(UTC)
                undone.append(self._change_item(row))
            await session.flush()
            return {
                "dry_run": False,
                "run_id": rows[0].run_id,
                "count": len(undone),
                "resources": undone,
            }

    async def _latest_undoable_group(self, session: AsyncSession, *, thread_id: str) -> list[WorkspaceChangeRow]:
        latest = await session.scalar(
            select(WorkspaceChangeRow)
            .where(
                WorkspaceChangeRow.user_id == self._user_id,
                WorkspaceChangeRow.thread_id == thread_id,
                WorkspaceChangeRow.status == "applied",
            )
            .order_by(WorkspaceChangeRow.seq.desc())
            .limit(1)
        )
        if latest is None:
            return []
        stmt = select(WorkspaceChangeRow).where(
            WorkspaceChangeRow.user_id == self._user_id,
            WorkspaceChangeRow.thread_id == thread_id,
            WorkspaceChangeRow.status == "applied",
        )
        if latest.run_id is None:
            stmt = stmt.where(WorkspaceChangeRow.id == latest.id)
        else:
            stmt = stmt.where(WorkspaceChangeRow.run_id == latest.run_id)
        return list((await session.execute(stmt.order_by(WorkspaceChangeRow.seq.asc()))).scalars().all())

    async def _undo_group(self, session: AsyncSession, *, thread_id: str, change_id: str | None) -> list[WorkspaceChangeRow]:
        if change_id is None:
            return await self._latest_undoable_group(session, thread_id=thread_id)
        target = await session.get(WorkspaceChangeRow, change_id)
        if target is None or target.user_id != self._user_id or target.thread_id != thread_id:
            raise WorkspaceResourceNotFound(f"resource change {change_id!r} not found")
        stmt = select(WorkspaceChangeRow).where(
            WorkspaceChangeRow.user_id == self._user_id,
            WorkspaceChangeRow.thread_id == thread_id,
            WorkspaceChangeRow.status == "applied",
        )
        if target.run_id is None:
            stmt = stmt.where(WorkspaceChangeRow.id == target.id)
        else:
            stmt = stmt.where(WorkspaceChangeRow.run_id == target.run_id)
        return list((await session.execute(stmt.order_by(WorkspaceChangeRow.seq.asc()))).scalars().all())

    async def _preflight_undo(self, session: AsyncSession, rows: list[WorkspaceChangeRow]) -> list[dict[str, Any]]:
        # Only the newest mutation of each resource describes the state the
        # group left behind. A create followed by an update would otherwise
        # compare the create's token against the updated row and reject a
        # perfectly valid undo. Reverse-application reaches the earlier token
        # after the newer mutation has been reverted.
        latest: dict[tuple[str, str, str | None], WorkspaceChangeRow] = {}
        for row in rows:
            key = (row.resource_kind, row.resource_id, row.parent_id)
            previous = latest.get(key)
            if previous is None or row.seq > previous.seq:
                latest[key] = row
        conflicts: list[dict[str, Any]] = []
        for row in latest.values():
            detail = await self._undo_conflict(session, row)
            if detail:
                conflicts.append({"change_id": row.id, "resource_kind": row.resource_kind, "resource_id": row.resource_id, "detail": detail})
        return conflicts

    async def _undo_conflict(self, session: AsyncSession, row: WorkspaceChangeRow) -> str | None:
        if row.resource_kind == RESOURCE_WORKFLOW:
            current = await session.get(WorkflowDefinitionRow, row.resource_id)
            if row.action == "create":
                if current is None:
                    return "workflow no longer exists"
                if row.after_token and _workflow_token(current) != row.after_token:
                    return "workflow changed after the agent created it"
            elif row.action == "delete":
                if current is not None:
                    return "workflow id was recreated after the agent deleted it"
            else:
                if current is None:
                    return "workflow no longer exists"
                if row.after_token and _workflow_token(current) != row.after_token:
                    return "workflow changed after the agent updated it"
            return None
        if row.resource_kind == RESOURCE_FOLDER:
            current = await session.get(WorkflowFolderRow, row.resource_id)
            if row.action == "create":
                if current is None:
                    return "folder no longer exists"
                if row.after_token and _folder_token(current) != row.after_token:
                    return "folder changed after the agent created it"
            elif row.action == "delete":
                if current is not None:
                    return "folder id was recreated after the agent deleted it"
            else:
                if current is None:
                    return "folder no longer exists"
                if row.after_token and _folder_token(current) != row.after_token:
                    return "folder changed after the agent updated it"
            return None
        if row.resource_kind == RESOURCE_WORKBENCH:
            current = await session.get(WorkflowWorkbenchRow, row.resource_id)
            if row.action == "create":
                if current is None:
                    return "workbench no longer exists"
                if row.after_token and _workbench_token(current) != row.after_token:
                    return "workbench changed after the agent created it"
            elif row.action == "delete":
                if current is not None:
                    return "workbench id was recreated after the agent deleted it"
            elif row.action == "update":
                if current is None:
                    return "workbench no longer exists"
                if row.after_token and _workbench_token(current) != row.after_token:
                    return "workbench changed after the agent updated it"
            elif row.action == "reorder_members":
                current_rows = await self._list_member_rows(session, row.resource_id)
                if row.after_token and _content_hash([_row_dict(item) for item in current_rows]) != row.after_token:
                    return "workbench member order changed after the agent updated it"
            return None
        if row.resource_kind == RESOURCE_MEMBER:
            current = await self._get_member_row(session, row.parent_id or "", row.resource_id)
            if row.action == "add_member":
                if current is None:
                    return "workbench member no longer exists"
                if row.after_token and _member_token(current) != row.after_token:
                    return "workbench member changed after the agent added it"
            elif row.action == "remove_member":
                if current is not None:
                    return "workbench member was re-added after the agent removed it"
            return None
        return f"unknown resource kind {row.resource_kind!r}"

    async def _apply_undo(self, session: AsyncSession, row: WorkspaceChangeRow) -> None:
        if row.resource_kind == RESOURCE_WORKFLOW:
            if row.action == "create":
                await self._delete_workflow_raw(session, row.resource_id)
            else:
                await self._restore_workflow(session, row.before_json or {})
            return
        if row.resource_kind == RESOURCE_FOLDER:
            if row.action == "create":
                current = await session.get(WorkflowFolderRow, row.resource_id)
                if current is not None:
                    await session.delete(current)
            else:
                await self._restore_folder(session, row.before_json or {})
            return
        if row.resource_kind == RESOURCE_WORKBENCH:
            if row.action == "create":
                await self._delete_workbench_raw(session, row.resource_id)
            elif row.action == "reorder_members":
                for index, member in enumerate((row.before_json or {}).get("members", [])):
                    current = await self._get_member_row(session, member["workbench_id"], member["definition_id"])
                    if current is not None:
                        current.order_index = index
            else:
                await self._restore_workbench(session, row.before_json or {})
            return
        if row.resource_kind == RESOURCE_MEMBER:
            if row.action == "add_member":
                current = await self._get_member_row(session, row.parent_id or "", row.resource_id)
                if current is not None:
                    await session.delete(current)
            else:
                await self._restore_member(session, row.before_json or {})
            return
        raise WorkspaceResourceError(f"cannot undo unknown resource kind {row.resource_kind!r}")

    async def _delete_workflow_raw(self, session: AsyncSession, definition_id: str) -> None:
        await session.execute(delete(WorkflowWorkbenchMemberRow).where(WorkflowWorkbenchMemberRow.definition_id == definition_id))
        await session.execute(delete(WorkflowDefinitionRevisionRow).where(WorkflowDefinitionRevisionRow.definition_id == definition_id))
        row = await session.get(WorkflowDefinitionRow, definition_id)
        if row is not None:
            await session.delete(row)

    async def _delete_workbench_raw(self, session: AsyncSession, workbench_id: str) -> None:
        await session.execute(delete(WorkflowWorkbenchMemberRow).where(WorkflowWorkbenchMemberRow.workbench_id == workbench_id))
        row = await session.get(WorkflowWorkbenchRow, workbench_id)
        if row is not None:
            await session.delete(row)

    async def _restore_workflow(self, session: AsyncSession, snapshot: dict[str, Any]) -> None:
        data = snapshot.get("row") or {}
        row = await session.get(WorkflowDefinitionRow, data["id"])
        if row is None:
            row = WorkflowDefinitionRow(
                id=data["id"],
                user_id=self._user_id,
                folder_id=data.get("folder_id"),
                name=data.get("name") or "Workflow",
                schema_version=int(data.get("schema_version") or SCHEMA_VERSION),
                definition=data.get("definition") or {},
                def_metadata=data.get("metadata") or {},
                version=data.get("version") or "0.1.0",
                resolved_at=_to_datetime(data.get("resolved_at")),
                created_at=_to_datetime(data.get("created_at")) or datetime.now(UTC),
                updated_at=_to_datetime(data.get("updated_at")) or datetime.now(UTC),
            )
            session.add(row)
        else:
            row.folder_id = data.get("folder_id")
            row.name = data.get("name") or row.name
            row.schema_version = int(data.get("schema_version") or row.schema_version)
            row.definition = data.get("definition") or row.definition
            row.def_metadata = data.get("metadata") or row.def_metadata
            row.version = data.get("version") or row.version
            row.resolved_at = _to_datetime(data.get("resolved_at"))
            row.updated_at = _to_datetime(data.get("updated_at")) or datetime.now(UTC)
        for member in snapshot.get("members") or []:
            if await self._get_member_row(session, member["workbench_id"], member["definition_id"]) is None:
                await self._restore_member(session, member)
        await session.flush()

    async def _restore_folder(self, session: AsyncSession, data: dict[str, Any]) -> None:
        row = await session.get(WorkflowFolderRow, data["id"])
        if row is None:
            row = WorkflowFolderRow(
                id=data["id"],
                user_id=self._user_id,
                name=data.get("name") or "Folder",
                parent_id=data.get("parent_id"),
                order_index=int(data.get("order_index") or 0),
                created_at=_to_datetime(data.get("created_at")) or datetime.now(UTC),
                updated_at=_to_datetime(data.get("updated_at")) or datetime.now(UTC),
            )
            session.add(row)
        else:
            row.name = data.get("name") or row.name
            row.parent_id = data.get("parent_id")
            row.order_index = int(data.get("order_index") or row.order_index)
            row.updated_at = _to_datetime(data.get("updated_at")) or datetime.now(UTC)

    async def _restore_workbench(self, session: AsyncSession, snapshot: dict[str, Any]) -> None:
        data = snapshot.get("row") or {}
        row = await session.get(WorkflowWorkbenchRow, data["id"])
        if row is None:
            row = WorkflowWorkbenchRow(
                id=data["id"],
                user_id=self._user_id,
                name=data.get("name") or "Workbench",
                description=data.get("description") or "",
                layout=data.get("layout") or {"version": 1, "cards": []},
                settings=data.get("settings") or {},
                revision=int(data.get("revision") or 1),
                created_at=_to_datetime(data.get("created_at")) or datetime.now(UTC),
                updated_at=_to_datetime(data.get("updated_at")) or datetime.now(UTC),
            )
            session.add(row)
        else:
            row.name = data.get("name") or row.name
            row.description = data.get("description") or ""
            row.layout = data.get("layout") or row.layout
            row.settings = data.get("settings") or row.settings
            row.revision = int(data.get("revision") or row.revision)
            row.updated_at = _to_datetime(data.get("updated_at")) or datetime.now(UTC)
        for member in snapshot.get("members") or []:
            if await self._get_member_row(session, member["workbench_id"], member["definition_id"]) is None:
                await self._restore_member(session, member)
        await session.flush()

    async def _restore_member(self, session: AsyncSession, data: dict[str, Any]) -> None:
        row = WorkflowWorkbenchMemberRow(
            id=data.get("id") or f"wbm-{uuid4().hex}",
            workbench_id=data["workbench_id"],
            definition_id=data["definition_id"],
            order_index=int(data.get("order_index") or 0),
            settings=data.get("settings") or {},
            created_at=_to_datetime(data.get("created_at")) or datetime.now(UTC),
        )
        session.add(row)

    # ── snapshots / journal helpers ─────────────────────────────────────────

    async def _snapshot_workflow(self, session: AsyncSession, definition_id: str) -> dict[str, Any]:
        row = await self._require_workflow(session, definition_id)
        members = (
            (
                await session.execute(
                    select(WorkflowWorkbenchMemberRow)
                    .join(WorkflowWorkbenchRow, WorkflowWorkbenchRow.id == WorkflowWorkbenchMemberRow.workbench_id)
                    .where(
                        WorkflowWorkbenchMemberRow.definition_id == definition_id,
                        WorkflowWorkbenchRow.user_id == self._user_id,
                    )
                )
            )
            .scalars()
            .all()
        )
        return {"row": _row_dict(row), "members": [_row_dict(member) for member in members]}

    async def _snapshot_workbench(self, session: AsyncSession, workbench_id: str) -> dict[str, Any]:
        row = await self._require_workbench(session, workbench_id)
        return {"row": _row_dict(row), "members": [_row_dict(member) for member in await self._list_member_rows(session, workbench_id)]}

    async def _record_change(
        self,
        session: AsyncSession,
        change: ChangeContext | None,
        *,
        kind: str,
        resource_id: str,
        parent_id: str | None,
        action: str,
        before: dict[str, Any] | None,
        after: dict[str, Any] | None,
        before_token: str | None,
        after_token: str | None,
    ) -> None:
        if change is None:
            return
        seq = await session.scalar(
            select(func.coalesce(func.max(WorkspaceChangeRow.seq), 0)).where(
                WorkspaceChangeRow.thread_id == change.thread_id,
                WorkspaceChangeRow.user_id == self._user_id,
            )
        )
        session.add(
            WorkspaceChangeRow(
                id=f"wsc-{uuid4().hex}",
                user_id=self._user_id,
                thread_id=change.thread_id,
                run_id=change.run_id,
                tool_call_id=change.tool_call_id,
                seq=int(seq or 0) + 1,
                resource_kind=kind,
                resource_id=resource_id,
                parent_id=parent_id,
                action=action,
                before_json=before,
                after_json=after,
                before_token=before_token,
                after_token=after_token,
                status="applied",
                detail="",
                created_at=datetime.now(UTC),
            )
        )

    @staticmethod
    def _change_item(row: WorkspaceChangeRow) -> dict[str, Any]:
        snapshot = row.after_json or row.before_json or {}
        data = snapshot.get("row") if isinstance(snapshot, dict) else None
        if not isinstance(data, dict) and isinstance(snapshot, dict):
            data = snapshot
        return {
            "id": row.id,
            "seq": row.seq,
            "run_id": row.run_id,
            "resource_kind": row.resource_kind,
            "resource_id": row.resource_id,
            "parent_id": row.parent_id,
            "action": row.action,
            "status": row.status,
            "name": (data or {}).get("name") or row.resource_id,
            "created_at": coerce_iso(row.created_at),
            "undone_at": coerce_iso(row.undone_at) if row.undone_at else None,
        }

    # ── resource lookups ─────────────────────────────────────────────────────

    async def _list_workflow_rows(self, session: AsyncSession) -> list[WorkflowDefinitionRow]:
        return list((await session.execute(select(WorkflowDefinitionRow).where(WorkflowDefinitionRow.user_id == self._user_id).order_by(WorkflowDefinitionRow.created_at.desc(), WorkflowDefinitionRow.id.desc()))).scalars().all())

    async def _list_folder_rows(self, session: AsyncSession) -> list[WorkflowFolderRow]:
        return list(
            (await session.execute(select(WorkflowFolderRow).where(WorkflowFolderRow.user_id == self._user_id).order_by(WorkflowFolderRow.parent_id.asc().nullsfirst(), WorkflowFolderRow.order_index.asc(), WorkflowFolderRow.name.asc())))
            .scalars()
            .all()
        )

    async def _list_workbench_rows(self, session: AsyncSession) -> list[WorkflowWorkbenchRow]:
        return list((await session.execute(select(WorkflowWorkbenchRow).where(WorkflowWorkbenchRow.user_id == self._user_id).order_by(WorkflowWorkbenchRow.updated_at.desc(), WorkflowWorkbenchRow.id.desc()))).scalars().all())

    async def _list_member_rows(self, session: AsyncSession, workbench_id: str) -> list[WorkflowWorkbenchMemberRow]:
        await self._require_workbench(session, workbench_id)
        return list(
            (await session.execute(select(WorkflowWorkbenchMemberRow).where(WorkflowWorkbenchMemberRow.workbench_id == workbench_id).order_by(WorkflowWorkbenchMemberRow.order_index.asc(), WorkflowWorkbenchMemberRow.created_at.asc())))
            .scalars()
            .all()
        )

    async def _get_member_row(self, session: AsyncSession, workbench_id: str, definition_id: str) -> WorkflowWorkbenchMemberRow | None:
        if not workbench_id:
            return None
        return await session.scalar(
            select(WorkflowWorkbenchMemberRow).where(
                WorkflowWorkbenchMemberRow.workbench_id == workbench_id,
                WorkflowWorkbenchMemberRow.definition_id == definition_id,
            )
        )

    async def _require_workflow(self, session: AsyncSession, definition_id: str) -> WorkflowDefinitionRow:
        row = await session.get(WorkflowDefinitionRow, definition_id)
        if row is None or row.user_id != self._user_id:
            raise WorkspaceResourceNotFound(f"workflow {definition_id!r} not found")
        return row

    async def _require_folder(self, session: AsyncSession, folder_id: str) -> WorkflowFolderRow:
        row = await session.get(WorkflowFolderRow, folder_id)
        if row is None or row.user_id != self._user_id:
            raise WorkspaceResourceNotFound(f"workflow folder {folder_id!r} not found")
        return row

    async def _require_folder_optional(self, session: AsyncSession, folder_id: str | None) -> None:
        if folder_id:
            await self._require_folder(session, folder_id)

    async def _require_workbench(self, session: AsyncSession, workbench_id: str) -> WorkflowWorkbenchRow:
        row = await session.get(WorkflowWorkbenchRow, workbench_id)
        if row is None or row.user_id != self._user_id:
            raise WorkspaceResourceNotFound(f"workbench {workbench_id!r} not found")
        return row

    @staticmethod
    def _reject_file_managed_workbench(row: WorkflowWorkbenchRow) -> None:
        """Project-file workbenches must be mutated through the project API."""
        if row.project_id:
            raise WorkspaceResourceValidationError([f"workbench {row.id!r} is managed by project files; use the project workbench API"])

    async def _require_unique_folder(self, session: AsyncSession, *, parent_id: str | None, name: str, exclude_id: str | None = None) -> None:
        stmt = select(WorkflowFolderRow.id).where(
            WorkflowFolderRow.user_id == self._user_id,
            WorkflowFolderRow.name == name,
            WorkflowFolderRow.parent_id.is_(None) if parent_id is None else WorkflowFolderRow.parent_id == parent_id,
        )
        if exclude_id is not None:
            stmt = stmt.where(WorkflowFolderRow.id != exclude_id)
        if await session.scalar(stmt.limit(1)) is not None:
            raise WorkspaceResourceConflict(f"A folder named {name!r} already exists here")

    async def _require_not_descendant(self, session: AsyncSession, *, folder_id: str, parent_id: str) -> None:
        current: str | None = parent_id
        seen: set[str] = set()
        while current is not None:
            if current == folder_id:
                raise WorkspaceResourceConflict("Cannot move a folder under its own descendant")
            if current in seen:
                raise WorkspaceResourceConflict("Folder tree contains a cycle")
            seen.add(current)
            parent = await session.get(WorkflowFolderRow, current)
            if parent is None or parent.user_id != self._user_id:
                raise WorkspaceResourceNotFound(f"workflow folder {current!r} not found")
            current = parent.parent_id

    # ── validation ───────────────────────────────────────────────────────────

    async def _validate_workflow_for_save(self, session: AsyncSession, definition: WorkflowDefinition, *, workflow_id: str) -> None:
        errors = validate_definition(definition)
        if errors:
            raise WorkspaceResourceValidationError(errors)
        tool_errors = validate_capability_tool_refs(definition, user_id=self._user_id)
        if tool_errors:
            raise WorkspaceResourceValidationError(tool_errors)
        rows = await self._list_workflow_rows(session)
        definitions: dict[str, WorkflowDefinition] = {}
        for row in rows:
            if row.id == workflow_id:
                continue
            try:
                definitions[row.id] = WorkflowDefinition.model_validate(row.definition)
            except Exception:
                continue
        definitions[workflow_id] = definition
        cycles = find_dependency_cycles(definitions, ())
        if cycles:
            raise WorkspaceResourceValidationError([f"dependency cycle: {item}" for item in cycles])

        app_config = get_app_config()
        profiles: dict[str, Any] = {}
        if collect_model_profile_ids(definition.model_dump(mode="json")):
            profile_rows = (await session.execute(select(ModelProfileRow).where(ModelProfileRow.user_id == self._user_id))).scalars().all()
            profiles = {row.id: _row_dict(row) for row in profile_rows}
        template_rows = {row.id: row for row in rows}
        template_rows[workflow_id] = WorkflowDefinitionRow(
            id=workflow_id,
            user_id=self._user_id,
            name=definition.name,
            schema_version=SCHEMA_VERSION,
            definition=definition.model_dump(mode="json"),
            def_metadata={},
            version=definition.version,
        )

        def resolver(template_id: str, _version: str | None = None) -> WorkflowDefinition | None:
            row = template_rows.get(template_id)
            if row is None:
                return None
            try:
                return WorkflowDefinition.model_validate(row.definition)
            except Exception:
                return None

        model_context_windows: dict[str, int] = {}
        for model in app_config.models:
            context_window = getattr(model, "context_window", None)
            if context_window is not None:
                model_context_windows[str(model.name)] = int(context_window)
        context = build_workflow_compile_context(
            build_default_registry(),
            checkpointer=None,
            definition_resolver=resolver,
            model_profiles=profiles,
            available_model_names=model_names(app_config.models),
            model_context_windows=model_context_windows,
            default_model_name=str(app_config.models[0].name) if app_config.models else None,
        )
        try:
            compile_definition(definition, context=context)
        except WorkflowCompileError as exc:
            message = str(exc)
            if "subworkflow template" in message and "not found" in message:
                return
            raise WorkspaceResourceValidationError([f"workflow semantic validation failed: {message}"]) from exc

        try:
            parsed = parse_definition_evals(definition.metadata)
        except DefinitionEvalError as exc:
            raise WorkspaceResourceValidationError([f"embedded eval spec is invalid: {exc}"]) from exc
        if parsed is not None and parsed.require_pass and definition_has_evals(definition):
            report = await evaluate_definition_evals(definition)
            if report is not None and report.failed:
                raise WorkspaceResourceValidationError(eval_gate_errors(report))

    @staticmethod
    def _check_token(expected: str | None, actual: str, label: str) -> None:
        if expected is not None and expected != actual:
            raise WorkspaceResourceConflict(f"{label} changed since it was read (expected {expected!r}, current {actual!r})")

    @staticmethod
    def _apply_definition_ops(raw: dict[str, Any], operations: list[dict[str, Any]]) -> dict[str, Any]:
        nodes = raw.setdefault("nodes", [])
        edges = raw.setdefault("edges", [])
        if not isinstance(nodes, list) or not isinstance(edges, list):
            raise WorkspaceResourceValidationError(["definition nodes/edges must be lists"])
        for operation in operations:
            if not isinstance(operation, dict):
                raise WorkspaceResourceValidationError(["each operation must be an object"])
            op = operation.get("op")
            if op == "add_node":
                node = operation.get("node")
                if not isinstance(node, dict):
                    raise WorkspaceResourceValidationError(["add_node requires a node object"])
                node_id = node.get("id")
                if any(isinstance(item, dict) and item.get("id") == node_id for item in nodes):
                    raise WorkspaceResourceConflict(f"node {node_id!r} already exists")
                nodes.append(copy.deepcopy(node))
            elif op == "update_node":
                node_id = operation.get("node_id")
                patch = operation.get("patch")
                if not isinstance(patch, dict):
                    raise WorkspaceResourceValidationError(["update_node requires a patch object"])
                target = next((item for item in nodes if isinstance(item, dict) and item.get("id") == node_id), None)
                if target is None:
                    raise WorkspaceResourceNotFound(f"node {node_id!r} not found")
                if "id" in patch and patch["id"] != node_id:
                    raise WorkspaceResourceValidationError(["update_node cannot change the node id"])
                target.update(copy.deepcopy(patch))
            elif op == "remove_node":
                node_id = operation.get("node_id")
                if not any(isinstance(item, dict) and item.get("id") == node_id for item in nodes):
                    raise WorkspaceResourceNotFound(f"node {node_id!r} not found")
                nodes[:] = [item for item in nodes if not (isinstance(item, dict) and item.get("id") == node_id)]
                edges[:] = [item for item in edges if not (isinstance(item, dict) and (item.get("source") == node_id or item.get("target") == node_id))]
            elif op == "add_edge":
                edge = operation.get("edge")
                if not isinstance(edge, dict):
                    raise WorkspaceResourceValidationError(["add_edge requires an edge object"])
                edges.append(copy.deepcopy(edge))
            elif op in {"update_edge", "remove_edge"}:
                match = operation.get("match")
                if not isinstance(match, dict):
                    raise WorkspaceResourceValidationError([f"{op} requires a match object"])
                target = next((item for item in edges if isinstance(item, dict) and all(item.get(key) == value for key, value in match.items())), None)
                if target is None:
                    raise WorkspaceResourceNotFound(f"edge {match!r} not found")
                if op == "remove_edge":
                    edges.remove(target)
                else:
                    patch = operation.get("patch")
                    if not isinstance(patch, dict):
                        raise WorkspaceResourceValidationError(["update_edge requires a patch object"])
                    target.update(copy.deepcopy(patch))
            elif op == "set_metadata":
                patch = operation.get("patch")
                if not isinstance(patch, dict):
                    raise WorkspaceResourceValidationError(["set_metadata requires a patch object"])
                raw.setdefault("metadata", {}).update(copy.deepcopy(patch))
            elif op == "set_name":
                raw["name"] = operation.get("name")
            elif op == "set_version":
                raw["version"] = operation.get("version")
            else:
                raise WorkspaceResourceValidationError([f"unknown definition operation {op!r}"])
        return raw

    # ── read-side catalog helpers ────────────────────────────────────────────

    async def _tool_items(self) -> list[dict[str, Any]]:
        from deerflow.tools.registry import ToolRegistry
        from deerflow.workflow.tool_gateway import build_default_tool_gateway

        def load() -> list[dict[str, Any]]:
            return list(ToolRegistry(build_default_tool_gateway(user_id=self._user_id)).descriptors())

        return await asyncio.to_thread(load)

    async def _capability_group_items(self) -> list[dict[str, Any]]:
        def load() -> list[dict[str, Any]]:
            return [group.summary_dict() for group in discover_capability_groups(user_id=self._user_id)]

        return await asyncio.to_thread(load)

    async def _model_profile_items(self, session: AsyncSession) -> list[dict[str, Any]]:
        rows = (await session.execute(select(ModelProfileRow).where(ModelProfileRow.user_id == self._user_id).order_by(ModelProfileRow.name))).scalars().all()
        app_config = get_app_config()
        items: list[dict[str, Any]] = []
        for row in rows:
            target = app_config.get_model_config(row.target_model)
            item = _row_dict(row)
            item["available"] = target is not None
            item["target"] = (
                None
                if target is None
                else {
                    "model": target.model,
                    "display_name": target.display_name,
                    "supports_thinking": target.supports_thinking,
                    "supports_reasoning_effort": target.supports_reasoning_effort,
                }
            )
            items.append(item)
        return items

    async def _skill_items(self) -> list[dict[str, Any]]:
        from deerflow.skills.storage import get_or_new_user_skill_storage

        def load() -> list[dict[str, Any]]:
            storage = get_or_new_user_skill_storage(self._user_id)
            return [
                {
                    "name": skill.name,
                    "description": skill.description,
                    "category": str(skill.category),
                    "enabled": skill.enabled,
                    "version": skill.version,
                }
                for skill in storage.load_skills(enabled_only=False)
            ]

        return await asyncio.to_thread(load)

    @staticmethod
    def _folder_item(row: WorkflowFolderRow) -> dict[str, Any]:
        return {
            "id": row.id,
            "name": row.name,
            "parent_id": row.parent_id,
            "order_index": row.order_index,
            "created_at": coerce_iso(row.created_at),
            "updated_at": coerce_iso(row.updated_at),
        }

    @staticmethod
    def _workbench_item(row: WorkflowWorkbenchRow, member_count: int) -> dict[str, Any]:
        return {
            "id": row.id,
            "name": row.name,
            "description": row.description,
            "revision": row.revision,
            "member_count": member_count,
            "created_at": coerce_iso(row.created_at),
            "updated_at": coerce_iso(row.updated_at),
        }


def _workflow_token_from_snapshot(snapshot: dict[str, Any]) -> str:
    data = snapshot.get("row") or {}
    return str(data.get("updated_at"))


def _folder_token_from_snapshot(data: dict[str, Any]) -> str:
    return str(data.get("updated_at"))


def _workbench_token_from_snapshot(snapshot: dict[str, Any]) -> str:
    data = snapshot.get("row") or {}
    return str(data.get("revision"))


def _member_token_from_snapshot(data: dict[str, Any]) -> str:
    return f"{data.get('workbench_id')}:{data.get('definition_id')}:{data.get('order_index')}:{_content_hash(data.get('settings') or {})}"


__all__ = [
    "ChangeContext",
    "RESOURCE_FOLDER",
    "RESOURCE_MEMBER",
    "RESOURCE_WORKBENCH",
    "RESOURCE_WORKFLOW",
    "WorkspaceResourceConflict",
    "WorkspaceResourceError",
    "WorkspaceResourceNotFound",
    "WorkspaceResourceService",
    "WorkspaceResourceValidationError",
    "WorkspaceUndoConflict",
    "WorkspaceUndoEmpty",
]
