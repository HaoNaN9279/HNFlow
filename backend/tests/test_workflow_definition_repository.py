"""Tests for WorkflowDefinitionRepository — CRUD, isolation, atomicity, serialization."""

from __future__ import annotations

from datetime import UTC, datetime

import pytest
from sqlalchemy.ext.asyncio import AsyncSession

from deerflow.config.database_config import DatabaseConfig
from deerflow.persistence.engine import close_engine, get_session_factory, init_engine_from_config
from deerflow.persistence.workflow_definitions import WorkflowDefinitionRepository

_VALID_DEFINITION = {
    "id": "wf-test-1",
    "name": "Test Workflow",
    "nodes": [
        {"id": "start", "type": "flow:start", "outputs": [{"name": "out", "type": "data"}]},
        {"id": "assign", "type": "data:assign", "inputs": [{"name": "in", "type": "data"}], "outputs": [{"name": "out", "type": "data"}]},
        {"id": "end", "type": "flow:end", "inputs": [{"name": "in", "type": "data"}]},
    ],
    "edges": [
        {"source": "start", "source_port": "out", "target": "assign", "target_port": "in"},
        {"source": "assign", "source_port": "out", "target": "end", "target_port": "in"},
    ],
}


# ── CRUD 全链路 ──────────────────────────────────────────────────────────────


@pytest.mark.asyncio
async def test_crud_full_cycle(tmp_path):
    """create → get → list_by_user → update → delete → get None."""
    await init_engine_from_config(DatabaseConfig(backend="sqlite", sqlite_dir=str(tmp_path)))
    sf = get_session_factory()
    assert sf is not None

    repo = WorkflowDefinitionRepository(sf)

    # Create
    created = await repo.create(
        definition_id="wf-crud",
        user_id="user-1",
        name="CRUD Test",
        schema_version=1,
        definition=_VALID_DEFINITION,
    )
    assert created["id"] == "wf-crud"
    assert created["name"] == "CRUD Test"
    assert created["user_id"] == "user-1"
    assert "metadata" in created
    assert created["schema_version"] == 1
    assert created["version"] == "0.1.0"

    # Get
    fetched = await repo.get("wf-crud", user_id="user-1")
    assert fetched is not None
    assert fetched["id"] == "wf-crud"

    # list_by_user
    listed = await repo.list_by_user("user-1")
    assert len(listed) == 1
    assert listed[0]["id"] == "wf-crud"

    # Update — change name and definition
    new_def = {**created["definition"], "name": "Updated WF"}
    updated = await repo.update(
        "wf-crud",
        user_id="user-1",
        updates={"name": "Updated Name", "definition": new_def},
    )
    assert updated is not None
    assert updated["name"] == "Updated Name"

    # Get after update
    fetched = await repo.get("wf-crud", user_id="user-1")
    assert fetched is not None
    assert fetched["name"] == "Updated Name"

    # Delete
    deleted = await repo.delete("wf-crud", user_id="user-1")
    assert deleted is True

    # Get after delete
    fetched = await repo.get("wf-crud", user_id="user-1")
    assert fetched is None

    await close_engine()


# ── user_id 隔离 ─────────────────────────────────────────────────────────────


@pytest.mark.asyncio
async def test_user_isolation_same_name_different_users(tmp_path):
    """Two users create workflows with the same name; each sees only their own."""
    await init_engine_from_config(DatabaseConfig(backend="sqlite", sqlite_dir=str(tmp_path)))
    sf = get_session_factory()
    assert sf is not None

    repo = WorkflowDefinitionRepository(sf)

    wf_a = await repo.create(
        definition_id="wf-same",
        user_id="user-a",
        name="同名工作流",
        schema_version=1,
        definition=_VALID_DEFINITION,
    )

    wf_b = await repo.create(
        definition_id="wf-same-b",
        user_id="user-b",
        name="同名工作流",
        schema_version=1,
        definition=_VALID_DEFINITION,
    )

    # user_a cannot see user_b's workflow
    assert await repo.get(wf_b["id"], user_id="user-a") is None

    # user_b cannot see user_a's workflow
    assert await repo.get(wf_a["id"], user_id="user-b") is None

    # list_by_user is scoped
    a_list = await repo.list_by_user("user-a")
    b_list = await repo.list_by_user("user-b")
    assert [w["id"] for w in a_list] == ["wf-same"]
    assert [w["id"] for w in b_list] == ["wf-same-b"]

    # update with wrong user → None
    assert await repo.update(wf_b["id"], user_id="user-a", updates={"name": "hijack"}) is None
    # still has original name
    fetched = await repo.get(wf_b["id"], user_id="user-b")
    assert fetched is not None
    assert fetched["name"] == "同名工作流"

    # delete with wrong user → False
    assert await repo.delete(wf_b["id"], user_id="user-a") is False
    # still exists for user_b
    fetched = await repo.get(wf_b["id"], user_id="user-b")
    assert fetched is not None

    await close_engine()


