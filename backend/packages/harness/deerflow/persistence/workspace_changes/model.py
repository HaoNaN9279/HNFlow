from __future__ import annotations

from datetime import UTC, datetime

from sqlalchemy import JSON, DateTime, Index, Integer, String, Text
from sqlalchemy.orm import Mapped, mapped_column

from deerflow.persistence.base import Base


class WorkspaceChangeRow(Base):
    """One resource mutation made by the Lead Agent inside a conversation.

    The row is the durable undo unit: ``before_json``/``after_json`` are full
    snapshots, and ``before_token``/``after_token`` guard against overwriting a
    resource that changed outside the agent after the mutation.
    """

    __tablename__ = "workspace_resource_changes"

    id: Mapped[str] = mapped_column(String(64), primary_key=True)
    user_id: Mapped[str] = mapped_column(String(64), index=True)
    thread_id: Mapped[str] = mapped_column(String(128), index=True)
    run_id: Mapped[str | None] = mapped_column(String(64), nullable=True, index=True)
    tool_call_id: Mapped[str | None] = mapped_column(String(128), nullable=True)
    seq: Mapped[int] = mapped_column(Integer, nullable=False)
    resource_kind: Mapped[str] = mapped_column(String(32), nullable=False)
    resource_id: Mapped[str] = mapped_column(String(128), nullable=False)
    parent_id: Mapped[str | None] = mapped_column(String(128), nullable=True)
    action: Mapped[str] = mapped_column(String(32), nullable=False)
    before_json: Mapped[dict | None] = mapped_column(JSON, nullable=True)
    after_json: Mapped[dict | None] = mapped_column(JSON, nullable=True)
    before_token: Mapped[str | None] = mapped_column(String(160), nullable=True)
    after_token: Mapped[str | None] = mapped_column(String(160), nullable=True)
    status: Mapped[str] = mapped_column(String(16), nullable=False, default="applied")
    detail: Mapped[str] = mapped_column(Text, nullable=False, default="")
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False, default=lambda: datetime.now(UTC))
    undone_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)

    __table_args__ = (Index("ix_workspace_resource_changes_thread_seq", "thread_id", "seq"),)


__all__ = ["WorkspaceChangeRow"]
