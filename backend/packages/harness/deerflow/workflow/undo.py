"""Undo / compensation records for irreversible workflow actions (N10, §21).

Dev plan §21 asks for irreversible operations to carry a **compensation action**.
Two things are needed for that:

1. a durable record of *what was done* (this module's :class:`UndoRecord` +
   :class:`~deerflow.persistence.workflow_undo.WorkflowUndoRepository`), and
2. a way to replay those records backwards (:func:`plan_undo`).

The file-level compensation itself lives here too as of this slice —
:func:`backup_host_file` / :func:`restore_host_file` — because the fallback must
work even when the application declares no undo support.  Backups go to an
engine-private directory (``{DEER_FLOW_HOME}/undo/<run_id>/<node_id>/``), **not**
through ``assets.roots``: they are recovery material the engine owns, not user
assets, so an empty allow-list must not disable rollback.

Compensation order is **reverse chronological**: the last thing the run did is
undone first, which is the only order that is correct when one action's target
was produced by an earlier one.

This module is pure except for the two documented file helpers (synchronous I/O,
offloaded by their callers).
"""

from __future__ import annotations

import logging
import os
import shutil
import tempfile
from enum import StrEnum
from pathlib import Path
from typing import Any

from pydantic import BaseModel, ConfigDict, Field

from deerflow.assets.ref import AssetRef

logger = logging.getLogger(__name__)


class UndoKind(StrEnum):
    """How an action can be compensated."""

    FILE_BACKUP = "file_backup"
    """The engine snapshotted the touched paths before the action ran."""

    APP_UNDO = "app_undo"
    """The application's own undo/history is the compensation (no engine copy)."""


class UndoStatus(StrEnum):
    """Lifecycle of one undo record.

    ``recorded`` is the only state :func:`plan_undo` schedules; the others are
    terminal, so a repeated undo request cannot apply the same compensation twice.
    """

    RECORDED = "recorded"
    UNDONE = "undone"
    SKIPPED = "skipped"
    FAILED = "failed"


ALLOWED_UNDO_TRANSITIONS: dict[UndoStatus, frozenset[UndoStatus]] = {
    UndoStatus.RECORDED: frozenset({UndoStatus.UNDONE, UndoStatus.SKIPPED, UndoStatus.FAILED}),
    UndoStatus.UNDONE: frozenset(),
    UndoStatus.SKIPPED: frozenset(),
    UndoStatus.FAILED: frozenset(),
}


def validate_undo_transition(from_status: UndoStatus, to_status: UndoStatus) -> bool:
    """Return whether transitioning *from_status* → *to_status* is legal."""
    return to_status in ALLOWED_UNDO_TRANSITIONS.get(from_status, frozenset())


class UndoRecord(BaseModel):
    """One reversible action, as stored and as reported to a caller."""

    model_config = ConfigDict(extra="forbid")

    id: str = Field(description="Record id (``undo-<hex>``).")
    run_id: str = Field(description="Workflow run that performed the action.")
    node_id: str = Field(description="Node that performed it.")
    kind: UndoKind = Field(description="Compensation strategy for this action.")
    status: UndoStatus = Field(default=UndoStatus.RECORDED, description="Lifecycle status.")
    targets: list[AssetRef] = Field(default_factory=list, description="Files the action touched.")
    backup_paths: list[str | None] = Field(
        default_factory=list,
        description="Engine-private copies, aligned 1:1 with ``targets`` — a ``None`` entry means the target did not exist before (rollback removes it).",
    )
    session_id: str | None = Field(default=None, description="Application session the action ran against (``app_undo``).")
    app_steps: int | None = Field(default=None, description="How many application undo steps revert it (``app_undo``).")
    detail: str = Field(default="", description="Human-readable note (backup failures, driver messages).")

    def to_port(self) -> dict[str, Any]:
        """JSON-safe form for API responses and run events."""
        return self.model_dump(mode="json")

    @classmethod
    def from_row(cls, row: dict[str, Any]) -> UndoRecord:
        """Rebuild a record from a repository row (already JSON-shaped)."""
        targets: list[AssetRef] = []
        for raw in row.get("targets") or []:
            if isinstance(raw, dict):
                targets.append(AssetRef.model_validate(raw))
        return cls(
            id=str(row.get("id") or ""),
            run_id=str(row.get("run_id") or ""),
            node_id=str(row.get("node_id") or ""),
            kind=UndoKind(str(row.get("kind"))),
            status=UndoStatus(str(row.get("status"))),
            targets=targets,
            backup_paths=[None if p is None else str(p) for p in (row.get("backup_paths") or [])],
            session_id=row.get("session_id"),
            app_steps=row.get("app_steps"),
            detail=str(row.get("detail") or ""),
        )


def plan_undo(records: list[UndoRecord]) -> list[UndoRecord]:
    """Order the records that still need undoing, newest action first.

    Pure: the caller supplies the run's records (the repository returns them
    oldest-first).  Terminal records — already undone, skipped or failed — are
    dropped so a repeated undo request is a no-op rather than a double rollback.
    """
    return [record for record in reversed(records) if record.status == UndoStatus.RECORDED]


# ── file-level compensation (the fallback that always exists) ─────────────────


def undo_directory(root: str | os.PathLike[str], *, run_id: str, node_id: str) -> Path:
    """Engine-private backup directory for one node of one run."""
    return Path(root) / "undo" / run_id / node_id


def backup_host_file(path: str | os.PathLike[str], *, backup_dir: str | os.PathLike[str], name: str | None = None) -> Path:
    """Copy *path* into *backup_dir* and return the copy's location (sync I/O).

    The copy is taken **before** the action runs, so a failure can restore the
    previous content.  The file's own name is preserved by default (a rollback
    looks for the same name it snapshotted).
    """
    source = Path(path)
    directory = Path(backup_dir)
    directory.mkdir(parents=True, exist_ok=True)
    target = directory / (name or source.name)
    shutil.copy2(source, target)
    return target


def restore_host_file(backup: str | os.PathLike[str], *, target: str | os.PathLike[str]) -> None:
    """Restore *backup* over *target* atomically (sync I/O).

    Same-directory staging + ``os.replace``, mirroring the N9 export writer: a
    crash mid-restore must not leave a half-written file where the user's
    original used to be.
    """
    source = Path(backup)
    destination = Path(target)
    destination.parent.mkdir(parents=True, exist_ok=True)
    temp_fd, temp_name = tempfile.mkstemp(prefix=".undo-", dir=str(destination.parent))
    temp_path = Path(temp_name)
    try:
        with os.fdopen(temp_fd, "wb") as handle:
            temp_fd = -1
            with source.open("rb") as original:
                shutil.copyfileobj(original, handle)
            handle.flush()
            os.fsync(handle.fileno())
        os.replace(temp_path, destination)
    finally:
        if temp_fd >= 0:
            os.close(temp_fd)
        try:
            temp_path.unlink()
        except FileNotFoundError:
            pass


__all__ = [
    "ALLOWED_UNDO_TRANSITIONS",
    "UndoKind",
    "UndoRecord",
    "UndoStatus",
    "backup_host_file",
    "plan_undo",
    "restore_host_file",
    "undo_directory",
    "validate_undo_transition",
]
