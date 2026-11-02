"""Tests for the ``check_cycles`` CLI (T11-3)."""

from __future__ import annotations

import pytest

from deerflow.config.database_config import DatabaseConfig
from deerflow.persistence.engine import close_engine, get_session_factory, init_engine_from_config
from deerflow.persistence.workflow_definitions import WorkflowDefinitionRepository
from deerflow.skills.types import Skill
from deerflow.workflow import check_cycles


def _wf_def(wf_id: str, template_id: str) -> dict:
    """A minimal workflow definition with one template subworkflow reference."""
    return {
        "id": wf_id,
        "name": wf_id,
        "nodes": [
            {
                "id": "sub",
                "type": "nested:subworkflow",
                "params": {"subworkflow": {"type": "template", "template_id": template_id}},
            }
        ],
    }


class _FakeStorage:
    """Skill storage stub returning a fixed skill list."""

    def __init__(self, skills: list[Skill]) -> None:
        self._skills = skills

    def load_skills(self, *, enabled_only: bool = False) -> list[Skill]:
        return list(self._skills)


class _FakeConfig:
    database = DatabaseConfig(backend="memory")


async def _seed(session_factory, user_id: str, refs: dict[str, str]) -> None:
    repo = WorkflowDefinitionRepository(session_factory)
    for wf_id, target in refs.items():
        await repo.create(
            definition_id=wf_id,
            user_id=user_id,
            name=wf_id,
            schema_version=1,
            definition=_wf_def(wf_id, target),
        )


# ── cycle detection ───────────────────────────────────────────────────────────


@pytest.mark.asyncio
async def test_cycles_detected_exit_1(tmp_path, monkeypatch):
    await init_engine_from_config(DatabaseConfig(backend="sqlite", sqlite_dir=str(tmp_path)))
    sf = get_session_factory()
    assert sf is not None
    await _seed(sf, "u1", {"wf-a": "wf-b", "wf-b": "wf-a"})
    monkeypatch.setattr(check_cycles, "get_or_new_skill_storage", lambda: _FakeStorage([]))

    cycles, code = await check_cycles._run_checks(sf, "u1")

    assert code == 1
    assert cycles
    assert any("workflow:wf-a" in c and "workflow:wf-b" in c for c in cycles)
    await close_engine()


@pytest.mark.asyncio
async def test_no_cycles_exit_0(tmp_path, monkeypatch):
    await init_engine_from_config(DatabaseConfig(backend="sqlite", sqlite_dir=str(tmp_path)))
    sf = get_session_factory()
    assert sf is not None
    await _seed(sf, "u1", {"wf-a": "wf-missing"})
    monkeypatch.setattr(check_cycles, "get_or_new_skill_storage", lambda: _FakeStorage([]))

    cycles, code = await check_cycles._run_checks(sf, "u1")

    assert code == 0
    assert cycles == []
    await close_engine()


@pytest.mark.asyncio
async def test_definition_filter(tmp_path, monkeypatch):
    await init_engine_from_config(DatabaseConfig(backend="sqlite", sqlite_dir=str(tmp_path)))
    sf = get_session_factory()
    assert sf is not None
    await _seed(sf, "u1", {"wf-a": "wf-b", "wf-b": "wf-a", "wf-c": "wf-d", "wf-d": "wf-c"})
    monkeypatch.setattr(check_cycles, "get_or_new_skill_storage", lambda: _FakeStorage([]))

    cycles, code = await check_cycles._run_checks(sf, "u1", definition_filter="wf-a")

    assert code == 1
    assert cycles
    assert all("workflow:wf-a" in c for c in cycles)
    assert all("workflow:wf-c" not in c for c in cycles)
    await close_engine()


# ── fail-open paths ───────────────────────────────────────────────────────────


@pytest.mark.asyncio
async def test_skills_load_failure_fail_open(tmp_path, monkeypatch, capsys):
    await init_engine_from_config(DatabaseConfig(backend="sqlite", sqlite_dir=str(tmp_path)))
    sf = get_session_factory()
    assert sf is not None
    await _seed(sf, "u1", {"wf-a": "wf-b", "wf-b": "wf-a"})

    def _boom_storage():
        raise RuntimeError("skill store unavailable")

    monkeypatch.setattr(check_cycles, "get_or_new_skill_storage", _boom_storage)

    cycles, code = await check_cycles._run_checks(sf, "u1")

    assert code == 1
    assert cycles  # workflow cycle still detected even though skills failed
    assert "skill" in capsys.readouterr().err
    await close_engine()


@pytest.mark.asyncio
async def test_malformed_definition_row_skipped(tmp_path, monkeypatch, capsys):
    await init_engine_from_config(DatabaseConfig(backend="sqlite", sqlite_dir=str(tmp_path)))
    sf = get_session_factory()
    assert sf is not None
    repo = WorkflowDefinitionRepository(sf)
    await repo.create(definition_id="wf-bad", user_id="u1", name="Bad", schema_version=1, definition={"id": "wf-bad"})
    await _seed(sf, "u1", {"wf-a": "wf-b", "wf-b": "wf-a"})
    monkeypatch.setattr(check_cycles, "get_or_new_skill_storage", lambda: _FakeStorage([]))

    cycles, code = await check_cycles._run_checks(sf, "u1")

    assert code == 1
    assert cycles
    assert "warning" in capsys.readouterr().err
    await close_engine()


# ── CLI smoke tests ───────────────────────────────────────────────────────────


def test_db_error_exit_2(monkeypatch, capsys):
    async def _boom(config):
        raise RuntimeError("boom: cannot connect")

    async def _noop_close():
        return None

    monkeypatch.setattr(check_cycles, "get_app_config", lambda: _FakeConfig())
    monkeypatch.setattr(check_cycles, "init_engine_from_config", _boom)
    monkeypatch.setattr(check_cycles, "close_engine", _noop_close)

    code = check_cycles.main(["--user", "u1"])

    assert code == 2
    assert "boom" in capsys.readouterr().err


def test_main_memory_backend_ok_exit_0(monkeypatch, capsys):
    async def _noop_init(config):
        return None

    async def _noop_close():
        return None

    monkeypatch.setattr(check_cycles, "get_app_config", lambda: _FakeConfig())
    monkeypatch.setattr(check_cycles, "init_engine_from_config", _noop_init)
    monkeypatch.setattr(check_cycles, "get_session_factory", lambda: None)
    monkeypatch.setattr(check_cycles, "close_engine", _noop_close)

    code = check_cycles.main(["--user", "u1"])

    assert code == 0
    assert capsys.readouterr().out.strip() == "OK"
