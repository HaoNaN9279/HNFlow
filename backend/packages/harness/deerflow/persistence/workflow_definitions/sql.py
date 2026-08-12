from __future__ import annotations

from datetime import UTC, datetime
from typing import Any

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from deerflow.persistence.workflow_definitions.model import WorkflowDefinitionRow
from deerflow.utils.time import coerce_iso


class WorkflowDefinitionRepository:
    def __init__(self, session_factory: async_sessionmaker[AsyncSession]) -> None:
        self._sf = session_factory

    @staticmethod
    def _row_to_dict(row: WorkflowDefinitionRow) -> dict[str, Any]:
        data = row.to_dict()
        # Map ORM attribute name to DB column name for API consistency.
        data["metadata"] = data.pop("def_metadata")
        for key in ("created_at", "updated_at", "resolved_at"):
            if data.get(key) is not None:
                data[key] = coerce_iso(data[key])
        return data

    async def create(
        self,
        *,
        definition_id: str,
        user_id: str,
        name: str,
        schema_version: int,
        definition: dict[str, Any],
        metadata: dict[str, Any] | None = None,
        version: str = "0.1.0",
        resolved_at: datetime | None = None,
    ) -> dict[str, Any]:
        now = datetime.now(UTC)
        row = WorkflowDefinitionRow(
            id=definition_id,
            user_id=user_id,
            name=name,
            schema_version=schema_version,
            definition=definition,
            def_metadata=metadata if metadata is not None else {},
            version=version,
            resolved_at=resolved_at,
            created_at=now,
            updated_at=now,
        )
        async with self._sf() as session:
            session.add(row)
            await session.commit()
            await session.refresh(row)
            return self._row_to_dict(row)

    async def get(self, definition_id: str, *, user_id: str) -> dict[str, Any] | None:
        async with self._sf() as session:
            row = await session.get(WorkflowDefinitionRow, definition_id)
            if row is None or row.user_id != user_id:
                return None
            return self._row_to_dict(row)

    async def list_by_user(self, user_id: str) -> list[dict[str, Any]]:
        stmt = select(WorkflowDefinitionRow).where(WorkflowDefinitionRow.user_id == user_id).order_by(WorkflowDefinitionRow.created_at.desc(), WorkflowDefinitionRow.id.desc())
        async with self._sf() as session:
            result = await session.execute(stmt)
            return [self._row_to_dict(row) for row in result.scalars()]

    async def update(
        self,
        definition_id: str,
        *,
        user_id: str,
        updates: dict[str, Any],
    ) -> dict[str, Any] | None:
        # Map API-facing key "metadata" to ORM attribute "def_metadata".
        _updates = dict(updates)
        if "metadata" in _updates:
            _updates["def_metadata"] = _updates.pop("metadata")
        async with self._sf() as session:
            row = await session.get(WorkflowDefinitionRow, definition_id)
            if row is None or row.user_id != user_id:
                return None
            for key, value in _updates.items():
                if hasattr(row, key):
                    setattr(row, key, value)
            row.updated_at = datetime.now(UTC)
            await session.commit()
            await session.refresh(row)
            return self._row_to_dict(row)

    async def delete(self, definition_id: str, *, user_id: str) -> bool:
        async with self._sf() as session:
            row = await session.get(WorkflowDefinitionRow, definition_id)
            if row is None or row.user_id != user_id:
                return False
            await session.delete(row)
            await session.commit()
            return True
