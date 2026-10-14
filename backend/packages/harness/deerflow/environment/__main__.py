"""``python -m deerflow.environment`` — print the environment report (N11, §22).

The same answer ``GET /api/environment`` serves, in a form a setup script or CI
job can run before serving traffic::

    python -m deerflow.environment            # human-readable
    python -m deerflow.environment --json     # machine-readable
    python -m deerflow.environment --force    # re-probe, ignore the cache

Exit codes (deliberately distinct, so a caller can tell "not ready" from "the
check itself broke"):

- ``0`` — nothing *required* is broken.  ``unknown`` results and optional
  failures do not fail the check: a probe that cannot answer has not shown the
  machine to be unprepared.
- ``1`` — a required item is definitively missing or mismatched.
- ``2`` — the check could not run at all (bad configuration, unreadable paths).

The layout is written for humans by default: every line is a real path with a
sentence explaining what lives there, so this doubles as the §22 data-directory
documentation an operator can actually run.
"""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

from deerflow.environment.report import build_environment_report


def _database_dir(config: object) -> str | None:
    database = getattr(config, "database", None)
    if database is None or getattr(database, "backend", None) != "sqlite":
        return None
    try:
        return str(Path(database.sqlite_path).parent)
    except Exception:  # pragma: no cover - a bad DB path must not break the report
        return None


def _collect(*, force: bool) -> dict:
    """Build the report from the live configuration (imports config lazily)."""
    from deerflow.apps.registry import AppRegistry
    from deerflow.config.app_config import get_app_config
    from deerflow.config.paths import get_paths
    from deerflow.environment.requirements import validate_environment

    config = get_app_config()
    environment_config = config.apps.environment
    memory_enabled = bool(getattr(config.memory, "enabled", True))
    database_dir = _database_dir(config)
    paths = get_paths()

    try:
        skills = _load_skills(config)
    except Exception:  # a broken skill tree must not hide the data-directory report
        skills = []

    requirement_status = validate_environment(
        registry=AppRegistry.from_config(config.apps),
        skills=skills,
        enabled=environment_config.enabled,
        timeout=environment_config.probe_timeout_seconds,
        cache_seconds=environment_config.cache_seconds,
        force=force,
        require_on_load=environment_config.require_on_load,
    )
    return build_environment_report(
        enabled=environment_config.enabled,
        requirement_status=requirement_status,
        data_dir_statuses=paths.check_data_dirs(memory_enabled=memory_enabled, database_dir=database_dir),
        require_on_load=environment_config.require_on_load,
    ).to_dict()


def _load_skills(config: object) -> list:
    """Enabled-or-not skills for the default user (collection filters on enabled)."""
    from deerflow.runtime.user_context import DEFAULT_USER_ID
    from deerflow.skills.storage import get_or_new_user_skill_storage

    storage = get_or_new_user_skill_storage(DEFAULT_USER_ID, app_config=config)
    return storage.load_skills(enabled_only=False)


def _render(report: dict) -> str:
    lines: list[str] = []
    enabled = report.get("enabled", True)
    lines.append(f"environment: {'enabled' if enabled else 'disabled'}  overall: {report.get('overall')}")
    if report.get("require_on_load"):
        lines.append("require_on_load: true (a failed required item refuses Gateway startup)")

    lines.append("")
    lines.append("data directories:")
    for entry in report.get("data_dirs", []):
        mark = "ok  " if entry.get("ok") else "FAIL"
        required = "required" if entry.get("required") else "optional"
        state = "present" if entry.get("exists") else "missing"
        if entry.get("writable") is False:
            state = "not writable"
        lines.append(f"  [{mark}] {entry['name']} ({required}, {entry['scope']}): {state}")
        lines.append(f"          {entry['path']}")
        lines.append(f"          {entry['purpose']}")

    requirements = report.get("requirements") or {}
    sources = requirements.get("sources", []) if isinstance(requirements, dict) else []
    lines.append("")
    if not sources:
        lines.append("requirements: none declared")
    else:
        lines.append("requirements:")
        for source in sources:
            lines.append(f"  {source['source']} [{source['overall']}]")
            for result in source.get("results", []):
                optional = " (optional)" if result.get("optional") else ""
                expect = f" expect {result['expect']}" if result.get("expect") else ""
                observed = f" -> {result['observed']}" if result.get("observed") else ""
                lines.append(f"    [{result['outcome']}] {result['kind']} {result['name']}{expect}{optional}{observed}")
                if result.get("detail"):
                    lines.append(f"          {result['detail']}")

    problems = report.get("blocking_problems", [])
    if problems:
        lines.append("")
        lines.append("blocking problems:")
        for problem in problems:
            lines.append(f"  - {problem}")
    return "\n".join(lines)


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(prog="python -m deerflow.environment", description="Report the data-directory layout and declared environment requirements.")
    parser.add_argument("--json", action="store_true", help="Print the report as JSON instead of text.")
    parser.add_argument("--force", action="store_true", help="Re-probe instead of reusing the short-lived probe cache.")
    args = parser.parse_args(argv)

    try:
        report = _collect(force=args.force)
    except Exception as exc:  # noqa: BLE001 - the CLI must report, not traceback
        print(f"environment check could not run: {type(exc).__name__}: {exc}", file=sys.stderr)
        return 2

    if args.json:
        print(json.dumps(report, indent=2, ensure_ascii=False))
    else:
        print(_render(report))

    return 1 if report.get("overall") == "missing" else 0


if __name__ == "__main__":
    raise SystemExit(main())
