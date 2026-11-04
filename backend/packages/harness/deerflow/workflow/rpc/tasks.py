"""In-memory human-task rows for the headless engine.

The executors own the semantics: ``human:task`` and ``human:review`` create a row
and suspend the graph with LangGraph ``interrupt()``.  This module is only the
repository they were written against (``create`` / ``find_by_run_and_node``) plus
the engine's own submission path.

Rows are plain dicts on purpose: the executors accept either a mapping or an
object, and a durable repository (M2) can keep the same shape.
"""

from __future__ import annotations

import uuid
from datetime import UTC, datetime
from typing import Any

from deerflow.workflow.human_task_state import validate_human_task_submission

#: Row statuses this store produces.  ``reopened`` exists for parity with the
#: gateway repository, which can reopen a rejected review.
STATUS_PENDING = "pending"
STATUS_SUBMITTED = "submitted"
STATUS_SKIPPED = "skipped"

TERMINAL_STATUSES = frozenset({STATUS_SUBMITTED, STATUS_SKIPPED})


class TaskError(Exception):
    """A submission failure with a stable code."""

    def __init__(self, code: str, message: str, data: dict[str, Any] | None = None) -> None:
        super().__init__(message)
        self.code = code
        self.message = message
        self.data = data or {}


def _now() -> str:
    """ISO-8601 UTC timestamp."""
    return datetime.now(UTC).isoformat(timespec="milliseconds")


class MemoryTaskStore:
    """The ``human_task_repo`` the executors see, plus the engine's view."""

    def __init__(self) -> None:
        self._rows: list[dict[str, Any]] = []

    # ── executor-facing repository ─────────────────────────────────────────

    async def create(
        self,
        *,
        user_id: str,
        workflow_run_id: str,
        node_id: str,
        description: str = "",
        inputs_snapshot: dict[str, Any] | None = None,
        output_spec: dict[str, Any] | None = None,
        validation_rules: dict[str, Any] | None = None,
        checkpoint_ref: str | None = None,
        kind: str = "task",
    ) -> dict[str, Any]:
        """Create one pending row and return it."""
        row = {
            "id": f"task-{uuid.uuid4().hex[:12]}",
            "user_id": user_id,
            "workflow_run_id": workflow_run_id,
            "node_id": node_id,
            "kind": kind,
            "description": description,
            "inputs_snapshot": inputs_snapshot or {},
            "output_spec": output_spec or {"ports": []},
            "validation_rules": validation_rules or {},
            "checkpoint_ref": checkpoint_ref,
            "status": STATUS_PENDING,
            "revision": 1,
            "payload": None,
            "created_at": _now(),
            "updated_at": _now(),
            "submitted_at": None,
        }
        self._rows.append(row)
        return dict(row)

    async def find_by_run_and_node(self, *, run_id: str, node_id: str) -> dict[str, Any] | None:
        """Return the newest row for one run+node pair.

        LangGraph re-executes a human node from its head after a resume, so the
        executor relies on this lookup to reuse the resolved row.
        """
        for row in reversed(self._rows):
            if row["workflow_run_id"] == run_id and row["node_id"] == node_id:
                return dict(row)
        return None

    async def delete_pending_by_run(self, *, run_id: str) -> None:
        """Drop a run's pending rows (used when a run dies before it can resume)."""
        self._rows = [row for row in self._rows if not (row["workflow_run_id"] == run_id and row["status"] == STATUS_PENDING)]

    def discard_run(self, run_id: str) -> None:
        """Drop every row of one run (a cancelled run can never be resumed)."""
        self._rows = [row for row in self._rows if row["workflow_run_id"] != run_id]

    def dump(self) -> list[dict[str, Any]]:
        """Snapshot of every row, for persistence."""
        return [dict(row) for row in self._rows]

    def load(self, rows: list[dict[str, Any]]) -> None:
        """Replace the rows from a persisted snapshot."""
        self._rows = [dict(row) for row in rows if isinstance(row, dict) and isinstance(row.get("id"), str) and isinstance(row.get("workflow_run_id"), str)]

    # ── engine-facing view ─────────────────────────────────────────────────

    def pending(self, run_id: str) -> list[dict[str, Any]]:
        """Pending rows of one run, oldest first."""
        return [dict(row) for row in self._rows if row["workflow_run_id"] == run_id and row["status"] == STATUS_PENDING]

    def get(self, task_id: str) -> dict[str, Any] | None:
        """Look up one row by id."""
        for row in self._rows:
            if row["id"] == task_id:
                return dict(row)
        return None

    def submit(self, task_id: str, payload: dict[str, Any], *, revision: int | None = None) -> dict[str, Any]:
        """Record a submission, refusing a stale or duplicate one.

        Raises:
            TaskError: ``unknown-task``, ``task-not-pending`` (already submitted
                or skipped), ``task-revision-conflict``, or ``task-invalid``.
        """
        if not isinstance(payload, dict):
            raise TaskError("task-invalid", "payload must be an object", {"taskId": task_id})
        for row in self._rows:
            if row["id"] != task_id:
                continue
            if row["status"] != STATUS_PENDING:
                raise TaskError("task-not-pending", f"task {task_id} is already {row['status']}", {"taskId": task_id, "status": row["status"]})
            if revision is not None and revision != row["revision"]:
                raise TaskError("task-revision-conflict", f"task {task_id} is at revision {row['revision']}, not {revision}", {"taskId": task_id, "revision": row["revision"]})
            _validate_payload(row, payload)
            row["status"] = STATUS_SKIPPED if payload.get("__skip") is True else STATUS_SUBMITTED
            row["payload"] = payload
            row["revision"] += 1
            row["updated_at"] = _now()
            row["submitted_at"] = row["updated_at"]
            return dict(row)
        raise TaskError("unknown-task", f"no task named {task_id}", {"taskId": task_id})

    def reopen(self, task_id: str) -> dict[str, Any]:
        """Return a submitted row to pending (a rejected review's next visit)."""
        for row in self._rows:
            if row["id"] == task_id:
                row["status"] = STATUS_PENDING
                row["revision"] += 1
                row["updated_at"] = _now()
                return dict(row)
        raise TaskError("unknown-task", f"no task named {task_id}", {"taskId": task_id})

    def summaries(self, run_id: str | None = None) -> list[dict[str, Any]]:
        """Pending tasks as the wire shape (no internal snapshots)."""
        rows = [row for row in self._rows if row["status"] == STATUS_PENDING and (run_id is None or row["workflow_run_id"] == run_id)]
        return [_summary(row) for row in rows]


