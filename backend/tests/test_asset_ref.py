"""Tests for asset references and data contracts (N9, plan §20).

Pure-function coverage: URI round-trips, fingerprinting, scope inference, port
coercion, contract validation and converter command rendering.  No sandbox and
no host filesystem mutation (``tmp_path`` is used only to build stable absolute
paths).
"""

from __future__ import annotations

import os
from pathlib import Path

import pytest
from pydantic import ValidationError

from deerflow.assets.contracts import (
    AssetContract,
    AssetContractError,
    AssetConverter,
    normalize_extension,
)
from deerflow.assets.ref import (
    AssetRef,
    asset_ref_from_stat,
    asset_uri,
    extension_of,
    fingerprint_bytes,
    make_ref,
    media_type_for,
    normalize_host_path,
    parse_asset_uri,
    ref_from_port,
    refs_from_port,
    scope_for_virtual_path,
    validate_asset_against_contract,
)

# ── extensions / media types ──────────────────────────────────────────────────


@pytest.mark.parametrize(
    ("path", "expected"),
    [
        ("chair.fbx", ".fbx"),
        ("a/b/Chair.FBX", ".fbx"),
        ("a\\b\\chair.blend", ".blend"),
        ("a/b.TAR.GZ", ".gz"),
        ("no_extension", None),
        (".bashrc", None),
        ("dir.with.dots/file", None),
        ("trailing.", None),
    ],
)
def test_extension_of(path: str, expected: str | None) -> None:
    assert extension_of(path) == expected


@pytest.mark.parametrize(
    ("value", "expected"),
    [("fbx", ".fbx"), (".FBX", ".fbx"), ("  .Glb ", ".glb")],
)
def test_normalize_extension_accepts(value: str, expected: str) -> None:
    assert normalize_extension(value) == expected


@pytest.mark.parametrize("value", ["", "   ", ".", ". ", "../etc", ".a/b"])
def test_normalize_extension_rejects(value: str) -> None:
    with pytest.raises(ValueError):
        normalize_extension(value)


def test_media_type_for_known_and_unknown() -> None:
    assert media_type_for(".blend") == "application/x-blender"
    assert media_type_for(".PNG") == "image/png"
    assert media_type_for(".nope") is None
    assert media_type_for(None) is None


def test_fingerprint_bytes_matches_known_vector() -> None:
    assert fingerprint_bytes(b"") == "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"
    assert fingerprint_bytes(b"deerflow") == fingerprint_bytes(b"deerflow")


# ── scope detection ───────────────────────────────────────────────────────────


@pytest.mark.parametrize(
    ("path", "expected"),
    [
        ("/mnt/user-data/workspace/a.fbx", "workspace"),
        ("/mnt/user-data/uploads/a.fbx", "uploads"),
        ("/mnt/user-data/outputs/a.fbx", "outputs"),
        ("/mnt/user-data/workspace", "workspace"),
        ("/mnt/user-data", None),
        ("/tmp/a.fbx", None),
        ("relative/a.fbx", None),
    ],
)
def test_scope_for_virtual_path(path: str, expected: str | None) -> None:
    assert scope_for_virtual_path(path) == expected


# ── URIs ──────────────────────────────────────────────────────────────────────


@pytest.mark.parametrize("scope", ["workspace", "uploads", "outputs"])
def test_sandbox_uri_round_trip(scope: str) -> None:
    uri = asset_uri(scope, "scenes/chair.blend")  # type: ignore[arg-type]
    assert uri == f"asset://{scope}/scenes/chair.blend"
    parsed_scope, parsed_path = parse_asset_uri(uri)
    assert parsed_scope == scope
    assert parsed_path == f"/mnt/user-data/{scope}/scenes/chair.blend"


@pytest.mark.parametrize("scope", ["workspace", "uploads", "outputs"])
def test_sandbox_uri_accepts_virtual_path_input(scope: str) -> None:
    uri = asset_uri(scope, f"/mnt/user-data/{scope}/a/b.fbx")  # type: ignore[arg-type]
    assert uri == f"asset://{scope}/a/b.fbx"
    assert parse_asset_uri(uri)[1] == f"/mnt/user-data/{scope}/a/b.fbx"


def test_sandbox_uri_scope_root_has_no_trailing_slash() -> None:
    assert asset_uri("outputs", "") == "asset://outputs"
    assert asset_uri("outputs", "/mnt/user-data/outputs") == "asset://outputs"
    assert parse_asset_uri("asset://outputs") == ("outputs", "/mnt/user-data/outputs")


def test_host_uri_round_trip(tmp_path: Path) -> None:
    target = tmp_path / "chair.fbx"
    uri = asset_uri("host", str(target))
    assert uri.startswith("asset://host/")
    assert "\\" not in uri
    scope, path = parse_asset_uri(uri)
    assert scope == "host"
    assert path == normalize_host_path(str(target))


