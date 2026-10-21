from __future__ import annotations

from datetime import UTC, datetime

from sqlalchemy import DateTime, Index, Integer, String
from sqlalchemy.orm import Mapped, mapped_column

from deerflow.persistence.base import Base


class WorkflowFolderRow(Base):
    """A user-owned folder in the workflow directory tree.

    ``parent_id`` is deliberately a plain string (not a database FK): the tree
    is user-scoped and cycles are rejected by the repository, so a database FK
    would add SQLite/Postgres-specific cascade complexity without improving
    the domain invariant.
    """

    __tablename__ = "workflow_folders"

    id: Mapped[str] = mapped_column(String(64), primary_key=True)
    user_id: Mapped[str] = mapped_column(String(64), index=True)
    name: Mapped[str] = mapped_column(String(255))
    parent_id: Mapped[str | None] = mapped_column(String(64), nullable=True, index=True)
    order_index: Mapped[int] = mapped_column(Integer, default=0, server_default="0")
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=lambda: datetime.now(UTC))
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True),
        default=lambda: datetime.now(UTC),
        onupdate=lambda: datetime.now(UTC),
    )

    __table_args__ = (Index("ix_workflow_folders_user_parent_order", "user_id", "parent_id", "order_index"),)
