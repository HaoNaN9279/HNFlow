"""Tests for N8 resource admission in the application session manager."""

from __future__ import annotations

from pathlib import Path

import pytest

from deerflow.apps.driver import AppDriverError
from deerflow.apps.registry import AppRegistry
from deerflow.apps.session import AppSessionManager
from deerflow.config.apps_config import AppDefinition, AppResourceDemand, AppsConfig, LicenseGroup
from deerflow.resources.governor import ResourceDemand, ResourceGovernor, ResourceUnavailableError

pytestmark = pytest.mark.no_auto_user


def _governed(
    tmp_path: Path,
    *,
    requirements: dict[str, dict],
    licenses: dict[str, int] | None = None,
    limits: dict[str, int] | None = None,
    exclusive: bool = True,
    on_conflict: str = "wait",
    acquire_timeout_seconds: float = 0.2,
) -> AppSessionManager:
    config = AppsConfig(
        enabled=True,
        definitions={name: AppDefinition(driver="mock", working_dir=str(tmp_path), exclusive=exclusive, resources=AppResourceDemand(**declared)) for name, declared in requirements.items()},
        licenses={name: LicenseGroup(slots=slots) for name, slots in (licenses or {}).items()},
        resources=limits or {},
    )
    governor = ResourceGovernor(
        limits or {},
        licenses or {},
        on_conflict=on_conflict,
        acquire_timeout_seconds=acquire_timeout_seconds,
    )
    return AppSessionManager(AppRegistry.from_config(config), governor=governor)


def _governor(manager: AppSessionManager) -> ResourceGovernor:
    governor = manager.governor
    assert governor is not None
    return governor


# ── ungoverned behavior is unchanged ─────────────────────────────────────────


def test_manager_without_governor_is_ungoverned(tmp_path):
    config = AppsConfig(enabled=True, definitions={"demo": AppDefinition(driver="mock", working_dir=str(tmp_path), resources=AppResourceDemand(gpu=1))}, resources={"gpu": 1})
    manager = AppSessionManager(AppRegistry.from_config(config))
    assert manager.governor is None

    first = manager.launch("demo")
    second = manager.launch("demo")
    assert first.session_id == second.session_id


def test_declared_app_without_limits_is_not_governed(tmp_path):
    manager = _governed(tmp_path, requirements={"demo": {"gpu": 4}})
    manager.launch("demo")
    session = manager.launch("demo", mode="attach")
    manager.run_script(session, script="x")
    assert _governor(manager).snapshot()["in_use"]["gpu"] == 0


# ── license (instance level) ─────────────────────────────────────────────────


def test_license_slot_is_held_for_instance_life(tmp_path):
    manager = _governed(tmp_path, requirements={"a": {"license": "render"}, "b": {"license": "render"}}, licenses={"render": 1}, on_conflict="fail")
    governor = _governor(manager)

    first = manager.launch("a")
    assert governor.snapshot()["licenses"]["render"]["in_use"] == 1

    with pytest.raises(ResourceUnavailableError):
        manager.launch("b")

    manager.close(first.session_id)
    assert governor.snapshot()["licenses"]["render"]["in_use"] == 0
    manager.launch("b")


def test_exclusive_attach_does_not_take_a_second_slot(tmp_path):
    manager = _governed(tmp_path, requirements={"a": {"license": "render"}}, licenses={"render": 1})
    governor = _governor(manager)

    first = manager.launch("a")
    second = manager.launch("a")
    assert second.session_id == first.session_id
    assert governor.snapshot()["licenses"]["render"]["in_use"] == 1


def test_reset_releases_license_slots(tmp_path):
    manager = _governed(tmp_path, requirements={"a": {"license": "render"}}, licenses={"render": 1})
    governor = _governor(manager)

    manager.launch("a")
    manager.reset()
    assert governor.snapshot()["licenses"]["render"]["in_use"] == 0


def test_failed_launch_releases_the_license(tmp_path):
    manager = _governed(tmp_path, requirements={"broken": {"license": "render"}}, licenses={"render": 1})
    governor = _governor(manager)
    manager._drivers["mock"] = _ExplodingDriver()  # type: ignore[assignment]

    with pytest.raises(RuntimeError, match="launch exploded"):
        manager.launch("broken")
    assert governor.snapshot()["licenses"]["render"]["in_use"] == 0


