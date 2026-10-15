"""N11b S1 — the backup manifest model and the import-compatibility verdict.

Pure: no filesystem, no archive, no config singleton.  The archive I/O half is
covered by ``tests/test_portability_archive.py`` (S3).
"""

from __future__ import annotations

import json

import pytest
from pydantic import ValidationError

from deerflow.portability.spec import (
    BACKUP_FORMAT_VERSION,
    KIND_ASSET,
    KIND_DATABASE,
    KIND_DIRECTORY,
    MANIFEST_FILENAME,
    BackupManifest,
    CompatibilityReport,
    ExcludedEntry,
    ManifestEntry,
    check_import_compatible,
    now_iso,
)


class TestManifestEntry:
    def test_minimal_directory_entry(self) -> None:
        entry = ManifestEntry(name="users", kind=KIND_DIRECTORY, archive_path="dirs/users")
        assert entry.scope == "global"
        assert entry.required is True
        assert entry.entry_count == 0
        assert entry.sha256 is None

    def test_blank_name_rejected(self) -> None:
        with pytest.raises(ValidationError):
            ManifestEntry(name="  ", kind=KIND_DIRECTORY, archive_path="dirs/x")

    def test_archive_path_must_be_relative(self) -> None:
        with pytest.raises(ValidationError):
            ManifestEntry(name="users", kind=KIND_DIRECTORY, archive_path="/abs/users")
        with pytest.raises(ValidationError):
            ManifestEntry(name="users", kind=KIND_DIRECTORY, archive_path="dirs/../../etc")

    def test_extra_fields_rejected(self) -> None:
        with pytest.raises(ValidationError):
            ManifestEntry(name="users", kind=KIND_DIRECTORY, archive_path="dirs/users", wat=True)  # type: ignore[call-arg]


class TestBackupManifest:
    def _manifest(self, **overrides) -> BackupManifest:
        base = dict(
            created_at=now_iso(),
            deerflow_version="0.9.6",
            config_version=40,
            schema_head="0019_human_task_kind_and_undo",
            platform="linux",
            database_backend="sqlite",
            database_included=True,
            database_file="database/deerflow.db",
            entries=[
                ManifestEntry(name="users", kind=KIND_DIRECTORY, archive_path="dirs/users", scope="per-user"),
                ManifestEntry(name="database", kind=KIND_DATABASE, archive_path="database/deerflow.db", sha256="a" * 64),
            ],
            excluded=[ExcludedEntry(name="locks", reason="transient")],
        )
        base.update(overrides)
        return BackupManifest(**base)

    def test_round_trip_dict(self) -> None:
        manifest = self._manifest()
        restored = BackupManifest.from_dict(manifest.to_dict())
        assert restored == manifest

    def test_round_trip_json(self) -> None:
        manifest = self._manifest()
        restored = BackupManifest.from_json(manifest.to_json())
        assert restored == manifest
        # the serialised form is stable JSON with the format version present
        payload = json.loads(manifest.to_json())
        assert payload["format_version"] == BACKUP_FORMAT_VERSION

    def test_lookups(self) -> None:
        manifest = self._manifest()
        assert manifest.find("users") is not None
        assert manifest.find("nope") is None
        assert manifest.database_entry is not None
        assert manifest.database_entry.sha256 == "a" * 64

    def test_to_json_is_utf8_safe(self) -> None:
        manifest = self._manifest(platform="windows")
        assert "windows" in manifest.to_json()

    def test_extra_fields_rejected(self) -> None:
        with pytest.raises(ValidationError):
            BackupManifest(created_at=now_iso(), mystery=True)  # type: ignore[call-arg]

    def test_format_version_must_be_positive(self) -> None:
        with pytest.raises(ValidationError):
            BackupManifest(created_at=now_iso(), format_version=0)

    def test_missing_required_field_rejected(self) -> None:
        with pytest.raises(ValidationError):
            BackupManifest()  # type: ignore[call-arg]  # created_at is required


class TestCheckImportCompatible:
    def _manifest(self, **overrides) -> BackupManifest:
        base = dict(created_at=now_iso(), config_version=40, schema_head="0019_x")
        base.update(overrides)
        return BackupManifest(**base)

    def test_same_versions_compatible(self) -> None:
        report = check_import_compatible(self._manifest(), current_config_version=40, current_schema_head="0019_x")
        assert isinstance(report, CompatibilityReport)
        assert report.compatible is True
        assert report.warnings == ()

    def test_newer_format_is_incompatible(self) -> None:
        report = check_import_compatible(self._manifest(format_version=BACKUP_FORMAT_VERSION + 1), current_config_version=40, current_schema_head="0019_x")
        assert report.compatible is False
        assert "format" in report.reason.lower()

    def test_config_version_drift_is_warning_not_refusal(self) -> None:
        report = check_import_compatible(self._manifest(config_version=39), current_config_version=40, current_schema_head="0019_x")
        assert report.compatible is True
        assert any("config_version" in w for w in report.warnings)

    def test_schema_head_drift_is_warning_not_refusal(self) -> None:
        report = check_import_compatible(self._manifest(schema_head="0018_y"), current_config_version=40, current_schema_head="0019_x")
        assert report.compatible is True
        assert any("schema" in w.lower() for w in report.warnings)

    def test_empty_manifest_schema_head_does_not_warn(self) -> None:
        report = check_import_compatible(self._manifest(schema_head=""), current_config_version=40, current_schema_head="0019_x")
        assert report.compatible is True
        assert report.warnings == ()


def test_manifest_filename_constant() -> None:
    assert MANIFEST_FILENAME == "manifest.json"


def test_entry_kind_constants() -> None:
    assert {KIND_DIRECTORY, KIND_DATABASE, KIND_ASSET} == {"directory", "database", "asset"}
