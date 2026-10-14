"""Tests for the ``/api/apps`` registry + instance router (N4/N6)."""

from __future__ import annotations

import asyncio
from pathlib import Path

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from app.gateway.deps import get_app_instance_repo, get_config
from app.gateway.routers import apps as apps_router
from deerflow.apps.session import reset_session_manager
from deerflow.config.apps_config import AppDefinition, AppsConfig, load_apps_config_from_dict, reset_apps_config

DEFAULT = "default"


class _FakeRepo:
    """In-memory stand-in for AppInstanceRepository (router-level tests)."""

    def __init__(self) -> None:
        self.rows: dict[str, dict] = {}

    async def seed(self, session_id: str, *, status: str, app_name: str = "demo", resources: dict | None = None, last_active: str = "2020-01-01T00:00:00+00:00") -> None:
        self.rows[session_id] = {
            "id": session_id,
            "user_id": DEFAULT,
            "app_name": app_name,
            "driver": "mock",
            "status": status,
            "pid": None,
            "endpoint": None,
            "handle": {},
            "exclusive": True,
            "resources": resources or {},
            "created_at": "2020-01-01T00:00:00+00:00",
            "last_active": last_active,
            "archived_at": None,
            "updated_at": "2020-01-01T00:00:00+00:00",
        }

    async def get(self, session_id: str, *, user_id: str):
        row = self.rows.get(session_id)
        return dict(row) if row and row["user_id"] == user_id else None

    async def list_by_user(self, user_id: str, *, status=None, include_archived=True, include_orphaned=True):
        out = []
        for row in self.rows.values():
            if row["user_id"] != user_id:
                continue
            if status is not None and row["status"] != status:
                continue
            if not include_archived and row["status"] == "archived":
                continue
            if not include_orphaned and row["status"] == "orphaned":
                continue
            out.append(dict(row))
        return out

    async def set_status(self, session_id, *, user_id, to_status, allowed_from):
        row = self.rows.get(session_id)
        if row is None or row["user_id"] != user_id or row["status"] not in allowed_from:
            return None
        row["status"] = to_status
        return dict(row)

    async def archive(self, session_id, *, user_id):
        row = self.rows.get(session_id)
        if row is None or row["user_id"] != user_id or row["status"] in ("launching", "ready", "attached", "busy"):
            return None
        row["status"] = "archived"
        return dict(row)

    async def delete(self, session_id, *, user_id):
        row = self.rows.get(session_id)
        if row is None or row["user_id"] != user_id:
            return False
        del self.rows[session_id]
        return True

    async def cleanup(self, *, older_than_days, user_id=None, statuses=()):
        removed = [sid for sid, row in self.rows.items() if row["status"] in statuses]
        for sid in removed:
            del self.rows[sid]
        return len(removed)


def _client(config: AppsConfig, repo: _FakeRepo | None = None) -> TestClient:
    app = FastAPI()
    app.include_router(apps_router.router)
    app.dependency_overrides[get_config] = lambda: type("C", (), {"apps": config})()
    if repo is not None:
        app.state.app_instance_repo = repo
        app.dependency_overrides[get_app_instance_repo] = lambda: repo
    return TestClient(app)


@pytest.fixture(autouse=True)
def _cleanup():
    reset_apps_config()
    reset_session_manager()
    yield
    reset_apps_config()
    reset_session_manager()


# ── registry ─────────────────────────────────────────────────────────────────


def test_list_apps_reports_registry(tmp_path: Path):
    config = AppsConfig(enabled=True, definitions={"demo": AppDefinition(driver="mock", description="demo", working_dir=str(tmp_path))})
    with _client(config) as client:
        response = client.get("/api/apps")
    assert response.status_code == 200
    body = response.json()
    assert body["enabled"] is True
    assert body["apps"] == [
        {
            "name": "demo",
            "driver": "mock",
            "description": "demo",
            "available": True,
            "error": None,
            "resources": {"gpu": 0, "cpu": 0, "memory_mb": 0, "disk_mb": 0},
            "license": None,
        }
    ]


def test_list_apps_disabled_is_empty():
    with _client(AppsConfig(enabled=False)) as client:
        response = client.get("/api/apps")
    assert response.status_code == 200
    assert response.json() == {"enabled": False, "apps": []}


# ── sessions: live fallback (memory backend) ─────────────────────────────────


