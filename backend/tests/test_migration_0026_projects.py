"""Migration 0026: file-backed project registry and old workbench cleanup."""

from __future__ import annotations

import sqlite3
from datetime import UTC, datetime
from pathlib import Path

import pytest
import sqlalchemy as sa

from deerflow.persistence import models as _models  # noqa: F401 - register ORM tables
from deerflow.persistence.base import Base
from deerflow.persistence.engine import close_engine, init_engine


@pytest.mark.asyncio
async def test_0026_removes_legacy_db_only_workbenches(tmp_path: Path) -> None:
    db_path = tmp_path / "legacy_workbenches.db"
    sync_engine = sa.create_engine(f"sqlite:///{db_path.as_posix()}")
    try:
        Base.metadata.create_all(sync_engine)
        now = datetime.now(UTC).isoformat()
        with sync_engine.begin() as conn:
            conn.execute(
                sa.text("INSERT INTO workflow_workbenches (id, user_id, project_id, name, description, layout, settings, revision, created_at, updated_at) VALUES ('wb-old', 'default', NULL, 'Old', '', '{}', '{}', 1, :now, :now)"),
                {"now": now},
            )
            conn.execute(
                sa.text("INSERT INTO workflow_workbench_members (id, workbench_id, definition_id, order_index, settings, created_at) VALUES ('wbm-old', 'wb-old', 'wf-old', 0, '{}', :now)"),
                {"now": now},
            )
            conn.execute(sa.text("CREATE TABLE alembic_version (version_num VARCHAR(32) NOT NULL)"))
            conn.execute(sa.text("INSERT INTO alembic_version (version_num) VALUES ('0025_workflow_specifications')"))
    finally:
        sync_engine.dispose()

    await init_engine(backend="sqlite", url=f"sqlite+aiosqlite:///{db_path.as_posix()}", sqlite_dir=str(tmp_path))
    try:
        with sqlite3.connect(db_path) as raw:
            version = raw.execute("SELECT version_num FROM alembic_version").fetchone()[0]
            workbenches = raw.execute("SELECT COUNT(*) FROM workflow_workbenches").fetchone()[0]
            members = raw.execute("SELECT COUNT(*) FROM workflow_workbench_members").fetchone()[0]
            tables = {row[0] for row in raw.execute("SELECT name FROM sqlite_master WHERE type='table'")}
        assert version == "0026_projects"
        assert workbenches == 0
        assert members == 0
        assert "projects" in tables
    finally:
        await close_engine()
