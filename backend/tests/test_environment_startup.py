"""N11 S6 — the Gateway startup environment gate.

Directory creation is always fatal on failure (the application owns those
paths); requirement probing is fatal **only** under
``apps.environment.require_on_load``.
"""

from __future__ import annotations

import sys
from pathlib import Path

import pytest

from app.gateway import app as gateway_app
from deerflow.config.apps_config import AppDefinition, AppsConfig, EnvironmentConfig
from deerflow.config.paths import Paths
from deerflow.environment.probe import clear_probe_cache
from deerflow.environment.spec import ProbeKind, RequirementSpec


def _config(*, require_on_load: bool = False, requires: list[RequirementSpec] | None = None, enabled: bool = True):
    apps_config = AppsConfig(
        enabled=True,
        definitions={"demo": AppDefinition(driver="mock", requires=list(requires or []))},
        environment=EnvironmentConfig(enabled=enabled, require_on_load=require_on_load),
    )
    return type(
        "C",
        (),
        {
            "apps": apps_config,
            "memory": type("M", (), {"enabled": False})(),
            "database": type("D", (), {"backend": "memory"})(),
        },
    )()


@pytest.fixture(autouse=True)
def _cleanup() -> None:
    clear_probe_cache()
    yield
    clear_probe_cache()


@pytest.fixture
def paths(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> Paths:
    instance = Paths(base_dir=tmp_path / "home")
    monkeypatch.setattr("deerflow.config.paths.get_paths", lambda: instance)
    return instance


class TestBootstrapEnvironment:
    def test_creates_the_layout_and_accepts_a_ready_machine(self, paths: Paths) -> None:
        gateway_app._bootstrap_environment(_config(requires=[RequirementSpec(kind=ProbeKind.EXECUTABLE, name=sys.executable)]))
        assert paths.base_dir.is_dir()
        assert (paths.base_dir / "locks").is_dir()

    def test_a_failing_requirement_only_warns_by_default(self, paths: Paths) -> None:
        gateway_app._bootstrap_environment(_config(requires=[RequirementSpec(kind=ProbeKind.EXECUTABLE, name="definitely-not-installed-xyz-12345")]))
        assert paths.base_dir.is_dir()  # startup continued

    def test_require_on_load_refuses_to_start(self, paths: Paths) -> None:
        with pytest.raises(RuntimeError, match="require_on_load"):
            gateway_app._bootstrap_environment(_config(require_on_load=True, requires=[RequirementSpec(kind=ProbeKind.EXECUTABLE, name="definitely-not-installed-xyz-12345")]))

    def test_require_on_load_is_satisfied_by_a_ready_machine(self, paths: Paths) -> None:
        gateway_app._bootstrap_environment(_config(require_on_load=True, requires=[RequirementSpec(kind=ProbeKind.EXECUTABLE, name=sys.executable)]))

    def test_unknown_never_blocks_startup_even_with_require_on_load(self, paths: Paths) -> None:
        """An unanswerable probe has not shown the machine to be unprepared."""
        spec = RequirementSpec(kind=ProbeKind.VERSION, name=sys.executable, command=[sys.executable, "-c", "print('no version here')"])
        gateway_app._bootstrap_environment(_config(require_on_load=True, requires=[spec]))

    def test_disabled_probing_still_creates_the_layout(self, paths: Paths) -> None:
        gateway_app._bootstrap_environment(_config(enabled=False, require_on_load=True, requires=[RequirementSpec(kind=ProbeKind.EXECUTABLE, name="definitely-not-installed-xyz-12345")]))
        assert paths.base_dir.is_dir()
