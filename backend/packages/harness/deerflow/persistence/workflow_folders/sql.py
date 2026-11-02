from __future__ import annotations

from datetime import UTC, datetime
from typing import Any
from uuid import uuid4

from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from deerflow.persistence.workflow_definitions.model import WorkflowDefinitionRow
from deerflow.persistence.workflow_folders.model import WorkflowFolderRow
from deerflow.utils.time import coerce_iso


class FolderNotFoundError(LookupError):
    """The folder does not exist or is not owned by the caller."""


class FolderConflictError(ValueError):
    """A folder name already exists under the same parent."""


class FolderCycleError(ValueError):
    """Moving a folder under one of its descendants would create a cycle."""


class FolderNotEmptyError(ValueError):
    """Deleting a folder that still contains folders or workflows."""


def _folder_dict(row: WorkflowFolderRow) -> dict[str, Any]:
    data = row.to_dict()
    for key in ("created_at", "updated_at"):
        if data.get(key) is not None:
            data[key] = coerce_iso(data[key])
    return data


class WorkflowFolderRepository:
    """Persistence for the arbitrary-depth workflow directory tree."""

    def __init__(self, session_factory: async_sessionmaker[AsyncSession]) -> None:
        self._sf = session_factory

    async def list_by_user(self, user_id: str) -> list[dict[str, Any]]:
        stmt = (
            select(WorkflowFolderRow)
            .where(WorkflowFolderRow.user_id == user_id)
            .order_by(
                WorkflowFolderRow.parent_id.asc().nullsfirst(),
                WorkflowFolderRow.order_index.asc(),
                WorkflowFolderRow.name.asc(),
                WorkflowFolderRow.id.asc(),
            )
        )
        async with self._sf() as session:
            rows = (await session.execute(stmt)).scalars().all()
            return [_folder_dict(row) for row in rows]

    async def get(self, folder_id: str, *, user_id: str) -> dict[str, Any] | None:
        async with self._sf() as session:
            row = await session.get(WorkflowFolderRow, folder_id)
            if row is None or row.user_id != user_id:
                return None
            return _folder_dict(row)

    async def create(
        self,
        *,
        user_id: str,
        name: str,
        parent_id: str | None = None,
    ) -> dict[str, Any]:
        async with self._sf() as session:
            await self._require_parent(session, user_id=user_id, parent_id=parent_id)
            await self._require_unique_name(session, user_id=user_id, parent_id=parent_id, name=name)
            max_order = await session.scalar(
                select(func.coalesce(func.max(WorkflowFolderRow.order_index), -1)).where(
                    WorkflowFolderRow.user_id == user_id,
                    WorkflowFolderRow.parent_id.is_(None) if parent_id is None else WorkflowFolderRow.parent_id == parent_id,
                )
            )
            now = datetime.now(UTC)
            row = WorkflowFolderRow(
                id=f"wfdir-{uuid4().hex}",
                user_id=user_id,
                name=name,
                parent_id=parent_id,
                order_index=(0 if max_order is None else int(max_order) + 1),
                created_at=now,
                updated_at=now,
            )
            session.add(row)
            await session.commit()
            await session.refresh(row)
            return _folder_dict(row)

    async def update(
        self,
        folder_id: str,
        *,
        user_id: str,
        name: str | None = None,
        parent_id: str | None = None,
        parent_id_set: bool = False,
    ) -> dict[str, Any] | None:
        async with self._sf() as session:
            row = await session.get(WorkflowFolderRow, folder_id)
            if row is None or row.user_id != user_id:
                return None
            next_parent = parent_id if parent_id_set else row.parent_id
            if next_parent == folder_id:
                raise FolderCycleError("A folder cannot be its own parent")
            await self._require_parent(session, user_id=user_id, parent_id=next_parent)
            if next_parent is not None:
                await self._require_not_descendant(session, user_id=user_id, folder_id=folder_id, parent_id=next_parent)
            next_name = name if name is not None else row.name
            await self._require_unique_name(
                session,
                user_id=user_id,
                parent_id=next_parent,
                name=next_name,
                exclude_id=folder_id,
            )
            row.name = next_name
            row.parent_id = next_parent
            row.updated_at = datetime.now(UTC)
            await session.commit()
            await session.refresh(row)
            return _folder_dict(row)

    async def delete(self, folder_id: str, *, user_id: str) -> bool:
        async with self._sf() as session:
            row = await session.get(WorkflowFolderRow, folder_id)
            if row is None or row.user_id != user_id:
                return False
            child = await session.scalar(
                select(WorkflowFolderRow.id)
                .where(
                    WorkflowFolderRow.user_id == user_id,
                    WorkflowFolderRow.parent_id == folder_id,
                )
                .limit(1)
            )
            workflow = await session.scalar(
                select(WorkflowDefinitionRow.id)
                .where(
                    WorkflowDefinitionRow.user_id == user_id,
                    WorkflowDefinitionRow.folder_id == folder_id,
                )
                .limit(1)
            )
            if child is not None or workflow is not None:
                raise FolderNotEmptyError("Folder is not empty; move or delete its contents first")
            await session.delete(row)
            await session.commit()
            return True

    async def _require_parent(self, session: AsyncSession, *, user_id: str, parent_id: str | None) -> None:
        if parent_id is None:
            return
        parent = await session.get(WorkflowFolderRow, parent_id)
        if parent is None or parent.user_id != user_id:
            raise FolderNotFoundError("Parent folder not found")

    async def _require_not_descendant(
        self,
        session: AsyncSession,
        *,
        user_id: str,
        folder_id: str,
        parent_id: str,
    ) -> None:
        current: str | None = parent_id
        seen: set[str] = set()
        while current is not None:
            if current == folder_id:
                raise FolderCycleError("Cannot move a folder under its own descendant")
            if current in seen:
                raise FolderCycleError("Folder tree contains a cycle")
            seen.add(current)
            parent = await session.get(WorkflowFolderRow, current)
            if parent is None or parent.user_id != user_id:
                raise FolderNotFoundError("Parent folder not found")
            current = parent.parent_id

    async def _require_unique_name(
        self,
        session: AsyncSession,
        *,
        user_id: str,
        parent_id: str | None,
        name: str,
        exclude_id: str | None = None,
    ) -> None:
        stmt = select(WorkflowFolderRow.id).where(
            WorkflowFolderRow.user_id == user_id,
            WorkflowFolderRow.name == name,
            WorkflowFolderRow.parent_id.is_(None) if parent_id is None else WorkflowFolderRow.parent_id == parent_id,
        )
        if exclude_id is not None:
            stmt = stmt.where(WorkflowFolderRow.id != exclude_id)
        existing = await session.scalar(stmt.limit(1))
        if existing is not None:
            raise FolderConflictError(f"A folder named '{name}' already exists here")