# ── 落盘原子性 ────────────────────────────────────────────────────────────────


@pytest.mark.asyncio
async def test_create_atomicity_no_dirty_data_on_commit_failure(tmp_path, monkeypatch):
    """A failed commit must not leave a partially persisted row behind."""
    await init_engine_from_config(DatabaseConfig(backend="sqlite", sqlite_dir=str(tmp_path)))
    sf = get_session_factory()
    assert sf is not None

    repo = WorkflowDefinitionRepository(sf)

    # Pre-condition: no workflows for this user
    assert await repo.get("wf-atomic", user_id="user-1") is None
    assert await repo.list_by_user("user-1") == []

    # Monkeypatch AsyncSession.commit to raise on the first call
    call_count = 0
    original_commit = AsyncSession.commit

    async def _failing_commit(self):
        nonlocal call_count
        call_count += 1
        if call_count == 1:
            raise RuntimeError("simulated DB failure")
        return await original_commit(self)

    monkeypatch.setattr(AsyncSession, "commit", _failing_commit)

    with pytest.raises(RuntimeError, match="simulated DB failure"):
        await repo.create(
            definition_id="wf-atomic",
            user_id="user-1",
            name="Atomic Test",
            schema_version=1,
            definition=_VALID_DEFINITION,
        )

    # After failure, no row should exist
    assert await repo.get("wf-atomic", user_id="user-1") is None
    assert await repo.list_by_user("user-1") == []

    # Verify repo still works (subsequent commits pass through)
    created = await repo.create(
        definition_id="wf-atomic-ok",
        user_id="user-1",
        name="Atomic OK",
        schema_version=1,
        definition=_VALID_DEFINITION,
    )
    assert created["id"] == "wf-atomic-ok"

    await close_engine()


# ── memory backend ────────────────────────────────────────────────────────────


@pytest.mark.asyncio
async def test_memory_backend_session_factory_returns_none(tmp_path):
    """With backend='memory', get_session_factory() returns None."""
    await init_engine_from_config(DatabaseConfig(backend="memory"))
    sf = get_session_factory()
    assert sf is None
    await close_engine()


# ── metadata 列往返 ───────────────────────────────────────────────────────────


@pytest.mark.asyncio
async def test_metadata_key_mapping(tmp_path):
    """Create with metadata dict → returned dict contains 'metadata', not 'def_metadata'."""
    await init_engine_from_config(DatabaseConfig(backend="sqlite", sqlite_dir=str(tmp_path)))
    sf = get_session_factory()
    assert sf is not None

    repo = WorkflowDefinitionRepository(sf)

    md = {"category": "test", "tags": ["a", "b"]}
    created = await repo.create(
        definition_id="wf-meta",
        user_id="user-1",
        name="Metadata Test",
        schema_version=1,
        definition=_VALID_DEFINITION,
        metadata=md,
    )

    assert "metadata" in created
    assert "def_metadata" not in created
    assert created["metadata"] == md

    # Round-trip through get
    fetched = await repo.get("wf-meta", user_id="user-1")
    assert fetched is not None
    assert "metadata" in fetched
    assert "def_metadata" not in fetched
    assert fetched["metadata"] == md

    await close_engine()


# ── resolved_at 序列化 ────────────────────────────────────────────────────────


@pytest.mark.asyncio
async def test_resolved_at_iso_serialization(tmp_path):
    """Create with datetime resolved_at → returned dict has ISO string."""
    await init_engine_from_config(DatabaseConfig(backend="sqlite", sqlite_dir=str(tmp_path)))
    sf = get_session_factory()
    assert sf is not None

    repo = WorkflowDefinitionRepository(sf)

    now = datetime.now(UTC)
    created = await repo.create(
        definition_id="wf-resolved",
        user_id="user-1",
        name="Resolved Test",
        schema_version=1,
        definition=_VALID_DEFINITION,
        resolved_at=now,
    )

    assert isinstance(created["resolved_at"], str)
    # Should look like an ISO 8601 string (with T separator or trailing Z/+00:00)
    assert "T" in created["resolved_at"] or "+" in created["resolved_at"]

    # Round-trip through get
    fetched = await repo.get("wf-resolved", user_id="user-1")
    assert fetched is not None
    assert isinstance(fetched["resolved_at"], str)

    await close_engine()
