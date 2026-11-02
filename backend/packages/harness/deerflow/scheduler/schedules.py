from __future__ import annotations

from datetime import UTC, datetime
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError

from croniter import croniter

# ``once``/``cron`` are driven by a persisted ``next_run_at`` timestamp; the
# condition-driven kinds (file watch / application event / idle) have no
# future timestamp and are evaluated against a runtime snapshot on every poll
# (see ``triggers.py``). Keeping both kinds in one claim loop is what lets the
# existing lease/budget machinery apply to both.
TIME_BASED_SCHEDULE_TYPES: frozenset[str] = frozenset({"once", "cron"})
CONDITIONAL_SCHEDULE_TYPES: frozenset[str] = frozenset({"file", "event", "idle"})
SUPPORTED_SCHEDULE_TYPES: frozenset[str] = TIME_BASED_SCHEDULE_TYPES | CONDITIONAL_SCHEDULE_TYPES


def is_conditional_schedule_type(schedule_type: str) -> bool:
    return schedule_type in CONDITIONAL_SCHEDULE_TYPES


def validate_timezone(timezone_name: str) -> str:
    try:
        ZoneInfo(timezone_name)
    except ZoneInfoNotFoundError as exc:
        raise ValueError(f"Unknown timezone: {timezone_name}") from exc
    return timezone_name


def normalize_cron_expression(expr: str) -> str:
    parts = [part for part in expr.split() if part]
    if len(parts) != 5:
        raise ValueError("Cron expression must contain exactly 5 fields")
    return " ".join(parts)


def next_run_at(
    schedule_type: str,
    schedule_spec: dict[str, object],
    timezone_name: str,
    *,
    now: datetime,
) -> datetime | None:
    validate_timezone(timezone_name)
    if schedule_type in CONDITIONAL_SCHEDULE_TYPES:
        # No future timestamp exists for a condition-driven trigger; the poller
        # evaluates it against a snapshot instead. Returning ``None`` here keeps
        # this the single entry point for "when does this fire".
        return None
    if now.tzinfo is None:
        now = now.replace(tzinfo=UTC)

    if schedule_type == "once":
        run_at_raw = schedule_spec.get("run_at")
        if not isinstance(run_at_raw, str):
            raise ValueError("once schedule requires run_at")
        run_at = datetime.fromisoformat(run_at_raw)
        if run_at.tzinfo is None:
            # A naive run_at means "wall-clock time in the task's declared
            # timezone", matching how cron schedules interpret it.
            run_at = run_at.replace(tzinfo=ZoneInfo(timezone_name))
        # Normalize to UTC like the cron branch: next_run_at is persisted to
        # timezone-discarding columns (SQLite), where a non-UTC offset shifts
        # the effective fire time by the whole offset.
        run_at = run_at.astimezone(UTC)
        return run_at if run_at > now else None

    if schedule_type == "cron":
        cron_expr = normalize_cron_expression(str(schedule_spec.get("cron", "")))
        zone = ZoneInfo(timezone_name)
        local_now = now.astimezone(zone)
        next_local = croniter(cron_expr, local_now).get_next(datetime)
        if next_local.tzinfo is None:
            next_local = next_local.replace(tzinfo=zone)
        return next_local.astimezone(UTC)

    raise ValueError(f"Unsupported schedule_type: {schedule_type}")
