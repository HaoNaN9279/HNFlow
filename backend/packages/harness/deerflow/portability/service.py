"""Export / inspect / import orchestration (N11b, all the backup I/O).

This is where the pure pieces meet the filesystem:

- :func:`export_backup` snapshots the SQLite database (when there is one),
  packages the N11 data directories and the snapshot into an archive, and writes
  the manifest that describes it.  Safe to run against a live install.
- :func:`inspect_backup` reads an archive's manifest and checks it against this
  build, changing nothing.
- :func:`import_backup` maps the archive onto this machine's paths and extracts
  it.  This is an **offline** operation: it overwrites the database file, so the
  Gateway must be stopped first.

Every decision lives in :mod:`deerflow.portability.select` (pure); this module
only gathers configuration, takes the snapshot, and calls the archive layer.
"""

from __future__ import annotations

import tempfile
from dataclasses import replace
from pathlib import Path
from typing import Any

from deerflow.portability.archive import extract_routes, read_manifest, write_archive
from deerflow.portability.select import ACTION_EXTRACT, plan_backup, plan_restore
from deerflow.portability.snapshot import snapshot_sqlite
from deerflow.portability.spec import BackupManifest, check_import_compatible, now_iso

_DATABASE_NAME = "database"


def _data_dirs(config: Any) -> list[Any]:
    from deerflow.config.paths import get_paths

    memory_enabled = bool(getattr(getattr(config, "memory", None), "enabled", True))
    return get_paths().data_dirs(memory_enabled=memory_enabled, database_dir=_database_dir(config))


def _database_dir(config: Any) -> str | None:
    """The SQLite directory, or ``None`` when the backend keeps no file."""
    database = getattr(config, "database", None)
    if database is None or getattr(database, "backend", None) != "sqlite":
        return None
    try:
        return str(Path(database.sqlite_path).parent)
    except Exception:  # pragma: no cover - a bad DB path must not break the report
        return None


def _database_path(config: Any) -> str | None:
    database = getattr(config, "database", None)
    if database is None or getattr(database, "backend", None) != "sqlite":
        return None
    try:
        return str(database.sqlite_path)
    except Exception:  # pragma: no cover
        return None


def _database_backend(config: Any) -> str:
    database = getattr(config, "database", None)
    return str(getattr(database, "backend", "memory"))


def _asset_roots(config: Any) -> list[str]:
    assets = getattr(config, "assets", None)
    roots = getattr(assets, "roots", None) or []
    return [str(root) for root in roots]


def current_config_version(config: Any) -> int:
    """The operator's ``config_version`` from the resolved config file (0 if absent).

    Read from the file rather than the model because ``AppConfig`` does not keep
    it; it is used only to *warn* about drift on import, never to block.
    """
    try:
        import yaml

        from deerflow.config.app_config import AppConfig

        path = AppConfig.resolve_config_path()
        with open(path, encoding="utf-8") as handle:
            data = yaml.safe_load(handle) or {}
        return int(data.get("config_version", 0) or 0)
    except Exception:  # noqa: BLE001 - an informational field must never fail a backup
        return 0


def current_schema_head() -> str:
    """The current alembic head (the schema the running build writes)."""
    try:
        from deerflow.persistence.bootstrap import _get_head_revision

        return str(_get_head_revision())
    except Exception:  # noqa: BLE001 - informational only
        return ""


def _base_manifest(config: Any, *, plan, assets_included: bool, assets_roots: list[str]) -> BackupManifest:
    import platform as _platform

    return BackupManifest(
        created_at=now_iso(),
        deerflow_version=_deerflow_version(),
        config_version=current_config_version(config),
        schema_head=current_schema_head(),
        platform=_platform.system().lower(),
        database_backend=_database_backend(config),
        database_included=plan.database_included,
        assets_included=assets_included,
        assets_roots=assets_roots,
        excluded=list(plan.excluded),
    )


def _deerflow_version() -> str:
    try:
        from deerflow import __version__  # type: ignore[attr-defined]

        return str(__version__)
    except Exception:  # noqa: BLE001
        return ""


