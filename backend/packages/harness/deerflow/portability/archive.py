"""Reading and writing the backup archive (N11b, the only archive I/O).

The archive is a single zip file whose root carries ``manifest.json``; every
other member sits under a logical prefix (``dirs/<name>/…``, ``database/<file>``,
``assets/<idx>/…``).  Two rules make this module safe:

- **Names are built here, never taken from the source tree.**  A file's archive
  name is ``<member.archive_path>/<relative path>``, so a weird file name in the
  data directory cannot escape the archive.
- **Extraction trusts nothing.**  Every incoming name is re-checked (relative,
  no ``..``, no drive/UNC prefix) and symlink entries are refused: a hostile zip
  must not be able to write outside the restore root or plant a link.

The walk also *measures*: :func:`write_archive` returns the manifest with the
actual packaged counts/sizes folded in, so the manifest inside the archive
describes what is really there rather than what was intended.
"""

from __future__ import annotations

import os
import shutil
import stat
import zipfile
from collections.abc import Sequence
from dataclasses import dataclass, field
from pathlib import Path

from deerflow.portability.select import PlannedMember
from deerflow.portability.spec import (
    KIND_DATABASE,
    MANIFEST_FILENAME,
    BackupManifest,
    ManifestEntry,
)


#: The archive could not be read as a backup, or an entry is unsafe.
class BackupFormatError(Exception):
    """The archive is missing its manifest, or an entry is not safe to use."""


def _is_symlink(info: zipfile.ZipInfo) -> bool:
    """Whether a zip entry encodes a POSIX symlink (mode bits in external_attr)."""
    return stat.S_ISLNK(info.external_attr >> 16)


def _safe_relative(name: str) -> str:
    """Validate an archive member name and return its normalized form.

    Mirrors :func:`deerflow.portability.spec._reject_unsafe_archive_path`: the
    extractor must not rely on the writer having been well-behaved.
    """
    normalized = name.replace("\\", "/").strip()
    if not normalized:
        raise BackupFormatError("archive contains an empty member name")
    if normalized.startswith("/") or (len(normalized) > 1 and normalized[1] == ":"):
        raise BackupFormatError(f"archive member must be relative: {name!r}")
    parts = [part for part in normalized.split("/") if part not in ("", ".")]
    if ".." in parts:
        raise BackupFormatError(f"archive member must not traverse upward: {name!r}")
    return "/".join(parts)


# ── Writing ───────────────────────────────────────────────────────────────────


def _iter_member_files(member: PlannedMember) -> list[Path]:
    """The files a directory/asset member contributes (shallow = top level only)."""
    source = Path(member.source_path)
    if not source.is_dir():
        return []
    if member.shallow:
        return sorted((child for child in source.iterdir() if child.is_file()), key=lambda p: p.name)
    files: list[Path] = []
    for root, _dirs, names in os.walk(source):
        for file_name in sorted(names):
            files.append(Path(root) / file_name)
    return files


def _relative_archive_name(member: PlannedMember, source_file: Path) -> str:
    if member.shallow:
        return f"{member.archive_path}/{source_file.name}"
    relative = source_file.relative_to(Path(member.source_path))
    return f"{member.archive_path}/{relative.as_posix()}"


def write_archive(
    dest_path: str | Path,
    *,
    base_manifest: BackupManifest,
    members: Sequence[PlannedMember],
) -> BackupManifest:
    """Write ``members`` into a new zip at ``dest_path`` and return the manifest.

    ``base_manifest`` carries the metadata (versions, backend flags, exclusions);
    its ``entries`` are computed here from what is actually packaged, so the
    manifest describes reality.  The manifest is written last, once the counts
    are known.
    """
    dest = Path(dest_path)
    dest.parent.mkdir(parents=True, exist_ok=True)
    entries: list[ManifestEntry] = []

    with zipfile.ZipFile(dest, "w", compression=zipfile.ZIP_DEFLATED) as archive:
        for member in members:
            if member.kind == KIND_DATABASE:
                source_file = Path(member.source_path)
                if not source_file.is_file():
                    raise BackupFormatError(f"database file to back up does not exist: {source_file}")
                archive.write(source_file, arcname=member.archive_path)
                entries.append(
                    ManifestEntry(
                        name=member.name,
                        kind=member.kind,
                        archive_path=member.archive_path,
                        scope=member.scope,
                        required=member.required,
                        entry_count=1,
                        total_bytes=source_file.stat().st_size,
                        sha256=member.sha256,
                        original_path=member.original_path,
                    )
                )
                continue

            files = _iter_member_files(member)
            if not files:
                # Nothing on disk for this member (e.g. the legacy threads root on
                # a fresh install): record nothing rather than fabricate an entry.
                continue
            total = 0
            for source_file in files:
                total += source_file.stat().st_size
                archive.write(source_file, arcname=_relative_archive_name(member, source_file))
            entries.append(
                ManifestEntry(
                    name=member.name,
                    kind=member.kind,
                    archive_path=member.archive_path,
                    scope=member.scope,
                    required=member.required,
                    entry_count=len(files),
                    total_bytes=total,
                    original_path=member.original_path,
                )
            )

        final = base_manifest.model_copy(update={"entries": entries})
        archive.writestr(MANIFEST_FILENAME, final.to_json())

    return final


