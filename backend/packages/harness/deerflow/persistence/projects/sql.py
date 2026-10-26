"""Repository for the project registry."""

from __future__ import annotations

from datetime import UTC, datetime
from typing import Any

from sqlalchemy import select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from deerflow.persistence.projects.model import ProjectRow
from deerflow.utils.time import coerce_iso


class ProjectRootConflictError(ValueError):
    """A project root is already registered to another project."""


class ProjectRepository:
    def __init__(self, session_factory: async_sessionmaker[AsyncSession]) -> None:
        self._sf = session_factory

    @staticmethod
    def _row_to_dict(row: ProjectRow) -> dict[str, Any]:
        data = row.to_dict()
        for key in ("created_at", "updated_at"):
            if data.get(key) is not None:
                data[key] = coerce_iso(data[key])
        return data

    async def upsert(
        self,
        *,
        project_id: str,
        user_id: str,
        name: str,
        root_path: str,
        manifest_hash: str,
    ) -> dict[str, Any]:
        now = datetime.now(UTC)
        async with self._sf() as session:
            row = await session.get(ProjectRow, project_id)
            if row is not None and row.user_id != user_id:
                raise ProjectRootConflictError(f"project {project_id!r} belongs to another user")
            existing = await session.scalar(
                select(ProjectRow).where(
                    ProjectRow.user_id == user_id,
                    ProjectRow.root_path == root_path,
                    ProjectRow.id != project_id,
                )
            )
            if existing is not None:
                raise ProjectRootConflictError(f"project root {root_path!r} is already registered as {existing.id}")
            if row is None:
                row = ProjectRow(
                    id=project_id,
                    user_id=user_id,
                    name=name,
                    root_path=root_path,
                    manifest_hash=manifest_hash,
                    created_at=now,
                    updated_at=now,
                )
                session.add(row)
            else:
                row.name = name
                row.root_path = root_path
                row.manifest_hash = manifest_hash
                row.updated_at = now
            try:
                await session.commit()
            except IntegrityError as exc:
                await session.rollback()
                raise ProjectRootConflictError(f"project root {root_path!r} is already registered") from exc
            await session.refresh(row)
            return self._row_to_dict(row)

    async def get(self, project_id: str, *, user_id: str) -> dict[str, Any] | None:
        async with self._sf() as session:
            row = await session.get(ProjectRow, project_id)
            if row is None or row.user_id != user_id:
                return None
            return self._row_to_dict(row)

    async def list_by_user(self, user_id: str) -> list[dict[str, Any]]:
        stmt = select(ProjectRow).where(ProjectRow.user_id == user_id).order_by(ProjectRow.updated_at.desc(), ProjectRow.id.desc())
        async with self._sf() as session:
            rows = (await session.execute(stmt)).scalars().all()
            return [self._row_to_dict(row) for row in rows]

    async def delete(self, project_id: str, *, user_id: str) -> bool:
        async with self._sf() as session:
            row = await session.get(ProjectRow, project_id)
            if row is None or row.user_id != user_id:
                return False
            await session.delete(row)
            await session.commit()
            return True


__all__ = ["ProjectRepository", "ProjectRootConflictError"]
