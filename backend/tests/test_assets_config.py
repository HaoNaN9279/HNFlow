"""Tests for the ``assets`` configuration section (N9, plan §20)."""

from __future__ import annotations

from pathlib import Path

import pytest
from pydantic import ValidationError

from deerflow.assets.ref import normalize_host_path
from deerflow.config.assets_config import (
    DEFAULT_MAX_ASSET_BYTES,
    AssetsConfig,
    get_assets_config,
    load_assets_config_from_dict,
    reset_assets_config,
)


def test_default_config_disables_host_transfer() -> None:
    config = AssetsConfig()
    assert config.roots == []
    assert config.host_transfer_enabled is False
    assert config.max_bytes == DEFAULT_MAX_ASSET_BYTES
    assert config.contracts == {}
    assert config.converters == {}


def test_default_config_rejects_every_host_path() -> None:
    config = AssetsConfig()
    assert config.allows_host_path("/tmp/anything.fbx") is False


def test_roots_are_normalized_absolute_and_deduplicated(tmp_path: Path) -> None:
    config = AssetsConfig(roots=[str(tmp_path), str(tmp_path), f"{tmp_path}{'/'}."])
    assert config.roots == [normalize_host_path(str(tmp_path))]
    assert config.host_transfer_enabled is True


def test_roots_reject_empty_entry() -> None:
    with pytest.raises(ValidationError):
        AssetsConfig(roots=["   "])


def test_allows_host_path_inside_root(tmp_path: Path) -> None:
    config = AssetsConfig(roots=[str(tmp_path)])
    assert config.allows_host_path(str(tmp_path / "models" / "chair.fbx")) is True
    assert config.allows_host_path(str(tmp_path)) is True


def test_allows_host_path_rejects_sibling_with_shared_prefix(tmp_path: Path) -> None:
    config = AssetsConfig(roots=[str(tmp_path / "root")])
    assert config.allows_host_path(str(tmp_path / "root" / "a.fbx")) is True
    assert config.allows_host_path(str(tmp_path / "root-fake" / "a.fbx")) is False
    assert config.allows_host_path(str(tmp_path / "other" / "a.fbx")) is False


def test_allows_host_path_accepts_relative_input(tmp_path: Path) -> None:
    config = AssetsConfig(roots=[str(tmp_path)])
    assert config.allows_host_path(str(tmp_path / "sub" / ".." / "a.fbx")) is True


def test_max_bytes_must_be_positive() -> None:
    with pytest.raises(ValidationError):
        AssetsConfig(max_bytes=0)


def test_unknown_fields_rejected() -> None:
    with pytest.raises(ValidationError):
        AssetsConfig.model_validate({"roots": [], "nope": 1})


def test_contracts_and_converters_load_and_resolve() -> None:
    config = AssetsConfig.model_validate(
        {
            "roots": ["/tmp/assets"],
            "contracts": {"blender_scene": {"extensions": ["BLEND"], "unit": "m", "up_axis": "Z"}},
            "converters": {"fbx_to_obj": {"from": ".fbx", "to": ".obj", "command": "assimp", "args": ["export", "{in}", "{out}"]}},
        }
    )
    contract = config.contract_for("blender_scene")
    assert contract is not None
    assert contract.extensions == [".blend"]
    converter = config.converter_for("fbx_to_obj")
    assert converter is not None
    assert converter.build_command(source="in.fbx", target="out.obj") == ["assimp", "export", "in.fbx", "out.obj"]
    assert config.contract_for(None) is None
    assert config.converter_for("missing") is None


@pytest.mark.parametrize("name", ["", "has space", "a/b", "x" * 65, "ünicode"])
def test_names_must_match_grammar(name: str) -> None:
    with pytest.raises(ValidationError):
        AssetsConfig.model_validate({"contracts": {name: {"extensions": [".fbx"]}}})


def test_singleton_load_and_reset() -> None:
    try:
        reset_assets_config()
        assert get_assets_config().host_transfer_enabled is False

        load_assets_config_from_dict({"roots": ["/tmp/assets"], "max_bytes": 1024})
        loaded = get_assets_config()
        assert loaded.host_transfer_enabled is True
        assert loaded.max_bytes == 1024
        assert loaded.allows_host_path("/tmp/assets/a.fbx") is True

        load_assets_config_from_dict(None)
        assert get_assets_config().host_transfer_enabled is False
    finally:
        reset_assets_config()


def test_singleton_is_not_the_default_instance_after_load() -> None:
    try:
        load_assets_config_from_dict({"roots": ["/tmp/assets"]})
        assert get_assets_config() is not AssetsConfig()
    finally:
        reset_assets_config()
