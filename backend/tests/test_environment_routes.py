"""N11 S6 — the ``GET /api/environment`` report endpoint.

The report must stay truthful and non-fatal: a missing directory or an
unanswerable probe is *data* in a 200 response, never a 5xx, and a machine that
is actually ready reports ``ok``.
"""

from __future__ import annotations

import sys
from pathlib import Path

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from app.gateway.deps import get_config
from app.gateway.routers import environment as environment_router
from app.gateway.routers import features as features_router
from deerflow.config.paths import Paths, get_paths
from deerflow.environment.probe import clear_probe_cache
from deerflow.environment.spec import ProbeKind, RequirementSpec


class _FakeConfig:
    """Minimal stand-in for AppConfig: only the fields the report reads."""

    def __init__(self, *, enabled: bool = True, apps_config=None, memory_enabled: bool = True, sqlite_dir: Path | None = None) -> None:
        self.apps = apps_config
        self.agents_api = type("A", (), {"enabled": False})()
        self.tools: list = []
        self.memory = type("M", (), {"enabled": memory_enabled})()
        if sqlite_dir is not None:
            self.database = type(
                "D",
                (),
                {
                    "backend": "sqlite",
                    "sqlite_path": str(sqlite_dir / "deerflow.db"),
                },
            )()
        else:
            self.database = type("D", (), {"backend": "memory"})()


class _FakeStorage:
    def __init__(self, skills: list) -> None:
        self._skills = skills

    def load_skills(self, *, enabled_only: bool = False) -> list:  # noqa: ARG002 - mirrors the real signature
        return self._skills


#: Skills the patched storage factory hands to the router (test-scoped).
_SKILLS: list = []


def _fake_storage_factory(*args: object, **kwargs: object) -> _FakeStorage:  # noqa: ARG001 - mirrors the real signature
    return _FakeStorage(list(_SKILLS))


def _apps_config(*, enabled: bool = True, require_on_load: bool = False, requires: list[RequirementSpec] | None = None, skills: list | None = None):
    """A tiny object shaped like ``AppsConfig`` + registry + skill catalog."""
    from deerflow.config.apps_config import AppDefinition, AppsConfig, EnvironmentConfig

    definition = AppDefinition(driver="mock", description="demo app", requires=list(requires or []))
    config = AppsConfig(enabled=True, definitions={"demo": definition}, environment=EnvironmentConfig(enabled=enabled, require_on_load=require_on_load))
    return config


def _client(config: _FakeConfig, *, skills: list | None = None) -> TestClient:
    global _SKILLS
    _SKILLS = list(skills or [])
    app = FastAPI()
    app.include_router(environment_router.router)
    app.include_router(features_router.router)
    app.dependency_overrides[get_config] = lambda: config
    return TestClient(app)


@pytest.fixture(autouse=True)
def _cleanup(tmp_path: Path, monkeypatch: pytest.MonkeyPatch):
    clear_probe_cache()
    # `Paths.base_dir` reads the env var on each access, so pointing
    # DEER_FLOW_HOME at a temp dir is enough even though `get_paths()` is cached.
    monkeypatch.setenv("DEER_FLOW_HOME", str(tmp_path / "home"))
    # The router calls the storage factory directly (not through `Depends`), so a
    # dependency override cannot intercept it — patch the module attribute.
    monkeypatch.setattr(environment_router, "get_or_new_user_skill_storage", _fake_storage_factory)
    yield
    clear_probe_cache()


def _ready_home(memory_enabled: bool = True, database_dir: Path | None = None) -> None:
    get_paths().ensure_data_dirs(memory_enabled=memory_enabled, database_dir=database_dir)