# ── Reading ───────────────────────────────────────────────────────────────────


def read_manifest(archive_path: str | Path) -> BackupManifest:
    """Parse the manifest from an archive, or raise :class:`BackupFormatError`."""
    try:
        with zipfile.ZipFile(archive_path, "r") as archive:
            try:
                raw = archive.read(MANIFEST_FILENAME)
            except KeyError as exc:
                raise BackupFormatError(f"archive has no {MANIFEST_FILENAME}; not a DeerFlow backup") from exc
    except zipfile.BadZipFile as exc:
        raise BackupFormatError(f"not a readable zip archive: {archive_path}") from exc

    try:
        return BackupManifest.from_json(raw.decode("utf-8"))
    except Exception as exc:  # noqa: BLE001 - a broken manifest must not leak a pydantic error
        raise BackupFormatError(f"{MANIFEST_FILENAME} could not be parsed: {exc}") from exc


def list_members(archive_path: str | Path) -> list[str]:
    """Every member name in the archive (including ``manifest.json``), sorted."""
    with zipfile.ZipFile(archive_path, "r") as archive:
        return sorted(info.filename for info in archive.infolist())


# ── Extraction ────────────────────────────────────────────────────────────────


@dataclass(frozen=True)
class ExtractResult:
    """What an extraction did (or, for a dry run, would have done)."""

    files: int = 0
    total_bytes: int = 0
    skipped: tuple[str, ...] = field(default_factory=tuple)
    written: tuple[str, ...] = field(default_factory=tuple)


def _match_route(name: str, routes: Sequence[tuple[str, str]]) -> tuple[str, str] | None:
    """Find the (prefix, target) whose prefix covers ``name``, longest first.

    A route's prefix may be a file (the database member) or a directory; the
    longest match wins so ``database/deerflow.db`` is not shadowed by a broader
    ``database`` route.
    """
    best: tuple[str, str] | None = None
    for prefix, target in routes:
        normalized = prefix.strip("/")
        if name == normalized or name.startswith(normalized + "/"):
            if best is None or len(normalized) > len(best[0].strip("/")):
                best = (normalized, target)
    return best


def extract_routes(
    archive_path: str | Path,
    routes: Sequence[tuple[str, str]],
    *,
    dry_run: bool = False,
) -> ExtractResult:
    """Extract archive members according to ``routes``.

    ``routes`` is a list of ``(archive_prefix, target)``.  A member equal to the
    prefix is written to ``target`` as a file (the database); a member under
    ``prefix/`` is written to ``target/<rest>``.  Members matching no route
    (notably ``manifest.json``) are skipped.  Unsafe names and symlink entries
    raise :class:`BackupFormatError` before anything is written.
    """
    written: list[str] = []
    skipped: list[str] = []
    files = 0
    total = 0

    with zipfile.ZipFile(archive_path, "r") as archive:
        for info in archive.infolist():
            if info.is_dir():
                continue
            if info.filename == MANIFEST_FILENAME:
                continue
            name = _safe_relative(info.filename)
            if _is_symlink(info):
                raise BackupFormatError(f"archive member is a symlink, refusing: {info.filename!r}")

            route = _match_route(name, routes)
            if route is None:
                skipped.append(info.filename)
                continue

            prefix, target = route
            if name == prefix.strip("/"):
                destination = Path(target)
            else:
                remainder = name[len(prefix.strip("/")) :].lstrip("/")
                destination = Path(target) / remainder

            files += 1
            total += info.file_size
            written.append(str(destination))
            if dry_run:
                continue

            destination.parent.mkdir(parents=True, exist_ok=True)
            with archive.open(info) as source, open(destination, "wb") as sink:
                shutil.copyfileobj(source, sink)

    return ExtractResult(files=files, total_bytes=total, skipped=tuple(skipped), written=tuple(written))


__all__ = [
    "BackupFormatError",
    "ExtractResult",
    "write_archive",
    "read_manifest",
    "list_members",
    "extract_routes",
]
