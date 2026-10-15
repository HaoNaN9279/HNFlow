"""Deciding *what* to back up and *how* to restore it (N11b, pure).

:func:`plan_backup` turns the N11 data-directory convention
(:meth:`deerflow.config.paths.Paths.data_dirs`) plus the database configuration
into a :class:`BackupPlan`: which directories are packaged, under what logical
name, and which are deliberately left out.  :func:`plan_restore` turns a
:class:`~deerflow.portability.spec.BackupManifest` plus this machine's current
paths into a :class:`RestorePlan`.

Both are **pure**: they never touch the filesystem, so the interesting rules —
"locks are transient", "the database is a file only on SQLite", "a non-empty
target needs ``--force``", "assets need an explicit destination" — are testable
without building a real archive.

The N11 layout names the members; this module never invents a second list.  The
one special case is ``base``: it is the root that *contains* the other
directories, so it is packaged **shallowly** (its own top-level files —
``memory.json``, ``USER.md`` — but not its subdirectories, which are members in
their own right).  Without that, every backup would nest the whole tree twice.
"""

from __future__ import annotations

from collections.abc import Mapping, Sequence
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

from deerflow.config.paths import DataDir
from deerflow.portability.spec import (
    KIND_ASSET,
    KIND_DATABASE,
    KIND_DIRECTORY,
    BackupManifest,
    CompatibilityReport,
    ExcludedEntry,
)

#: Directories deliberately left out of an archive, with the reason.
#:
#: ``locks`` holds transient cross-process lock files (N8) — meaningless on
#: another machine.  ``retrieval`` is the derived memory index (rebuildable) —
#: packaging it would ship a cache as if it were data.
EXCLUDED_DIRS: dict[str, str] = {
    "locks": "transient cross-process lock files (recreated on demand)",
    "retrieval": "derived memory retrieval index (rebuilt from the canonical memory data)",
}

#: The data-directory entry shape is a directory; the database is one file.
_DATABASE_DIR_NAME = "database"

#: Archive location prefixes (logical, never absolute).
_DIR_PREFIX = "dirs"
_DB_PREFIX = "database"
_ASSET_PREFIX = "assets"


@dataclass(frozen=True)
class PlannedMember:
    """One member of an archive to be written.

    ``shallow`` restricts a directory member to the files directly inside it
    (used for ``base``); recursively packaging it would duplicate the members
    that are themselves entries.
    """

    name: str
    kind: str
    source_path: str
    archive_path: str
    scope: str = "global"
    required: bool = True
    shallow: bool = False
    original_path: str | None = None
    sha256: str | None = None

    def to_dict(self) -> dict[str, Any]:
        return {
            "name": self.name,
            "kind": self.kind,
            "source_path": self.source_path,
            "archive_path": self.archive_path,
            "scope": self.scope,
            "required": self.required,
            "shallow": self.shallow,
            "original_path": self.original_path,
            "sha256": self.sha256,
        }


@dataclass(frozen=True)
class BackupPlan:
    """What an export would package, and what it would leave out."""

    members: tuple[PlannedMember, ...] = field(default_factory=tuple)
    excluded: tuple[ExcludedEntry, ...] = field(default_factory=tuple)
    database_backend: str = "memory"
    database_included: bool = False

    @property
    def excluded_names(self) -> list[str]:
        return [entry.name for entry in self.excluded]

    def to_dict(self) -> dict[str, Any]:
        return {
            "database_backend": self.database_backend,
            "database_included": self.database_included,
            "members": [member.to_dict() for member in self.members],
            "excluded": [entry.model_dump(mode="json") for entry in self.excluded],
        }


def plan_backup(
    data_dirs: Sequence[DataDir],
    *,
    database_backend: str,
    database_path: str | None,
    include_assets: bool = False,
    asset_roots: Sequence[str] = (),
) -> BackupPlan:
    """Build the export plan from the N11 layout and the database configuration.

    ``database_path`` is the SQLite file to snapshot (``None`` for a
    non-file backend).  Assets are opted into explicitly: they are operator-owned
    directories outside the application's own data root, so packaging them by
    default could copy gigabytes the operator never asked to move.
    """
    members: list[PlannedMember] = []
    excluded: list[ExcludedEntry] = []

    for entry in data_dirs:
        if entry.name == _DATABASE_DIR_NAME:
            # The database is one file, handled below — not a directory tree.
            continue
        if entry.name in EXCLUDED_DIRS:
            excluded.append(ExcludedEntry(name=entry.name, reason=EXCLUDED_DIRS[entry.name]))
            continue
        members.append(
            PlannedMember(
                name=entry.name,
                kind=KIND_DIRECTORY,
                source_path=str(entry.path),
                archive_path=f"{_DIR_PREFIX}/{entry.name}",
                scope=entry.scope,
                required=entry.required,
                shallow=(entry.name == "base"),
            )
        )

    database_included = database_backend == "sqlite" and bool(database_path)
    if database_included and database_path is not None:
        file_name = Path(database_path).name
        members.append(
            PlannedMember(
                name=_DATABASE_DIR_NAME,
                kind=KIND_DATABASE,
                source_path=str(database_path),
                archive_path=f"{_DB_PREFIX}/{file_name}",
            )
        )
    elif database_backend == "postgres":
        excluded.append(
            ExcludedEntry(
                name=_DATABASE_DIR_NAME,
                reason="Postgres database content is not packaged; export it with pg_dump and restore it separately.",
            )
        )

    if include_assets:
        for index, root in enumerate(asset_roots):
            members.append(
                PlannedMember(
                    name=f"asset-{index}",
                    kind=KIND_ASSET,
                    source_path=str(root),
                    archive_path=f"{_ASSET_PREFIX}/{index}",
                    required=False,
                    original_path=str(root),
                )
            )

    return BackupPlan(
        members=tuple(members),
        excluded=tuple(excluded),
        database_backend=database_backend,
        database_included=database_included,
    )


