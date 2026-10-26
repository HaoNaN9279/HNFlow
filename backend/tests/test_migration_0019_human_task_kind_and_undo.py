"""Regression tests for migration ``0019_human_task_kind_and_undo`` (N10).

The migration is purely additive, so the interesting properties are:

1. the ``human_tasks.kind`` column exists and existing rows read back as
   ``"task"`` (the additive default — a pre-N10 row must never look like an
   approval),
2. the ``workflow_undo_records`` table + its run index exist,
3. the migration is idempotent (the empty-DB bootstrap path already ran
   ``create_all``, so ``upgrade head`` must not fail on existing objects),
4. ``downgrade`` removes both.

The DB is built at revision 0018 and upgraded through the real ``init_engine``
lifespan entry point, mirroring
``test_migration_0007_scheduled_run_active_dedupe``.
"""

from __future__ import annotations

import asyncio
import sqlite3
from pathlib import Path

import pytest
import sqlalchemy as sa

import deerflow.persistence.models  # noqa: F401  -- registers ORM models
from deerflow.persistence.base import Base
from deerflow.persistence.engine import close_engine, init_engine

#: ``human_tasks`` as it looked before this revision (no ``kind``).
_PRE_0019_HUMAN_TASKS = (
    "CREATE TABLE human_tasks ("
    "id VARCHAR(64) NOT NULL PRIMARY KEY, user_id VARCHAR(64) NOT NULL, workflow_run_id VARCHAR(64) NOT NULL, "
    "node_id VARCHAR(64) NOT NULL, status VARCHAR(32) NOT NULL, description VARCHAR(512) NOT NULL, "
    "inputs_snapshot JSON, output_spec JSON, validation_rules JSON, checkpoint_ref JSON, submission JSON, "
    "created_at DATETIME NOT NULL, updated_at DATETIME NOT NULL)"
)

_LEGACY_ROW = (
    "INSERT INTO human_tasks (id, user_id, workflow_run_id, node_id, status, description, inputs_snapshot, output_spec, validation_rules, checkpoint_ref, submission, created_at, updated_at) "
    "VALUES ('ht-legacy', 'default', 'run-legacy', 'ht', 'submitted', 'a pre-N10 human task', '{}', '{}', '{}', NULL, NULL, '2026-01-01 00:00:00', '2026-01-01 00:00:00')"
)


def _seed_pre_0019(db_path: Path) -> None:
    """Build the current schema, roll the N10 objects back, stamp at 0018."""
    db_path.parent.mkdir(parents=True, exist_ok=True)
    sync_engine = sa.create_engine(f"sqlite:///{db_path.as_posix()}")
    try:
        Base.metadata.create_all(sync_engine)
        with sync_engine.begin() as conn:
            conn.execute(sa.text("DROP TABLE IF EXISTS workflow_undo_records"))
            # SQLite cannot drop a column in place: rebuild human_tasks without it.
            conn.execute(sa.text("DROP TABLE IF EXISTS human_tasks"))
            conn.execute(sa.text(_PRE_0019_HUMAN_TASKS))
            conn.execute(sa.text(_LEGACY_ROW))
            conn.execute(sa.text("CREATE TABLE IF NOT EXISTS alembic_version (version_num VARCHAR(32) NOT NULL)"))
            conn.execute(sa.text("DELETE FROM alembic_version"))
            conn.execute(sa.text("INSERT INTO alembic_version (version_num) VALUES ('0018_scheduled_task_triggers')"))
    finally:
        sync_engine.dispose()


def _table_names(db_path: Path) -> set[str]:
    with sqlite3.connect(db_path) as raw:
        return {row[0] for row in raw.execute("SELECT name FROM sqlite_master WHERE type='table'")}


def _index_names(db_path: Path) -> set[str]:
    with sqlite3.connect(db_path) as raw:
        return {row[0] for row in raw.execute("SELECT name FROM sqlite_master WHERE type='index'")}


