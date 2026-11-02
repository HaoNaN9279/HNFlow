"""Environment report endpoint (N11, dev plan §22).

``GET /api/environment`` answers one operator question: **is this machine ready
for what has been declared?**  It reports

- the data-directory layout (existence / writability, plus what each directory is
  for), and
- the declared environment requirements, grouped by their source (applications
  from ``config.yaml`` and enabled capability groups from ``SKILL.md``).

It is **read-only**: probing never installs or mutates anything, so there is no
write endpoint here.  A probe that cannot answer is reported as ``unknown`` — it
is never turned into a 5xx, and never into a silent pass.  ``?force=true``
re-probes instead of reusing the short-lived cache.

``apps.environment.require_on_load`` is the operator's opt-in to make a
definitively failed *required* item refuse Gateway startup; this route always
just reports, so an operator can look before they tighten.
"""

import asyncio
from pathlib import Path

from fastapi import APIRouter, Depends, Query

from app.gateway.deps import get_config
from deerflow.apps.registry import AppRegistry
from deerflow.config.app_config import AppConfig
from deerflow.config.paths import get_paths
from deerflow.environment.report import build_environment_report
from deerflow.environment.requirements import validate_environment
from deerflow.runtime.user_context import get_effective_user_id
from deerflow.skills.storage import get_or_new_user_skill_storage

router = APIRouter(prefix="/api/environment", tags=["environment"])


def _database_dir(config: AppConfig) -> str | None:
    """The SQLite directory, or ``None`` when the backend keeps no file."""
    database = getattr(config, "database", None)
    if database is None or getattr(database, "backend", None) != "sqlite":
        return None
    try:
        return str(Path(database.sqlite_path).parent)
    except Exception:  # pragma: no cover - defensive; a bad DB path must not break the report
        return None


def _build_report(config: AppConfig, skills: list, *, force: bool) -> dict:
    """Assemble the report (synchronous; callers offload it to a worker thread)."""
    environment = config.apps.environment
    requirement_status = validate_environment(
        # The request-scoped config, not the process singleton: the report should
        # describe the configuration the operator is actually running.
        registry=AppRegistry.from_config(config.apps),
        skills=skills,
        enabled=environment.enabled,
        timeout=environment.probe_timeout_seconds,
        cache_seconds=environment.cache_seconds,
        force=force,
        require_on_load=environment.require_on_load,
    )
    data_dir_statuses = get_paths().check_data_dirs(
        memory_enabled=bool(getattr(config.memory, "enabled", True)),
        database_dir=_database_dir(config),
    )
    return build_environment_report(
        enabled=environment.enabled,
        requirement_status=requirement_status,
        data_dir_statuses=data_dir_statuses,
        require_on_load=environment.require_on_load,
    ).to_dict()


@router.get(
    "",
    summary="Environment report",
    description="Report the data-directory layout and the declared environment requirements (read-only, best-effort probing).",
)
async def get_environment(
    force: bool = Query(default=False, description="Re-probe instead of reusing the short-lived probe cache."),
    config: AppConfig = Depends(get_config),
) -> dict:
    """Return the combined environment report."""
    storage = get_or_new_user_skill_storage(get_effective_user_id(), app_config=config)
    skills = await asyncio.to_thread(storage.load_skills, enabled_only=False)
    return await asyncio.to_thread(_build_report, config, skills, force=force)
