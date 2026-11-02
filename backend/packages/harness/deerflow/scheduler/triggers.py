"""Condition-driven trigger evaluation for the scheduled-task stack.

``once``/``cron`` fire at a persisted timestamp (``schedules.next_run_at``);
``file``/``event``/``idle`` have no future timestamp and are evaluated against
a runtime *snapshot* on every poll. This module is the pure half of that
evaluation: it owns spec validation, the due decision, the dedupe key, and the
trigger payload. The impure half — reading the filesystem, the ``app_instances``
table, and active runs — lives in the app layer (``app/scheduler/probe.py``)
because the harness cannot depend on app repositories.

Keeping the decision pure means the trigger semantics are unit-testable without
a database or a filesystem, and the same rules apply whether the poller or a
manual ``POST /trigger`` is the caller.
"""

from __future__ import annotations

from collections.abc import Mapping
from dataclasses import dataclass, field
from datetime import UTC, datetime
from typing import Any

from deerflow.scheduler.schedules import (
    CONDITIONAL_SCHEDULE_TYPES,
    SUPPORTED_SCHEDULE_TYPES,
    TIME_BASED_SCHEDULE_TYPES,
    normalize_cron_expression,
)

FILE_MODES: frozenset[str] = frozenset({"modified", "created"})
APP_EVENT_KINDS: frozenset[str] = frozenset({"completed", "failed", "any"})

# Application-event spec kind -> the ``app_instances`` terminal statuses it
# matches. ``stopped`` is a clean completion; ``crashed`` is a failure.
_EVENT_KIND_STATUSES: dict[str, frozenset[str]] = {
    "completed": frozenset({"stopped"}),
    "failed": frozenset({"crashed"}),
    "any": frozenset({"stopped", "crashed"}),
}


@dataclass(frozen=True)
class DueDecision:
    """Outcome of evaluating one condition-driven trigger.

    ``due`` is False with a non-empty ``reason`` for a snapshot that does not
    satisfy the condition (the reason is for logs/tests, never persisted).
    """

    due: bool
    trigger_key: str | None = None
    payload: dict[str, Any] = field(default_factory=dict)
    reason: str = ""


def _coerce_datetime(value: Any) -> datetime | None:
    if isinstance(value, datetime):
        dt = value
    elif isinstance(value, str):
        try:
            dt = datetime.fromisoformat(value)
        except ValueError:
            return None
    else:
        return None
    if dt.tzinfo is None:
        dt = dt.replace(tzinfo=UTC)
    return dt.astimezone(UTC)


def _iso(value: datetime) -> str:
    return value.astimezone(UTC).isoformat()


def validate_schedule_spec(schedule_type: str, schedule_spec: Mapping[str, Any] | None) -> dict[str, Any]:
    """Validate + normalize a schedule spec, raising ``ValueError`` on defects.

    Structural validation only: for ``once``/``cron`` the *time* computation
    stays in ``schedules.next_run_at`` (which also validates ``run_at``).
    """
    if schedule_type not in SUPPORTED_SCHEDULE_TYPES:
        raise ValueError(f"Unsupported schedule_type: {schedule_type}")
    spec = dict(schedule_spec or {})

    if schedule_type in TIME_BASED_SCHEDULE_TYPES:
        if schedule_type == "cron":
            cron = spec.get("cron")
            if not isinstance(cron, str):
                raise ValueError("cron schedule requires schedule_spec.cron")
            spec["cron"] = normalize_cron_expression(cron)
        return spec

    if schedule_type == "file":
        path = spec.get("path")
        if not isinstance(path, str) or not path.strip():
            raise ValueError("file schedule requires schedule_spec.path")
        glob = spec.get("glob")
        if glob is not None and (not isinstance(glob, str) or not glob.strip()):
            raise ValueError("file schedule schedule_spec.glob must be a non-empty string when set")
        mode = spec.get("mode", "modified")
        if mode not in FILE_MODES:
            raise ValueError(f"file schedule mode must be one of {sorted(FILE_MODES)}")
        spec["path"] = path.strip()
        spec["mode"] = mode
        if glob is not None:
            spec["glob"] = glob.strip()
        return spec

    if schedule_type == "event":
        app = spec.get("app")
        if not isinstance(app, str) or not app.strip():
            raise ValueError("event schedule requires schedule_spec.app")
        event = spec.get("event", "any")
        if event not in APP_EVENT_KINDS:
            raise ValueError(f"event schedule event must be one of {sorted(APP_EVENT_KINDS)}")
        spec["app"] = app.strip()
        spec["event"] = event
        return spec

    # idle
    idle_seconds = spec.get("idle_seconds")
    if not isinstance(idle_seconds, int) or isinstance(idle_seconds, bool) or idle_seconds < 1:
        raise ValueError("idle schedule requires a positive integer schedule_spec.idle_seconds")
    scope = spec.get("scope", "global")
    if not isinstance(scope, str) or not scope.strip():
        raise ValueError("idle schedule schedule_spec.scope must be a non-empty string when set")
    spec["idle_seconds"] = idle_seconds
    spec["scope"] = scope.strip()
    return spec


