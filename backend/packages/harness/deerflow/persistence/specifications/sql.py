"""Persistence for immutable formal specifications."""

from __future__ import annotations

from datetime import UTC, datetime
from typing import Any
from uuid import uuid4

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from deerflow.persistence.specifications.model import WorkflowSpecificationRow
from deerflow.persistence.specifications.revision_model import WorkflowSpecificationRevisionRow
from deerflow.utils.time import coerce_iso
from deerflow.workflow.spec import SpecLanguage, SpecRef, SpecStatus, content_hash, parse_spec_ref


class SpecificationNotFoundError(LookupError):
    """The specification or revision does not exist for this user."""


class SpecificationConflictError(ValueError):
    """A revision/state transition is not allowed."""


def _head(row: WorkflowSpecificationRow) -> dict[str, Any]:
    data = row.to_dict()
    for key in ("created_at", "updated_at"):
        if data.get(key) is not None:
            data[key] = coerce_iso(data[key])
    return data


def _revision(row: WorkflowSpecificationRevisionRow) -> dict[str, Any]:
    data = row.to_dict()
    data["metadata"] = data.pop("def_metadata", {}) or {}
    for key in ("created_at", "approved_at"):
        if data.get(key) is not None:
            data[key] = coerce_iso(data[key])
    return data


