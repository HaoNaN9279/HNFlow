"""Runtime snapshot for condition-driven triggers (N7).

``deerflow.scheduler.triggers.is_trigger_due`` is the pure decision; this module
is the impure half that gathers what it decides on: filesystem state for
``file``, terminal ``app_instances`` transitions for ``event``, and run activity
for ``idle``. It lives in the app layer because it reads application
repositories (and ``runs`` directly, the same reporting-layer pattern the
console router uses) which the harness must not import.

A missing/failing source yields an empty snapshot, and an empty snapshot is
never "due" — a transient read failure must not fabricate a trigger.
"""

from __future__ import annotations

import asyncio
import logging
from collections.abc import Callable, Mapping
from datetime import UTC, datetime
from pathlib import Path
from typing import Any

from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from deerflow.persistence.run.model import RunRow
from deerflow.runtime.user_context import DEFAULT_USER_ID

logger = logging.getLogger(__name__)

#: Bound on the number of files returned for a ``file`` trigger snapshot.
DEFAULT_MAX_FILES = 500
#: Bound on terminal instance rows returned for an ``event`` trigger snapshot.
DEFAULT_MAX_EVENTS = 20

#: Statuses that mean "a run is currently occupying the system" for ``idle``.
_ACTIVE_RUN_STATUSES: tuple[str, ...] = ("pending", "running")


def _iso(value: datetime | None) -> str | None:
    if value is None:
        return None
    if value.tzinfo is None:
        value = value.replace(tzinfo=UTC)
    return value.astimezone(UTC).isoformat()


def list_matching_files(path: Path, glob: str | None, *, last_run_at: datetime | None, limit: int = DEFAULT_MAX_FILES) -> list[dict[str, Any]]:
    """List files under ``path`` (a file or a directory) with mtime/created flags.

    ``created`` means "this file appeared after the trigger last ran", derived
    from ``st_ctime``: creation time on Windows, inode/metadata-change time on
    POSIX — so a metadata touch (or ``os.utime``) can read as a creation. The
    flag only matters for ``mode: created`` specs, which use it to ignore
    pre-existing files.
    """
    last_ts = last_run_at.timestamp() if isinstance(last_run_at, datetime) else None
    try:
        if path.is_file():
            candidates = [path]
        elif path.is_dir():
            candidates = [candidate for candidate in path.glob(glob or "**/*") if candidate.is_file()]
        else:
            return []
    except OSError:
        return []

    entries: list[dict[str, Any]] = []
    for candidate in candidates:
        try:
            stat = candidate.stat()
        except OSError:
            continue
        entries.append(
            {
                "path": str(candidate),
                "mtime": _iso(datetime.fromtimestamp(stat.st_mtime, UTC)),
                "created": last_ts is None or stat.st_ctime > last_ts,
            }
        )
    entries.sort(key=lambda entry: str(entry["mtime"]), reverse=True)
    return entries[:limit]


class TriggerProbe:
    """Builds per-kind trigger snapshots from filesystem / DB state."""

    def __init__(
        self,
        *,
        session_factory: async_sessionmaker[AsyncSession] | None = None,
        instance_repo: Any | None = None,
        file_lister: Callable[..., list[dict[str, Any]]] = list_matching_files,
        max_files: int = DEFAULT_MAX_FILES,
        max_events: int = DEFAULT_MAX_EVENTS,
    ) -> None:
        self._session_factory = session_factory
        self._instance_repo = instance_repo
        self._file_lister = file_lister
        self._max_files = max_files
        self._max_events = max_events

    async def build(self, task: Mapping[str, Any], *, now: datetime) -> dict[str, Any]:
        schedule_type = task.get("schedule_type")
        spec = task.get("schedule_spec") or {}
        if not isinstance(spec, Mapping):
            return {}
        if schedule_type == "file":
            return await self._file_snapshot(spec, last_run_at=task.get("last_run_at"))
        if schedule_type == "event":
            return await self._event_snapshot(task, spec)
        if schedule_type == "idle":
            return await self._idle_snapshot()
        return {}

    async def _file_snapshot(self, spec: Mapping[str, Any], *, last_run_at: Any) -> dict[str, Any]:
        path = spec.get("path")
        if not isinstance(path, str):
            return {}
        glob = spec.get("glob")
        last = last_run_at if isinstance(last_run_at, datetime) else None
        try:
            files = await asyncio.to_thread(self._file_lister, Path(path), glob if isinstance(glob, str) else None, last_run_at=last, limit=self._max_files)
        except Exception:
            logger.exception("Trigger file scan failed for %s", path)
            return {}
        return {"files": files}

    async def _event_snapshot(self, task: Mapping[str, Any], spec: Mapping[str, Any]) -> dict[str, Any]:
        app_name = spec.get("app")
        if not isinstance(app_name, str) or self._instance_repo is None:
            return {"events": []}
        user_id = str(task.get("user_id") or DEFAULT_USER_ID)
        last = task.get("last_run_at")
        try:
            rows = await self._instance_repo.list_terminal_since(
                user_id,
                app_name=app_name,
                since=last if isinstance(last, datetime) else None,
                limit=self._max_events,
            )
        except Exception:
            logger.exception("Trigger event probe failed for app %s", app_name)
            return {"events": []}
        return {
            "events": [
                {
                    "app": row.get("app_name"),
                    "session_id": row.get("id"),
                    "status": row.get("status"),
                    "updated_at": row.get("updated_at"),
                }
                for row in rows
            ]
        }

    async def _idle_snapshot(self) -> dict[str, Any]:
        if self._session_factory is None:
            return {"active_runs": 0, "last_activity_at": None}
        try:
            async with self._session_factory() as session:
                active = await session.scalar(select(func.count()).select_from(RunRow).where(RunRow.status.in_(_ACTIVE_RUN_STATUSES)))
                last_activity = await session.scalar(select(func.max(RunRow.updated_at)).select_from(RunRow))
        except Exception:
            logger.exception("Idle trigger probe failed")
            return {"active_runs": 0, "last_activity_at": None}
        return {"active_runs": int(active or 0), "last_activity_at": _iso(last_activity)}
