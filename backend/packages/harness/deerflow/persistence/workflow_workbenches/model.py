from __future__ import annotations

from datetime import UTC, datetime

from sqlalchemy import JSON, DateTime, Index, Integer, String, Text, UniqueConstraint
from sqlalchemy.orm import Mapped, mapped_column

from deerflow.persistence.base import Base


class WorkflowWorkbenchRow(Base):
    """A saved project workbench (monitoring surface, never executable)."""

    __tablename__ = "workflow_workbenches"

    id: Mapped[str] = mapped_column(String(64), primary_key=True)
    user_id: Mapped[str] = mapped_column(String(64), index=True)
    #: Set for file-backed workbenches; NULL for legacy DB-only rows.
    project_id: Mapped[str | None] = mapped_column(String(64), nullable=True, index=True)
    name: Mapped[str] = mapped_column(String(255))
    description: Mapped[str] = mapped_column(Text, default="")
    layout: Mapped[dict] = mapped_column(JSON, default=dict)
    settings: Mapped[dict] = mapped_column(JSON, default=dict)
    revision: Mapped[int] = mapped_column(Integer, default=1, server_default="1")
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=lambda: datetime.now(UTC))
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True),
        default=lambda: datetime.now(UTC),
        onupdate=lambda: datetime.now(UTC),
    )


class WorkflowWorkbenchMemberRow(Base):
    """A root workflow shown on a workbench.

    The row references a definition; it never copies it.  Subworkflow
    references discovered through ``nested:subworkflow`` nodes are not members
    unless the user explicitly adds them.
    """

    __tablename__ = "workflow_workbench_members"

    id: Mapped[str] = mapped_column(String(64), primary_key=True)
    workbench_id: Mapped[str] = mapped_column(String(64), index=True)
    definition_id: Mapped[str] = mapped_column(String(64), index=True)
    order_index: Mapped[int] = mapped_column(Integer, default=0, server_default="0")
    settings: Mapped[dict] = mapped_column(JSON, default=dict)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=lambda: datetime.now(UTC))

    __table_args__ = (
        UniqueConstraint("workbench_id", "definition_id", name="uq_workflow_workbench_member"),
        Index("ix_workflow_workbench_members_workbench_order", "workbench_id", "order_index"),
    )
