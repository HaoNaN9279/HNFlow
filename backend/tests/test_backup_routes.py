"""N11b S6 — the read-only ``GET /api/backup`` plan endpoint."""

from __future__ import annotations

from types import SimpleNamespace

from fastapi import FastAPI
from fastapi.testclient import TestClient

from app.gateway.deps import get_config
from app.gateway.routers import backup as backup_router


def _config(*, backend: str = "sqlite", sqlite_path: str | None = None):
    if backend == "sqlite":
        database = SimpleNamespace(backend="sqlite", sqlite_path=sqlite_path or "/tmp/data/deerflow.db")
    else:
        database = SimpleNamespace(backend=backend)
    return SimpleNamespace(memory=SimpleNamespace(enabled=True), database=database, assets=SimpleNamespace(roots=[]))


def _client(config) -> TestClient:
    app = FastAPI()
    app.include_router(backup_router.router)
    app.dependency_overrides[get_config] = lambda: config
    return TestClient(app)


class TestBackupPlanEndpoint:
    def test_sqlite_plan_includes_database(self) -> None:
        with _client(_config()) as client:
            response = client.get("/api/backup")

        assert response.status_code == 200
        body = response.json()
        assert body["database_backend"] == "sqlite"
        assert body["database_included"] is True
        names = {member["name"] for member in body["members"]}
        assert {"base", "users", "database"} <= names
        assert {entry["name"] for entry in body["excluded"]} == {"locks", "retrieval", "capability-groups", "tools"}
        assert "note" in body

    def test_memory_plan_has_no_database(self) -> None:
        with _client(_config(backend="memory")) as client:
            body = client.get("/api/backup").json()

        assert body["database_included"] is False
        assert all(member["kind"] != "database" for member in body["members"])

    def test_plan_is_read_only_and_returns_200(self) -> None:
        with _client(_config()) as client:
            assert client.get("/api/backup").status_code == 200