def is_trigger_due(
    schedule_type: str,
    schedule_spec: Mapping[str, Any] | None,
    *,
    now: datetime,
    next_run_at: datetime | None,
    last_run_at: datetime | None,
    snapshot: Mapping[str, Any] | None = None,
) -> DueDecision:
    """Decide whether a trigger fires now, and with what payload/dedupe key."""
    if schedule_type in TIME_BASED_SCHEDULE_TYPES:
        due_at = _coerce_datetime(next_run_at)
        due = due_at is not None and due_at <= now
        return DueDecision(due=due, reason="" if due else "not yet due")

    spec = validate_schedule_spec(schedule_type, schedule_spec)
    snap = snapshot or {}
    last = _coerce_datetime(last_run_at)

    if schedule_type == "file":
        return _due_file(spec, snap, last=last)
    if schedule_type == "event":
        return _due_event(spec, snap)
    return _due_idle(spec, snap, now=now, last=last)


def _due_file(spec: Mapping[str, Any], snapshot: Mapping[str, Any], *, last: datetime | None) -> DueDecision:
    mode = spec["mode"]
    files = snapshot.get("files")
    if not isinstance(files, list):
        return DueDecision(False, reason="file snapshot missing")
    newest_path: str | None = None
    newest_mtime: datetime | None = None
    matched = False
    for entry in files:
        if not isinstance(entry, Mapping):
            continue
        path = entry.get("path")
        mtime = _coerce_datetime(entry.get("mtime"))
        if not isinstance(path, str) or mtime is None:
            continue
        if mode == "created":
            if not entry.get("created"):
                continue
        elif last is not None and mtime <= last:
            continue
        matched = True
        if newest_mtime is None or mtime > newest_mtime:
            newest_path, newest_mtime = path, mtime
    if not matched or newest_path is None or newest_mtime is None:
        return DueDecision(False, reason=f"no matching file change ({mode})")
    iso = _iso(newest_mtime)
    return DueDecision(
        due=True,
        trigger_key=f"{newest_path}:{iso}",
        payload={"path": newest_path, "mtime": iso, "count": len(files)},
        reason="",
    )


def _due_event(spec: Mapping[str, Any], snapshot: Mapping[str, Any]) -> DueDecision:
    app = spec["app"]
    allowed = _EVENT_KIND_STATUSES[spec["event"]]
    events = snapshot.get("events")
    if not isinstance(events, list):
        return DueDecision(False, reason="event snapshot missing")
    for entry in events:
        if not isinstance(entry, Mapping):
            continue
        session_id = entry.get("session_id")
        status = entry.get("status")
        if not isinstance(session_id, str) or not isinstance(status, str):
            continue
        if str(entry.get("app") or "") != app or status not in allowed:
            continue
        payload: dict[str, Any] = {"app": app, "session_id": session_id, "status": status}
        updated_at = _coerce_datetime(entry.get("updated_at"))
        if updated_at is not None:
            payload["updated_at"] = _iso(updated_at)
        return DueDecision(due=True, trigger_key=f"{session_id}:{status}", payload=payload, reason="")
    return DueDecision(False, reason=f"no {spec['event']} event for app {app!r}")


def _due_idle(spec: Mapping[str, Any], snapshot: Mapping[str, Any], *, now: datetime, last: datetime | None) -> DueDecision:
    idle_seconds = spec["idle_seconds"]
    if int(snapshot.get("active_runs") or 0) > 0:
        return DueDecision(False, reason="system is busy")
    activity = _coerce_datetime(snapshot.get("last_activity_at"))
    # ``last_run_at`` participates so a fired idle trigger can't retrigger on
    # the same idle window: the window restarts when the run it launched ends.
    reference = max([value for value in (activity, last) if value is not None], default=None)
    if reference is None:
        reference = datetime(1970, 1, 1, tzinfo=UTC)
    elapsed = (now - reference).total_seconds()
    if elapsed < idle_seconds:
        return DueDecision(False, reason=f"idle {elapsed:.0f}s < {idle_seconds}s")
    bucket = int(reference.timestamp()) // idle_seconds
    return DueDecision(
        due=True,
        trigger_key=f"{spec['scope']}:{bucket}",
        payload={"idle_seconds": idle_seconds, "scope": spec["scope"], "since": _iso(reference)},
        reason="",
    )


def trigger_key_for(schedule_type: str, payload: Mapping[str, Any] | None) -> str | None:
    """Derive a dedupe key from a already-decided trigger payload.

    Time-based schedules have no natural occurrence identity (their
    ``next_run_at`` already advances after a dispatch), so they stay ``None``
    and are unaffected by the partial unique dedupe index.
    """
    if schedule_type not in CONDITIONAL_SCHEDULE_TYPES or not payload:
        return None
    if schedule_type == "file":
        path, mtime = payload.get("path"), payload.get("mtime")
        return f"{path}:{mtime}" if isinstance(path, str) and isinstance(mtime, str) else None
    if schedule_type == "event":
        session_id, status = payload.get("session_id"), payload.get("status")
        return f"{session_id}:{status}" if isinstance(session_id, str) and isinstance(status, str) else None
    scope, since = payload.get("scope"), payload.get("since")
    idle_seconds = payload.get("idle_seconds")
    if isinstance(scope, str) and isinstance(since, str) and isinstance(idle_seconds, int):
        parsed = _coerce_datetime(since)
        if parsed is not None:
            return f"{scope}:{int(parsed.timestamp()) // idle_seconds}"
    return None
