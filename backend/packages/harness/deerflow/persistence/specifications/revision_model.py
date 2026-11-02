from __future__ import annotations

from datetime import UTC, datetime

from sqlalchemy import JSON, DateTime, Integer, String, Text, UniqueConstraint
from sqlalchemy.orm import Mapped, mapped_column

from deerflow.persistence.base import Base


class WorkflowSpecificationRevisionRow(Base):
    """Immutable revision of a formal specification."""

    __tablename__ = "workflow_specification_revisions"
    __table_args__ = (UniqueConstraint("spec_id", "revision", name="uq_workflow_specification_revision"),)

    id: Mapped[str] = mapped_column(String(64), primary_key=True)
    spec_id: Mapped[str] = mapped_column(String(64), index=True)
    user_id: Mapped[str] = mapped_column(String(64), index=True)
    revision: Mapped[int] = mapped_column(Integer, nullable=False)
    language: Mapped[str] = mapped_column(String(16), nullable=False)
    content: Mapped[str] = mapped_column(Text, nullable=False)
    content_hash: Mapped[str] = mapped_column(String(80), nullable=False)
    status: Mapped[str] = mapped_column(String(16), nullable=False, default="draft")
    title: Mapped[str | None] = mapped_column(String(255), nullable=True)
    def_metadata: Mapped[dict] = mapped_column("metadata", JSON, nullable=False, default=dict)
    approved_by: Mapped[str | None] = mapped_column(String(64), nullable=True)
    approval_task_id: Mapped[str | None] = mapped_column(String(64), nullable=True)
    approved_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=lambda: datetime.now(UTC))
