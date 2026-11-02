"""Repository for durable local-application instance records (N6).

Mirrors the write style of :mod:`deerflow.persistence.human_tasks.sql`:
conditional UPDATEs for state transitions, per-user reads, and a single
read-modify-write for cumulative resource counters.
"""

from __future__ import annotations

from datetime import UTC, datetime, timedelta
from typing import Any

from sqlalchemy import delete, func, select, update
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from deerflow.persistence.app_instances.model import AppInstanceRow
from deerflow.utils.time import coerce_iso

#: Statuses a live (in-memory) session can carry.
LIVE_STATUSES: tuple[str, ...] = ("launching", "ready", "attached", "busy")
#: Non-terminal statuses a previous process may have left behind; these are
#: reaped to ``orphaned`` on startup.
ACTIVE_STATUSES: tuple[str, ...] = ("launching", "ready", "attached", "busy", "crashed")
#: Terminal statuses that archival/cleanup may act on.
TERMINAL_STATUSES: tuple[str, ...] = ("stopped", "orphaned", "archived")

#: Default status set deleted by :meth:`AppInstanceRepository.cleanup`.
CLEANUP_STATUSES: tuple[str, ...] = ("archived", "stopped", "orphaned")


def _row_to_dict(row: AppInstanceRow) -> dict[str, Any]:
    data = row.to_dict()
    for key in ("created_at", "last_active", "archived_at", "updated_at"):
        if data.get(key) is not None:
            data[key] = coerce_iso(data[key])
    return data