def export_backup(config: Any, output_path: str | Path, *, include_assets: bool = False) -> dict[str, Any]:
    """Write a backup archive and return a JSON-safe summary.

    The database — when the backend is SQLite — is snapshotted consistently into
    a temporary file first, so the archived database is complete even while the
    Gateway is serving.
    """
    data_dirs = _data_dirs(config)
    database_backend = _database_backend(config)
    database_path = _database_path(config)
    assets_roots = _asset_roots(config)

    plan = plan_backup(
        data_dirs,
        database_backend=database_backend,
        database_path=database_path,
        include_assets=include_assets,
        asset_roots=assets_roots,
    )
    base_manifest = _base_manifest(config, plan=plan, assets_included=include_assets, assets_roots=assets_roots)

    with tempfile.TemporaryDirectory(prefix="deerflow-backup-") as scratch:
        members = list(plan.members)
        if plan.database_included and database_path is not None:
            snapshot = Path(scratch) / Path(database_path).name
            digest = snapshot_sqlite(database_path, snapshot)
            for index, member in enumerate(members):
                if member.name == _DATABASE_NAME:
                    members[index] = replace(member, source_path=str(snapshot), sha256=digest)
        final = write_archive(output_path, base_manifest=base_manifest, members=members)

    return {
        "ok": True,
        "output": str(output_path),
        "manifest": final.to_dict(),
        "database_included": final.database_included,
        "excluded": final.excluded_names,
        "member_count": len(final.entries),
        "total_bytes": final.total_bytes,
    }


def inspect_backup(config: Any, archive_path: str | Path) -> dict[str, Any]:
    """Read an archive's manifest and report compatibility.  Changes nothing."""
    manifest = read_manifest(archive_path)
    compatibility = check_import_compatible(manifest, current_config_version=current_config_version(config), current_schema_head=current_schema_head())
    return {
        "ok": compatibility.compatible,
        "archive": str(archive_path),
        "manifest": manifest.to_dict(),
        "compatibility": compatibility.to_dict(),
        "excluded": manifest.excluded_names,
        "database_included": manifest.database_included,
        "total_bytes": manifest.total_bytes,
    }


def _target_has_data(dir_paths: dict[str, Path], database_path: str | None) -> bool:
    """Whether this machine already holds importable data.

    Empty directories created by ``ensure_data_dirs`` must not count — otherwise
    every fresh machine would demand ``--force`` — so only actual files (or an
    existing database file) do.
    """
    if database_path is not None and Path(database_path).is_file():
        return True
    for path in dir_paths.values():
        if not Path(path).is_dir():
            continue
        for _root, _dirs, files in _safe_walk(path):
            if files:
                return True
    return False


def _safe_walk(root: Path):
    import os

    try:
        return list(os.walk(root))
    except OSError:  # pragma: no cover - defensive
        return []


def import_backup(
    config: Any,
    archive_path: str | Path,
    *,
    force: bool = False,
    dry_run: bool = False,
    assets_dest: str | None = None,
) -> dict[str, Any]:
    """Restore an archive onto this machine (offline operation).

    Returns a summary whose ``ok`` is ``False`` when a refusal applies (a
    non-empty target without ``--force``, an unrecognised archive format).  A
    refused import changes nothing.
    """
    manifest = read_manifest(archive_path)
    compatibility = check_import_compatible(manifest, current_config_version=current_config_version(config), current_schema_head=current_schema_head())

    dir_paths = {entry.name: Path(entry.path) for entry in _data_dirs(config)}
    database_path = _database_path(config)
    target_exists = _target_has_data(dir_paths, database_path)

    plan = plan_restore(
        manifest,
        dir_paths={name: str(path) for name, path in dir_paths.items()},
        database_path=database_path,
        target_exists=target_exists,
        force=force,
        assets_dest=assets_dest,
        compatibility=compatibility,
    )
    if not plan.ok:
        return {"ok": False, "refusals": list(plan.refusals), "warnings": list(plan.warnings), "actions": [a.to_dict() for a in plan.actions]}

    routes = [(action.archive_path, action.target_path) for action in plan.actions if action.action == ACTION_EXTRACT]
    result = extract_routes(archive_path, routes, dry_run=dry_run)
    return {
        "ok": True,
        "dry_run": dry_run,
        "archive": str(archive_path),
        "files": result.files,
        "total_bytes": result.total_bytes,
        "written": list(result.written),
        "skipped": list(result.skipped),
        "warnings": list(plan.warnings),
        "actions": [action.to_dict() for action in plan.actions],
    }


__all__ = [
    "current_config_version",
    "current_schema_head",
    "export_backup",
    "inspect_backup",
    "import_backup",
]
