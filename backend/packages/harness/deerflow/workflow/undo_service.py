"""Execute a run's undo plan (N10, dev plan §21).

A finished run's recorded irreversible actions can be replayed backwards.
:mod:`deerflow.workflow.compensation` handles the *failure-time* case (the node
that is failing rolls back what it did); this module handles the *later* case —
a human decides, after the run, that it should be undone.

Order is reverse chronological (see :func:`deerflow.workflow.undo.plan_undo`):
the last thing the run did is undone first, which is the only order that is
correct when one action's target was produced by an earlier one.

Two compensation kinds, mirroring :class:`~deerflow.workflow.undo.UndoKind`:

- ``file_backup`` — the engine snapshotted the touched paths, so restoring is a
  copy back (host) or an ``update_file`` (sandbox), and a path that did not exist
  before is removed.  ``backup_paths`` is aligned 1:1 with ``targets`` so each
  backup restores the file it was taken from; a ``None`` entry means "did not
  exist".
- ``app_undo`` — the application's own undo/history is asked to step back.  An
  instance that is no longer running cannot be undone, which is reported as
  ``skipped`` instead of pretending otherwise.

A record that cannot be compensated is marked ``failed`` (terminal) with the
reason in its detail, so a repeated undo request does not retry it forever and
the caller sees exactly which step did not come back.
"""

from __future__ import annotations

import asyncio
import logging
from collections.abc import Callable
from dataclasses import dataclass
from pathlib import Path
from typing import Any

from deerflow.workflow.undo import UndoRecord, UndoStatus, plan_undo, restore_host_file

logger = logging.getLogger(__name__)


@dataclass
class UndoOutcome:
    """What happened to one record during a run-level undo."""

    record_id: str
    node_id: str
    kind: str
    status: str  # "undone" | "skipped" | "failed"
    detail: str = ""

    def to_port(self) -> dict[str, Any]:
        return {"record_id": self.record_id, "node_id": self.node_id, "kind": self.kind, "status": self.status, "detail": self.detail}


def plan_run_undo(rows: list[dict[str, Any]]) -> list[UndoRecord]:
    """Parse repository rows and return the records still worth undoing, newest first."""
    return plan_undo([UndoRecord.from_row(row) for row in rows])


async def execute_run_undo(
    records: list[UndoRecord],
    *,
    repo: Any,
    user_id: str,
    sandbox_factory: Callable[[], Any] | None = None,
    session_manager: Any | None = None,
    dry_run: bool = False,
) -> list[UndoOutcome]:
    """Undo *records* in order; return one outcome per record.

    ``dry_run`` reports what *would* happen without touching anything — the plan
    is useful on its own ("this will restore 3 host files").
    """
    outcomes: list[UndoOutcome] = []
    sandbox: Any | None = None
    sandbox_tried = False

    for record in records:
        if record.kind.value == "app_undo":
            outcome = await _undo_app_record(record, session_manager=session_manager, dry_run=dry_run)
        else:
            if sandbox is None and not sandbox_tried and sandbox_factory is not None and _needs_sandbox(record):
                sandbox_tried = True
                sandbox = await _acquire_sandbox(sandbox_factory)
            outcome = await _undo_file_record(record, sandbox=sandbox, dry_run=dry_run)

        if not dry_run:
            await _mark(repo, record, outcome, user_id=user_id)
        outcomes.append(outcome)
    return outcomes


def _needs_sandbox(record: UndoRecord) -> bool:
    return any(ref.scope != "host" for ref in record.targets)


async def _acquire_sandbox(sandbox_factory: Callable[[], Any]) -> Any | None:
    try:
        return await asyncio.to_thread(sandbox_factory)
    except Exception:  # noqa: BLE001 — without a sandbox the host files are still restorable
        logger.warning("run-level undo could not acquire a sandbox; sandbox targets will be reported as failed", exc_info=True)
        return None