def test_list_sessions_reflects_live_launch(tmp_path: Path):
    load_apps_config_from_dict({"enabled": True, "definitions": {"demo": {"driver": "mock", "description": "demo", "working_dir": str(tmp_path)}}})
    reset_session_manager()
    from deerflow.apps.session import get_session_manager

    get_session_manager().launch("demo")

    with _client(AppsConfig(enabled=True)) as client:
        response = client.get("/api/apps/sessions")
    assert response.status_code == 200
    body = response.json()
    assert body["persisted"] is False
    sessions = body["sessions"]
    assert len(sessions) == 1
    assert sessions[0]["app_name"] == "demo"
    assert sessions[0]["driver"] == "mock"
    assert sessions[0]["live"] is True


# ── sessions: durable backend ────────────────────────────────────────────────


def test_list_sessions_durable_and_filters():
    repo = _FakeRepo()

    asyncio.run(repo.seed("app-ready", status="ready"))
    asyncio.run(repo.seed("app-arch", status="archived"))
    asyncio.run(repo.seed("app-orph", status="orphaned"))

    with _client(AppsConfig(enabled=True), repo) as client:
        body = client.get("/api/apps/sessions").json()
        assert body["persisted"] is True
        assert {s["session_id"] for s in body["sessions"]} == {"app-ready", "app-arch", "app-orph"}

        hidden = client.get("/api/apps/sessions", params={"include_archived": "false", "include_orphaned": "false"}).json()
        assert [s["session_id"] for s in hidden["sessions"]] == ["app-ready"]

        ready = client.get("/api/apps/sessions", params={"status": "ready"}).json()
        assert [s["session_id"] for s in ready["sessions"]] == ["app-ready"]


def test_get_session_detail_and_404():
    repo = _FakeRepo()

    asyncio.run(repo.seed("app-1", status="ready", resources={"scripts_run": 2}))

    with _client(AppsConfig(enabled=True), repo) as client:
        ok = client.get("/api/apps/sessions/app-1")
        assert ok.status_code == 200
        assert ok.json()["resources"] == {"scripts_run": 2}
        assert client.get("/api/apps/sessions/missing").status_code == 404


def test_close_marks_stopped():
    repo = _FakeRepo()

    asyncio.run(repo.seed("app-1", status="ready"))

    with _client(AppsConfig(enabled=True), repo) as client:
        response = client.post("/api/apps/sessions/app-1/close")
        assert response.status_code == 200
        assert response.json()["status"] == "stopped"


def test_archive_rejects_live_and_archives_stopped():
    repo = _FakeRepo()

    asyncio.run(repo.seed("app-live", status="ready"))
    asyncio.run(repo.seed("app-stop", status="stopped"))

    with _client(AppsConfig(enabled=True), repo) as client:
        assert client.post("/api/apps/sessions/app-live/archive").status_code == 409
        archived = client.post("/api/apps/sessions/app-stop/archive")
        assert archived.status_code == 200
        assert archived.json()["status"] == "archived"
        assert archived.json()["archived"] is True
        assert client.post("/api/apps/sessions/missing/archive").status_code == 404


def test_delete_instance():
    repo = _FakeRepo()

    asyncio.run(repo.seed("app-1", status="stopped"))

    with _client(AppsConfig(enabled=True), repo) as client:
        assert client.delete("/api/apps/sessions/app-1").status_code == 204
        assert client.delete("/api/apps/sessions/app-1").status_code == 404


def test_cleanup_uses_config_retention_default():
    repo = _FakeRepo()

    asyncio.run(repo.seed("app-arch", status="archived"))
    asyncio.run(repo.seed("app-ready", status="ready"))

    config = AppsConfig(enabled=True, session_retention_days=7)
    with _client(config, repo) as client:
        response = client.post("/api/apps/sessions/cleanup")
        assert response.status_code == 200
        assert response.json()["removed"] == 1
        # The live row survives the sweep.
        assert client.get("/api/apps/sessions/app-ready").status_code == 200


def test_management_routes_503_without_repo():
    with _client(AppsConfig(enabled=True)) as client:
        assert client.post("/api/apps/sessions/app-1/archive").status_code == 503
        assert client.post("/api/apps/sessions/cleanup").status_code == 503
        assert client.delete("/api/apps/sessions/app-1").status_code == 503
