"""Workflow undo record store (N10).

Mirrors :mod:`deerflow.persistence.human_tasks.sql`: an async SQLAlchemy
repository over an injected session factory, with a conditional-UPDATE
transition so two concurrent undo attempts cannot both claim the same record.
Writes are **best-effort** at the call site (an executor recording what it did
must never fail because persistence did).
"""

from __future__ import annotations

from datetime import UTC, datetime
from typing import Any
from uuid import uuid4

from sqlalchemy import select, update
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from deerflow.persistence.workflow_undo.model import WorkflowUndoRow
from deerflow.utils.time import coerce_iso
from deerflow.workflow.undo import ALLOWED_UNDO_TRANSITIONS, UndoStatus


def _allowed_sources(to_status: str) -> list[str]:
    """Statuses a transition to *to_status* is legal from (reverse lookup).

    Derived from the state machine so the repository cannot drift from it; an
    unknown target yields an empty list, which makes the conditional UPDATE match
    no rows and rejects the transition.
    """
    try:
        target = UndoStatus(to_status)
    except ValueError:
        return []
    return [source.value for source, allowed in ALLOWED_UNDO_TRANSITIONS.items() if target in allowed]


class WorkflowUndoRepository:
    def __init__(self, session_factory: async_sessionmaker[AsyncSession]) -> None:
        self._sf = session_factory

    @staticmethod
    def _row_to_dict(row: WorkflowUndoRow) -> dict[str, Any]:
        data = row.to_dict()
        for key in ("created_at", "updated_at"):
            if data.get(key) is not None:
                data[key] = coerce_iso(data[key])
        return data

    async def create(
        self,
        *,
        user_id: str,
        run_id: str,
        node_id: str,
        kind: str,
        targets: list[dict[str, Any]] | None = None,
        backup_paths: list[str] | None = None,
        session_id: str | None = None,
        app_steps: int | None = None,
        detail: str = "",
        status: str = UndoStatus.RECORDED.value,
    ) -> dict[str, Any]:
        now = datetime.now(UTC)
        row = WorkflowUndoRow(
            id=f"undo-{uuid4().hex}",
            user_id=user_id,
            run_id=run_id,
            node_id=node_id,
            kind=kind,
            status=status,
            targets=list(targets or []),
            backup_paths=list(backup_paths or []),
            session_id=session_id,
            app_steps=app_steps,
            detail=detail,
            created_at=now,
            updated_at=now,
        )
        async with self._sf() as session:
            session.add(row)
            await session.commit()
            await session.refresh(row)
            return self._row_to_dict(row)

    async def get(self, record_id: str, *, user_id: str) -> dict[str, Any] | None:
        async with self._sf() as session:
            row = await session.get(WorkflowUndoRow, record_id)
            if row is None or row.user_id != user_id:
                return None
            return self._row_to_dict(row)

    async def list_by_run(self, run_id: str, *, user_id: str | None = None) -> list[dict[str, Any]]:
        """Return a run's records oldest-first — the order :func:`plan_undo` reverses."""
        stmt = select(WorkflowUndoRow).where(WorkflowUndoRow.run_id == run_id)
        if user_id is not None:
            stmt = stmt.where(WorkflowUndoRow.user_id == user_id)
        stmt = stmt.order_by(WorkflowUndoRow.created_at.asc(), WorkflowUndoRow.id.asc())
        async with self._sf() as session:
            result = await session.execute(stmt)
            return [self._row_to_dict(row) for row in result.scalars()]

    async def mark(self, record_id: str, *, user_id: str, to_status: str, detail: str | None = None) -> dict[str, Any] | None:
        """Conditionally transition a record; ``None`` when the move is illegal.

        The condition is the whole point: two concurrent undo requests for one run
        must not both "undo" the same record, and an already-undone record must
        not be undone twice.
        """
        sources = _allowed_sources(to_status)
        if not sources:
            return None
        values: dict[str, Any] = {"status": to_status, "updated_at": datetime.now(UTC)}
        if detail is not None:
            values["detail"] = detail[:512]
        stmt = update(WorkflowUndoRow).where(WorkflowUndoRow.id == record_id, WorkflowUndoRow.user_id == user_id, WorkflowUndoRow.status.in_(sources)).values(**values)
        async with self._sf() as session:
            result = await session.execute(stmt)
            if result.rowcount != 1:
                await session.rollback()
                return None
            await session.commit()
            row = await session.get(WorkflowUndoRow, record_id)
            if row is None or row.user_id != user_id:
                return None
            return self._row_to_dict(row)
