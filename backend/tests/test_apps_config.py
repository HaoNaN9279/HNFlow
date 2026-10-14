"""Tests for the ``apps`` configuration schema (N4)."""

from __future__ import annotations

import pytest
from pydantic import ValidationError

from deerflow.config.apps_config import (
    AppDefinition,
    AppsConfig,
    get_apps_config,
    load_apps_config_from_dict,
    reset_apps_config,
)


def test_cli_definition_requires_command():
    with pytest.raises(ValidationError):
        AppDefinition(driver="cli")


def test_mock_definition_needs_no_command():
    definition = AppDefinition(driver="mock")
    assert definition.driver == "mock"
    assert definition.command is None
    assert definition.timeout_seconds == 600
    assert definition.exclusive is True


def test_unknown_driver_rejected():
    with pytest.raises(ValidationError):
        AppDefinition(driver="photoshop")  # type: ignore[arg-type]


def test_unknown_field_rejected():
    with pytest.raises(ValidationError):
        AppDefinition(driver="mock", bogus=True)  # type: ignore[call-arg]


def test_app_name_grammar_enforced():
    with pytest.raises(ValidationError):
        AppsConfig(definitions={"bad name": AppDefinition(driver="mock")})
    with pytest.raises(ValidationError):
        AppsConfig(definitions={"../escape": AppDefinition(driver="mock")})
    assert AppsConfig(definitions={"ok-1": AppDefinition(driver="mock")}).definitions


def test_singleton_defaults_disabled_then_loads_and_resets():
    reset_apps_config()
    assert get_apps_config().enabled is False
    assert get_apps_config().definitions == {}

    load_apps_config_from_dict({"enabled": True, "definitions": {"blender": {"driver": "mock", "description": "B"}}})
    assert get_apps_config().enabled is True
    assert get_apps_config().definitions["blender"].description == "B"

    reset_apps_config()
    assert get_apps_config().enabled is False


def test_env_values_expand_stripping():
    definition = AppDefinition(driver="cli", command="  python  ")
    assert definition.command == "python"


def test_instance_management_defaults():
    config = AppsConfig()
    assert config.persist_sessions is True
    assert config.session_retention_days == 30


def test_session_retention_days_range_enforced():
    with pytest.raises(ValidationError):
        AppsConfig(session_retention_days=0)
    with pytest.raises(ValidationError):
        AppsConfig(session_retention_days=4000)
    assert AppsConfig(session_retention_days=90).session_retention_days == 90


def test_load_reads_instance_management_fields():
    reset_apps_config()
    load_apps_config_from_dict({"enabled": True, "persist_sessions": False, "session_retention_days": 7})
    cfg = get_apps_config()
    assert cfg.persist_sessions is False
    assert cfg.session_retention_days == 7
    reset_apps_config()