class TestEnvironmentEndpoint:
    def test_reports_directories_and_requirements(self, tmp_path: Path) -> None:
        database_dir = tmp_path / "db"
        _ready_home(database_dir=database_dir)
        config = _FakeConfig(apps_config=_apps_config(requires=[RequirementSpec(kind=ProbeKind.EXECUTABLE, name=sys.executable)]), sqlite_dir=database_dir)

        with _client(config) as client:
            response = client.get("/api/environment")

        assert response.status_code == 200
        body = response.json()
        assert body["enabled"] is True
        assert body["overall"] == "ok"
        names = [entry["name"] for entry in body["data_dirs"]]
        assert names[:3] == ["base", "users", "skills_view"]
        assert all(entry["ok"] for entry in body["data_dirs"] if entry["required"])
        # The derived retrieval index is created on demand, so its absence is
        # reported but does not make the environment degraded.
        retrieval = next(entry for entry in body["data_dirs"] if entry["name"] == "retrieval")
        assert retrieval["required"] is False
        sources = body["requirements"]["sources"]
        assert sources[0]["source"] == "app:demo"
        assert sources[0]["results"][0]["outcome"] == "ok"
        assert body["blocking_problems"] == []

    def test_missing_required_directory_is_reported_not_fatal(self) -> None:
        config = _FakeConfig(apps_config=_apps_config())

        with _client(config) as client:
            response = client.get("/api/environment")

        assert response.status_code == 200
        body = response.json()
        assert body["overall"] == "missing"
        assert any("does not exist" in problem for problem in body["blocking_problems"])
        base = next(entry for entry in body["data_dirs"] if entry["name"] == "base")
        assert base["exists"] is False
        assert base["writable"] is None

    def test_a_failing_requirement_does_not_500(self) -> None:
        _ready_home()
        config = _FakeConfig(apps_config=_apps_config(requires=[RequirementSpec(kind=ProbeKind.EXECUTABLE, name="definitely-not-installed-xyz-12345")]))

        with _client(config) as client:
            response = client.get("/api/environment")

        assert response.status_code == 200
        body = response.json()
        assert body["overall"] == "missing"
        assert body["requirements"]["sources"][0]["results"][0]["outcome"] == "missing"

    def test_skill_requirements_are_reported_separately(self, tmp_path: Path) -> None:
        _ready_home()
        from deerflow.skills.types import Skill, SkillCategory

        directory = tmp_path / "cad"
        skill = Skill(
            name="cad-export",
            description="Export CAD.",
            license=None,
            skill_dir=directory,
            skill_file=directory / "SKILL.md",
            relative_path=Path("cad"),
            category=SkillCategory.CUSTOM,
            enabled=True,
            requirements=(RequirementSpec(kind=ProbeKind.EXECUTABLE, name=sys.executable),),
        )
        config = _FakeConfig(apps_config=_apps_config())
        with _client(config, skills=[skill]) as client:
            body = client.get("/api/environment").json()
        assert [source["source"] for source in body["requirements"]["sources"]] == ["skill:cad-export"]

    def test_force_reprobes_instead_of_reusing_the_cache(self) -> None:
        _ready_home()
        config = _FakeConfig(apps_config=_apps_config(requires=[RequirementSpec(kind=ProbeKind.EXECUTABLE, name=sys.executable)]))
        with _client(config) as client:
            first = client.get("/api/environment").json()["requirements"]["sources"][0]["results"][0]
            second = client.get("/api/environment").json()["requirements"]["sources"][0]["results"][0]
            forced = client.get("/api/environment", params={"force": True}).json()["requirements"]["sources"][0]["results"][0]
        assert first["source"] == "live"
        assert second["source"] == "cache"
        assert forced["source"] == "live"

    def test_disabled_report_still_shows_directories(self) -> None:
        _ready_home()
        config = _FakeConfig(apps_config=_apps_config(enabled=False, requires=[RequirementSpec(kind=ProbeKind.EXECUTABLE, name=sys.executable)]))
        with _client(config) as client:
            body = client.get("/api/environment").json()
        assert body["enabled"] is False
        assert body["data_dirs"]
        assert body["requirements"]["enabled"] is False

    def test_optional_probe_failure_only_degrades(self) -> None:
        _ready_home()
        config = _FakeConfig(apps_config=_apps_config(requires=[RequirementSpec(kind=ProbeKind.EXECUTABLE, name="definitely-not-installed-xyz-12345", optional=True)]))
        with _client(config) as client:
            body = client.get("/api/environment").json()
        assert body["overall"] == "degraded"
        assert body["blocking_problems"] == []

    def test_memory_disabled_drops_the_retrieval_entry(self) -> None:
        _ready_home(memory_enabled=False)
        config = _FakeConfig(apps_config=_apps_config(), memory_enabled=False)
        with _client(config) as client:
            body = client.get("/api/environment").json()
        assert all(entry["name"] != "retrieval" for entry in body["data_dirs"])


class TestFeaturesFlag:
    def test_features_reports_environment_availability(self) -> None:
        _ready_home()
        config = _FakeConfig(apps_config=_apps_config())
        with _client(config) as client:
            response = client.get("/api/features")
        assert response.status_code == 200
        assert response.json()["environment"]["enabled"] is True
        assert response.json()["apps"]["enabled"] is True


def test_paths_fixture_is_isolated(tmp_path: Path) -> None:
    """Guard: the env-var redirect really keeps the report off the real home."""
    assert get_paths().base_dir == (tmp_path / "home").resolve()


def test_paths_object_directly(tmp_path: Path) -> None:
    paths = Paths(base_dir=tmp_path / "explicit")
    assert paths.data_dirs()[0].path == tmp_path / "explicit"
