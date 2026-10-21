"""Migrate saved workflow definitions to the current AI-node contract.

Run from ``backend/``:

    PYTHONPATH=. python scripts/migrate_workflow_ai_contract.py --dry-run
    PYTHONPATH=. python scripts/migrate_workflow_ai_contract.py --apply --user-id default

The migration is conservative and reports multi-inbound ports rather than
guessing which edge to keep.
"""

from __future__ import annotations

import argparse
import asyncio
import json
from collections.abc import Sequence
from typing import Any

from deerflow.config import get_app_config
from deerflow.persistence.engine import close_engine, get_session_factory, init_engine_from_config
from deerflow.persistence.workflow_definitions import WorkflowDefinitionRepository
from deerflow.runtime.user_context import DEFAULT_USER_ID
from deerflow.workflow.ai_contract_migration import migrate_definition


def _parse_args(argv: Sequence[str] | None = None) -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--user-id", action="append", dest="user_ids", help="user id to migrate (repeatable; default: 'default')")
    parser.add_argument("--dry-run", action="store_true", help="explicit dry-run (the default; kept for scripts)")
    parser.add_argument("--apply", action="store_true", help="persist changes; default is dry-run")
    parser.add_argument("--json", action="store_true", help="print a machine-readable report")
    return parser.parse_args(argv)


async def _run(args: argparse.Namespace) -> int:
    app_config = get_app_config()
    await init_engine_from_config(app_config.database)
    session_factory = get_session_factory()
    if session_factory is None:
        raise RuntimeError("database is not available (configure database.backend first)")
    repo = WorkflowDefinitionRepository(session_factory)
    user_ids = args.user_ids or [DEFAULT_USER_ID]
    report: list[dict[str, Any]] = []
    failed = False
    try:
        for user_id in user_ids:
            for row in await repo.list_by_user(user_id):
                result = migrate_definition(row["definition"])
                entry = {
                    "definition_id": row["id"],
                    "user_id": user_id,
                    "changed": result.changed,
                    "notes": result.notes,
                    "conflicts": result.conflicts,
                }
                report.append(entry)
                if result.conflicts:
                    failed = True
                if args.apply and result.changed and not result.conflicts:
                    await repo.update(row["id"], user_id=user_id, updates={"definition": result.definition})
    finally:
        await close_engine()

    if args.json:
        print(json.dumps(report, ensure_ascii=False, indent=2))
    else:
        for entry in report:
            state = "CHANGED" if entry["changed"] else "unchanged"
            print(f"{entry['definition_id']} ({entry['user_id']}): {state}")
            for note in entry["notes"]:
                print(f"  - {note}")
            for conflict in entry["conflicts"]:
                print(f"  ! {conflict}")
        if not args.apply:
            print("dry-run: no rows were written")
    return 1 if failed else 0


def main(argv: Sequence[str] | None = None) -> int:
    return asyncio.run(_run(_parse_args(argv)))


if __name__ == "__main__":
    raise SystemExit(main())