class AppInstanceRepository:
    """Async CRUD + lifecycle store for ``app_instances``."""

    def __init__(self, session_factory: async_sessionmaker[AsyncSession]) -> None:
        self._sf = session_factory

    # -- create / read --

    async def create(
        self,
        *,
        session_id: str,
        user_id: str,
        app_name: str,
        driver: str,
        status: str,
        pid: int | None = None,
        endpoint: str | None = None,
        handle: dict[str, Any] | None = None,
        exclusive: bool = True,
        created_at: float | None = None,
        resources: dict[str, Any] | None = None,
    ) -> dict[str, Any]:
        now = datetime.now(UTC)
        created = datetime.fromtimestamp(created_at, tz=UTC) if created_at else now
        row = AppInstanceRow(
            id=session_id,
            user_id=user_id,
            app_name=app_name,
            driver=driver,
            status=status,
            pid=pid,
            endpoint=endpoint,
            handle=dict(handle or {}),
            exclusive=exclusive,
            resources=dict(resources or {}),
            created_at=created,
            last_active=now,
            updated_at=now,
        )
        async with self._sf() as session:
            # Upsert-safe: a re-launch reusing a session id replaces the record.
            existing = await session.get(AppInstanceRow, session_id)
            if existing is not None:
                await session.delete(existing)
                await session.flush()
            session.add(row)
            await session.commit()
            await session.refresh(row)
            return _row_to_dict(row)

    async def get(self, session_id: str, *, user_id: str) -> dict[str, Any] | None:
        async with self._sf() as session:
            row = await session.get(AppInstanceRow, session_id)
            if row is None or row.user_id != user_id:
                return None
            return _row_to_dict(row)

    async def list_by_user(
        self,
        user_id: str,
        *,
        status: str | None = None,
        include_archived: bool = True,
        include_orphaned: bool = True,
    ) -> list[dict[str, Any]]:
        stmt = select(AppInstanceRow).where(AppInstanceRow.user_id == user_id)
        if status is not None:
            stmt = stmt.where(AppInstanceRow.status == status)
        else:
            hidden: list[str] = []
            if not include_archived:
                hidden.append("archived")
            if not include_orphaned:
                hidden.append("orphaned")
            if hidden:
                stmt = stmt.where(AppInstanceRow.status.not_in(hidden))
        stmt = stmt.order_by(AppInstanceRow.last_active.desc(), AppInstanceRow.id.desc())
        async with self._sf() as session:
            result = await session.execute(stmt)
            return [_row_to_dict(row) for row in result.scalars()]

    async def list_terminal_since(
        self,
        user_id: str,
        *,
        app_name: str,
        since: datetime | None,
        statuses: tuple[str, ...] = ("stopped", "crashed"),
        limit: int = 20,
    ) -> list[dict[str, Any]]:
        """Terminal instances of one app touched after ``since`` (N7 event triggers).

        ``since=None`` means "any recorded terminal instance" (first evaluation
        of a trigger that has never fired). Ordered newest-first so the event
        trigger dispatches for the most recent transition.
        """
        stmt = select(AppInstanceRow).where(
            AppInstanceRow.user_id == user_id,
            AppInstanceRow.app_name == app_name,
            AppInstanceRow.status.in_(statuses),
        )
        if since is not None:
            stmt = stmt.where(AppInstanceRow.updated_at > since)
        stmt = stmt.order_by(AppInstanceRow.updated_at.desc(), AppInstanceRow.id.desc()).limit(limit)
        async with self._sf() as session:
            result = await session.execute(stmt)
            return [_row_to_dict(row) for row in result.scalars()]

    # -- lifecycle --

    async def record_operation(
        self,
        session_id: str,
        *,
        user_id: str,
        status: str | None = None,
        resource_deltas: dict[str, Any] | None = None,
        last_active: float | None = None,
    ) -> dict[str, Any] | None:
        """Refresh an instance after an operation: bump counters + status.

        ``resource_deltas`` numeric values are **added** to the stored counters
        (e.g. ``{"scripts_run": 1}``); non-numeric values (``last_error``)
        replace.  Read-modify-write, acceptable for the single-user local build.
        Returns the refreshed row, or ``None`` when the instance is unknown.
        """
        async with self._sf() as session:
            row = await session.get(AppInstanceRow, session_id)
            if row is None or row.user_id != user_id:
                return None
            if resource_deltas:
                merged = dict(row.resources or {})
                for key, delta in resource_deltas.items():
                    if isinstance(delta, (int, float)) and not isinstance(delta, bool) and isinstance(merged.get(key, 0), (int, float)):
                        merged[key] = merged.get(key, 0) + delta
                    else:
                        merged[key] = delta
                row.resources = merged
            if status is not None:
                row.status = status
            row.last_active = datetime.fromtimestamp(last_active, tz=UTC) if last_active else datetime.now(UTC)
            row.updated_at = datetime.now(UTC)
            await session.commit()
            await session.refresh(row)
            return _row_to_dict(row)

    async def set_status(self, session_id: str, *, user_id: str, to_status: str, allowed_from: tuple[str, ...]) -> dict[str, Any] | None:
        """Conditional transition; returns the refreshed row or ``None`` on conflict."""
        if not allowed_from:
            return None
        async with self._sf() as session:
            result = await session.execute(
                update(AppInstanceRow)
                .where(
                    AppInstanceRow.id == session_id,
                    AppInstanceRow.user_id == user_id,
                    AppInstanceRow.status.in_(allowed_from),
                    AppInstanceRow.status != to_status,
                )
                .values(status=to_status, updated_at=datetime.now(UTC))
            )
            if result.rowcount != 1:
                await session.rollback()
                return None
            await session.commit()
            row = await session.get(AppInstanceRow, session_id)
            if row is None or row.user_id != user_id:
                return None
            return _row_to_dict(row)

    async def archive(self, session_id: str, *, user_id: str) -> dict[str, Any] | None:
        """Archive a non-live instance (idempotent; live rows are rejected)."""
        async with self._sf() as session:
            row = await session.get(AppInstanceRow, session_id)
            if row is None or row.user_id != user_id:
                return None
            if row.status in LIVE_STATUSES:
                return None
            row.status = "archived"
            row.archived_at = datetime.now(UTC)
            row.updated_at = datetime.now(UTC)
            await session.commit()
            await session.refresh(row)
            return _row_to_dict(row)

    async def delete(self, session_id: str, *, user_id: str) -> bool:
        async with self._sf() as session:
            row = await session.get(AppInstanceRow, session_id)
            if row is None or row.user_id != user_id:
                return False
            await session.delete(row)
            await session.commit()
            return True

    # -- maintenance --

    async def mark_orphaned(self, *, user_id: str | None = None) -> int:
        """Reap instances left active by a previous process to ``orphaned``.

        Returns the number of rows updated.  Called at Gateway startup: the
        process-local session map is gone, so a persisted ``ready``/``busy`` row
        can no longer be trusted.  No automatic re-attach (that needs the driver
        and belongs to N7).
        """
        now = datetime.now(UTC)
        stmt = update(AppInstanceRow).where(AppInstanceRow.status.in_(ACTIVE_STATUSES)).values(status="orphaned", updated_at=now)
        if user_id is not None:
            stmt = stmt.where(AppInstanceRow.user_id == user_id)
        async with self._sf() as session:
            result = await session.execute(stmt)
            await session.commit()
            return result.rowcount or 0

    async def cleanup(
        self,
        *,
        older_than_days: int,
        user_id: str | None = None,
        statuses: tuple[str, ...] = CLEANUP_STATUSES,
    ) -> int:
        """Delete terminal instances idle for longer than *older_than_days*.

        Returns the number of rows deleted.  *statuses* defaults to the terminal
        set; live rows are never swept.
        """
        if older_than_days < 0:
            raise ValueError("older_than_days must be >= 0")
        cutoff = datetime.now(UTC) - timedelta(days=older_than_days)
        stmt = delete(AppInstanceRow).where(AppInstanceRow.status.in_(statuses), AppInstanceRow.last_active < cutoff)
        if user_id is not None:
            stmt = stmt.where(AppInstanceRow.user_id == user_id)
        async with self._sf() as session:
            result = await session.execute(stmt)
            await session.commit()
            return result.rowcount or 0

    async def count_by_status(self, *, user_id: str | None = None) -> dict[str, int]:
        """Return ``{status: count}`` (reporting helper for the API surface)."""
        stmt = select(AppInstanceRow.status, func.count()).group_by(AppInstanceRow.status)
        if user_id is not None:
            stmt = stmt.where(AppInstanceRow.user_id == user_id)
        async with self._sf() as session:
            result = await session.execute(stmt)
            return {status: count for status, count in result.all()}


__all__ = [
    "AppInstanceRepository",
    "ACTIVE_STATUSES",
    "LIVE_STATUSES",
    "TERMINAL_STATUSES",
    "CLEANUP_STATUSES",
]
