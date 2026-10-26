"""Tests for migration 0012_workflow_definitions — table create, idempotent, downgrade."""

from __future__ import annotations

import asyncio
import sqlite3
from pathlib import Path

import pytest
import sqlalchemy as sa

import deerflow.persistence.models  # noqa: F401 — registers ORM models
from deerflow.persistence.base import Base
from deerflow.persistence.engine import close_engine, init_engine

pytestmark = pytest.mark.asyncio


def _build_pre_0012_db(db_path: Path) -> None:
    """Build a SQLite DB stamped at revision 0011_mcp_tasks (one before 0012)."""
    db_path.parent.mkdir(parents=True, exist_ok=True)
    sync_engine = sa.create_engine(f"sqlite:///{db_path.as_posix()}")
    try:
        Base.metadata.create_all(sync_engine)
        with sync_engine.begin() as conn:
            # Drop the table + index that 0012 would create, so we land in the
            # pre-0012 state — the migration will create them fresh.
            conn.execute(sa.text("DROP TABLE IF EXISTS workflow_definitions"))
            # Stamp at 0011 so bootstrap takes the versioned branch and runs
            # ``alembic upgrade head`` (which executes 0012.upgrade()).
            conn.execute(sa.text("CREATE TABLE IF NOT EXISTS alembic_version (version_num VARCHAR(32) NOT NULL)"))
            conn.execute(sa.text("DELETE FROM alembic_version"))
            conn.execute(sa.text("INSERT INTO alembic_version (version_num) VALUES ('0011_mcp_tasks')"))
    finally:
        sync_engine.dispose()


def _table_exists(db_path: Path, table_name: str) -> bool:
    with sqlite3.connect(db_path) as raw:
        row = raw.execute(
            "SELECT 1 FROM sqlite_master WHERE type='table' AND name=?",
            (table_name,),
        ).fetchone()
    return row is not None


def _index_exists(db_path: Path, index_name: str) -> bool:
    with sqlite3.connect(db_path) as raw:
        row = raw.execute(
            "SELECT 1 FROM sqlite_master WHERE type='index' AND name=?",
            (index_name,),
        ).fetchone()
    return row is not None


def _run_alembic_downgrade(db_path: Path, target_revision: str) -> None:
    """Run alembic downgrade in a synchronous context.

    Called via ``loop.run_in_executor`` because alembic's ``env.py`` calls
    ``asyncio.run(run_migrations_online())`` which cannot be called from
    within an already-running event loop.
    """
    from alembic.command import downgrade
    from alembic.config import Config

    cfg = Config()
    cfg.set_main_option(
        "script_location",
        str(Path(__file__).resolve().parent.parent / "packages" / "harness" / "deerflow" / "persistence" / "migrations"),
    )
    # env.py uses create_async_engine, so the URL must use an async driver.
    cfg.set_main_option("sqlalchemy.url", f"sqlite+aiosqlite:///{db_path.as_posix()}")
    downgrade(cfg, target_revision)


async def test_upgrade_creates_table_and_index(tmp_path: Path) -> None:
    """Running init_engine on a pre-0012 DB creates the table + index."""
    db_path = tmp_path / "test.db"
    _build_pre_0012_db(db_path)

    url = f"sqlite+aiosqlite:///{db_path.as_posix()}"
    await init_engine(backend="sqlite", url=url, sqlite_dir=str(tmp_path))

    try:
        assert _table_exists(db_path, "workflow_definitions"), "Table should exist after upgrade"
        assert _index_exists(db_path, "ix_workflow_definitions_user_id"), "Index should exist after upgrade"

        with sqlite3.connect(db_path) as raw:
            version_row = raw.execute("SELECT version_num FROM alembic_version").fetchone()
        assert version_row[0] == "0025_workflow_specifications", f"Expected head 0023_model_profiles, got {version_row[0]}"
    finally:
        await close_engine()


async def test_upgrade_idempotent(tmp_path: Path) -> None:
    """Running init_engine twice on the same DB is safe — has_table guard prevents duplicates."""
    db_path = tmp_path / "test.db"
    _build_pre_0012_db(db_path)

    url = f"sqlite+aiosqlite:///{db_path.as_posix()}"

    # First upgrade
    await init_engine(backend="sqlite", url=url, sqlite_dir=str(tmp_path))
    await close_engine()

    assert _table_exists(db_path, "workflow_definitions")

    # Second upgrade — init_engine again on the same DB
    await init_engine(backend="sqlite", url=url, sqlite_dir=str(tmp_path))

    try:
        # Table + index still exist
        assert _table_exists(db_path, "workflow_definitions")
        assert _index_exists(db_path, "ix_workflow_definitions_user_id")
    finally:
        await close_engine()


async def test_downgrade_removes_table(tmp_path: Path) -> None:
    """After upgrade, running alembic downgrade removes the table and index."""
    db_path = tmp_path / "test.db"
    _build_pre_0012_db(db_path)

    url = f"sqlite+aiosqlite:///{db_path.as_posix()}"
    await init_engine(backend="sqlite", url=url, sqlite_dir=str(tmp_path))

    try:
        assert _table_exists(db_path, "workflow_definitions")

        # Run alembic downgrade in a thread executor so its internal
        # asyncio.run() does not conflict with pytest-asyncio's event loop.
        loop = asyncio.get_running_loop()
        await loop.run_in_executor(None, _run_alembic_downgrade, db_path, "0011_mcp_tasks")

        assert not _table_exists(db_path, "workflow_definitions"), "Table should be removed after downgrade"
        assert not _index_exists(db_path, "ix_workflow_definitions_user_id"), "Index should be removed after downgrade"

        with sqlite3.connect(db_path) as raw:
            version_row = raw.execute("SELECT version_num FROM alembic_version").fetchone()
        assert version_row[0] == "0011_mcp_tasks", f"Expected 0011_mcp_tasks, got {version_row[0]}"
    finally:
        await close_engine()
