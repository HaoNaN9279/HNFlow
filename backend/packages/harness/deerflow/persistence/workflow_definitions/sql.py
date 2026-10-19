from __future__ import annotations

import hashlib
import json
from datetime import UTC, datetime
from typing import Any
from uuid import uuid4

from sqlalchemy import delete, func, select
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from deerflow.persistence.workflow_definitions.model import WorkflowDefinitionRow
from deerflow.persistence.workflow_definitions.revision_model import WorkflowDefinitionRevisionRow
from deerflow.utils.time import coerce_iso


def _content_hash(definition: dict[str, Any]) -> str:
    payload = json.dumps(definition, sort_keys=True, ensure_ascii=False, separators=(",", ":"))
    return hashlib.sha256(payload.encode("utf-8")).hexdigest()


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

    @staticmethod
    def _revision_to_dict(row: WorkflowDefinitionRevisionRow) -> dict[str, Any]:
        data = row.to_dict()
        data["metadata"] = data.pop("def_metadata")
        if data.get("created_at") is not None:
            data["created_at"] = coerce_iso(data["created_at"])
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
            session.add(
                WorkflowDefinitionRevisionRow(
                    id=f"wfr-{uuid4().hex}",
                    definition_id=definition_id,
                    user_id=user_id,
                    revision=1,
                    content_hash=_content_hash(definition),
                    schema_version=schema_version,
                    definition=definition,
                    def_metadata=metadata if metadata is not None else {},
                    version=version,
                    created_at=now,
                )
            )
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

            if "definition" in _updates:
                latest = await session.scalar(
                    select(func.coalesce(func.max(WorkflowDefinitionRevisionRow.revision), 0)).where(
                        WorkflowDefinitionRevisionRow.definition_id == definition_id,
                    )
                )
                next_revision = int(latest or 0) + 1
                session.add(
                    WorkflowDefinitionRevisionRow(
                        id=f"wfr-{uuid4().hex}",
                        definition_id=definition_id,
                        user_id=user_id,
                        revision=next_revision,
                        content_hash=_content_hash(row.definition),
                        schema_version=row.schema_version,
                        definition=row.definition,
                        def_metadata=row.def_metadata,
                        version=row.version,
                        created_at=row.updated_at,
                    )
                )
            await session.commit()
            await session.refresh(row)
            return self._row_to_dict(row)

    async def list_revisions(self, definition_id: str, *, user_id: str) -> list[dict[str, Any]]:
        stmt = select(WorkflowDefinitionRevisionRow).where(WorkflowDefinitionRevisionRow.definition_id == definition_id, WorkflowDefinitionRevisionRow.user_id == user_id).order_by(WorkflowDefinitionRevisionRow.revision.desc())
        async with self._sf() as session:
            result = await session.execute(stmt)
            return [self._revision_to_dict(row) for row in result.scalars()]

    async def get_revision(self, revision_id: str, *, user_id: str) -> dict[str, Any] | None:
        async with self._sf() as session:
            row = await session.get(WorkflowDefinitionRevisionRow, revision_id)
            if row is None or row.user_id != user_id:
                return None
            return self._revision_to_dict(row)

    async def delete(self, definition_id: str, *, user_id: str) -> bool:
        async with self._sf() as session:
            row = await session.get(WorkflowDefinitionRow, definition_id)
            if row is None or row.user_id != user_id:
                return False
            await session.execute(delete(WorkflowDefinitionRevisionRow).where(WorkflowDefinitionRevisionRow.definition_id == definition_id))
            await session.delete(row)
            await session.commit()
            return True
