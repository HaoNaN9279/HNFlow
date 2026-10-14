from __future__ import annotations

from datetime import UTC, datetime

from sqlalchemy import JSON, DateTime, Integer, String, Text, text
from sqlalchemy.orm import Mapped, mapped_column

from deerflow.persistence.base import Base


class ScheduledTaskRow(Base):
    __tablename__ = "scheduled_tasks"

    id: Mapped[str] = mapped_column(String(64), primary_key=True)
    user_id: Mapped[str] = mapped_column(String(64), index=True)
    thread_id: Mapped[str | None] = mapped_column(String(64), index=True, nullable=True)
    context_mode: Mapped[str] = mapped_column(String(32), default="fresh_thread_per_run")
    assistant_id: Mapped[str | None] = mapped_column(String(128), nullable=True)
    title: Mapped[str] = mapped_column(String(255))
    prompt: Mapped[str] = mapped_column(Text)
    schedule_type: Mapped[str] = mapped_column(String(16))
    schedule_spec: Mapped[dict] = mapped_column(JSON, default=dict)
    timezone: Mapped[str] = mapped_column(String(64))
    status: Mapped[str] = mapped_column(String(16), default="enabled", index=True)
    overlap_policy: Mapped[str] = mapped_column(String(16), default="skip")
    # Dispatch target (N7): ``agent`` keeps the original prompt-driven lead-agent
    # run; ``workflow`` launches ``target_definition_id`` with params rendered
    # from ``payload_template`` against the trigger payload.
    target_kind: Mapped[str] = mapped_column(String(16), nullable=False, default="agent", server_default=text("'agent'"))
    target_definition_id: Mapped[str | None] = mapped_column(String(64), nullable=True)
    payload_template: Mapped[dict] = mapped_column(JSON, nullable=False, default=dict, server_default=text("'{}'"))
    # Retry bookkeeping (N7): ``max_attempts`` defaults to 1 = no retry, so
    # existing tasks keep their exact behavior; ``attempt`` is the count of
    # consecutive failed attempts consumed by the current failure streak.
    max_attempts: Mapped[int] = mapped_column(Integer, nullable=False, default=1, server_default=text("1"))
    attempt: Mapped[int] = mapped_column(Integer, nullable=False, default=0, server_default=text("0"))
    next_run_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), index=True, nullable=True)
    last_run_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    last_run_id: Mapped[str | None] = mapped_column(String(64), nullable=True)
    last_thread_id: Mapped[str | None] = mapped_column(String(64), nullable=True)
    last_error: Mapped[str | None] = mapped_column(Text, nullable=True)
    lease_owner: Mapped[str | None] = mapped_column(String(128), nullable=True)
    lease_expires_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    run_count: Mapped[int] = mapped_column(Integer, default=0)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=lambda: datetime.now(UTC))
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True),
        default=lambda: datetime.now(UTC),
        onupdate=lambda: datetime.now(UTC),
    )
