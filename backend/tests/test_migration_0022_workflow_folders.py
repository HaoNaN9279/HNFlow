"""Migration 0022 adds folders and intentionally clears old workflow content."""

from __future__ import annotations

import sqlite3
from datetime import UTC, datetime
from pathlib import Path

import pytest
import sqlalchemy as sa

import deerflow.persistence.models  # noqa: F401 - registers ORM models
from deerflow.persistence.base import Base
from deerflow.persistence.engine import close_engine, init_engine


@pytest.mark.asyncio
async def test_folder_schema_and_workflow_reset(tmp_path: Path) -> None:
    db_path = tmp_path / "folders.db"
    sync_engine = sa.create_engine(f"sqlite:///{db_path.as_posix()}")
    try:
        Base.metadata.create_all(sync_engine)
        now = datetime.now(UTC).isoformat()
        with sync_engine.begin() as conn:
            conn.execute(
                sa.text("INSERT INTO workflow_definitions (id, user_id, name, schema_version, definition, metadata, version, created_at, updated_at) VALUES (:id, 'default', 'Old workflow', 1, '{}', '{}', '0.1.0', :now, :now)"),
                {"id": "wf-old", "now": now},
            )
            conn.execute(sa.text("CREATE TABLE IF NOT EXISTS alembic_version (version_num VARCHAR(32) NOT NULL)"))
            conn.execute(sa.text("DELETE FROM alembic_version"))
            conn.execute(sa.text("INSERT INTO alembic_version (version_num) VALUES ('0021_workflow_workbenches')"))
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
            columns = {row[1] for row in raw.execute("PRAGMA table_info(workflow_definitions)")}
            version = raw.execute("SELECT version_num FROM alembic_version").fetchone()[0]
            remaining = raw.execute("SELECT COUNT(*) FROM workflow_definitions").fetchone()[0]
        assert "workflow_folders" in tables
        assert "folder_id" in columns
        assert version == "0024_workspace_resource_changes"
        assert remaining == 0
    finally:
        await close_engine()
