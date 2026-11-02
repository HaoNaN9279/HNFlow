from __future__ import annotations

from datetime import UTC, datetime

from sqlalchemy import JSON, DateTime, Integer, String
from sqlalchemy.orm import Mapped, mapped_column

from deerflow.persistence.base import Base


class WorkflowUndoRow(Base):
    """One recorded side effect of an irreversible workflow node (N10).

    ``kind`` is a :class:`deerflow.workflow.undo.UndoKind` value — ``file_backup``
    (the engine snapshotted the touched paths) or ``app_undo`` (the application's
    own undo/history is the compensation).  ``status`` is an
    :class:`deerflow.workflow.undo.UndoStatus` value; only ``recorded`` rows are
    candidates for :func:`deerflow.workflow.undo.plan_undo`.

    ``targets`` holds serialized :class:`~deerflow.assets.ref.AssetRef` dicts (the
    files the action touched) and ``backup_paths`` the engine-private copies that
    make a rollback possible — **aligned 1:1 with ``targets``**, where a ``null``
    entry means the file did not exist before the action.
    """

    __tablename__ = "workflow_undo_records"

    id: Mapped[str] = mapped_column(String(64), primary_key=True)
    user_id: Mapped[str] = mapped_column(String(64), index=True)
    run_id: Mapped[str] = mapped_column(String(64))
    node_id: Mapped[str] = mapped_column(String(64))
    kind: Mapped[str] = mapped_column(String(32))
    status: Mapped[str] = mapped_column(String(32))
    targets: Mapped[list] = mapped_column(JSON, default=list)
    backup_paths: Mapped[list] = mapped_column(JSON, default=list)
    session_id: Mapped[str | None] = mapped_column(String(64), nullable=True)
    app_steps: Mapped[int | None] = mapped_column(Integer, nullable=True)
    detail: Mapped[str] = mapped_column(String(512), default="")
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=lambda: datetime.now(UTC))
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True),
        default=lambda: datetime.now(UTC),
        onupdate=lambda: datetime.now(UTC),
    )
