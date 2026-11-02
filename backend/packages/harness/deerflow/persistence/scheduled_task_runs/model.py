from __future__ import annotations

from datetime import UTC, datetime

from sqlalchemy import DateTime, Index, Integer, String, Text, text
from sqlalchemy.orm import Mapped, mapped_column

from deerflow.persistence.base import Base


class ScheduledTaskRunRow(Base):
    __tablename__ = "scheduled_task_runs"

    id: Mapped[str] = mapped_column(String(64), primary_key=True)
    task_id: Mapped[str] = mapped_column(String(64), index=True)
    thread_id: Mapped[str] = mapped_column(String(64), index=True)
    run_id: Mapped[str | None] = mapped_column(String(64), nullable=True)
    scheduled_for: Mapped[datetime] = mapped_column(DateTime(timezone=True))
    trigger: Mapped[str] = mapped_column(String(16))
    status: Mapped[str] = mapped_column(String(16), index=True)
    # Occurrence identity for condition-driven triggers (N7), e.g.
    # ``<path>:<mtime>`` / ``<session_id>:<status>``. ``NULL`` for ``once``/
    # ``cron`` (their ``next_run_at`` already advances after a dispatch), which
    # keeps them outside the partial unique dedupe index below.
    dedupe_key: Mapped[str | None] = mapped_column(String(128), nullable=True)
    # 1-based attempt ordinal of the failure streak this row belongs to.
    attempt: Mapped[int] = mapped_column(Integer, nullable=False, default=1, server_default=text("1"))
    error: Mapped[str | None] = mapped_column(Text, nullable=True)
    started_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    finished_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=lambda: datetime.now(UTC))

    __table_args__ = (
        # At most one active (queued/running) run per task. This is the atomic
        # arbiter for the ``dispatch_task`` skip policy: the non-atomic
        # ``has_active_runs`` check-then-create is a fast path, but two
        # concurrent dispatches (double-click / client retry / manual trigger
        # racing the poller) can both pass it, so the DB must reject the second
        # active insert. Sibling of the ``runs`` table's ``uq_runs_thread_active``
        # (PR #4003); that one keys on ``thread_id`` and does not cover the
        # default ``fresh_thread_per_run`` context (every dispatch gets a new
        # thread), which is why the scheduled-task run row needs its own guard.
        #
        # Condition is status-only, not ``overlap_policy``: the policy is fixed
        # to "skip" in the MVP, so a status-only predicate enforces the current
        # invariant without denormalizing ``overlap_policy`` onto the run row
        # for an unimplemented non-skip policy. If a non-skip policy is added
        # this must become conditional (e.g. ``... AND overlap_policy = 'skip'``).
        #
        # Must live in ORM ``__table_args__`` (not just the migration) because
        # the empty-DB bootstrap path runs ``create_all`` + ``stamp head`` and
        # never executes the migration that also defines this index.
        Index(
            "uq_scheduled_task_run_active",
            "task_id",
            unique=True,
            sqlite_where=text("status IN ('queued', 'running')"),
            postgresql_where=text("status IN ('queued', 'running')"),
        ),
        # Atomic arbiter for condition-driven trigger idempotency (N7): a
        # physical trigger (same file mtime / same app-instance terminal
        # transition / same idle window) can be observed again on a later poll,
        # so the dispatch that already recorded it must win. Status-only partial
        # uniqueness would not cover this; ``dedupe_key IS NULL`` keeps
        # ``once``/``cron`` runs (which have no occurrence identity and may
        # legitimately repeat across occurrences) outside the index.
        Index(
            "uq_scheduled_task_run_dedupe",
            "task_id",
            "dedupe_key",
            unique=True,
            sqlite_where=text("dedupe_key IS NOT NULL"),
            postgresql_where=text("dedupe_key IS NOT NULL"),
        ),
    )
