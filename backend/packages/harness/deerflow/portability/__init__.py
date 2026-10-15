"""Backup, export/import and machine migration (N11b, dev plan §22).

The package mirrors the split the engine uses elsewhere:

- :mod:`deerflow.portability.spec` — the archive model + compatibility verdict (pure).
- :mod:`deerflow.portability.select` — what to back up / how to restore (pure).
- :mod:`deerflow.portability.archive` — safe zip read/write (the only archive I/O).
- :mod:`deerflow.portability.snapshot` — consistent SQLite snapshots (I/O).
- :mod:`deerflow.portability.service` — export / inspect / import orchestration.

Export is safe to run against a live install (the database snapshot is taken
with SQLite's online backup API); import is an **offline** operation — restore
while the Gateway is stopped, because it overwrites the database file.
"""

from __future__ import annotations

from deerflow.portability.archive import (
    BackupFormatError,
    ExtractResult,
    extract_routes,
    list_members,
    read_manifest,
    write_archive,
)
from deerflow.portability.select import (
    ACTION_EXTRACT,
    ACTION_SKIP,
    EXCLUDED_DIRS,
    BackupPlan,
    PlannedMember,
    RestoreAction,
    RestorePlan,
    plan_backup,
    plan_restore,
)
from deerflow.portability.service import export_backup, import_backup, inspect_backup
from deerflow.portability.snapshot import is_sqlite_file, sha256_file, snapshot_sqlite, sqlite_sidecars
from deerflow.portability.spec import (
    BACKUP_FORMAT_VERSION,
    KIND_ASSET,
    KIND_DATABASE,
    KIND_DIRECTORY,
    MANIFEST_FILENAME,
    MEMBER_KINDS,
    BackupManifest,
    CompatibilityReport,
    ExcludedEntry,
    ManifestEntry,
    check_import_compatible,
    now_iso,
)

__all__ = [
    "ACTION_EXTRACT",
    "ACTION_SKIP",
    "BACKUP_FORMAT_VERSION",
    "EXCLUDED_DIRS",
    "KIND_ASSET",
    "KIND_DATABASE",
    "KIND_DIRECTORY",
    "MANIFEST_FILENAME",
    "MEMBER_KINDS",
    "BackupFormatError",
    "BackupManifest",
    "BackupPlan",
    "CompatibilityReport",
    "ExcludedEntry",
    "ExtractResult",
    "ManifestEntry",
    "PlannedMember",
    "RestoreAction",
    "RestorePlan",
    "check_import_compatible",
    "export_backup",
    "extract_routes",
    "import_backup",
    "inspect_backup",
    "is_sqlite_file",
    "list_members",
    "now_iso",
    "plan_backup",
    "plan_restore",
    "read_manifest",
    "sha256_file",
    "snapshot_sqlite",
    "sqlite_sidecars",
    "write_archive",
]
