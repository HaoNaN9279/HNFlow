"""CLI entry point: detect dependency cycles across stored workflow definitions.

Runs offline against the persistence layer.  It loads every workflow definition
for a user, aggregates workflow → workflow / workflow → skill / skill → skill
references, and reports each dependency cycle as one path per line (via
:func:`deerflow.workflow.dependency_graph.find_dependency_cycles`).

Exit codes:

- ``0`` — no cycles found (prints ``OK``)
- ``1`` — at least one cycle found
- ``2`` — engine/config/definition-loading failure (readable error on stderr)
"""

from __future__ import annotations

import argparse
import asyncio
import sys

from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from deerflow.config.app_config import get_app_config
from deerflow.persistence.engine import close_engine, get_session_factory, init_engine_from_config
from deerflow.persistence.workflow_definitions import WorkflowDefinitionRepository
from deerflow.skills.storage import get_or_new_skill_storage
from deerflow.skills.types import Skill
from deerflow.workflow.dependency_graph import find_dependency_cycles
from deerflow.workflow.schema import WorkflowDefinition

DEFAULT_USER_ID = "default"


async def _run_checks(
    session_factory: async_sessionmaker[AsyncSession],
    user_id: str,
    definition_filter: str | None = None,
) -> tuple[list[str], int]:
    """Load definitions + skills, detect cycles, apply the definition filter.

    Returns ``(cycles, exit_code)``.  Per-row validation failures and skill
    loading failures are non-fatal (warned on stderr) so a single malformed
    definition or an unavailable skill store cannot hide every other cycle.
    """
    repo = WorkflowDefinitionRepository(session_factory)

    rows = await repo.list_by_user(user_id)
    definitions: dict[str, WorkflowDefinition] = {}
    for row in rows:
        try:
            definitions[row["id"]] = WorkflowDefinition.model_validate(row["definition"])
        except Exception as exc:  # keep going on malformed rows
            print(f"check_cycles: warning: skipping definition {row.get('id')!r}: {exc}", file=sys.stderr)

    skills: list[Skill] = []
    try:
        storage = get_or_new_skill_storage()
        skills = storage.load_skills(enabled_only=False)
    except Exception as exc:  # skill loading is best-effort
        print(f"check_cycles: warning: failed to load skills: {exc}", file=sys.stderr)

    cycles = find_dependency_cycles(definitions, skills)

    if definition_filter is not None:
        needle = f"workflow:{definition_filter}"
        cycles = [cycle for cycle in cycles if needle in cycle]

    return cycles, 1 if cycles else 0


async def _async_main(user_id: str, definition_filter: str | None) -> int:
    """Initialise the engine, run the checks, and print the result to stdout."""
    config = get_app_config()
    try:
        await init_engine_from_config(config.database)
        session_factory = get_session_factory()
        if session_factory is None:
            # memory backend — no persisted definitions, so nothing to check.
            print("OK")
            return 0
        cycles, code = await _run_checks(session_factory, user_id, definition_filter)
        if code:
            for cycle in cycles:
                print(cycle)
        else:
            print("OK")
        return code
    finally:
        await close_engine()


def _build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        prog="check_cycles",
        description="Detect dependency cycles across stored workflow definitions.",
    )
    parser.add_argument(
        "--definition",
        metavar="ID",
        help="Only report cycles that contain workflow:<ID>.",
    )
    parser.add_argument(
        "--user",
        default=DEFAULT_USER_ID,
        help=f"Workflow definitions owner (default: {DEFAULT_USER_ID}).",
    )
    return parser


def main(argv: list[str] | None = None) -> int:
    """CLI entry point.  Returns the process exit code."""
    parser = _build_parser()
    args = parser.parse_args(argv)
    try:
        return asyncio.run(_async_main(args.user, args.definition))
    except Exception as exc:  # CLI boundary: report a readable error and exit 2
        print(f"check_cycles: error: {exc}", file=sys.stderr)
        return 2


if __name__ == "__main__":
    raise SystemExit(main())