@pytest.mark.asyncio
async def test_migration_adds_kind_column_and_undo_table(tmp_path: Path) -> None:
    db_path = tmp_path / "pre0019.db"
    _seed_pre_0019(db_path)

    await init_engine(backend="sqlite", url=f"sqlite+aiosqlite:///{db_path.as_posix()}", sqlite_dir=str(tmp_path))
    try:
        assert "workflow_undo_records" in _table_names(db_path)
        assert "ix_workflow_undo_records_run_id" in _index_names(db_path)

        with sqlite3.connect(db_path) as raw:
            columns = {row[1] for row in raw.execute("PRAGMA table_info(human_tasks)").fetchall()}
            assert "kind" in columns
            assert raw.execute("SELECT version_num FROM alembic_version").fetchone()[0] == "0025_workflow_specifications"
            # 0022 intentionally clears old workflow content, including the
            # pre-0019 legacy row.
            assert raw.execute("SELECT COUNT(*) FROM human_tasks").fetchone()[0] == 0
            # An approval kind is accepted and distinguishable.
            raw.execute(
                "INSERT INTO human_tasks (id, user_id, workflow_run_id, node_id, status, kind, description, inputs_snapshot, output_spec, validation_rules, checkpoint_ref, created_at, updated_at) "
                "VALUES ('ht-approval', 'default', 'run-a', 'a1', 'pending', 'approval', 'x', '{}', '{}', '{}', NULL, '2026-01-01 00:00:00', '2026-01-01 00:00:00')"
            )
            raw.commit()
            kinds = dict(raw.execute("SELECT id, kind FROM human_tasks").fetchall())
        assert kinds == {"ht-approval": "approval"}
    finally:
        await close_engine()


@pytest.mark.asyncio
async def test_migration_is_idempotent_when_the_objects_already_exist(tmp_path: Path) -> None:
    """The empty-DB bootstrap path runs ``create_all`` before ``upgrade head``."""
    db_path = tmp_path / "already.db"
    db_path.parent.mkdir(parents=True, exist_ok=True)
    sync_engine = sa.create_engine(f"sqlite:///{db_path.as_posix()}")
    try:
        Base.metadata.create_all(sync_engine)  # already at head shape
        with sync_engine.begin() as conn:
            conn.execute(sa.text("CREATE TABLE IF NOT EXISTS alembic_version (version_num VARCHAR(32) NOT NULL)"))
            conn.execute(sa.text("DELETE FROM alembic_version"))
            conn.execute(sa.text("INSERT INTO alembic_version (version_num) VALUES ('0018_scheduled_task_triggers')"))
    finally:
        sync_engine.dispose()

    await init_engine(backend="sqlite", url=f"sqlite+aiosqlite:///{db_path.as_posix()}", sqlite_dir=str(tmp_path))
    try:
        assert "workflow_undo_records" in _table_names(db_path)
        with sqlite3.connect(db_path) as raw:
            assert raw.execute("SELECT version_num FROM alembic_version").fetchone()[0] == "0025_workflow_specifications"
    finally:
        await close_engine()


def _downgrade(db_path: Path, target: str) -> None:
    """Run alembic's sync downgrade — off the event loop, since ``env.py`` runs
    ``asyncio.run`` itself and cannot do so from inside a running loop."""
    from alembic import command
    from alembic.config import Config as AlembicConfig

    migrations_dir = Path(__file__).resolve().parents[1] / "packages" / "harness" / "deerflow" / "persistence" / "migrations"
    config = AlembicConfig()
    config.set_main_option("script_location", str(migrations_dir))
    config.set_main_option("sqlalchemy.url", f"sqlite+aiosqlite:///{db_path.as_posix()}")
    command.downgrade(config, target)


@pytest.mark.asyncio
async def test_migration_downgrade_removes_the_n10_objects(tmp_path: Path) -> None:
    db_path = tmp_path / "downgrade.db"
    _seed_pre_0019(db_path)
    await init_engine(backend="sqlite", url=f"sqlite+aiosqlite:///{db_path.as_posix()}", sqlite_dir=str(tmp_path))
    await close_engine()

    await asyncio.to_thread(_downgrade, db_path, "0018_scheduled_task_triggers")

    assert "workflow_undo_records" not in _table_names(db_path)
    with sqlite3.connect(db_path) as raw:
        columns = {row[1] for row in raw.execute("PRAGMA table_info(human_tasks)")}
    assert "kind" not in columns
