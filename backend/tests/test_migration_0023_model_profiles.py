"""Migration 0023 creates the model-profile middle layer."""

from __future__ import annotations

import sqlite3
from pathlib import Path

import pytest
import sqlalchemy as sa

import deerflow.persistence.models  # noqa: F401 - registers ORM models
from deerflow.persistence.base import Base
from deerflow.persistence.engine import close_engine, init_engine


@pytest.mark.asyncio
async def test_model_profile_table_is_created_and_idempotent(tmp_path: Path) -> None:
    db_path = tmp_path / "profiles.db"
    sync_engine = sa.create_engine(f"sqlite:///{db_path.as_posix()}")
    try:
        Base.metadata.create_all(sync_engine)
        with sync_engine.begin() as conn:
            # Simulate a database that reached 0022 before this revision existed.
            conn.execute(sa.text("DROP TABLE model_profiles"))
            conn.execute(sa.text("CREATE TABLE IF NOT EXISTS alembic_version (version_num VARCHAR(32) NOT NULL)"))
            conn.execute(sa.text("DELETE FROM alembic_version"))
            conn.execute(sa.text("INSERT INTO alembic_version (version_num) VALUES ('0022_workflow_folders')"))
    finally:
        sync_engine.dispose()

    await init_engine(
        backend="sqlite",
        url=f"sqlite+aiosqlite:///{db_path.as_posix()}",
        sqlite_dir=str(tmp_path),
    )
    try:
        with sqlite3.connect(db_path) as raw:
            tables = {row[0] for row in raw.execute("SELECT name FROM sqlite_master WHERE type='table'")}
            columns = {row[1] for row in raw.execute("PRAGMA table_info(model_profiles)")}
            version = raw.execute("SELECT version_num FROM alembic_version").fetchone()[0]
            indexes = {row[1] for row in raw.execute("PRAGMA index_list(model_profiles)")}
            table_sql = raw.execute("SELECT sql FROM sqlite_master WHERE type='table' AND name='model_profiles'").fetchone()[0]
        assert "model_profiles" in tables
        assert {"id", "user_id", "name", "display_name", "description", "target_model", "enabled", "created_at", "updated_at"} <= columns
        assert version == "0023_model_profiles"
        assert "ix_model_profiles_user_id" in indexes
        assert "uq_model_profiles_user_name" in table_sql
    finally:
        await close_engine()
