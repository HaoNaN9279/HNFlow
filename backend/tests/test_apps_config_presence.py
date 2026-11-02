"""Human/machine sharing configuration (N10b, §17).

The defaults must reproduce today's behavior exactly: a config that declares
nothing about presence behaves as if the feature did not exist (an application
with no ``presence_command`` answers ``unknown``, and ``unknown`` never blocks).
"""

from __future__ import annotations

from pathlib import Path

import pytest
import yaml
from pydantic import ValidationError

from deerflow.config.apps_config import AppDefinition, AppsConfig

_REPO_ROOT = Path(__file__).resolve().parents[2]


def _config(**overrides) -> AppsConfig:
    payload: dict = {"enabled": True, "definitions": {"blender": {"driver": "cli", "command": "blender"}}}
    payload.update(overrides)
    return AppsConfig(**payload)


class TestDefaults:
    def test_absent_configuration_is_todays_behavior(self) -> None:
        config = _config()
        assert config.on_human_conflict == "fail"
        definition = config.definitions["blender"]
        assert definition.presence_command is None
        assert definition.allow_preempt is False

    def test_exclusive_cardinality_is_untouched(self) -> None:
        """`exclusive` is instance cardinality; presence is who is using it (orthogonal)."""
        definition = AppDefinition(driver="cli", command="x", presence_command="check", allow_preempt=True)
        assert definition.exclusive is True

    def test_n8_and_n10b_conflict_policies_stay_independent(self) -> None:
        config = _config(on_conflict="degrade", on_human_conflict="wait")
        assert config.on_conflict == "degrade"
        assert config.on_human_conflict == "wait"


class TestHumanConflictPolicy:
    @pytest.mark.parametrize("policy", ["fail", "wait", "preempt"])
    def test_supported_policies(self, policy: str) -> None:
        assert _config(on_human_conflict=policy).on_human_conflict == policy

    @pytest.mark.parametrize("policy", ["degrade", "ignore", "stop", ""])
    def test_unsupported_policy_rejected(self, policy: str) -> None:
        with pytest.raises(ValidationError):
            _config(on_human_conflict=policy)


class TestPresenceCommand:
    def test_whitespace_normalized_to_absent(self) -> None:
        assert AppDefinition(driver="cli", command="x", presence_command="   ").presence_command is None

    def test_command_is_stripped(self) -> None:
        assert AppDefinition(driver="cli", command="x", presence_command="  check-presence  ").presence_command == "check-presence"

    def test_optional_for_every_driver(self) -> None:
        assert AppDefinition(driver="mock").presence_command is None

    def test_allow_preempt_round_trips(self) -> None:
        config = _config(definitions={"blender": {"driver": "cli", "command": "blender", "presence_command": "check", "allow_preempt": True}})
        assert config.definitions["blender"].allow_preempt is True


class TestLoadFromDict:
    def test_loader_reads_the_new_fields(self) -> None:
        config = AppsConfig.model_validate(
            {
                "enabled": True,
                "on_human_conflict": "preempt",
                "definitions": {"blender": {"driver": "cli", "command": "blender", "presence_command": "is-busy", "allow_preempt": True}},
            }
        )
        assert config.on_human_conflict == "preempt"
        definition = config.definitions["blender"]
        assert definition.presence_command == "is-busy"
        assert definition.allow_preempt is True

    def test_unknown_field_still_rejected(self) -> None:
        with pytest.raises(ValidationError):
            _config(definitions={"blender": {"driver": "cli", "command": "blender", "presence": "yes"}})


class TestExampleTemplate:
    def _example(self) -> dict:
        return yaml.safe_load((_REPO_ROOT / "config.example.yaml").read_text(encoding="utf-8")) or {}

    def test_example_version_covers_the_new_fields(self) -> None:
        """The template version must move so existing configs are flagged as outdated."""
        assert self._example().get("config_version", 0) >= 39

    def test_example_documents_the_sharing_knobs(self) -> None:
        text = (_REPO_ROOT / "config.example.yaml").read_text(encoding="utf-8")
        assert "on_human_conflict" in text
        assert "presence_command" in text
        assert "allow_preempt" in text

    def test_example_loads_with_the_defaults(self) -> None:
        config = AppsConfig.model_validate(self._example().get("apps", {}))
        assert config.enabled is False
        assert config.on_human_conflict == "fail"