class SpecificationRepository:
    """User-scoped specification head + immutable revision store."""

    def __init__(self, session_factory: async_sessionmaker[AsyncSession]) -> None:
        self._sf = session_factory

    async def list_by_user(self, user_id: str) -> list[dict[str, Any]]:
        stmt = select(WorkflowSpecificationRow).where(WorkflowSpecificationRow.user_id == user_id).order_by(WorkflowSpecificationRow.updated_at.desc(), WorkflowSpecificationRow.id)
        async with self._sf() as session:
            rows = (await session.execute(stmt)).scalars().all()
            return [_head(row) for row in rows]

    async def get(self, spec_id: str, *, user_id: str) -> dict[str, Any] | None:
        async with self._sf() as session:
            row = await session.get(WorkflowSpecificationRow, spec_id)
            if row is None or row.user_id != user_id:
                return None
            return _head(row)

    async def list_revisions(self, spec_id: str, *, user_id: str) -> list[dict[str, Any]]:
        if await self.get(spec_id, user_id=user_id) is None:
            raise SpecificationNotFoundError(spec_id)
        stmt = select(WorkflowSpecificationRevisionRow).where(WorkflowSpecificationRevisionRow.spec_id == spec_id, WorkflowSpecificationRevisionRow.user_id == user_id).order_by(WorkflowSpecificationRevisionRow.revision.desc())
        async with self._sf() as session:
            rows = (await session.execute(stmt)).scalars().all()
            return [_revision(row) for row in rows]

    async def get_revision(self, spec_id: str, revision: int, *, user_id: str) -> dict[str, Any] | None:
        stmt = select(WorkflowSpecificationRevisionRow).where(
            WorkflowSpecificationRevisionRow.spec_id == spec_id,
            WorkflowSpecificationRevisionRow.revision == revision,
            WorkflowSpecificationRevisionRow.user_id == user_id,
        )
        async with self._sf() as session:
            row = (await session.execute(stmt)).scalar_one_or_none()
            return _revision(row) if row is not None else None

    async def create(
        self,
        *,
        user_id: str,
        name: str,
        language: SpecLanguage,
        content: str,
        title: str | None = None,
        metadata: dict[str, Any] | None = None,
    ) -> dict[str, Any]:
        now = datetime.now(UTC)
        spec_id = f"spec-{uuid4().hex}"
        head = WorkflowSpecificationRow(
            id=spec_id,
            user_id=user_id,
            name=name,
            language=language.value,
            current_revision=1,
            created_at=now,
            updated_at=now,
        )
        revision = WorkflowSpecificationRevisionRow(
            id=f"spr-{uuid4().hex}",
            spec_id=spec_id,
            user_id=user_id,
            revision=1,
            language=language.value,
            content=content,
            content_hash=content_hash(content),
            status=SpecStatus.DRAFT.value,
            title=title,
            def_metadata=metadata or {},
            created_at=now,
        )
        async with self._sf() as session:
            session.add_all([head, revision])
            await session.commit()
            await session.refresh(revision)
            return _revision(revision)

    async def add_revision(
        self,
        spec_id: str,
        *,
        user_id: str,
        content: str,
        title: str | None = None,
        metadata: dict[str, Any] | None = None,
        language: SpecLanguage | None = None,
    ) -> dict[str, Any]:
        async with self._sf() as session:
            head = await session.get(WorkflowSpecificationRow, spec_id)
            if head is None or head.user_id != user_id:
                raise SpecificationNotFoundError(spec_id)
            next_revision = int(head.current_revision) + 1
            now = datetime.now(UTC)
            row = WorkflowSpecificationRevisionRow(
                id=f"spr-{uuid4().hex}",
                spec_id=spec_id,
                user_id=user_id,
                revision=next_revision,
                language=(language or SpecLanguage(head.language)).value,
                content=content,
                content_hash=content_hash(content),
                status=SpecStatus.DRAFT.value,
                title=title,
                def_metadata=metadata or {},
                created_at=now,
            )
            head.current_revision = next_revision
            head.updated_at = now
            if language is not None:
                head.language = language.value
            session.add(row)
            await session.commit()
            await session.refresh(row)
            return _revision(row)

    async def freeze(
        self,
        spec_id: str,
        revision: int,
        *,
        user_id: str,
        approved_by: str,
        approval_task_id: str | None = None,
    ) -> dict[str, Any]:
        if not approved_by.strip():
            raise SpecificationConflictError("freeze requires a non-empty approved_by")
        async with self._sf() as session:
            head = await session.get(WorkflowSpecificationRow, spec_id)
            if head is None or head.user_id != user_id:
                raise SpecificationNotFoundError(spec_id)
            stmt = select(WorkflowSpecificationRevisionRow).where(
                WorkflowSpecificationRevisionRow.spec_id == spec_id,
                WorkflowSpecificationRevisionRow.user_id == user_id,
            )
            rows = (await session.execute(stmt)).scalars().all()
            target = next((row for row in rows if row.revision == revision), None)
            if target is None:
                raise SpecificationNotFoundError(f"{spec_id}@{revision}")
            if target.status == SpecStatus.SUPERSEDED.value:
                raise SpecificationConflictError(f"revision {revision} is superseded and cannot be frozen")
            now = datetime.now(UTC)
            for row in rows:
                if row.revision != revision and row.status == SpecStatus.FROZEN.value:
                    row.status = SpecStatus.SUPERSEDED.value
            target.status = SpecStatus.FROZEN.value
            target.approved_by = approved_by.strip()
            target.approval_task_id = approval_task_id
            target.approved_at = now
            head.updated_at = now
            await session.commit()
            await session.refresh(target)
            return _revision(target)

    async def resolve_ref(self, ref: SpecRef | dict[str, Any], *, user_id: str) -> dict[str, Any]:
        parsed = parse_spec_ref(ref)
        row = await self.get_revision(parsed.spec_id, parsed.revision, user_id=user_id)
        if row is None:
            raise SpecificationNotFoundError(f"{parsed.spec_id}@{parsed.revision}")
        if row["content_hash"] != parsed.content_hash:
            raise SpecificationConflictError(f"spec {parsed.spec_id}@{parsed.revision} content hash mismatch")
        if row["status"] != SpecStatus.FROZEN.value:
            raise SpecificationConflictError(f"spec {parsed.spec_id}@{parsed.revision} is not frozen (status={row['status']})")
        return row


__all__ = [
    "SpecificationConflictError",
    "SpecificationNotFoundError",
    "SpecificationRepository",
]
