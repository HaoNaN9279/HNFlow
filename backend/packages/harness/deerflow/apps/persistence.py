"""Best-effort persistence bridge for local-application instances (N6).

The live session map lives in :mod:`deerflow.apps.session`; durable records
live in :class:`deerflow.persistence.app_instances.AppInstanceRepository`.
The workflow executors are async, so after each operation they hand the live
:class:`~deerflow.apps.session.AppSession` to these helpers to write the record
through.

Persistence is deliberately **best-effort**: a missing repository (memory
backend, or ``apps.persist_sessions=false``) is a no-op, and a failing write is
logged and swallowed so it can never roll back a live launch/script that
actually succeeded.  The live operation is the source of truth; the row is a
durable shadow.
"""

from __future__ import annotations

import logging
from typing import Any, Protocol, runtime_checkable

from deerflow.apps.session import AppSession

logger = logging.getLogger(__name__)


@runtime_checkable
class AppInstanceStore(Protocol):
    """The subset of :class:`AppInstanceRepository` the bridge needs."""

    async def create(self, **kwargs: Any) -> dict[str, Any]: ...

    async def record_operation(self, session_id: str, **kwargs: Any) -> dict[str, Any] | None: ...

    async def set_status(self, session_id: str, **kwargs: Any) -> dict[str, Any] | None: ...


async def record_launch(repo: AppInstanceStore | None, session: AppSession, *, user_id: str) -> None:
    """Write an instance record for a freshly launched/attached session."""
    if repo is None:
        return
    try:
        await repo.create(
            session_id=session.session_id,
            user_id=user_id,
            app_name=session.app_name,
            driver=session.driver,
            status=session.status,
            pid=session.pid,
            endpoint=session.endpoint,
            handle=dict(session.handle),
            exclusive=session.exclusive,
            created_at=session.created_at or None,
        )
    except Exception:  # noqa: BLE001 - persistence must never fail the live op
        logger.warning("app instance persist: launch of %s failed", session.session_id, exc_info=True)


async def record_operation(
    repo: AppInstanceStore | None,
    session: AppSession,
    *,
    user_id: str,
    status: str | None = None,
    resource_deltas: dict[str, Any] | None = None,
) -> None:
    """Refresh an instance record after an operation (counters + status)."""
    if repo is None:
        return
    try:
        await repo.record_operation(
            session.session_id,
            user_id=user_id,
            status=status,
            resource_deltas=resource_deltas,
            last_active=session.last_active or None,
        )
    except Exception:  # noqa: BLE001
        logger.warning("app instance persist: operation on %s failed", session.session_id, exc_info=True)


async def record_status(
    repo: AppInstanceStore | None,
    *,
    session_id: str,
    user_id: str,
    to_status: str,
    allowed_from: tuple[str, ...],
) -> None:
    """Best-effort conditional status transition (e.g. mark ``stopped``)."""
    if repo is None:
        return
    try:
        await repo.set_status(session_id, user_id=user_id, to_status=to_status, allowed_from=allowed_from)
    except Exception:  # noqa: BLE001
        logger.warning("app instance persist: status write for %s failed", session_id, exc_info=True)


__all__ = ["AppInstanceStore", "record_launch", "record_operation", "record_status"]