def test_host_uri_normalizes_relative_paths() -> None:
    relative = os.path.join("relative_dir", "a.fbx")
    assert parse_asset_uri(asset_uri("host", relative))[1] == normalize_host_path(relative)


@pytest.mark.parametrize(
    "uri",
    [
        "file:///tmp/a.fbx",
        "asset://bogus/a.fbx",
        "asset://host/",
        "asset://workspace/../etc/passwd",
        "asset://outputs//abs.fbx",
    ],
)
def test_parse_asset_uri_rejects_bad_input(uri: str) -> None:
    with pytest.raises(ValueError):
        parse_asset_uri(uri)


# ── make_ref ──────────────────────────────────────────────────────────────────


def test_make_ref_infers_sandbox_scope_and_metadata() -> None:
    ref = make_ref("/mnt/user-data/outputs/render/final.png", size=12, source="app:collect")
    assert ref.scope == "outputs"
    assert ref.path == "/mnt/user-data/outputs/render/final.png"
    assert ref.uri == "asset://outputs/render/final.png"
    assert ref.extension == ".png"
    assert ref.media_type == "image/png"
    assert ref.size == 12
    assert ref.source == "app:collect"
    assert ref.is_sandbox() is True


def test_make_ref_explicit_scope_wins() -> None:
    ref = make_ref("a.fbx", scope="workspace")
    assert ref.scope == "workspace"
    assert ref.path == "/mnt/user-data/workspace/a.fbx"


def test_make_ref_treats_plain_paths_as_host(tmp_path: Path) -> None:
    target = tmp_path / "chair.blend"
    ref = make_ref(str(target))
    assert ref.scope == "host"
    assert ref.is_sandbox() is False
    assert ref.extension == ".blend"
    assert ref.media_type == "application/x-blender"


def test_make_ref_does_not_require_existence(tmp_path: Path) -> None:
    ref = make_ref(str(tmp_path / "missing.fbx"))
    assert ref.size is None
    assert ref.sha256 is None
    assert ref.mtime is None


def test_make_ref_explicit_media_type_wins() -> None:
    ref = make_ref("model.glb", scope="workspace", media_type="model/custom")
    assert ref.media_type == "model/custom"


def test_asset_ref_from_stat(tmp_path: Path) -> None:
    target = tmp_path / "chair.fbx"
    target.write_bytes(b"abc")
    stat_result = target.stat()
    ref = asset_ref_from_stat(str(target), stat_result, sha256=fingerprint_bytes(b"abc"))
    assert ref.size == 3
    assert ref.sha256 == fingerprint_bytes(b"abc")
    assert ref.mtime == pytest.approx(stat_result.st_mtime)
    assert ref.scope == "host"


# ── port coercion ─────────────────────────────────────────────────────────────


def test_ref_from_port_round_trips_dict() -> None:
    ref = make_ref("/mnt/user-data/workspace/a.fbx")
    assert ref_from_port(ref.to_port()) == ref
    assert ref_from_port(ref) is ref


def test_ref_from_port_accepts_asset_uri() -> None:
    ref = ref_from_port("asset://workspace/a.fbx")
    assert ref is not None
    assert ref.scope == "workspace"
    assert ref.path == "/mnt/user-data/workspace/a.fbx"


def test_ref_from_port_accepts_virtual_path() -> None:
    ref = ref_from_port("/mnt/user-data/uploads/source.psd")
    assert ref is not None
    assert ref.scope == "uploads"


def test_ref_from_port_accepts_host_path(tmp_path: Path) -> None:
    ref = ref_from_port(str(tmp_path / "a.fbx"))
    assert ref is not None
    assert ref.scope == "host"


@pytest.mark.parametrize("value", [None, "", "   "])
def test_ref_from_port_returns_none_for_empty(value: object) -> None:
    assert ref_from_port(value) is None


def test_ref_from_port_rejects_unsupported_type() -> None:
    with pytest.raises(TypeError):
        ref_from_port(123)


def test_refs_from_port_normalizes_mixed_lists() -> None:
    refs = refs_from_port(
        [
            "asset://workspace/a.fbx",
            "/mnt/user-data/outputs/b.png",
            make_ref("c.blend", scope="workspace").to_port(),
            None,
            "",
        ]
    )
    assert [ref.scope for ref in refs] == ["workspace", "outputs", "workspace"]
    assert [ref.extension for ref in refs] == [".fbx", ".png", ".blend"]


def test_refs_from_port_single_value() -> None:
    assert len(refs_from_port("asset://uploads/a.psd")) == 1
    assert refs_from_port(None) == []