def _summary(row: dict[str, Any]) -> dict[str, Any]:
    """Strip a row down to what a client needs to render and submit."""
    return {
        "taskId": row["id"],
        "runId": row["workflow_run_id"],
        "nodeId": row["node_id"],
        "kind": row["kind"],
        "description": row["description"],
        "status": row["status"],
        "revision": row["revision"],
        "outputSpec": row["output_spec"],
        "inputs": row["inputs_snapshot"],
        "createdAt": row.get("created_at"),
        "updatedAt": row.get("updated_at"),
    }


def _validate_payload(row: dict[str, Any], payload: dict[str, Any]) -> None:
    """Check the payload against the task's derived output spec and rules.

    The catalog-driven checks live in ``human_task_state`` (shared with the
    gateway); this function adds the one guard a headless caller needs most: an
    unknown field must not silently produce an empty output.
    """
    if payload.get("__skip") is True:
        return
    ports = row.get("output_spec", {}).get("ports") or []
    declared = {port.get("name") for port in ports if isinstance(port, dict) and isinstance(port.get("name"), str)}
    unknown = sorted(key for key in payload if key != "__skip" and key not in declared)
    if unknown:
        raise TaskError("task-invalid", f"unknown field(s): {', '.join(unknown)}", {"taskId": row["id"], "fields": unknown})
    errors = validate_human_task_submission(payload, row.get("output_spec") or {"ports": []}, row.get("validation_rules") or {})
    if errors:
        raise TaskError("task-invalid", "; ".join(errors), {"taskId": row["id"], "errors": errors})


__all__ = ["MemoryTaskStore", "TaskError", "STATUS_PENDING", "STATUS_SKIPPED", "STATUS_SUBMITTED", "TERMINAL_STATUSES"]
