"""Tests for the application registry and session manager (N4)."""

from __future__ import annotations

from pathlib import Path

import pytest

from deerflow.apps.drivers.mock import MOCK_ARTIFACT_NAME
from deerflow.apps.registry import AppRegistry
from deerflow.apps.session import (
    AppDisabledError,
    AppNotFoundError,
    AppSession,
    AppSessionManager,
    AppSessionNotFoundError,
)
from deerflow.config.apps_config import AppDefinition, AppResourceDemand, AppsConfig


def _registry(tmp_path: Path, *, enabled: bool = True, exclusive: bool = True) -> AppRegistry:
    config = AppsConfig(
        enabled=enabled,
        definitions={
            "demo": AppDefinition(driver="mock", description="demo app", working_dir=str(tmp_path), exclusive=exclusive),
        },
    )
    return AppRegistry.from_config(config)


def test_registry_describe_reports_availability(tmp_path):
    registry = _registry(tmp_path)
    described = registry.describe()
    assert described == [
        {
            "name": "demo",
            "driver": "mock",
            "description": "demo app",
            "available": True,
            "error": None,
            "resources": {"gpu": 0, "cpu": 0, "memory_mb": 0, "disk_mb": 0},
            "license": None,
        },
    ]


def test_registry_describe_includes_declared_resources(tmp_path):
    config = AppsConfig(
        enabled=True,
        definitions={"blender": AppDefinition(driver="mock", description="B", working_dir=str(tmp_path), resources=AppResourceDemand(gpu=1, memory_mb=2048, license="render"))},
        licenses={"render": {"slots": 1}},
    )
    described = AppRegistry.from_config(config).describe()
    assert described[0]["resources"] == {"gpu": 1, "cpu": 0, "memory_mb": 2048, "disk_mb": 0}
    assert described[0]["license"] == "render"


def test_launch_creates_session_and_exclusive_reuses(tmp_path):
    manager = AppSessionManager(_registry(tmp_path))
    first = manager.launch("demo")
    assert first.status == "ready"
    assert first.session_id.startswith("app-")

    second = manager.launch("demo")
    assert second.session_id == first.session_id
    assert second.status == "attached"
    assert len(manager.list_sessions()) == 1


def test_launch_disabled_raises(tmp_path):
    manager = AppSessionManager(_registry(tmp_path, enabled=False))
    with pytest.raises(AppDisabledError):
        manager.launch("demo")


def test_launch_unknown_app_raises(tmp_path):
    manager = AppSessionManager(_registry(tmp_path))
    with pytest.raises(AppNotFoundError):
        manager.launch("nope")


def test_run_script_and_collect_roundtrip(tmp_path):
    manager = AppSessionManager(_registry(tmp_path))
    session = manager.launch("demo")

    result = manager.run_script(session, script="render", args=["--frames", "2"])
    assert result.status == "completed"
    assert (tmp_path / MOCK_ARTIFACT_NAME).exists()

    artifacts = manager.collect(session, globs=None)
    assert len(artifacts) == 1
    assert Path(artifacts[0]).name == MOCK_ARTIFACT_NAME
    assert session.artifacts == artifacts


def test_resolve_prefers_session_port(tmp_path):
    manager = AppSessionManager(_registry(tmp_path))
    session = manager.launch("demo")

    resolved = manager.resolve("demo", session.to_port())
    assert resolved.session_id == session.session_id

    # A well-formed port for an unknown/closed session falls back to the app's
    # live session (here the same one).
    stale = AppSession.from_port({"session_id": "app-gone", "app_name": "demo"})
    assert stale is not None
    assert manager.resolve("demo", {"session_id": "app-gone", "app_name": "demo"}).session_id == session.session_id


def test_resolve_without_session_raises(tmp_path):
    manager = AppSessionManager(_registry(tmp_path))
    with pytest.raises(AppSessionNotFoundError):
        manager.resolve("demo", None)


def test_close_stops_session(tmp_path):
    manager = AppSessionManager(_registry(tmp_path))
    session = manager.launch("demo")
    assert manager.close(session.session_id) is True
    assert manager.get(session.session_id) is None
    assert manager.close(session.session_id) is False


def test_driver_cached_per_family(tmp_path):
    manager = AppSessionManager(_registry(tmp_path))
    assert manager._driver_for("demo") is manager._driver_for("demo")
