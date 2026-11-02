"""N11 S3 — `apps.environment` knobs and `AppDefinition.requires`.

Defaults must be a no-op: an untouched configuration probes nothing and blocks
nothing, and a definition that declares no requirements behaves exactly as it did
before N11.
"""

from __future__ import annotations

import pytest
from pydantic import ValidationError

from deerflow.config.apps_config import (
    AppDefinition,
    AppsConfig,
    EnvironmentConfig,
    get_apps_config,
    load_apps_config_from_dict,
    reset_apps_config,
)


@pytest.fixture(autouse=True)
def _reset_singleton() -> None:
    reset_apps_config()
    yield
    reset_apps_config()


class TestEnvironmentConfig:
    def test_defaults_are_non_blocking(self) -> None:
        config = EnvironmentConfig()
        assert config.enabled is True
        assert config.require_on_load is False
        assert config.probe_timeout_seconds == 5.0
        assert config.cache_seconds == 5.0

    def test_apps_config_carries_environment_default(self) -> None:
        assert AppsConfig().environment == EnvironmentConfig()

    def test_invalid_values_rejected(self) -> None:
        with pytest.raises(ValidationError):
            EnvironmentConfig(probe_timeout_seconds=0)
        with pytest.raises(ValidationError):
            EnvironmentConfig(cache_seconds=-1)
        with pytest.raises(ValidationError):
            EnvironmentConfig(unknown_knob=True)  # type: ignore[call-arg]


class TestAppDefinitionRequires:
    def test_default_is_empty(self) -> None:
        definition = AppDefinition(driver="mock")
        assert definition.requires == []

    def test_parses_structured_requirements(self) -> None:
        definition = AppDefinition.model_validate(
            {
                "driver": "cli",
                "command": "blender",
                "requires": [
                    {"kind": "version", "name": "blender", "command": ["blender", "--version"], "expect": ">=4.0"},
                    {"kind": "plugin", "name": "addons/x", "optional": True},
                    {"kind": "path", "name": "$SHOT_DIR"},
                    {"kind": "runtime", "name": "python", "expect": "^3.11"},
                ],
            }
        )
        kinds = [str(spec.kind) for spec in definition.requires]
        assert kinds == ["version", "plugin", "path", "runtime"]
        assert definition.requires[0].resolved_command() == ["blender", "--version"]
        assert definition.requires[1].optional is True
        assert definition.requires[2].resolved_command() is None

    def test_version_command_is_still_a_plain_string(self) -> None:
        definition = AppDefinition(driver="cli", command="blender", version_command="--version")
        assert definition.version_command == "--version"

    def test_invalid_requirement_kind_rejected(self) -> None:
        with pytest.raises(ValidationError):
            AppDefinition.model_validate({"driver": "mock", "requires": [{"kind": "vibes", "name": "x"}]})

    def test_requirement_with_command_on_existence_kind_rejected(self) -> None:
        with pytest.raises(ValidationError, match="command is only meaningful"):
            AppDefinition.model_validate({"driver": "mock", "requires": [{"kind": "path", "name": "/x", "command": ["x"]}]})


class TestSingletonLoad:
    def test_environment_and_requires_round_trip_through_the_singleton(self) -> None:
        load_apps_config_from_dict(
            {
                "enabled": True,
                "environment": {"require_on_load": True, "probe_timeout_seconds": 1.5},
                "definitions": {
                    "blender": {
                        "driver": "cli",
                        "command": "blender",
                        "requires": [{"kind": "version", "name": "blender", "expect": ">=4"}],
                    }
                },
            }
        )
        loaded = get_apps_config()
        assert loaded.environment.require_on_load is True
        assert loaded.environment.probe_timeout_seconds == 1.5
        assert loaded.definitions["blender"].requires[0].expect == ">=4"

    def test_missing_environment_section_keeps_defaults(self) -> None:
        load_apps_config_from_dict({"enabled": True, "definitions": {"m": {"driver": "mock"}}})
        assert get_apps_config().environment == EnvironmentConfig()
        assert get_apps_config().definitions["m"].requires == []
