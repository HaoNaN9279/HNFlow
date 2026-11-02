"""The backup archive model (N11b, dev plan §22 third bullet).

Dev plan §22's third bullet asks for **backup and migration**: export/import plus
data-directory copy, so a single-machine install can be moved to another machine
and restored.  This module owns the **description** half — what an archive says
about itself — and is deliberately pure: no filesystem, no zipfile, no config.

Two ideas shape it:

- **The archive is self-describing.**  ``manifest.json`` at the archive root
  records the format version, the source machine's versions, and one entry per
  packaged member.  An importer decides what to do from the manifest, not from
  guessing at the zip's contents.
- **Logical, machine-independent layout.**  Entries name their location with a
  logical path (``dirs/<name>/…``, ``database/<file>``, ``assets/<idx>/…``),
  never an absolute host path, so restoring onto a machine with a different
  ``DEER_FLOW_HOME`` works.  See :mod:`deerflow.portability.select` for the plan
  that produces them; the I/O lives in :mod:`deerflow.portability.archive`.
"""

from __future__ import annotations

import json
from dataclasses import dataclass
from datetime import UTC, datetime
from typing import Any

from pydantic import BaseModel, ConfigDict, Field, field_validator

#: Bump when the on-disk archive shape changes incompatibly.
BACKUP_FORMAT_VERSION = 1

#: The manifest's name at the archive root.
MANIFEST_FILENAME = "manifest.json"

#: Member kinds in the manifest.
KIND_DIRECTORY = "directory"
KIND_DATABASE = "database"
KIND_ASSET = "asset"

MEMBER_KINDS: frozenset[str] = frozenset({KIND_DIRECTORY, KIND_DATABASE, KIND_ASSET})


def now_iso() -> str:
    """UTC timestamp for ``created_at`` (seconds resolution, ISO 8601)."""
    return datetime.now(UTC).replace(microsecond=0).isoformat()


def _reject_unsafe_archive_path(value: str) -> str:
    """A manifest path must be a relative, non-traversing path.

    The importer trusts the manifest to *tell it where things are*, so the
    manifest itself must not be able to point outside the restore root.
    """
    stripped = value.strip()
    if not stripped:
        raise ValueError("archive_path must be a non-empty string")
    normalized = stripped.replace("\\", "/")
    if normalized.startswith("/") or (len(normalized) > 1 and normalized[1] == ":"):
        raise ValueError(f"archive_path must be relative: {value!r}")
    parts = [part for part in normalized.split("/") if part not in ("", ".")]
    if ".." in parts:
        raise ValueError(f"archive_path must not traverse upward: {value!r}")
    return "/".join(parts)


class ManifestEntry(BaseModel):
    """One packaged member (a directory, the database file, or an asset root)."""

    model_config = ConfigDict(extra="forbid")

    name: str = Field(..., description="Logical name in the data layout (DataDir.name for directories; 'database' for the DB; an index for assets).")
    kind: str = Field(..., description="Member kind: directory / database / asset.")
    archive_path: str = Field(..., description="Relative path of this member inside the archive.")
    scope: str = Field(default="global", description="'global' or 'per-user'.")
    required: bool = Field(default=True, description="Whether the layout needs this member on restore.")
    entry_count: int = Field(default=0, ge=0, description="Number of files packaged under this member.")
    total_bytes: int = Field(default=0, ge=0, description="Sum of file sizes packaged under this member.")
    sha256: str | None = Field(default=None, description="Digest of a single-file member (the database).")
    original_path: str | None = Field(default=None, description="Host path this member came from (recorded for assets; informational).")

    @field_validator("name")
    @classmethod
    def _name_not_blank(cls, value: str) -> str:
        stripped = value.strip()
        if not stripped:
            raise ValueError("name must be a non-empty string")
        return stripped

    @field_validator("kind")
    @classmethod
    def _known_kind(cls, value: str) -> str:
        if value not in MEMBER_KINDS:
            raise ValueError(f"unknown member kind {value!r}; expected one of {sorted(MEMBER_KINDS)}")
        return value

    @field_validator("archive_path")
    @classmethod
    def _safe_path(cls, value: str) -> str:
        return _reject_unsafe_archive_path(value)


class ExcludedEntry(BaseModel):
    """A layout directory deliberately left out of the archive, with a reason."""

    model_config = ConfigDict(extra="forbid")

    name: str
    reason: str

    @field_validator("name", "reason")
    @classmethod
    def _not_blank(cls, value: str) -> str:
        stripped = value.strip()
        if not stripped:
            raise ValueError("must be a non-empty string")
        return stripped


