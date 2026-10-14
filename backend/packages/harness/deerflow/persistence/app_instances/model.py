"""Durable local-application instance records (N6, plan §18).

One row per application *instance/session* that the ``app:*`` workflow nodes
(or the tool gateway's ``app`` provider) have driven.  The live process-local
session map still lives in :mod:`deerflow.apps.session`; this table is the
durable record that survives a Gateway restart so instances can be listed,
archived, cleaned up and their resource counters accumulated.
"""

from __future__ import annotations

from datetime import UTC, datetime

from sqlalchemy import JSON, Boolean, DateTime, Integer, String
from sqlalchemy.orm import Mapped, mapped_column

from deerflow.persistence.base import Base


class AppInstanceRow(Base):
    __tablename__ = "app_instances"

    #: The live ``AppSession.session_id`` (``app-<uuid>``).
    id: Mapped[str] = mapped_column(String(64), primary_key=True)
    user_id: Mapped[str] = mapped_column(String(64), index=True)
    app_name: Mapped[str] = mapped_column(String(64))
    driver: Mapped[str] = mapped_column(String(32))
    #: "launching" | "ready" | "attached" | "busy" | "crashed" | "stopped"
    #: | "orphaned" | "archived".
    status: Mapped[str] = mapped_column(String(32), index=True)
    pid: Mapped[int | None] = mapped_column(Integer, nullable=True)
    endpoint: Mapped[str | None] = mapped_column(String(512), nullable=True)
    #: Driver-private handle (JSON-safe; mirrors ``AppSession.to_port()["handle"]``).
    handle: Mapped[dict] = mapped_column(JSON, default=dict)
    exclusive: Mapped[bool] = mapped_column(Boolean, default=True)
    #: Cumulative per-instance counters (``scripts_run`` / ``artifacts`` /
    #: ``busy_seconds`` / ``last_error``). Deeper resource governance is N8.
    resources: Mapped[dict] = mapped_column(JSON, default=dict)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=lambda: datetime.now(UTC))
    last_active: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=lambda: datetime.now(UTC))
    archived_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True),
        default=lambda: datetime.now(UTC),
        onupdate=lambda: datetime.now(UTC),
    )
