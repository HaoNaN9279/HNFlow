from __future__ import annotations

from datetime import UTC, datetime

from sqlalchemy import JSON, DateTime, String
from sqlalchemy.orm import Mapped, mapped_column

from deerflow.persistence.base import Base


class HumanTaskRow(Base):
    __tablename__ = "human_tasks"

    id: Mapped[str] = mapped_column(String(64), primary_key=True)
    user_id: Mapped[str] = mapped_column(String(64), index=True)
    workflow_run_id: Mapped[str] = mapped_column(String(64))
    node_id: Mapped[str] = mapped_column(String(64))
    status: Mapped[str] = mapped_column(String(32))
    #: ``"task"`` for a plain ``human:task`` node; ``"approval"`` for the task an
    #: irreversible node suspends on (N10).  Additive: pre-N10 rows and code paths
    #: keep the ``"task"`` default.
    kind: Mapped[str] = mapped_column(String(32), default="task", server_default="task")
    description: Mapped[str] = mapped_column(String(512), default="")
    inputs_snapshot: Mapped[dict] = mapped_column(JSON, default=dict)
    output_spec: Mapped[dict] = mapped_column(JSON, default=dict)
    validation_rules: Mapped[dict] = mapped_column(JSON, default=dict)
    checkpoint_ref: Mapped[dict | None] = mapped_column(JSON, nullable=True)
    submission: Mapped[dict | None] = mapped_column(JSON, nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=lambda: datetime.now(UTC))
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True),
        default=lambda: datetime.now(UTC),
        onupdate=lambda: datetime.now(UTC),
    )
