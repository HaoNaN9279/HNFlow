from __future__ import annotations

from datetime import UTC, datetime
from typing import Any
from uuid import uuid4

from sqlalchemy import delete, func, select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from deerflow.persistence.workflow_definitions.model import WorkflowDefinitionRow
from deerflow.persistence.workflow_workbenches.model import (
    WorkflowWorkbenchMemberRow,
    WorkflowWorkbenchRow,
)
from deerflow.utils.time import coerce_iso


class WorkbenchRevisionConflict(Exception):
    """The caller's workbench revision is stale."""


class WorkbenchMemberConflict(Exception):
    """The definition is already a member of the workbench."""


def _iso_dict(row: WorkflowWorkbenchRow) -> dict[str, Any]:
    data = row.to_dict()
    for key in ("created_at", "updated_at"):
        if data.get(key) is not None:
            data[key] = coerce_iso(data[key])
    return data


def _member_dict(row: WorkflowWorkbenchMemberRow) -> dict[str, Any]:
    data = row.to_dict()
    if data.get("created_at") is not None:
        data["created_at"] = coerce_iso(data["created_at"])
    return data


class WorkflowWorkbenchRepository:
    """Persistence for saved workbenches and their root-workflow members."""

    def __init__(self, session_factory: async_sessionmaker[AsyncSession]) -> None:
        self._sf = session_factory

    async def create(
        self,
        *,
        user_id: str,
        name: str,
        description: str = "",
        layout: dict[str, Any] | None = None,
        settings: dict[str, Any] | None = None,
    ) -> dict[str, Any]:
        now = datetime.now(UTC)
        row = WorkflowWorkbenchRow(
            id=f"wb-{uuid4().hex}",
            user_id=user_id,
            name=name,
            description=description,
            layout=layout if layout is not None else {"version": 1, "cards": []},
            settings=settings if settings is not None else {},
            revision=1,
            created_at=now,
            updated_at=now,
        )
        async with self._sf() as session:
            session.add(row)
            await session.commit()
            await session.refresh(row)
            return _iso_dict(row)

    async def list_by_user(self, user_id: str) -> list[dict[str, Any]]:
        member_count = (
            select(
                WorkflowWorkbenchMemberRow.workbench_id,
                func.count(WorkflowWorkbenchMemberRow.id).label("member_count"),
            )
            .group_by(WorkflowWorkbenchMemberRow.workbench_id)
            .subquery()
        )
        stmt = (
            select(WorkflowWorkbenchRow, func.coalesce(member_count.c.member_count, 0))
            .outerjoin(member_count, member_count.c.workbench_id == WorkflowWorkbenchRow.id)
            .where(WorkflowWorkbenchRow.user_id == user_id)
            .order_by(WorkflowWorkbenchRow.updated_at.desc(), WorkflowWorkbenchRow.id.desc())
        )
        async with self._sf() as session:
            result = await session.execute(stmt)
            rows: list[dict[str, Any]] = []
            for row, count in result.all():
                data = _iso_dict(row)
                data["member_count"] = int(count or 0)
                rows.append(data)
            return rows

    async def get(self, workbench_id: str, *, user_id: str) -> dict[str, Any] | None:
        async with self._sf() as session:
            row = await session.get(WorkflowWorkbenchRow, workbench_id)
            if row is None or row.user_id != user_id:
                return None
            data = _iso_dict(row)
            data["members"] = await self._list_members(session, workbench_id, user_id=user_id)
            return data

    async def update(
        self,
        workbench_id: str,
        *,
        user_id: str,
        updates: dict[str, Any],
        expected_revision: int | None = None,
    ) -> dict[str, Any] | None:
        async with self._sf() as session:
            row = await session.get(WorkflowWorkbenchRow, workbench_id)
            if row is None or row.user_id != user_id:
                return None
            if expected_revision is not None and row.revision != expected_revision:
                raise WorkbenchRevisionConflict(f"Workbench revision {expected_revision} is stale (current {row.revision})")
            for key in ("name", "description", "layout", "settings"):
                if key in updates and updates[key] is not None:
                    setattr(row, key, updates[key])
            row.revision += 1
            row.updated_at = datetime.now(UTC)
            await session.commit()
            await session.refresh(row)
            data = _iso_dict(row)
            data["members"] = await self._list_members(session, workbench_id, user_id=user_id)
            return data

    async def delete(self, workbench_id: str, *, user_id: str) -> bool:
        async with self._sf() as session:
            row = await session.get(WorkflowWorkbenchRow, workbench_id)
            if row is None or row.user_id != user_id:
                return False
            await session.execute(delete(WorkflowWorkbenchMemberRow).where(WorkflowWorkbenchMemberRow.workbench_id == workbench_id))
            await session.delete(row)
            await session.commit()
            return True

    async def add_member(
        self,
        workbench_id: str,
        *,
        user_id: str,
        definition_id: str,
        settings: dict[str, Any] | None = None,
    ) -> dict[str, Any]:
        async with self._sf() as session:
            workbench = await session.get(WorkflowWorkbenchRow, workbench_id)
            if workbench is None or workbench.user_id != user_id:
                raise LookupError("Workbench not found")
            definition = await session.get(WorkflowDefinitionRow, definition_id)
            if definition is None or definition.user_id != user_id:
                raise LookupError("Workflow definition not found")
            existing = await session.scalar(
                select(WorkflowWorkbenchMemberRow).where(
                    WorkflowWorkbenchMemberRow.workbench_id == workbench_id,
                    WorkflowWorkbenchMemberRow.definition_id == definition_id,
                )
            )
            if existing is not None:
                raise WorkbenchMemberConflict("Workflow is already a member of this workbench")
            max_order = await session.scalar(
                select(func.coalesce(func.max(WorkflowWorkbenchMemberRow.order_index), -1)).where(
                    WorkflowWorkbenchMemberRow.workbench_id == workbench_id,
                )
            )
            next_order = 0 if max_order is None else int(max_order) + 1
            row = WorkflowWorkbenchMemberRow(
                id=f"wbm-{uuid4().hex}",
                workbench_id=workbench_id,
                definition_id=definition_id,
                order_index=next_order,
                settings=settings if settings is not None else {},
                created_at=datetime.now(UTC),
            )
            session.add(row)
            workbench.updated_at = datetime.now(UTC)
            try:
                await session.commit()
            except IntegrityError as exc:
                await session.rollback()
                raise WorkbenchMemberConflict("Workflow is already a member of this workbench") from exc
            await session.refresh(row)
            return _member_dict(row)

    async def remove_member(self, workbench_id: str, *, user_id: str, definition_id: str) -> bool:
        async with self._sf() as session:
            workbench = await session.get(WorkflowWorkbenchRow, workbench_id)
            if workbench is None or workbench.user_id != user_id:
                return False
            result = await session.execute(
                delete(WorkflowWorkbenchMemberRow).where(
                    WorkflowWorkbenchMemberRow.workbench_id == workbench_id,
                    WorkflowWorkbenchMemberRow.definition_id == definition_id,
                )
            )
            if result.rowcount:
                workbench.updated_at = datetime.now(UTC)
                await session.commit()
            return bool(result.rowcount)

    async def delete_memberships_for_definition(self, definition_id: str) -> int:
        """Drop dangling workbench references when a definition is deleted."""
        async with self._sf() as session:
            result = await session.execute(delete(WorkflowWorkbenchMemberRow).where(WorkflowWorkbenchMemberRow.definition_id == definition_id))
            await session.commit()
            return result.rowcount or 0

    async def mirror_file_workbench(
        self,
        *,
        workbench_id: str,
        user_id: str,
        project_id: str,
        name: str,
        description: str,
        layout: dict[str, Any],
        settings: dict[str, Any],
        revision: int,
        members: list[dict[str, Any]],
    ) -> dict[str, Any]:
        """Upsert the internal mirror of a file-backed workbench.

        The file remains authoritative.  The mirror exists so run monitoring and
        legacy workspace tooling can keep reading the same SQL tables.
        """
        now = datetime.now(UTC)
        async with self._sf() as session:
            row = await session.get(WorkflowWorkbenchRow, workbench_id)
            if row is None:
                row = WorkflowWorkbenchRow(
                    id=workbench_id,
                    user_id=user_id,
                    project_id=project_id,
                    name=name,
                    description=description,
                    layout=layout,
                    settings=settings,
                    revision=revision,
                    created_at=now,
                    updated_at=now,
                )
                session.add(row)
            else:
                if row.user_id != user_id:
                    raise LookupError("Workbench mirror belongs to another user")
                row.project_id = project_id
                row.name = name
                row.description = description
                row.layout = layout
                row.settings = settings
                row.revision = revision
                row.updated_at = now

            await session.execute(delete(WorkflowWorkbenchMemberRow).where(WorkflowWorkbenchMemberRow.workbench_id == workbench_id))
            for member in members:
                session.add(
                    WorkflowWorkbenchMemberRow(
                        id=f"wbm-{uuid4().hex}",
                        workbench_id=workbench_id,
                        definition_id=str(member["definition_id"]),
                        order_index=int(member.get("order_index") or 0),
                        settings=member.get("settings") or {},
                        created_at=now,
                    )
                )
            await session.commit()
            await session.refresh(row)
            return _iso_dict(row)

    async def get_member(self, workbench_id: str, *, user_id: str, definition_id: str) -> dict[str, Any] | None:
        async with self._sf() as session:
            workbench = await session.get(WorkflowWorkbenchRow, workbench_id)
            if workbench is None or workbench.user_id != user_id:
                return None
            row = await session.scalar(
                select(WorkflowWorkbenchMemberRow).where(
                    WorkflowWorkbenchMemberRow.workbench_id == workbench_id,
                    WorkflowWorkbenchMemberRow.definition_id == definition_id,
                )
            )
            return _member_dict(row) if row is not None else None

    async def _list_members(
        self,
        session: AsyncSession,
        workbench_id: str,
        *,
        user_id: str,
    ) -> list[dict[str, Any]]:
        stmt = (
            select(WorkflowWorkbenchMemberRow, WorkflowDefinitionRow)
            .outerjoin(
                WorkflowDefinitionRow,
                WorkflowDefinitionRow.id == WorkflowWorkbenchMemberRow.definition_id,
            )
            .where(WorkflowWorkbenchMemberRow.workbench_id == workbench_id)
            .order_by(WorkflowWorkbenchMemberRow.order_index.asc(), WorkflowWorkbenchMemberRow.created_at.asc())
        )
        result = await session.execute(stmt)
        members: list[dict[str, Any]] = []
        for member, definition in result.all():
            data = _member_dict(member)
            if definition is not None and definition.user_id == user_id:
                data["definition_name"] = definition.name
                data["definition_version"] = definition.version
                data["definition_exists"] = True
            else:
                data["definition_name"] = None
                data["definition_version"] = None
                data["definition_exists"] = False
            members.append(data)
        return members
