"""Backup plan endpoint (N11b, dev plan §22 third bullet).

``GET /api/backup`` answers one operator question: **what would a backup of this
machine contain?**  It names the data directories that would be packaged, the
ones deliberately left out (and why), and whether — and how — the database
travels.

It is **read-only and side-effect free**: it plans, it does not archive.  The
actual export and (offline) import are CLI operations
(``python -m deerflow.portability export|import``) — an HTTP import could
overwrite the database a running Gateway is serving from, so there is no write
endpoint here.
"""

import asyncio
from pathlib import Path

from fastapi import APIRouter, Depends

from app.gateway.deps import get_config
from deerflow.config.app_config import AppConfig
from deerflow.config.paths import get_paths
from deerflow.portability.select import plan_backup

router = APIRouter(prefix="/api/backup", tags=["backup"])


def _database_dir(config: AppConfig) -> str | None:
    """The SQLite directory, or ``None`` when the backend keeps no file."""
    database = getattr(config, "database", None)
    if database is None or getattr(database, "backend", None) != "sqlite":
        return None
    try:
        return str(Path(database.sqlite_path).parent)
    except Exception:  # pragma: no cover - a bad DB path must not break the plan
        return None


def _database_path(config: AppConfig) -> str | None:
    database = getattr(config, "database", None)
    if database is None or getattr(database, "backend", None) != "sqlite":
        return None
    try:
        return str(database.sqlite_path)
    except Exception:  # pragma: no cover
        return None


def _build_plan(config: AppConfig) -> dict:
    """Assemble the plan (synchronous; callers offload it off the event loop)."""
    memory_enabled = bool(getattr(getattr(config, "memory", None), "enabled", True))
    data_dirs = get_paths().data_dirs(memory_enabled=memory_enabled, database_dir=_database_dir(config))
    plan = plan_backup(
        data_dirs,
        database_backend=str(getattr(getattr(config, "database", None), "backend", "memory")),
        database_path=_database_path(config),
    )
    payload = plan.to_dict()
    payload["note"] = "Export and restore are CLI operations: `python -m deerflow.portability export|import`."
    return payload


@router.get(
    "",
    summary="Backup plan",
    description="Describe what a backup of this machine would contain (read-only; the archive itself is produced by the CLI).",
)
async def get_backup_plan(config: AppConfig = Depends(get_config)) -> dict:
    """Return the export plan: included members, exclusions and the database mode."""
    return await asyncio.to_thread(_build_plan, config)