def test_asset_ref_is_json_safe() -> None:
    import json

    ref = make_ref("/mnt/user-data/outputs/a.json", size=1)
    assert json.loads(json.dumps(ref.to_port()))["uri"] == "asset://outputs/a.json"


def test_asset_ref_rejects_unknown_fields() -> None:
    with pytest.raises(ValidationError):
        AssetRef(uri="asset://workspace/a", path="a", scope="workspace", nope=1)


# ── contracts ─────────────────────────────────────────────────────────────────


def test_asset_contract_normalizes_extensions() -> None:
    contract = AssetContract(extensions=["FBX", ".fbx", ".blend"])
    assert contract.extensions == [".fbx", ".blend"]


def test_asset_contract_rejects_bad_extension() -> None:
    with pytest.raises(ValidationError):
        AssetContract(extensions=["../x"])


def test_asset_contract_describe() -> None:
    contract = AssetContract(extensions=[".blend"], media_type="application/x-blender", unit="m", up_axis="Z")
    described = contract.describe()
    assert ".blend" in described
    assert "unit m" in described
    assert "up_axis Z" in described
    assert AssetContract().describe() == "no restriction"


def test_accepts_extension() -> None:
    contract = AssetContract(extensions=[".fbx"])
    assert contract.accepts_extension(".fbx") is True
    assert contract.accepts_extension(".FBX") is True
    assert contract.accepts_extension(".obj") is False
    assert contract.accepts_extension(None) is False
    assert AssetContract().accepts_extension(None) is True


def test_validate_asset_against_contract_passes_and_tags_name() -> None:
    contract = AssetContract(extensions=[".blend"], media_type="application/x-blender", unit="m")
    ref = make_ref("/mnt/user-data/workspace/scene.blend")
    validated = validate_asset_against_contract(ref, contract, name="blender_scene")
    assert validated.contract == "blender_scene"
    assert ref.contract is None  # original untouched


def test_validate_asset_against_contract_reports_expected_and_actual() -> None:
    contract = AssetContract(extensions=[".blend"])
    ref = make_ref("/mnt/user-data/workspace/scene.fbx")
    with pytest.raises(AssetContractError) as excinfo:
        validate_asset_against_contract(ref, contract, name="blender_scene")
    error = excinfo.value
    assert error.contract == "blender_scene"
    assert error.actual == ".fbx"
    assert ".blend" in (error.expected or "")


def test_validate_asset_against_contract_media_type_mismatch() -> None:
    contract = AssetContract(media_type="application/x-blender")
    ref = make_ref("/mnt/user-data/workspace/scene.png")
    with pytest.raises(AssetContractError) as excinfo:
        validate_asset_against_contract(ref, contract, name="c")
    assert excinfo.value.expected == "application/x-blender"
    assert excinfo.value.actual == "image/png"


def test_validate_asset_against_contract_without_restriction() -> None:
    ref = make_ref("/mnt/user-data/workspace/anything.xyz")
    assert validate_asset_against_contract(ref, AssetContract(), name="loose").contract == "loose"


def test_asset_contract_error_is_value_error() -> None:
    assert issubclass(AssetContractError, ValueError)


# ── converters ────────────────────────────────────────────────────────────────


def test_converter_parses_yaml_style_aliases() -> None:
    converter = AssetConverter.model_validate({"from": "fbx", "to": ".OBJ", "command": "assimp", "args": ["export", "{in}", "{out}"]})
    assert converter.from_extension == ".fbx"
    assert converter.to_extension == ".obj"


def test_converter_requires_command() -> None:
    with pytest.raises(ValidationError):
        AssetConverter.model_validate({"from": ".fbx", "to": ".obj", "command": "  ", "args": ["{in}", "{out}"]})


@pytest.mark.parametrize(
    "args",
    [
        ["export", "{out}"],
        ["export", "{in}"],
        ["export"],
    ],
)
def test_converter_requires_both_placeholders(args: list[str]) -> None:
    with pytest.raises(ValidationError):
        AssetConverter.model_validate({"from": ".fbx", "to": ".obj", "command": "assimp", "args": args})


def test_converter_build_command_substitutes_placeholders() -> None:
    converter = AssetConverter.model_validate({"from": ".fbx", "to": ".obj", "command": "assimp", "args": ["export", "{in}", "{out}", "-f", "{out}"]})
    argv = converter.build_command(source="/mnt/user-data/workspace/a.fbx", target="/mnt/user-data/outputs/a.obj")
    assert argv == ["assimp", "export", "/mnt/user-data/workspace/a.fbx", "/mnt/user-data/outputs/a.obj", "-f", "/mnt/user-data/outputs/a.obj"]


def test_converter_rejects_unknown_fields() -> None:
    with pytest.raises(ValidationError):
        AssetConverter.model_validate({"from": ".fbx", "to": ".obj", "command": "x", "args": ["{in}", "{out}"], "extra": 1})
