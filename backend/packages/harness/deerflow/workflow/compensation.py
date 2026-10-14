"""Failure-time rollback of a node's own side effects (N10, dev plan §21).

An irreversible node can ask for :func:`rollback_requested` support: before it
mutates anything it snapshots every file it is about to touch, and if the node
then fails it puts them back.  This is the "补偿动作" half of §21 — the approval
gate (``workflow/approval.py``) covers the "preview + confirm" half, and the
run-level ``POST …/undo`` route replays the same records later.

Boundaries, deliberately:

- **Compensation is best-effort after the fact, never a transaction.**  The node
  is the only thing that knows which of its writes succeeded; the snapshot
  covers the files the node declares up front, so a fresh failure path that
  writes somewhere new must declare that path too.
- **A backup failure aborts the node before it mutates anything** (the
  conservative default): running an irreversible action with a rollback promise
  that could not be prepared is worse than refusing to run.  The caller asks for
  rollback explicitly, so refusing is the honest answer.
- **Recording is best-effort** (mirroring the N6 instance records): a missing
  repository (memory backend) is a no-op and a failing write is logged and
  swallowed.  A successful mutation must never fail because its *bookkeeping*
  did.
- **Snapshots live outside ``assets.roots``**: ``{base_dir}/undo/<run_id>/<node_id>/``
  is engine-private recovery material, not a user asset, so an empty allow-list
  cannot disable rollback.
- Removing a file the node *created* is supported on the host directly; in the
  sandbox it goes through ``execute_command`` (the sandbox is the only writer),
  and a failure to remove is reported in the record's ``detail`` rather than
  hidden.
"""

from __future__ import annotations

import asyncio
import logging
import shutil
from pathlib import Path
from typing import Any

from pydantic import BaseModel, ConfigDict, Field

from deerflow.assets.ref import AssetRef
from deerflow.config.paths import get_paths
from deerflow.workflow.undo import UndoKind, UndoStatus, backup_host_file, restore_host_file, undo_directory

logger = logging.getLogger(__name__)

#: Runtime-context key holding the undo repository (injected by the run worker).
UNDO_REPO_CONTEXT_KEY = "workflow_undo_repo"


class CompensationUnavailable(RuntimeError):
    """Raised when a requested pre-execution backup cannot be taken."""


class FileSnapshot(BaseModel):
    """One file's pre-mutation state."""

    model_config = ConfigDict(extra="forbid")

    ref: AssetRef
    existed: bool = Field(description="Whether the file existed before the action (a created file is removed on rollback).")
    backup_path: str | None = Field(default=None, description="Engine-private copy, when the file existed.")


def rollback_requested(params: dict[str, Any]) -> bool:
    """Whether *params* ask the node to roll back its own side effects on failure."""
    return params.get("rollback_on_failure") is True


def backup_root() -> Path:
    """Engine-private root for undo snapshots."""
    return get_paths().base_dir / "undo"


