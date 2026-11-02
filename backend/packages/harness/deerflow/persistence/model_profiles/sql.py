from __future__ import annotations

from datetime import UTC, datetime
from typing import Any
from uuid import uuid4

from sqlalchemy import select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from deerflow.persistence.model_profiles.model import ModelProfileRow
from deerflow.utils.time import coerce_iso


class ModelProfileNotFoundError(LookupError):
    """The profile does not exist or is not owned by the caller."""


class ModelProfileConflictError(ValueError):
    """A profile name already exists for this user."""


def _profile_dict(row: ModelProfileRow) -> dict[str, Any]:
    data = row.to_dict()
    for key in ("created_at", "updated_at"):
        if data.get(key) is not None:
            data[key] = coerce_iso(data[key])
    return data


class ModelProfileRepository:
    """Persistence for user-managed model profiles (one hop to a real model)."""

    def __init__(self, session_factory: async_sessionmaker[AsyncSession]) -> None:
        self._sf = session_factory

    async def list_by_user(self, user_id: str) -> list[dict[str, Any]]:
        stmt = select(ModelProfileRow).where(ModelProfileRow.user_id == user_id).order_by(ModelProfileRow.name.asc(), ModelProfileRow.id.asc())
        async with self._sf() as session:
            rows = (await session.execute(stmt)).scalars().all()
            return [_profile_dict(row) for row in rows]

    async def get(self, profile_id: str, *, user_id: str) -> dict[str, Any] | None:
        async with self._sf() as session:
            row = await session.get(ModelProfileRow, profile_id)
            if row is None or row.user_id != user_id:
                return None
            return _profile_dict(row)

    async def create(
        self,
        *,
        user_id: str,
        name: str,
        display_name: str,
        target_model: str,
        description: str | None = None,
        enabled: bool = True,
    ) -> dict[str, Any]:
        now = datetime.now(UTC)
        row = ModelProfileRow(
            id=f"mp-{uuid4().hex}",
            user_id=user_id,
            name=name,
            display_name=display_name,
            description=description,
            target_model=target_model,
            enabled=enabled,
            created_at=now,
            updated_at=now,
        )
        async with self._sf() as session:
            session.add(row)
            try:
                await session.commit()
            except IntegrityError as exc:
                await session.rollback()
                raise ModelProfileConflictError(f"A model profile named '{name}' already exists") from exc
            await session.refresh(row)
            return _profile_dict(row)

    async def update(
        self,
        profile_id: str,
        *,
        user_id: str,
        updates: dict[str, Any],
    ) -> dict[str, Any] | None:
        async with self._sf() as session:
            row = await session.get(ModelProfileRow, profile_id)
            if row is None or row.user_id != user_id:
                return None
            next_name = str(updates.get("name", row.name))
            for key in ("name", "display_name", "description", "target_model", "enabled"):
                if key in updates:
                    setattr(row, key, updates[key])
            row.updated_at = datetime.now(UTC)
            try:
                await session.commit()
            except IntegrityError as exc:
                await session.rollback()
                raise ModelProfileConflictError(f"A model profile named '{next_name}' already exists") from exc
            await session.refresh(row)
            return _profile_dict(row)

    async def delete(self, profile_id: str, *, user_id: str) -> bool:
        async with self._sf() as session:
            row = await session.get(ModelProfileRow, profile_id)
            if row is None or row.user_id != user_id:
                return False
            await session.delete(row)
            await session.commit()
            return True