# ── Restore ───────────────────────────────────────────────────────────────────

#: Action verbs in a restore plan.
ACTION_EXTRACT = "extract"
ACTION_SKIP = "skip"


@dataclass(frozen=True)
class RestoreAction:
    """One member's restore decision: extract it to ``target_path``, or skip it."""

    name: str
    kind: str
    archive_path: str
    target_path: str = ""
    action: str = ACTION_EXTRACT
    reason: str = ""

    def to_dict(self) -> dict[str, Any]:
        return {
            "name": self.name,
            "kind": self.kind,
            "archive_path": self.archive_path,
            "target_path": self.target_path,
            "action": self.action,
            "reason": self.reason,
        }


@dataclass(frozen=True)
class RestorePlan:
    """How an archive maps onto this machine, plus any blockers.

    ``refusals`` are hard stops (a non-empty target without ``--force``, an
    unrecognised format, an unknown required directory).  ``warnings`` are
    advisory — version drift surfaced by the compatibility check.
    """

    actions: tuple[RestoreAction, ...] = field(default_factory=tuple)
    refusals: tuple[str, ...] = field(default_factory=tuple)
    warnings: tuple[str, ...] = field(default_factory=tuple)

    @property
    def ok(self) -> bool:
        return not self.refusals

    def to_dict(self) -> dict[str, Any]:
        return {
            "ok": self.ok,
            "actions": [action.to_dict() for action in self.actions],
            "refusals": list(self.refusals),
            "warnings": list(self.warnings),
        }


def plan_restore(
    manifest: BackupManifest,
    *,
    dir_paths: Mapping[str, str],
    database_path: str | None,
    target_exists: bool,
    force: bool,
    assets_dest: str | None,
    compatibility: CompatibilityReport | None = None,
) -> RestorePlan:
    """Map a manifest onto this machine's paths and surface blockers.

    ``dir_paths`` maps a member name to the *current* machine's path for it (from
    ``Paths.data_dirs``), so an archive taken with one ``DEER_FLOW_HOME``
    restores correctly under another.  ``target_exists`` means the layout on this
    machine already holds data; overwriting then requires ``force``.
    """
    refusals: list[str] = []
    warnings: list[str] = list(compatibility.warnings) if compatibility is not None else []

    if compatibility is not None and not compatibility.compatible:
        refusals.append(compatibility.reason or "archive is not compatible with this build")
    if target_exists and not force:
        refusals.append("target already contains data; pass --force to overwrite it with the archive")

    actions: list[RestoreAction] = []
    for entry in manifest.entries:
        if entry.kind == KIND_DATABASE:
            if database_path is None:
                actions.append(
                    RestoreAction(
                        name=entry.name,
                        kind=entry.kind,
                        archive_path=entry.archive_path,
                        action=ACTION_SKIP,
                        reason="this build's database backend keeps no file to restore (memory/postgres)",
                    )
                )
            else:
                actions.append(
                    RestoreAction(
                        name=entry.name,
                        kind=entry.kind,
                        archive_path=entry.archive_path,
                        target_path=str(database_path),
                        action=ACTION_EXTRACT,
                    )
                )
        elif entry.kind == KIND_ASSET:
            if assets_dest is None:
                actions.append(
                    RestoreAction(
                        name=entry.name,
                        kind=entry.kind,
                        archive_path=entry.archive_path,
                        action=ACTION_SKIP,
                        reason="assets are operator-owned paths outside the data root; re-run with --assets-dest to place them",
                    )
                )
            else:
                leaf = entry.archive_path.rsplit("/", 1)[-1]
                actions.append(
                    RestoreAction(
                        name=entry.name,
                        kind=entry.kind,
                        archive_path=entry.archive_path,
                        target_path=str(Path(assets_dest) / leaf),
                        action=ACTION_EXTRACT,
                    )
                )
        else:  # directory
            target = dir_paths.get(entry.name)
            if target is None:
                if entry.required:
                    refusals.append(f"archive references required directory {entry.name!r}, which this build's data layout does not define")
                else:
                    warnings.append(f"archive references optional directory {entry.name!r}, which this build's data layout does not define; skipping it")
                continue
            actions.append(
                RestoreAction(
                    name=entry.name,
                    kind=entry.kind,
                    archive_path=entry.archive_path,
                    target_path=str(target),
                    action=ACTION_EXTRACT,
                )
            )

    return RestorePlan(actions=tuple(actions), refusals=tuple(refusals), warnings=tuple(warnings))


__all__ = [
    "EXCLUDED_DIRS",
    "ACTION_EXTRACT",
    "ACTION_SKIP",
    "PlannedMember",
    "BackupPlan",
    "RestoreAction",
    "RestorePlan",
    "plan_backup",
    "plan_restore",
]
