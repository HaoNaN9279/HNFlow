"""Tests for the ``apps`` configuration schema (N4)."""

from __future__ import annotations

import pytest
from pydantic import ValidationError

from deerflow.config.apps_config import (
    AppDefinition,
    AppResourceDemand,
    AppsConfig,
    LicenseGroup,
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


# ── N8: declared resources / licenses ────────────────────────────────────────


def test_resource_demand_defaults_to_nothing():
    demand = AppResourceDemand()
    assert demand.numeric() == {"gpu": 0, "cpu": 0, "memory_mb": 0, "disk_mb": 0}
    assert demand.license is None
    assert AppDefinition(driver="mock").resources == demand


def test_resource_demand_rejects_unknown_dimension_and_negatives():
    with pytest.raises(ValidationError):
        AppResourceDemand(vram=8)  # type: ignore[call-arg]
    with pytest.raises(ValidationError):
        AppResourceDemand(gpu=-1)


def test_license_group_name_grammar_enforced():
    with pytest.raises(ValidationError):
        AppResourceDemand(license="../escape")
    with pytest.raises(ValidationError):
        AppsConfig(licenses={"bad name": LicenseGroup()})


def test_declared_license_must_exist():
    with pytest.raises(ValidationError):
        AppsConfig(
            definitions={"blender": AppDefinition(driver="mock", resources=AppResourceDemand(license="render"))},
        )
    config = AppsConfig(
        definitions={"blender": AppDefinition(driver="mock", resources=AppResourceDemand(license="render"))},
        licenses={"render": LicenseGroup(slots=2)},
    )
    assert config.licenses["render"].slots == 2


def test_resource_governance_defaults():
    config = AppsConfig()
    assert config.resources.as_dict() == {"gpu": None, "cpu": None, "memory_mb": None, "disk_mb": None}
    assert config.licenses == {}
    assert config.on_conflict == "wait"
    assert config.acquire_timeout_seconds == 60.0


def test_conflict_policy_and_timeout_validated():
    with pytest.raises(ValidationError):
        AppsConfig(on_conflict="ignore")  # type: ignore[arg-type]
    with pytest.raises(ValidationError):
        AppsConfig(acquire_timeout_seconds=0)
    assert AppsConfig(on_conflict="degrade", acquire_timeout_seconds=5).on_conflict == "degrade"


def test_license_slots_minimum_one():
    with pytest.raises(ValidationError):
        LicenseGroup(slots=0)
    assert LicenseGroup().slots == 1


def test_load_reads_resource_fields():
    reset_apps_config()
    load_apps_config_from_dict(
        {
            "enabled": True,
            "resources": {"gpu": 1},
            "licenses": {"render": {"slots": 2}},
            "on_conflict": "fail",
            "acquire_timeout_seconds": 5,
            "definitions": {"blender": {"driver": "mock", "resources": {"gpu": 1, "license": "render"}}},
        }
    )
    cfg = get_apps_config()
    assert cfg.resources.gpu == 1
    assert cfg.resources.cpu is None
    assert cfg.licenses["render"].slots == 2
    assert cfg.on_conflict == "fail"
    assert cfg.acquire_timeout_seconds == 5
    assert cfg.definitions["blender"].resources.license == "render"
    reset_apps_config()
