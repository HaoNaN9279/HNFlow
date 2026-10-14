from __future__ import annotations

from datetime import UTC, datetime, timedelta

import pytest

from deerflow.scheduler.schedules import next_run_at
from deerflow.scheduler.triggers import (
    DueDecision,
    is_trigger_due,
    trigger_key_for,
    validate_schedule_spec,
)

NOW = datetime(2026, 10, 14, 12, 0, 0, tzinfo=UTC)


# ── next_run_at: condition-driven kinds have no future timestamp ─────────────


@pytest.mark.parametrize("schedule_type", ["file", "event", "idle"])
def test_next_run_at_returns_none_for_conditional_types(schedule_type: str) -> None:
    assert next_run_at(schedule_type, {"path": "/tmp", "app": "unity", "idle_seconds": 60}, "UTC", now=NOW) is None


# ── validate_schedule_spec ──────────────────────────────────────────────────


def test_validate_file_spec_normalizes_and_defaults_mode() -> None:
    spec = validate_schedule_spec("file", {"path": "  /data/out  ", "glob": " *.fbx "})
    assert spec == {"path": "/data/out", "glob": "*.fbx", "mode": "modified"}


def test_validate_file_spec_requires_path() -> None:
    with pytest.raises(ValueError, match="requires schedule_spec.path"):
        validate_schedule_spec("file", {"glob": "*.txt"})


def test_validate_file_spec_rejects_bad_mode() -> None:
    with pytest.raises(ValueError, match="mode must be one of"):
        validate_schedule_spec("file", {"path": "/data", "mode": "deleted"})


def test_validate_event_spec_defaults_to_any() -> None:
    assert validate_schedule_spec("event", {"app": " unity "}) == {"app": "unity", "event": "any"}


def test_validate_event_spec_rejects_unknown_event() -> None:
    with pytest.raises(ValueError, match="event must be one of"):
        validate_schedule_spec("event", {"app": "unity", "event": "exploded"})


def test_validate_idle_spec_requires_positive_int() -> None:
    with pytest.raises(ValueError, match="positive integer"):
        validate_schedule_spec("idle", {"idle_seconds": 0})
    with pytest.raises(ValueError, match="positive integer"):
        validate_schedule_spec("idle", {"idle_seconds": True})
    assert validate_schedule_spec("idle", {"idle_seconds": 30}) == {"idle_seconds": 30, "scope": "global"}


def test_validate_cron_spec_normalizes_expression() -> None:
    assert validate_schedule_spec("cron", {"cron": "  0   3 * * *  "}) == {"cron": "0 3 * * *"}


def test_validate_rejects_unsupported_schedule_type() -> None:
    with pytest.raises(ValueError, match="Unsupported schedule_type"):
        validate_schedule_spec("webhook", {})


# ── time-based due decision ─────────────────────────────────────────────────


def test_time_based_due_only_when_next_run_at_passed() -> None:
    assert is_trigger_due("cron", {}, now=NOW, next_run_at=NOW - timedelta(seconds=1), last_run_at=None).due
    assert is_trigger_due("cron", {}, now=NOW, next_run_at=NOW, last_run_at=None).due
    assert not is_trigger_due("cron", {}, now=NOW, next_run_at=NOW + timedelta(seconds=1), last_run_at=None).due
    assert not is_trigger_due("once", {}, now=NOW, next_run_at=None, last_run_at=None).due


def test_time_based_decision_never_carries_payload_or_key() -> None:
    decision = is_trigger_due("cron", {}, now=NOW, next_run_at=NOW, last_run_at=None)
    assert decision.trigger_key is None
    assert decision.payload == {}


# ── file ────────────────────────────────────────────────────────────────────


def _file_snapshot(*entries: tuple[str, datetime, bool]) -> dict:
    return {"files": [{"path": path, "mtime": mtime.isoformat(), "created": created} for path, mtime, created in entries]}


def test_file_modified_due_for_newer_mtime() -> None:
    snapshot = _file_snapshot(("/data/a.fbx", NOW - timedelta(minutes=1), False))
    decision = is_trigger_due("file", {"path": "/data"}, now=NOW, next_run_at=None, last_run_at=NOW - timedelta(hours=1), snapshot=snapshot)
    assert decision.due
    assert decision.trigger_key == f"/data/a.fbx:{(NOW - timedelta(minutes=1)).isoformat()}"
    assert decision.payload["path"] == "/data/a.fbx"
    assert decision.payload["count"] == 1


def test_file_modified_not_due_when_not_newer_than_last_run() -> None:
    snapshot = _file_snapshot(("/data/a.fbx", NOW - timedelta(hours=2), False))
    decision = is_trigger_due("file", {"path": "/data"}, now=NOW, next_run_at=None, last_run_at=NOW - timedelta(hours=1), snapshot=snapshot)
    assert not decision.due
    assert "no matching file change" in decision.reason


def test_file_modified_due_on_first_evaluation_without_last_run() -> None:
    snapshot = _file_snapshot(("/data/a.fbx", NOW - timedelta(days=1), False))
    assert is_trigger_due("file", {"path": "/data"}, now=NOW, next_run_at=None, last_run_at=None, snapshot=snapshot).due


def test_file_created_mode_ignores_preexisting_files() -> None:
    snapshot = _file_snapshot(("/data/old.fbx", NOW, False), ("/data/new.fbx", NOW - timedelta(seconds=5), True))
    decision = is_trigger_due("file", {"path": "/data", "mode": "created"}, now=NOW, next_run_at=None, last_run_at=None, snapshot=snapshot)
    assert decision.due
    assert decision.payload["path"] == "/data/new.fbx"