# ── numeric demand (operation level) ─────────────────────────────────────────


def test_operation_holds_demand_for_its_duration(tmp_path):
    manager = _governed(tmp_path, requirements={"a": {"gpu": 1, "memory_mb": 512}}, limits={"gpu": 1, "memory_mb": 512})
    governor = _governor(manager)
    session = manager.launch("a")
    assert governor.snapshot()["in_use"]["gpu"] == 0  # launch takes only the license

    peaks: list[dict[str, int]] = []
    driver = manager._driver_for(session.app_name)  # type: ignore[attr-defined]
    original = driver.run_script

    def observing(*args, **kwargs):
        peaks.append(governor.snapshot()["in_use"])
        return original(*args, **kwargs)

    driver.run_script = observing  # type: ignore[method-assign]
    manager.run_script(session, script="build")

    assert peaks == [{"gpu": 1, "cpu": 0, "memory_mb": 512, "disk_mb": 0}]
    assert governor.snapshot()["in_use"] == {"gpu": 0, "cpu": 0, "memory_mb": 0, "disk_mb": 0}


def test_operation_demand_is_released_on_driver_failure(tmp_path):
    manager = _governed(tmp_path, requirements={"a": {"gpu": 1}}, limits={"gpu": 1})
    governor = _governor(manager)
    session = manager.launch("a")

    def boom(*args, **kwargs):
        raise AppDriverError("driver exploded")

    manager._driver_for(session.app_name).run_script = boom  # type: ignore[method-assign]

    with pytest.raises(AppDriverError):
        manager.run_script(session, script="x")
    assert governor.snapshot()["in_use"]["gpu"] == 0


def test_operation_waits_then_fails_for_a_parallel_holder(tmp_path):
    manager = _governed(tmp_path, requirements={"a": {"gpu": 1}}, limits={"gpu": 1}, acquire_timeout_seconds=0.2)
    governor = _governor(manager)
    session = manager.launch("a")

    holder = governor.acquire(ResourceDemand(gpu=1))
    with pytest.raises(ResourceUnavailableError) as exc:
        manager.run_script(session, script="x")
    assert exc.value.dimension == "gpu"

    governor.release(holder)
    manager.run_script(session, script="x")  # admitted once the slot frees up


def test_degrade_marks_the_session(tmp_path):
    manager = _governed(tmp_path, requirements={"a": {"gpu": 1}}, limits={"gpu": 1}, on_conflict="degrade")
    governor = _governor(manager)
    session = manager.launch("a")

    holder = governor.acquire(ResourceDemand(gpu=1))
    manager.run_script(session, script="x")
    assert session.degraded_operations == 1

    governor.release(holder)


def test_wait_and_collect_also_consume_demand(tmp_path):
    manager = _governed(tmp_path, requirements={"a": {"disk_mb": 16}}, limits={"disk_mb": 16})
    governor = _governor(manager)
    session = manager.launch("a")

    manager.wait(session, reason="render", timeout=0)
    manager.collect(session)
    assert governor.snapshot()["in_use"]["disk_mb"] == 0


class _ExplodingDriver:
    name = "mock"

    def launch(self, definition, *, mode="launch"):
        raise RuntimeError("launch exploded")


def test_process_singleton_is_built_with_the_configured_governor(monkeypatch, tmp_path):
    """The wiring every executor/tool path relies on: config → singleton manager."""
    from deerflow.apps.session import get_session_manager, reset_session_manager
    from deerflow.config.apps_config import load_apps_config_from_dict, reset_apps_config

    reset_session_manager()
    reset_apps_config()
    try:
        load_apps_config_from_dict(
            {
                "enabled": True,
                "definitions": {"demo": {"driver": "mock", "working_dir": str(tmp_path), "resources": {"gpu": 1}}},
                "resources": {"gpu": 1},
            }
        )
        governor = get_session_manager().governor
        assert governor is not None
        assert governor.limits["gpu"] == 1
    finally:
        reset_session_manager()
        reset_apps_config()
