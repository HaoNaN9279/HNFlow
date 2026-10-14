"""Presence + release endpoints and the agent-facing presence tool (N10b, §17).

The read path must stay truthful: an unprobeable application answers ``unknown``
(never a 5xx, never "free"), a hand-back does not stop the instance, and the
tool tells the agent what the answer does *not* mean.
"""

from __future__ import annotations

import asyncio
from pathlib import Path

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from app.gateway.deps import get_app_instance_repo, get_config
from app.gateway.routers import apps as apps_router
from deerflow.apps.drivers.mock import MOCK_PRESENCE_NAME
from deerflow.apps.session import get_session_manager, reset_session_manager
from deerflow.config.apps_config import AppDefinition, AppsConfig, load_apps_config_from_dict, reset_apps_config


class _FakeRepo:
    def __init__(self) -> None:
        self.operations: list[dict] = []

    async def record_operation(self, session_id, **kwargs):
        self.operations.append({"session_id": session_id, **kwargs})
        return {"id": session_id}


def _client(config: AppsConfig, repo: _FakeRepo | None = None) -> TestClient:
    # The session manager — the choke point every presence probe goes through —
    # reads the process-wide ``apps`` config, not the request-scoped AppConfig.
    load_apps_config_from_dict(config.model_dump())
    app = FastAPI()
    app.include_router(apps_router.router)
    app.dependency_overrides[get_config] = lambda: type("C", (), {"apps": config})()
    if repo is not None:
        app.state.app_instance_repo = repo
        app.dependency_overrides[get_app_instance_repo] = lambda: repo
    return TestClient(app)


def _config(tmp_path: Path, *, policy: str = "fail", allow_preempt: bool = False) -> AppsConfig:
    return AppsConfig(
        enabled=True,
        definitions={"demo": AppDefinition(driver="mock", working_dir=str(tmp_path), allow_preempt=allow_preempt)},
        on_human_conflict=policy,
    )


@pytest.fixture(autouse=True)
def _cleanup():
    reset_apps_config()
    reset_session_manager()
    yield
    reset_apps_config()
    reset_session_manager()


class TestPresenceEndpoint:
    def test_reports_idle_for_a_free_application(self, tmp_path: Path) -> None:
        with _client(_config(tmp_path)) as client:
            response = client.get("/api/apps/demo/presence")
        assert response.status_code == 200
        body = response.json()
        assert body["app_name"] == "demo"
        assert body["state"] == "idle"
        assert body["observed_at"] > 0

    def test_reports_a_person(self, tmp_path: Path) -> None:
        (tmp_path / MOCK_PRESENCE_NAME).write_text("human", encoding="utf-8")
        with _client(_config(tmp_path)) as client:
            response = client.get("/api/apps/demo/presence", params={"force": True})
        assert response.json()["state"] == "human"

    def test_an_unparsable_probe_is_unknown_not_free(self, tmp_path: Path) -> None:
        (tmp_path / MOCK_PRESENCE_NAME).write_text("probably not", encoding="utf-8")
        with _client(_config(tmp_path)) as client:
            response = client.get("/api/apps/demo/presence", params={"force": True})
        assert response.status_code == 200
        assert response.json()["state"] == "unknown"

    def test_unknown_application_is_404(self, tmp_path: Path) -> None:
        with _client(_config(tmp_path)) as client:
            response = client.get("/api/apps/nope/presence")
        assert response.status_code == 404

    def test_disabled_layer_is_404(self) -> None:
        with _client(AppsConfig(enabled=False)) as client:
            response = client.get("/api/apps/demo/presence")
        assert response.status_code == 404

    def test_cached_answers_are_labelled(self, tmp_path: Path) -> None:
        with _client(_config(tmp_path)) as client:
            first = client.get("/api/apps/demo/presence").json()
            second = client.get("/api/apps/demo/presence").json()
            forced = client.get("/api/apps/demo/presence", params={"force": True}).json()
        assert first["cached"] is False
        assert second["cached"] is True
        assert forced["cached"] is False


class TestReleaseEndpoint:
    def test_release_hands_back_without_stopping(self, tmp_path: Path) -> None:
        manager = get_session_manager()
        # Bind the manager to this configuration before launching through it.
        manager.set_registry(manager.registry.from_config(_config(tmp_path, policy="preempt", allow_preempt=True)))
        (tmp_path / MOCK_PRESENCE_NAME).write_text("human", encoding="utf-8")
        session = manager.launch("demo")
        assert session.taken_over_from == "human"

        repo = _FakeRepo()
        with _client(_config(tmp_path, policy="preempt", allow_preempt=True), repo) as client:
            response = client.post(f"/api/apps/sessions/{session.session_id}/release")

        assert response.status_code == 200
        body = response.json()
        assert body["holder"] == "human"
        assert body["taken_over_from"] is None
        assert body["live"] is True
        assert manager.get(session.session_id) is not None  # still running

    def test_release_persists_the_hand_back_best_effort(self, tmp_path: Path) -> None:
        manager = get_session_manager()
        manager.set_registry(manager.registry.from_config(_config(tmp_path)))
        session = manager.launch("demo")

        repo = _FakeRepo()
        with _client(_config(tmp_path), repo) as client:
            client.post(f"/api/apps/sessions/{session.session_id}/release")

        assert repo.operations[-1]["resource_deltas"]["holder"] == "human"

    def test_release_of_a_non_live_instance_is_404(self, tmp_path: Path) -> None:
        with _client(_config(tmp_path)) as client:
            response = client.post("/api/apps/sessions/app-nope/release")
        assert response.status_code == 404