class BackupManifest(BaseModel):
    """What an archive says about itself.

    ``database_included`` is explicit because a Postgres install never packages
    its database content (that is ``pg_dump``'s job) — the flag lets an importer
    say so instead of assuming the absence of a database member is corruption.
    """

    model_config = ConfigDict(extra="forbid")

    format_version: int = Field(default=BACKUP_FORMAT_VERSION, ge=1)
    created_at: str
    deerflow_version: str = ""
    config_version: int = Field(default=0, ge=0)
    schema_head: str = ""
    platform: str = ""
    database_backend: str = "memory"
    database_included: bool = False
    database_file: str | None = None
    assets_included: bool = False
    assets_roots: list[str] = Field(default_factory=list)
    entries: list[ManifestEntry] = Field(default_factory=list)
    excluded: list[ExcludedEntry] = Field(default_factory=list)

    # -- lookups / helpers --

    def find(self, name: str) -> ManifestEntry | None:
        for entry in self.entries:
            if entry.name == name:
                return entry
        return None

    @property
    def database_entry(self) -> ManifestEntry | None:
        for entry in self.entries:
            if entry.kind == KIND_DATABASE:
                return entry
        return None

    @property
    def total_bytes(self) -> int:
        return sum(entry.total_bytes for entry in self.entries)

    @property
    def excluded_names(self) -> list[str]:
        return [entry.name for entry in self.excluded]

    # -- serialisation --

    def to_dict(self) -> dict[str, Any]:
        return self.model_dump(mode="json")

    @classmethod
    def from_dict(cls, data: dict[str, Any]) -> BackupManifest:
        return cls.model_validate(data)

    def to_json(self, *, indent: int | None = 2) -> str:
        return json.dumps(self.to_dict(), indent=indent, ensure_ascii=False)

    @classmethod
    def from_json(cls, raw: str) -> BackupManifest:
        return cls.model_validate(json.loads(raw))


#: Verdicts from :func:`check_import_compatible`.
COMPATIBLE = "compatible"
INCOMPATIBLE = "incompatible"


@dataclass(frozen=True)
class CompatibilityReport:
    """Whether an archive can be imported here, and what to warn about.

    ``compatible`` is the hard gate (an unrecognised archive format is refused);
    ``warnings`` are advisory drifts the operator should know about but that do
    not block — a ``config_version`` gap is fixed by ``make config-upgrade`` and
    a ``schema_head`` gap is fixed by alembic on the next startup.
    """

    compatible: bool
    reason: str = ""
    warnings: tuple[str, ...] = ()

    def to_dict(self) -> dict[str, Any]:
        return {"compatible": self.compatible, "reason": self.reason, "warnings": list(self.warnings)}


def check_import_compatible(
    manifest: BackupManifest,
    *,
    current_config_version: int,
    current_schema_head: str,
    supported_format: int = BACKUP_FORMAT_VERSION,
) -> CompatibilityReport:
    """Decide whether ``manifest`` may be imported into this build.

    Only the **archive format** is a hard gate: a newer writer may have stored
    something this reader would misread.  Version drift is surfaced as warnings —
    refusing on it would block the ordinary "restore an older backup after an
    upgrade" case, where the migration machinery already knows what to do.
    """
    if manifest.format_version > supported_format:
        return CompatibilityReport(
            compatible=False,
            reason=(f"archive format version {manifest.format_version} is newer than this build supports ({supported_format}); upgrade DeerFlow before importing."),
        )

    warnings: list[str] = []
    if manifest.config_version and manifest.config_version != current_config_version:
        warnings.append(f"archive config_version={manifest.config_version} but this build expects {current_config_version}; run `make config-upgrade` if the config looks incomplete.")
    if manifest.schema_head and manifest.schema_head != current_schema_head:
        warnings.append(f"archive schema head={manifest.schema_head!r} but this build is at {current_schema_head!r}; alembic will migrate the restored database on the next startup.")
    return CompatibilityReport(compatible=True, warnings=tuple(warnings))


__all__ = [
    "BACKUP_FORMAT_VERSION",
    "MANIFEST_FILENAME",
    "KIND_DIRECTORY",
    "KIND_DATABASE",
    "KIND_ASSET",
    "MEMBER_KINDS",
    "COMPATIBLE",
    "INCOMPATIBLE",
    "now_iso",
    "ManifestEntry",
    "ExcludedEntry",
    "BackupManifest",
    "CompatibilityReport",
    "check_import_compatible",
]
