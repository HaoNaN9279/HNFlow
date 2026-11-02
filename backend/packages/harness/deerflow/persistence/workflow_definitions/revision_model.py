from __future__ import annotations

from datetime import UTC, datetime

from sqlalchemy import JSON, DateTime, Integer, String, UniqueConstraint
from sqlalchemy.orm import Mapped, mapped_column

from deerflow.persistence.base import Base


class WorkflowDefinitionRevisionRow(Base):
    """Immutable snapshot of one saved workflow definition revision."""

    __tablename__ = "workflow_definition_revisions"
    __table_args__ = (UniqueConstraint("definition_id", "revision", name="uq_workflow_definition_revision"),)

    id: Mapped[str] = mapped_column(String(64), primary_key=True)
    definition_id: Mapped[str] = mapped_column(String(64), index=True)
    user_id: Mapped[str] = mapped_column(String(64), index=True)
    revision: Mapped[int] = mapped_column(Integer, nullable=False)
    content_hash: Mapped[str] = mapped_column(String(64), nullable=False)
    schema_version: Mapped[int] = mapped_column(Integer, nullable=False)
    definition: Mapped[dict] = mapped_column(JSON, nullable=False)
    def_metadata: Mapped[dict] = mapped_column("metadata", JSON, nullable=False, default=dict)
    version: Mapped[str] = mapped_column(String(32), nullable=False, default="0.1.0")
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False, default=lambda: datetime.now(UTC))
