"""Tests for the N10 undo record model, planner and file-level compensation.

Pure-model coverage (ordering, transitions, row round-trip) lives here; the
executor integration is in ``test_workflow_undo_executors.py``.
"""

from __future__ import annotations

from pathlib import Path

import pytest

from deerflow.assets.ref import make_ref
from deerflow.workflow.undo import (
    ALLOWED_UNDO_TRANSITIONS,
    UndoKind,
    UndoRecord,
    UndoStatus,
    backup_host_file,
    plan_undo,
    restore_host_file,
    undo_directory,
    validate_undo_transition,
)


def _record(node_id: str, *, status: UndoStatus = UndoStatus.RECORDED, kind: UndoKind = UndoKind.FILE_BACKUP) -> UndoRecord:
    return UndoRecord(
        id=f"undo-{node_id}",
        run_id="run-1",
        node_id=node_id,
        kind=kind,
        status=status,
        targets=[make_ref(f"/mnt/user-data/workspace/{node_id}.txt", scope="workspace")],
        backup_paths=[f"/tmp/undo/{node_id}.txt"],
    )


# ── status machine ────────────────────────────────────────────────────────────


def test_recorded_is_the_only_source_status() -> None:
    assert UndoStatus.RECORDED in {src for src, allowed in ALLOWED_UNDO_TRANSITIONS.items() if UndoStatus.UNDONE in allowed}
    for terminal in (UndoStatus.UNDONE, UndoStatus.SKIPPED, UndoStatus.FAILED):
        assert ALLOWED_UNDO_TRANSITIONS[terminal] == frozenset()


def test_validate_transition() -> None:
    assert validate_undo_transition(UndoStatus.RECORDED, UndoStatus.UNDONE) is True
    assert validate_undo_transition(UndoStatus.RECORDED, UndoStatus.FAILED) is True
    assert validate_undo_transition(UndoStatus.UNDONE, UndoStatus.UNDONE) is False
    assert validate_undo_transition(UndoStatus.FAILED, UndoStatus.UNDONE) is False


# ── plan_undo ─────────────────────────────────────────────────────────────────


def test_plan_undo_reverses_the_run_order() -> None:
    records = [_record("a1"), _record("a2"), _record("a3")]

    assert [r.node_id for r in plan_undo(records)] == ["a3", "a2", "a1"]


def test_plan_undo_skips_terminal_records() -> None:
    records = [
        _record("a1", status=UndoStatus.UNDONE),
        _record("a2"),
        _record("a3", status=UndoStatus.FAILED),
        _record("a4", status=UndoStatus.SKIPPED),
    ]

    assert [r.node_id for r in plan_undo(records)] == ["a2"]


def test_plan_undo_of_an_empty_run_is_empty() -> None:
    assert plan_undo([]) == []


# ── row round-trip ────────────────────────────────────────────────────────────


def test_record_round_trips_through_a_repository_row() -> None:
    record = _record("a1")
    row = {
        "id": record.id,
        "run_id": record.run_id,
        "node_id": record.node_id,
        "kind": "file_backup",
        "status": "recorded",
        "targets": [t.to_port() for t in record.targets],
        "backup_paths": ["/tmp/undo/a1.txt"],
        "session_id": None,
        "app_steps": None,
        "detail": "",
    }

    rebuilt = UndoRecord.from_row(row)

    assert rebuilt == record
    assert rebuilt.to_port()["kind"] == "file_backup"


def test_app_undo_record_carries_session_and_steps() -> None:
    record = UndoRecord(
        id="undo-1",
        run_id="run-1",
        node_id="s1",
        kind=UndoKind.APP_UNDO,
        session_id="sess-1",
        app_steps=2,
        detail="blender native undo",
    )

    assert record.to_port()["kind"] == "app_undo"
    assert record.to_port()["session_id"] == "sess-1"
    assert record.to_port()["app_steps"] == 2


def test_from_row_rejects_an_unknown_kind() -> None:
    with pytest.raises(ValueError):
        UndoRecord.from_row({"id": "x", "run_id": "r", "node_id": "n", "kind": "teleport", "status": "recorded"})


# ── file-level compensation ───────────────────────────────────────────────────


def test_undo_directory_is_run_and_node_scoped(tmp_path: Path) -> None:
    assert undo_directory(tmp_path, run_id="run-1", node_id="a1") == tmp_path / "undo" / "run-1" / "a1"


def test_backup_and_restore_round_trip(tmp_path: Path) -> None:
    target = tmp_path / "scene.blend"
    target.write_bytes(b"original")
    backup_dir = tmp_path / "backups"

    backup = backup_host_file(target, backup_dir=backup_dir)
    assert backup.read_bytes() == b"original"

    target.write_bytes(b"clobbered")
    restore_host_file(backup, target=target)

    assert target.read_bytes() == b"original"


def test_backup_keeps_the_original_filename_by_default(tmp_path: Path) -> None:
    target = tmp_path / "nested" / "scene.blend"
    target.parent.mkdir(parents=True, exist_ok=True)
    target.write_bytes(b"x")

    backup = backup_host_file(target, backup_dir=tmp_path / "b")

    assert backup.name == "scene.blend"


def test_backup_accepts_an_explicit_name(tmp_path: Path) -> None:
    target = tmp_path / "scene.blend"
    target.write_bytes(b"x")

    backup = backup_host_file(target, backup_dir=tmp_path / "b", name="before-import.blend")

    assert backup.name == "before-import.blend"


def test_restore_creates_a_missing_parent_directory(tmp_path: Path) -> None:
    source = tmp_path / "src.bin"
    source.write_bytes(b"payload")
    backup = backup_host_file(source, backup_dir=tmp_path / "b")

    target = tmp_path / "gone" / "dir" / "src.bin"
    restore_host_file(backup, target=target)

    assert target.read_bytes() == b"payload"


def test_backup_of_a_missing_file_raises(tmp_path: Path) -> None:
    with pytest.raises(FileNotFoundError):
        backup_host_file(tmp_path / "nope.bin", backup_dir=tmp_path / "b")


def test_restore_leaves_no_staging_file_behind(tmp_path: Path) -> None:
    source = tmp_path / "src.bin"
    source.write_bytes(b"payload")
    backup = backup_host_file(source, backup_dir=tmp_path / "b")
    target = tmp_path / "out" / "src.bin"

    restore_host_file(backup, target=target)

    leftovers = [p.name for p in target.parent.iterdir() if p.name.startswith(".undo-")]
    assert leftovers == []