def test_file_picks_newest_matching_entry() -> None:
    snapshot = _file_snapshot(
        ("/data/a.fbx", NOW - timedelta(minutes=30), False),
        ("/data/b.fbx", NOW - timedelta(minutes=5), False),
        ("/data/c.fbx", NOW - timedelta(hours=3), False),
    )
    decision = is_trigger_due("file", {"path": "/data"}, now=NOW, next_run_at=None, last_run_at=None, snapshot=snapshot)
    assert decision.payload["path"] == "/data/b.fbx"


def test_file_without_snapshot_is_not_due() -> None:
    assert not is_trigger_due("file", {"path": "/data"}, now=NOW, next_run_at=None, last_run_at=None).due


# ── event ───────────────────────────────────────────────────────────────────


def test_event_due_on_matching_terminal_transition() -> None:
    snapshot = {"events": [{"app": "unity", "session_id": "s-1", "status": "crashed", "updated_at": NOW.isoformat()}]}
    decision = is_trigger_due("event", {"app": "unity", "event": "failed"}, now=NOW, next_run_at=None, last_run_at=None, snapshot=snapshot)
    assert decision.due
    assert decision.trigger_key == "s-1:crashed"
    assert decision.payload == {"app": "unity", "session_id": "s-1", "status": "crashed", "updated_at": NOW.isoformat()}


def test_event_completed_kind_does_not_match_crash() -> None:
    snapshot = {"events": [{"app": "unity", "session_id": "s-1", "status": "crashed"}]}
    decision = is_trigger_due("event", {"app": "unity", "event": "completed"}, now=NOW, next_run_at=None, last_run_at=None, snapshot=snapshot)
    assert not decision.due


def test_event_any_kind_matches_both_terminal_statuses() -> None:
    for status in ("stopped", "crashed"):
        snapshot = {"events": [{"app": "blender", "session_id": "s", "status": status}]}
        assert is_trigger_due("event", {"app": "blender"}, now=NOW, next_run_at=None, last_run_at=None, snapshot=snapshot).due


def test_event_ignores_other_apps_and_non_terminal_statuses() -> None:
    snapshot = {
        "events": [
            {"app": "blender", "session_id": "s-1", "status": "stopped"},
            {"app": "unity", "session_id": "s-2", "status": "ready"},
        ]
    }
    assert not is_trigger_due("event", {"app": "unity"}, now=NOW, next_run_at=None, last_run_at=None, snapshot=snapshot).due


# ── idle ────────────────────────────────────────────────────────────────────


def test_idle_due_after_window_without_activity() -> None:
    snapshot = {"last_activity_at": (NOW - timedelta(minutes=5)).isoformat(), "active_runs": 0}
    decision = is_trigger_due("idle", {"idle_seconds": 60}, now=NOW, next_run_at=None, last_run_at=None, snapshot=snapshot)
    assert decision.due
    assert decision.payload["idle_seconds"] == 60
    assert decision.trigger_key == f"global:{int((NOW - timedelta(minutes=5)).timestamp()) // 60}"


def test_idle_not_due_while_busy() -> None:
    snapshot = {"last_activity_at": (NOW - timedelta(hours=1)).isoformat(), "active_runs": 1}
    decision = is_trigger_due("idle", {"idle_seconds": 60}, now=NOW, next_run_at=None, last_run_at=None, snapshot=snapshot)
    assert not decision.due
    assert decision.reason == "system is busy"


def test_idle_not_due_before_window_elapses() -> None:
    snapshot = {"last_activity_at": (NOW - timedelta(seconds=10)).isoformat(), "active_runs": 0}
    assert not is_trigger_due("idle", {"idle_seconds": 60}, now=NOW, next_run_at=None, last_run_at=None, snapshot=snapshot).due


def test_idle_restarts_window_from_last_run() -> None:
    """A fired idle trigger must not retrigger on the same idle window."""
    snapshot = {"last_activity_at": (NOW - timedelta(hours=2)).isoformat(), "active_runs": 0}
    decision = is_trigger_due("idle", {"idle_seconds": 60}, now=NOW, next_run_at=None, last_run_at=NOW - timedelta(seconds=5), snapshot=snapshot)
    assert not decision.due


def test_idle_with_no_recorded_activity_is_due() -> None:
    assert is_trigger_due("idle", {"idle_seconds": 60}, now=NOW, next_run_at=None, last_run_at=None, snapshot={"active_runs": 0}).due


# ── trigger_key_for ─────────────────────────────────────────────────────────


def test_trigger_key_for_reassembles_conditional_keys() -> None:
    assert trigger_key_for("file", {"path": "/a", "mtime": NOW.isoformat()}) == f"/a:{NOW.isoformat()}"
    assert trigger_key_for("event", {"session_id": "s", "status": "stopped"}) == "s:stopped"
    assert trigger_key_for("idle", {"scope": "global", "since": NOW.isoformat(), "idle_seconds": 60}) == f"global:{int(NOW.timestamp()) // 60}"


def test_trigger_key_for_time_based_or_incomplete_payload_is_none() -> None:
    assert trigger_key_for("cron", {"anything": 1}) is None
    assert trigger_key_for("file", {}) is None
    assert trigger_key_for("event", {"session_id": "s"}) is None
    assert trigger_key_for("idle", {"scope": "global", "since": "not-a-date", "idle_seconds": 60}) is None


def test_due_decision_defaults_are_immutable_safe() -> None:
    first = DueDecision(due=False)
    second = DueDecision(due=False)
    assert first.payload == second.payload
    assert first.payload is not second.payload