class TestInstanceHolderVisibility:
    def test_live_session_reports_its_holder(self, tmp_path: Path) -> None:
        manager = get_session_manager()
        manager.set_registry(manager.registry.from_config(_config(tmp_path, policy="preempt", allow_preempt=True)))
        (tmp_path / MOCK_PRESENCE_NAME).write_text("human", encoding="utf-8")
        launched = manager.launch("demo")

        with _client(_config(tmp_path, policy="preempt", allow_preempt=True)) as client:
            response = client.get(f"/api/apps/sessions/{launched.session_id}")
        body = response.json()
        assert body["holder"] == "human"
        assert body["taken_over_from"] == "human"

    def test_a_row_without_recorded_holder_reads_unknown(self, tmp_path: Path) -> None:
        """Rows written before N10b must not be presented as machine-held."""
        row = {
            "id": "app-legacy",
            "user_id": "default",
            "app_name": "demo",
            "driver": "mock",
            "status": "stopped",
            "pid": None,
            "endpoint": None,
            "handle": {},
            "exclusive": True,
            "resources": {},
            "created_at": "2020-01-01T00:00:00+00:00",
            "last_active": "2020-01-01T00:00:00+00:00",
            "archived_at": None,
            "updated_at": "2020-01-01T00:00:00+00:00",
        }

        class _ListRepo(_FakeRepo):
            async def list_by_user(self, user_id, *, status=None, include_archived=True, include_orphaned=True):
                return [dict(row)]

            async def get(self, session_id, *, user_id):
                return dict(row) if session_id == row["id"] else None

        with _client(_config(tmp_path), _ListRepo()) as client:
            body = client.get("/api/apps/sessions").json()
        assert body["sessions"][0]["holder"] == "unknown"

    def test_a_row_carrying_the_acquisition_fact_reports_it(self, tmp_path: Path) -> None:
        row = {
            "id": "app-taken",
            "user_id": "default",
            "app_name": "demo",
            "driver": "mock",
            "status": "ready",
            "pid": None,
            "endpoint": None,
            "handle": {},
            "exclusive": True,
            "resources": {"holder": "human", "taken_over_from": "human"},
            "created_at": "2020-01-01T00:00:00+00:00",
            "last_active": "2020-01-01T00:00:00+00:00",
            "archived_at": None,
            "updated_at": "2020-01-01T00:00:00+00:00",
        }

        class _ListRepo(_FakeRepo):
            async def list_by_user(self, user_id, *, status=None, include_archived=True, include_orphaned=True):
                return [dict(row)]

        with _client(_config(tmp_path), _ListRepo()) as client:
            body = client.get("/api/apps/sessions").json()
        assert body["sessions"][0]["holder"] == "human"
        assert body["sessions"][0]["taken_over_from"] == "human"


class TestPresenceTool:
    def _tools(self, tmp_path: Path, policy: str = "fail"):
        from deerflow.workflow.tool_gateway import _app_tools

        config = _config(tmp_path, policy=policy)
        load_apps_config_from_dict(config.model_dump())  # the tool resolves the manager from the singleton
        return _app_tools(app_config=config)

    def test_tool_is_exposed_when_an_application_is_available(self, tmp_path: Path) -> None:
        tools = self._tools(tmp_path)
        assert "check_app_presence" in tools
        assert "app_demo" in tools

    def test_tool_reports_the_state(self, tmp_path: Path) -> None:
        (tmp_path / MOCK_PRESENCE_NAME).write_text("human", encoding="utf-8")
        tool = self._tools(tmp_path)["check_app_presence"]
        payload = asyncio.run(tool.ainvoke({"app": "demo"}))
        assert '"state": "human"' in payload

    def test_tool_explains_what_unknown_means(self, tmp_path: Path) -> None:
        (tmp_path / MOCK_PRESENCE_NAME).write_text("nonsense", encoding="utf-8")
        tool = self._tools(tmp_path)["check_app_presence"]
        payload = asyncio.run(tool.ainvoke({"app": "demo"}))
        assert '"state": "unknown"' in payload
        assert "does not mean the application is free" in payload

    def test_tool_reports_an_unknown_application_as_data(self, tmp_path: Path) -> None:
        tool = self._tools(tmp_path)["check_app_presence"]
        payload = asyncio.run(tool.ainvoke({"app": "nope"}))
        assert '"status": "unknown_app"' in payload