async def _undo_file_record(record: UndoRecord, *, sandbox: Any, dry_run: bool) -> UndoOutcome:
    if not record.targets:
        return UndoOutcome(record_id=record.id, node_id=record.node_id, kind=record.kind.value, status="skipped", detail="no file targets were recorded")

    notes: list[str] = []
    restored = 0
    for index, ref in enumerate(record.targets):
        backup = record.backup_paths[index] if index < len(record.backup_paths) else None
        if dry_run:
            restored += 1
            continue
        note = await asyncio.to_thread(_restore_one, ref, backup, sandbox)
        if note:
            notes.append(note)
        else:
            restored += 1

    if notes:
        return UndoOutcome(record_id=record.id, node_id=record.node_id, kind=record.kind.value, status="failed", detail="; ".join(notes))
    return UndoOutcome(record_id=record.id, node_id=record.node_id, kind=record.kind.value, status="undone", detail=f"restored {restored} file(s)")


def _restore_one(ref: Any, backup: str | None, sandbox: Any) -> str | None:
    """Restore one target; return an error note, or ``None`` on success."""
    try:
        if ref.scope == "host":
            if backup is None:
                Path(ref.path).unlink(missing_ok=True)
                return None
            restore_host_file(backup, target=ref.path)
            return None
        if sandbox is None:
            return f"{ref.path}: no sandbox available to restore it"
        if backup is None:
            output = sandbox.execute_command(f'rm -f "{ref.path}"', None, None)
            if output and "rror" in str(output):
                return f"{ref.path}: created sandbox file may remain ({str(output).strip()[:160]})"
            return None
        sandbox.update_file(ref.path, Path(backup).read_bytes())
        return None
    except Exception as exc:  # noqa: BLE001 — one failed target must not stop the rest
        return f"{ref.path}: restore failed ({exc})"


async def _undo_app_record(record: UndoRecord, *, session_manager: Any | None, dry_run: bool) -> UndoOutcome:
    if dry_run:
        return UndoOutcome(record_id=record.id, node_id=record.node_id, kind=record.kind.value, status="undone", detail="would undo in-app steps")
    if session_manager is None:
        return UndoOutcome(record_id=record.id, node_id=record.node_id, kind=record.kind.value, status="failed", detail="no application session manager available")
    session = session_manager.get(record.session_id) if record.session_id else None
    if session is None:
        # The instance is gone; there is no in-app state left to step back.
        return UndoOutcome(record_id=record.id, node_id=record.node_id, kind=record.kind.value, status="skipped", detail="the application instance is no longer running")
    try:
        outcome = await asyncio.to_thread(session_manager.undo, session, steps=record.app_steps or 1)
    except Exception as exc:  # noqa: BLE001 — compensation failure is reported, not raised
        return UndoOutcome(record_id=record.id, node_id=record.node_id, kind=record.kind.value, status="failed", detail=f"application undo failed: {exc}")
    if outcome.status != "undone":
        return UndoOutcome(record_id=record.id, node_id=record.node_id, kind=record.kind.value, status="failed", detail=outcome.detail or outcome.status)
    return UndoOutcome(record_id=record.id, node_id=record.node_id, kind=record.kind.value, status="undone", detail=f"application undid {outcome.steps} step(s)")


async def _mark(repo: Any, record: UndoRecord, outcome: UndoOutcome, *, user_id: str) -> None:
    """Persist the terminal status of one record (best-effort)."""
    if repo is None:
        return
    to_status = UndoStatus.UNDONE.value if outcome.status == "undone" else (UndoStatus.SKIPPED.value if outcome.status == "skipped" else UndoStatus.FAILED.value)
    try:
        await repo.mark(record.id, user_id=user_id, to_status=to_status, detail=outcome.detail or None)
    except Exception:  # noqa: BLE001 — reporting must not fail the request
        logger.warning("could not persist undo status for record %s", record.id, exc_info=True)


__all__ = ["UndoOutcome", "execute_run_undo", "plan_run_undo"]
