from __future__ import annotations

from datetime import UTC, datetime
from typing import Any
from uuid import uuid4

from sqlalchemy import JSON, delete, select, update
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from deerflow.persistence.human_tasks.model import HumanTaskRow
from deerflow.utils.time import coerce_iso
from deerflow.workflow.human_task_state import ALLOWED_TRANSITIONS, HumanTaskStatus


def _allowed_sources(to_status: str) -> list[str]:
    """Return the statuses from which a transition to *to_status* is legal.

    Derived from :data:`deerflow.workflow.human_task_state.ALLOWED_TRANSITIONS`
    (reverse lookup) so the repository never hard-codes a source set that could
    drift from the state machine. Unknown or unreachable *to_status* values
    yield an empty list, so the conditional UPDATE below matches no rows and the
    transition is rejected.
    """
    try:
        target = HumanTaskStatus(to_status)
    except ValueError:
        return []
    return [source.value for source, allowed in ALLOWED_TRANSITIONS.items() if target in allowed]


class HumanTaskRepository:
    def __init__(self, session_factory: async_sessionmaker[AsyncSession]) -> None:
        self._sf = session_factory

    @staticmethod
    def _row_to_dict(row: HumanTaskRow) -> dict[str, Any]:
        data = row.to_dict()
        for key in ("created_at", "updated_at"):
            if data.get(key) is not None:
                data[key] = coerce_iso(data[key])
        return data

    async def create(
        self,
        *,
        user_id: str,
        workflow_run_id: str,
        node_id: str,
        kind: str = "task",
        description: str = "",
        inputs_snapshot: dict[str, Any] | None = None,
        output_spec: dict[str, Any] | None = None,
        validation_rules: dict[str, Any] | None = None,
        checkpoint_ref: dict[str, Any] | None = None,
    ) -> dict[str, Any]:
        now = datetime.now(UTC)
        row = HumanTaskRow(
            id=f"ht-{uuid4().hex}",
            user_id=user_id,
            workflow_run_id=workflow_run_id,
            node_id=node_id,
            status=HumanTaskStatus.PENDING.value,
            kind=kind,
            description=description,
            inputs_snapshot=dict(inputs_snapshot or {}),
            output_spec=dict(output_spec or {}),
            validation_rules=dict(validation_rules or {}),
            checkpoint_ref=checkpoint_ref,
            created_at=now,
            updated_at=now,
        )
        async with self._sf() as session:
            session.add(row)
            await session.commit()
            await session.refresh(row)
            return self._row_to_dict(row)

    async def get(self, task_id: str, *, user_id: str) -> dict[str, Any] | None:
        async with self._sf() as session:
            row = await session.get(HumanTaskRow, task_id)
            if row is None or row.user_id != user_id:
                return None
            return self._row_to_dict(row)

    async def find_by_run_and_node(self, *, run_id: str, node_id: str) -> dict[str, Any] | None:
        """Return the latest human task for a run+node (any status), or ``None``.

        Used by the ``human:task`` executor (T13-4 idempotency) so that a
        LangGraph node re-execution on ``Command(resume=...)`` reuses the
        already-created task instead of minting a duplicate.  A single-confirm
        model is assumed: the latest row (by ``created_at`` / ``id``) wins
        regardless of status — the re-execution happens after the original task
        was already submitted/skipped, so status is not a discriminator.
        Loop-internal multiple suspensions would need a finer idempotency key;
        out of scope for now.
        """
        async with self._sf() as session:
            stmt = select(HumanTaskRow).where(HumanTaskRow.workflow_run_id == run_id, HumanTaskRow.node_id == node_id).order_by(HumanTaskRow.created_at.desc(), HumanTaskRow.id.desc()).limit(1)
            row = (await session.execute(stmt)).scalar_one_or_none()
            return self._row_to_dict(row) if row is not None else None

    async def list_by_user(self, user_id: str, *, status: str | None = None, kind: str | None = None) -> list[dict[str, Any]]:
        stmt = select(HumanTaskRow).where(HumanTaskRow.user_id == user_id)
        if status is not None:
            stmt = stmt.where(HumanTaskRow.status == status)
        if kind is not None:
            stmt = stmt.where(HumanTaskRow.kind == kind)
        stmt = stmt.order_by(HumanTaskRow.created_at.desc(), HumanTaskRow.id.desc())
        async with self._sf() as session:
            result = await session.execute(stmt)
            return [self._row_to_dict(row) for row in result.scalars()]

    async def submit(self, task_id: str, *, user_id: str, values: dict[str, Any], to_status: str) -> dict[str, Any] | None:
        return await self._transition(task_id, user_id=user_id, to_status=to_status, submission=values)

    async def skip(self, task_id: str, *, user_id: str) -> dict[str, Any] | None:
        return await self._transition(task_id, user_id=user_id, to_status=HumanTaskStatus.SKIPPED.value)

    async def reopen(self, task_id: str, *, user_id: str) -> dict[str, Any] | None:
        return await self._transition(task_id, user_id=user_id, to_status=HumanTaskStatus.REOPENED.value)

    async def mark_expired(self, task_id: str, *, user_id: str) -> dict[str, Any] | None:
        return await self._transition(task_id, user_id=user_id, to_status=HumanTaskStatus.EXPIRED.value)

    async def _transition(
        self,
        task_id: str,
        *,
        user_id: str,
        to_status: str,
        submission: dict[str, Any] | None = None,
    ) -> dict[str, Any] | None:
        """Conditional-UPDATE transition; returns the refreshed row or None on conflict."""
        sources = _allowed_sources(to_status)
        if not sources:
            return None
        values: dict[str, Any] = {
            "status": to_status,
            "updated_at": datetime.now(UTC),
        }
        if submission is not None:
            values["submission"] = submission
        stmt = (
            update(HumanTaskRow)
            .where(
                HumanTaskRow.id == task_id,
                HumanTaskRow.user_id == user_id,
                HumanTaskRow.status.in_(sources),
                HumanTaskRow.status != to_status,
            )
            .values(**values)
        )
        async with self._sf() as session:
            result = await session.execute(stmt)
            if result.rowcount != 1:
                await session.rollback()
                return None
            await session.commit()
            row = await session.get(HumanTaskRow, task_id)
            if row is None or row.user_id != user_id:
                return None
            return self._row_to_dict(row)

    async def delete(self, task_id: str, *, user_id: str) -> bool:
        async with self._sf() as session:
            row = await session.get(HumanTaskRow, task_id)
            if row is None or row.user_id != user_id:
                return False
            await session.delete(row)
            await session.commit()
            return True

    async def update_checkpoint_ref_by_run(self, *, run_id: str, checkpoint_ref: dict[str, Any] | None) -> int:
        """Backfill ``checkpoint_ref`` on all pending/reopened human tasks of a run.

        Used by the workflow worker once a run has interrupted on a ``human:task``
        (T13-2): the suspended checkpoint coordinate is only known after the graph
        has hung, so it is written back to the executor-created rows.  Returns the
        number of rows updated (``0`` when there are no matching tasks, or when the
        ref was already backfilled).
        """
        async with self._sf() as session:
            result = await session.execute(
                update(HumanTaskRow)
                .where(
                    HumanTaskRow.workflow_run_id == run_id,
                    HumanTaskRow.status.in_(["pending", "reopened"]),
                )
                .values(checkpoint_ref=checkpoint_ref, updated_at=datetime.now(UTC))
            )
            await session.commit()
            return result.rowcount or 0

    async def delete_pending_by_run(self, *, run_id: str) -> int:
        """Compensation: delete a run's unresolved pending tasks that never hung.

        When ``interrupt()`` or the checkpoint write fails, the ``human:task``
        executor has already created a pending row (``checkpoint_ref=None``) but
        the graph never suspended, so the row can never be resumed.  Deleting is
        the clean compensation — the state machine has no ``failed`` status, and a
        half-state row would leak into ``list_by_user``/route filtering.

        Only ``pending`` rows whose ``checkpoint_ref`` is unset (stored as JSON
        ``null`` — the column uses ``none_as_null=False``, so ``None`` serializes
        to JSON null, not SQL NULL) are deleted: a row whose ref was backfilled
        did hang successfully and is NOT a failure residue, while
        ``submitted``/``skipped``/``reopened``/``expired`` rows are resolved
        user-facing state and must never be swept.

        Returns the number of rows deleted.
        """
        async with self._sf() as session:
            result = await session.execute(
                delete(HumanTaskRow).where(
                    HumanTaskRow.workflow_run_id == run_id,
                    HumanTaskRow.status == "pending",
                    HumanTaskRow.checkpoint_ref == JSON.NULL,
                )
            )
            await session.commit()
            return result.rowcount or 0