class Compensation:
    """Snapshot / restore / record helper for one mutating node operation.

    Usage in an executor::

        comp = await Compensation.prepare(runtime, node_id=…, node_label=…, targets=[…], sandbox=sandbox, enabled=rollback_requested(params))
        try:
            …mutate…
        except Exception as exc:
            await comp.rollback(reason=str(exc))
            raise
        await comp.commit(detail=…)

    When rollback was not requested (``enabled=False``) every method is a no-op,
    so an executor never has to branch on the flag itself.
    """

    def __init__(
        self,
        *,
        runtime: Any,
        sandbox: Any,
        node_id: str,
        node_label: str,
        targets: list[AssetRef],
        snapshots: list[FileSnapshot],
        kind: UndoKind,
        enabled: bool,
    ) -> None:
        self._runtime = runtime
        self._sandbox_ref = sandbox
        self._node_id = node_id
        self._node_label = node_label
        self._targets = targets
        self._snapshots = snapshots
        self._kind = kind
        self._enabled = enabled

    @property
    def enabled(self) -> bool:
        return self._enabled

    @classmethod
    async def prepare(
        cls,
        runtime: Any,
        *,
        node_id: str,
        node_label: str,
        targets: list[AssetRef],
        sandbox: Any,
        kind: UndoKind = UndoKind.FILE_BACKUP,
        enabled: bool = True,
    ) -> Compensation:
        """Snapshot the targets when *enabled*; a no-op guard otherwise."""
        if not enabled:
            return cls(runtime=runtime, sandbox=sandbox, node_id=node_id, node_label=node_label, targets=targets, snapshots=[], kind=kind, enabled=False)
        context = getattr(runtime, "context", None) or {}
        snapshots = await snapshot_targets(targets, sandbox=sandbox, node_id=node_id, node_label=node_label, run_id=str(context.get("run_id") or ""))
        return cls(runtime=runtime, sandbox=sandbox, node_id=node_id, node_label=node_label, targets=targets, snapshots=snapshots, kind=kind, enabled=True)

    async def rollback(self, *, reason: str) -> list[str]:
        """Restore everything the action touched, then record the compensation."""
        if not self._enabled:
            return []
        notes = await compensate(self._snapshots, sandbox=self._sandbox_ref, node_label=self._node_label, reason=reason)
        detail = f"rolled back after failure: {reason}"
        if notes:
            detail = f"{detail} ({'; '.join(notes)})"
        await record_undo(
            self._runtime,
            node_id=self._node_id,
            kind=self._kind,
            targets=self._targets,
            backup_paths=[s.backup_path for s in self._snapshots if s.backup_path],
            detail=detail,
            status=UndoStatus.UNDONE if not notes else UndoStatus.FAILED,
        )
        cleanup_snapshots(self._snapshots)
        return notes

    async def commit(self, *, detail: str = "") -> None:
        """Record the action as still standing (and therefore undoable later)."""
        if not self._enabled:
            return
        await record_undo(
            self._runtime,
            node_id=self._node_id,
            kind=self._kind,
            targets=self._targets,
            backup_paths=[s.backup_path for s in self._snapshots if s.backup_path],
            detail=detail,
            status=UndoStatus.RECORDED,
        )


async def snapshot_targets(targets: list[AssetRef], *, sandbox: Any, node_id: str, node_label: str, run_id: str) -> list[FileSnapshot]:
    """Snapshot every target before the node mutates it.

    Raises :class:`CompensationUnavailable` when a target that exists cannot be
    backed up — the caller must abort rather than proceed with a rollback
    promise it cannot keep.
    """
    if not targets:
        return []
    return await asyncio.to_thread(_snapshot_targets_sync, targets, sandbox, node_id, node_label, run_id)


def _snapshot_targets_sync(targets: list[AssetRef], sandbox: Any, node_id: str, node_label: str, run_id: str) -> list[FileSnapshot]:
    directory = undo_directory(backup_root(), run_id=run_id or "unknown-run", node_id=node_id)
    snapshots: list[FileSnapshot] = []
    for ref in targets:
        if ref.scope == "host":
            source = Path(ref.path)
            if not source.exists():
                snapshots.append(FileSnapshot(ref=ref, existed=False))
                continue
            try:
                backup = backup_host_file(source, backup_dir=directory)
            except OSError as exc:
                raise CompensationUnavailable(f"{node_label}: cannot back up {ref.path!r} before running ({exc}); refusing to mutate it with rollback_on_failure enabled") from exc
            snapshots.append(FileSnapshot(ref=ref, existed=True, backup_path=str(backup)))
            continue

        # Sandbox scope: content is the only observable (the abstract Sandbox has
        # no stat), so a missing download means "did not exist".
        try:
            data = sandbox.download_file(ref.path)
        except OSError:
            snapshots.append(FileSnapshot(ref=ref, existed=False))
            continue
        try:
            directory.mkdir(parents=True, exist_ok=True)
            backup = directory / f"{ref.scope}-{Path(ref.path).name}"
            backup.write_bytes(data)
        except OSError as exc:
            raise CompensationUnavailable(f"{node_label}: cannot back up sandbox file {ref.path!r} before running ({exc}); refusing to mutate it with rollback_on_failure enabled") from exc
        snapshots.append(FileSnapshot(ref=ref, existed=True, backup_path=str(backup)))
    return snapshots


async def compensate(snapshots: list[FileSnapshot], *, sandbox: Any, node_label: str, reason: str) -> list[str]:
    """Restore the snapshots after a failure; return notes for anything that failed.

    Never raises: the caller is already handling the original error and must not
    lose it to a rollback problem.
    """
    if not snapshots:
        return []
    try:
        return await asyncio.to_thread(_restore_snapshots_sync, snapshots, sandbox, node_label)
    except Exception as exc:  # noqa: BLE001 — rollback failure must not mask the node error
        logger.warning("%s: rollback failed (%s)", node_label, reason, exc_info=True)
        return [f"rollback failed: {exc}"]


def _restore_snapshots_sync(snapshots: list[FileSnapshot], sandbox: Any, node_label: str) -> list[str]:
    notes: list[str] = []
    for snapshot in snapshots:
        ref = snapshot.ref
        try:
            if not snapshot.existed:
                notes.extend(_remove_created(ref, sandbox, node_label))
                continue
            if snapshot.backup_path is None:  # pragma: no cover — defensive
                notes.append(f"{ref.path}: no backup available")
                continue
            if ref.scope == "host":
                restore_host_file(snapshot.backup_path, target=ref.path)
            else:
                sandbox.update_file(ref.path, Path(snapshot.backup_path).read_bytes())
        except Exception as exc:  # noqa: BLE001 — one failed target must not stop the rest
            notes.append(f"{ref.path}: restore failed ({exc})")
    return notes


def _remove_created(ref: AssetRef, sandbox: Any, node_label: str) -> list[str]:
    """Remove a file the failed node created (nothing to restore)."""
    if ref.scope == "host":
        try:
            Path(ref.path).unlink()
        except FileNotFoundError:
            return []
        except OSError as exc:
            return [f"{ref.path}: created file could not be removed ({exc})"]
        return []
    # Sandbox: the sandbox itself is the only writer, so removal goes through a
    # command.  A shell that cannot run ``rm`` leaves the file behind — report it
    # rather than pretend the rollback was complete.
    try:
        output = sandbox.execute_command(f'rm -f "{ref.path}"', None, None)
    except Exception as exc:  # noqa: BLE001
        return [f"{ref.path}: created sandbox file may remain ({exc})"]
    if output and "rror" in str(output):
        return [f"{ref.path}: created sandbox file may remain ({str(output).strip()[:200]})"]
    return []


async def record_undo(
    runtime: Any,
    *,
    node_id: str,
    kind: UndoKind,
    targets: list[AssetRef] | None = None,
    backup_paths: list[str] | None = None,
    session_id: str | None = None,
    app_steps: int | None = None,
    detail: str = "",
    status: UndoStatus = UndoStatus.RECORDED,
) -> dict[str, Any] | None:
    """Write an undo record through the injected repository (best-effort)."""
    repo = _repo(runtime)
    if repo is None:
        return None
    context = getattr(runtime, "context", None) or {}
    try:
        return await repo.create(
            user_id=str(context.get("user_id") or ""),
            run_id=str(context.get("run_id") or ""),
            node_id=node_id,
            kind=kind.value,
            status=status.value,
            targets=[ref.to_port() for ref in (targets or [])],
            backup_paths=list(backup_paths or []),
            session_id=session_id,
            app_steps=app_steps,
            detail=detail[:512],
        )
    except Exception:  # noqa: BLE001 — bookkeeping must never fail a successful mutation
        logger.warning("workflow undo record for node %s could not be persisted", node_id, exc_info=True)
        return None


def _repo(runtime: Any) -> Any | None:
    context = getattr(runtime, "context", None)
    if not isinstance(context, dict):
        return None
    return context.get(UNDO_REPO_CONTEXT_KEY)


def cleanup_snapshots(snapshots: list[FileSnapshot]) -> None:
    """Remove an unneeded snapshot directory (a compensated action needs no copy).

    Best-effort: the files live under an engine-owned root, so a leftover copy is
    garbage rather than a leak of user data.
    """
    parents = {Path(s.backup_path).parent for s in snapshots if s.backup_path}
    for parent in parents:
        try:
            shutil.rmtree(parent, ignore_errors=True)
        except OSError:  # pragma: no cover — ignore_errors already covers this
            pass


__all__ = [
    "UNDO_REPO_CONTEXT_KEY",
    "Compensation",
    "CompensationUnavailable",
    "FileSnapshot",
    "backup_root",
    "cleanup_snapshots",
    "compensate",
    "record_undo",
    "rollback_requested",
    "snapshot_targets",
]
