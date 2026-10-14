"""Tests for the ``data:asset`` workflow executor (N9, plan §20).

Covers the four operations (inspect / import / export / convert), the host
allow-list boundary (``assets.roots``), the crash-confirm gate, atomic export
writes, contract validation and converter wiring.  The sandbox is mocked — no
real external side-effects — while host files are exercised through ``tmp_path``.
"""

from __future__ import annotations

import asyncio
import hashlib
import os
from pathlib import Path
from typing import Any
from unittest.mock import MagicMock

import pytest

from deerflow.config.assets_config import load_assets_config_from_dict, reset_assets_config
from deerflow.workflow.compiler import WorkflowRuntime
from deerflow.workflow.executors import WorkflowExecutionError
from deerflow.workflow.executors.asset import exec_asset

# ── helpers ───────────────────────────────────────────────────────────────────


@pytest.fixture(autouse=True)
def _reset_assets_config() -> Any:
    reset_assets_config()
    yield
    reset_assets_config()


def _runtime() -> WorkflowRuntime:
    return WorkflowRuntime(context={}, config={}, state={})


def _run_asset(params: dict[str, Any], inputs: dict[str, Any] | None = None) -> dict[str, Any]:
    """Run the executor synchronously (this suite has no async pytest plugin)."""
    return asyncio.run(exec_asset(_runtime(), params, inputs or {}))


def _configure_assets(**kwargs: Any) -> None:
    load_assets_config_from_dict(kwargs)


def _install_sandbox(monkeypatch: pytest.MonkeyPatch, sandbox: Any) -> None:
    monkeypatch.setattr("deerflow.workflow.executors.asset.sandbox_tools.ensure_sandbox_initialized", lambda runtime=None: sandbox, raising=True)


def _install_thread_data(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr("deerflow.workflow.executors.asset.sandbox_tools.get_thread_data", lambda runtime=None: {}, raising=True)
    monkeypatch.setattr("deerflow.workflow.executors.asset.sandbox_tools.replace_virtual_paths_in_command", lambda command, thread_data: command, raising=True)


def _mock_sandbox(**kwargs: Any) -> MagicMock:
    sandbox = MagicMock()
    sandbox.execute_command.return_value = kwargs.get("stdout", "")
    if "download" in kwargs:
        sandbox.download_file.return_value = kwargs["download"]
    return sandbox


def _make_symlink(target: Path, link: Path) -> None:
    try:
        os.symlink(target, link)
    except (OSError, NotImplementedError):  # pragma: no cover - platform dependent
        pytest.skip("symlinks are unavailable in this environment")


def _converter_config() -> dict[str, Any]:
    return {"fbx_to_obj": {"from": ".fbx", "to": ".obj", "command": "assimp", "args": ["export", "{in}", "{out}"], "timeout_seconds": 42}}


# ── operation dispatch ────────────────────────────────────────────────────────


def test_unsupported_operation_raises() -> None:
    with pytest.raises(WorkflowExecutionError, match="unsupported operation"):
        _run_asset({"operation": "move"}, {})


def test_missing_source_raises() -> None:
    with pytest.raises(WorkflowExecutionError, match="missing required param 'path'"):
        _run_asset({"operation": "inspect"}, {})


# ── inspect ───────────────────────────────────────────────────────────────────


def test_inspect_host_file(tmp_path: Path) -> None:
    _configure_assets(roots=[str(tmp_path)])
    target = tmp_path / "chair.fbx"
    target.write_bytes(b"payload")

    result = _run_asset({"operation": "inspect", "path": str(target)}, {})

    ref = result["out"]
    assert ref["scope"] == "host"
    assert ref["path"] == str(target)
    assert ref["size"] == 7
    assert ref["sha256"] == hashlib.sha256(b"payload").hexdigest()
    assert ref["extension"] == ".fbx"
    assert ref["mtime"] is not None
    assert ref["uri"].startswith("asset://host/")
    assert result["asset"] == ref
    assert result["assets"] == [ref]


def test_inspect_host_file_without_hash(tmp_path: Path) -> None:
    _configure_assets(roots=[str(tmp_path)])
    target = tmp_path / "chair.fbx"
    target.write_bytes(b"payload")

    result = _run_asset({"operation": "inspect", "path": str(target), "hash": False}, {})

    assert result["out"]["sha256"] is None
    assert result["out"]["size"] == 7


def test_inspect_host_file_outside_roots(tmp_path: Path) -> None:
    allowed = tmp_path / "allowed"
    allowed.mkdir()
    _configure_assets(roots=[str(allowed)])
    outside = tmp_path / "outside.fbx"
    outside.write_bytes(b"x")

    with pytest.raises(WorkflowExecutionError, match="outside assets.roots"):
        _run_asset({"operation": "inspect", "path": str(outside)}, {})


def test_inspect_host_file_requires_roots(tmp_path: Path) -> None:
    target = tmp_path / "chair.fbx"
    target.write_bytes(b"x")

    with pytest.raises(WorkflowExecutionError, match="host asset transfer is disabled"):
        _run_asset({"operation": "inspect", "path": str(target)}, {})


def test_inspect_rejects_symlinked_host_file(tmp_path: Path) -> None:
    _configure_assets(roots=[str(tmp_path)])
    real = tmp_path / "real.fbx"
    real.write_bytes(b"x")
    link = tmp_path / "link.fbx"
    _make_symlink(real, link)

    with pytest.raises(WorkflowExecutionError, match="symlinked"):
        _run_asset({"operation": "inspect", "path": str(link)}, {})


def test_inspect_rejects_symlink_escaping_roots(tmp_path: Path) -> None:
    root = tmp_path / "root"
    root.mkdir()
    outside = tmp_path / "outside.fbx"
    outside.write_bytes(b"x")
    link = root / "escape.fbx"
    _make_symlink(outside, link)
    _configure_assets(roots=[str(root)])

    with pytest.raises(WorkflowExecutionError, match="symlinked|escapes assets.roots"):
        _run_asset({"operation": "inspect", "path": str(link)}, {})


def test_inspect_missing_host_file(tmp_path: Path) -> None:
    _configure_assets(roots=[str(tmp_path)])

    with pytest.raises(WorkflowExecutionError, match="cannot access"):
        _run_asset({"operation": "inspect", "path": str(tmp_path / "missing.fbx")}, {})


def test_inspect_rejects_directory(tmp_path: Path) -> None:
    _configure_assets(roots=[str(tmp_path)])
    directory = tmp_path / "models"
    directory.mkdir()

    with pytest.raises(WorkflowExecutionError, match="not a regular file"):
        _run_asset({"operation": "inspect", "path": str(directory)}, {})


def test_inspect_sandbox_asset(monkeypatch: pytest.MonkeyPatch) -> None:
    sandbox = _mock_sandbox(download=b"hello world")
    _install_sandbox(monkeypatch, sandbox)
    _configure_assets(roots=[])

    result = _run_asset({"operation": "inspect", "path": "/mnt/user-data/workspace/a.txt"}, {})

    ref = result["out"]
    assert ref["scope"] == "workspace"
    assert ref["path"] == "/mnt/user-data/workspace/a.txt"
    assert ref["size"] == 11
    assert ref["sha256"] == hashlib.sha256(b"hello world").hexdigest()
    assert ref["mtime"] is None
    sandbox.download_file.assert_called_once_with("/mnt/user-data/workspace/a.txt")


def test_inspect_sandbox_asset_without_hash(monkeypatch: pytest.MonkeyPatch) -> None:
    _install_sandbox(monkeypatch, _mock_sandbox(download=b"hello"))

    result = _run_asset({"operation": "inspect", "path": "/mnt/user-data/outputs/a.txt", "hash": False}, {})

    assert result["out"]["sha256"] is None
    assert result["out"]["scope"] == "outputs"


def test_inspect_sandbox_asset_above_max_bytes(monkeypatch: pytest.MonkeyPatch) -> None:
    _install_sandbox(monkeypatch, _mock_sandbox(download=b"0123456789"))
    _configure_assets(max_bytes=4)

    with pytest.raises(WorkflowExecutionError, match="above assets.max_bytes"):
        _run_asset({"operation": "inspect", "path": "/mnt/user-data/workspace/big.bin"}, {})


def test_inspect_accepts_asset_uri(monkeypatch: pytest.MonkeyPatch) -> None:
    _install_sandbox(monkeypatch, _mock_sandbox(download=b"x"))

    result = _run_asset({"operation": "inspect", "path": "asset://uploads/source.psd"}, {})

    assert result["out"]["scope"] == "uploads"
    assert result["out"]["path"] == "/mnt/user-data/uploads/source.psd"


def test_inspect_accepts_ref_dict_from_input_port(monkeypatch: pytest.MonkeyPatch) -> None:
    _install_sandbox(monkeypatch, _mock_sandbox(download=b"x"))

    result = _run_asset({"operation": "inspect"}, {"in": {"uri": "asset://workspace/a.fbx", "path": "/mnt/user-data/workspace/a.fbx", "scope": "workspace"}})

    assert result["out"]["scope"] == "workspace"
    assert result["out"]["path"] == "/mnt/user-data/workspace/a.fbx"


def test_inspect_explicit_scope_overrides_inference(tmp_path: Path) -> None:
    _configure_assets(roots=[str(tmp_path)])
    target = tmp_path / "a.fbx"
    target.write_bytes(b"x")

    result = _run_asset({"operation": "inspect", "path": str(target), "scope": "host"}, {})

    assert result["out"]["scope"] == "host"


# ── contract validation ───────────────────────────────────────────────────────


def test_inspect_applies_declared_contract(tmp_path: Path) -> None:
    _configure_assets(roots=[str(tmp_path)], contracts={"blender_scene": {"extensions": [".blend"], "unit": "m"}})
    target = tmp_path / "scene.blend"
    target.write_bytes(b"x")

    result = _run_asset({"operation": "inspect", "path": str(target), "contract": "blender_scene"}, {})

    assert result["out"]["contract"] == "blender_scene"


def test_inspect_contract_mismatch_reports_expected_and_actual(tmp_path: Path) -> None:
    _configure_assets(roots=[str(tmp_path)], contracts={"blender_scene": {"extensions": [".blend"]}})
    target = tmp_path / "scene.fbx"
    target.write_bytes(b"x")

    with pytest.raises(WorkflowExecutionError) as excinfo:
        _run_asset({"operation": "inspect", "path": str(target), "contract": "blender_scene"}, {})

    assert ".fbx" in str(excinfo.value)
    assert ".blend" in str(excinfo.value)


def test_inspect_unknown_contract_raises(tmp_path: Path) -> None:
    _configure_assets(roots=[str(tmp_path)])
    target = tmp_path / "scene.blend"
    target.write_bytes(b"x")

    with pytest.raises(WorkflowExecutionError, match="not declared under assets.contracts"):
        _run_asset({"operation": "inspect", "path": str(target), "contract": "nope"}, {})


# ── import ────────────────────────────────────────────────────────────────────


def test_import_requires_crash_confirm(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    _configure_assets(roots=[str(tmp_path)])
    sandbox = _mock_sandbox()
    _install_sandbox(monkeypatch, sandbox)
    target = tmp_path / "chair.fbx"
    target.write_bytes(b"payload")

    with pytest.raises(WorkflowExecutionError, match="requires crash_confirm=true"):
        _run_asset({"operation": "import", "path": str(target)}, {})

    sandbox.update_file.assert_not_called()


def test_import_host_file_into_workspace(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    _configure_assets(roots=[str(tmp_path)])
    sandbox = _mock_sandbox()
    _install_sandbox(monkeypatch, sandbox)
    target = tmp_path / "chair.fbx"
    target.write_bytes(b"payload")

    result = _run_asset({"operation": "import", "path": str(target), "crash_confirm": True}, {})

    sandbox.update_file.assert_called_once_with("/mnt/user-data/workspace/chair.fbx", b"payload")
    ref = result["out"]
    assert ref["scope"] == "workspace"
    assert ref["path"] == "/mnt/user-data/workspace/chair.fbx"
    assert ref["size"] == 7
    assert ref["sha256"] == hashlib.sha256(b"payload").hexdigest()
    assert ref["uri"] == "asset://workspace/chair.fbx"


def test_import_honours_destination_and_subpath(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    _configure_assets(roots=[str(tmp_path)])
    sandbox = _mock_sandbox()
    _install_sandbox(monkeypatch, sandbox)
    target = tmp_path / "chair.fbx"
    target.write_bytes(b"payload")

    result = _run_asset(
        {"operation": "import", "path": str(target), "crash_confirm": True, "destination": "outputs", "destination_path": "models/chair.fbx"},
        {},
    )

    sandbox.update_file.assert_called_once_with("/mnt/user-data/outputs/models/chair.fbx", b"payload")
    assert result["out"]["scope"] == "outputs"


def test_import_rejects_invalid_destination(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    _configure_assets(roots=[str(tmp_path)])
    _install_sandbox(monkeypatch, _mock_sandbox())
    target = tmp_path / "chair.fbx"
    target.write_bytes(b"payload")

    with pytest.raises(WorkflowExecutionError, match="must be one of"):
        _run_asset({"operation": "import", "path": str(target), "crash_confirm": True, "destination": "/etc"}, {})


def test_import_rejects_sandbox_source(monkeypatch: pytest.MonkeyPatch) -> None:
    _install_sandbox(monkeypatch, _mock_sandbox())

    with pytest.raises(WorkflowExecutionError, match="import expects a host path"):
        _run_asset({"operation": "import", "path": "/mnt/user-data/workspace/a.fbx", "crash_confirm": True}, {})


def test_import_rejects_oversized_file(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    _configure_assets(roots=[str(tmp_path)], max_bytes=3)
    sandbox = _mock_sandbox()
    _install_sandbox(monkeypatch, sandbox)
    target = tmp_path / "chair.fbx"
    target.write_bytes(b"payload")

    with pytest.raises(WorkflowExecutionError, match="above assets.max_bytes"):
        _run_asset({"operation": "import", "path": str(target), "crash_confirm": True}, {})

    sandbox.update_file.assert_not_called()


def test_import_outside_roots_rejected(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    allowed = tmp_path / "allowed"
    allowed.mkdir()
    _configure_assets(roots=[str(allowed)])
    sandbox = _mock_sandbox()
    _install_sandbox(monkeypatch, sandbox)
    outside = tmp_path / "outside.fbx"
    outside.write_bytes(b"payload")

    with pytest.raises(WorkflowExecutionError, match="outside assets.roots"):
        _run_asset({"operation": "import", "path": str(outside), "crash_confirm": True}, {})

    sandbox.update_file.assert_not_called()


# ── export ────────────────────────────────────────────────────────────────────


def test_export_requires_crash_confirm(monkeypatch: pytest.MonkeyPatch) -> None:
    sandbox = _mock_sandbox(download=b"data")
    _install_sandbox(monkeypatch, sandbox)

    with pytest.raises(WorkflowExecutionError, match="requires crash_confirm=true"):
        _run_asset({"operation": "export", "path": "/mnt/user-data/outputs/a.obj"}, {})


def test_export_sandbox_asset_to_host_root(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    _configure_assets(roots=[str(tmp_path)])
    _install_sandbox(monkeypatch, _mock_sandbox(download=b"obj-bytes"))

    result = _run_asset({"operation": "export", "path": "/mnt/user-data/outputs/models/chair.obj", "crash_confirm": True}, {})

    written = tmp_path / "chair.obj"
    assert written.read_bytes() == b"obj-bytes"
    ref = result["out"]
    assert ref["scope"] == "host"
    assert ref["path"] == str(written)
    assert ref["sha256"] == hashlib.sha256(b"obj-bytes").hexdigest()


def test_export_writes_atomically_without_leftovers(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    _configure_assets(roots=[str(tmp_path)])
    _install_sandbox(monkeypatch, _mock_sandbox(download=b"obj-bytes"))

    _run_asset({"operation": "export", "path": "/mnt/user-data/outputs/chair.obj", "crash_confirm": True}, {})

    assert [p.name for p in tmp_path.iterdir()] == ["chair.obj"]


def test_export_honours_relative_destination(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    _configure_assets(roots=[str(tmp_path)])
    _install_sandbox(monkeypatch, _mock_sandbox(download=b"data"))

    result = _run_asset({"operation": "export", "path": "/mnt/user-data/outputs/chair.obj", "crash_confirm": True, "destination": "renders/chair.obj"}, {})

    assert Path(result["out"]["path"]) == tmp_path / "renders" / "chair.obj"
    assert (tmp_path / "renders" / "chair.obj").read_bytes() == b"data"


def test_export_rejects_absolute_destination_outside_roots(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    allowed = tmp_path / "allowed"
    allowed.mkdir()
    _configure_assets(roots=[str(allowed)])
    _install_sandbox(monkeypatch, _mock_sandbox(download=b"data"))

    with pytest.raises(WorkflowExecutionError, match="outside assets.roots"):
        _run_asset({"operation": "export", "path": "/mnt/user-data/outputs/a.obj", "crash_confirm": True, "destination": str(tmp_path / "elsewhere.obj")}, {})


def test_export_requires_roots(monkeypatch: pytest.MonkeyPatch) -> None:
    _install_sandbox(monkeypatch, _mock_sandbox(download=b"data"))

    with pytest.raises(WorkflowExecutionError, match="host asset transfer is disabled"):
        _run_asset({"operation": "export", "path": "/mnt/user-data/outputs/a.obj", "crash_confirm": True}, {})


def test_export_rejects_host_source(tmp_path: Path) -> None:
    _configure_assets(roots=[str(tmp_path)])

    with pytest.raises(WorkflowExecutionError, match="export expects a sandbox path"):
        _run_asset({"operation": "export", "path": str(tmp_path / "a.obj"), "crash_confirm": True}, {})


def test_export_rejects_oversized_asset(monkeypatch: pytest.MonkeyPatch) -> None:
    _configure_assets(max_bytes=2)
    _install_sandbox(monkeypatch, _mock_sandbox(download=b"data"))

    with pytest.raises(WorkflowExecutionError, match="above assets.max_bytes"):
        _run_asset({"operation": "export", "path": "/mnt/user-data/outputs/a.obj", "crash_confirm": True}, {})


# ── convert ───────────────────────────────────────────────────────────────────


def test_convert_requires_crash_confirm(monkeypatch: pytest.MonkeyPatch) -> None:
    _configure_assets(converters=_converter_config())
    sandbox = _mock_sandbox(download=b"out")
    _install_sandbox(monkeypatch, sandbox)

    with pytest.raises(WorkflowExecutionError, match="requires crash_confirm=true"):
        _run_asset({"operation": "convert", "path": "/mnt/user-data/workspace/a.fbx", "converter": "fbx_to_obj"}, {})

    sandbox.execute_command.assert_not_called()


def test_convert_runs_declared_converter(monkeypatch: pytest.MonkeyPatch) -> None:
    _configure_assets(converters=_converter_config())
    sandbox = _mock_sandbox(download=b"converted", stdout="ok")
    _install_sandbox(monkeypatch, sandbox)
    _install_thread_data(monkeypatch)

    result = _run_asset({"operation": "convert", "path": "/mnt/user-data/workspace/chair.fbx", "converter": "fbx_to_obj", "crash_confirm": True}, {})

    args = sandbox.execute_command.call_args
    command = args.args[0]
    assert command.startswith("assimp export ")
    assert "/mnt/user-data/workspace/chair.fbx" in command
    assert "/mnt/user-data/outputs/chair.obj" in command
    assert args.args[2] == 42  # converter.timeout_seconds

    ref = result["out"]
    assert ref["scope"] == "outputs"
    assert ref["path"] == "/mnt/user-data/outputs/chair.obj"
    assert ref["extension"] == ".obj"
    assert ref["sha256"] == hashlib.sha256(b"converted").hexdigest()
    assert result["detail"] == "ok"


def test_convert_quotes_paths_with_spaces(monkeypatch: pytest.MonkeyPatch) -> None:
    _configure_assets(converters=_converter_config())
    sandbox = _mock_sandbox(download=b"x")
    _install_sandbox(monkeypatch, sandbox)
    _install_thread_data(monkeypatch)

    _run_asset({"operation": "convert", "path": "/mnt/user-data/workspace/my scene.fbx", "converter": "fbx_to_obj", "crash_confirm": True}, {})

    command = sandbox.execute_command.call_args.args[0]
    assert '"/mnt/user-data/workspace/my scene.fbx"' in command


def test_convert_unknown_converter_raises(monkeypatch: pytest.MonkeyPatch) -> None:
    _configure_assets(converters=_converter_config())
    _install_sandbox(monkeypatch, _mock_sandbox())

    with pytest.raises(WorkflowExecutionError, match="not declared under assets.converters"):
        _run_asset({"operation": "convert", "path": "/mnt/user-data/workspace/a.fbx", "converter": "missing", "crash_confirm": True}, {})


def test_convert_rejects_mismatched_source_extension(monkeypatch: pytest.MonkeyPatch) -> None:
    _configure_assets(converters=_converter_config())
    sandbox = _mock_sandbox()
    _install_sandbox(monkeypatch, sandbox)

    with pytest.raises(WorkflowExecutionError, match="expects .fbx"):
        _run_asset({"operation": "convert", "path": "/mnt/user-data/workspace/a.obj", "converter": "fbx_to_obj", "crash_confirm": True}, {})

    sandbox.execute_command.assert_not_called()


def test_convert_rejects_host_source(monkeypatch: pytest.MonkeyPatch) -> None:
    _configure_assets(converters=_converter_config())

    with pytest.raises(WorkflowExecutionError, match="operates on sandbox assets"):
        _run_asset({"operation": "convert", "path": "C:/models/a.fbx", "converter": "fbx_to_obj", "crash_confirm": True}, {})


def test_convert_reports_missing_output(monkeypatch: pytest.MonkeyPatch) -> None:
    _configure_assets(converters=_converter_config())
    sandbox = _mock_sandbox(stdout="boom: unsupported format")
    sandbox.download_file.side_effect = OSError("no such file")
    _install_sandbox(monkeypatch, sandbox)
    _install_thread_data(monkeypatch)

    with pytest.raises(WorkflowExecutionError) as excinfo:
        _run_asset({"operation": "convert", "path": "/mnt/user-data/workspace/a.fbx", "converter": "fbx_to_obj", "crash_confirm": True}, {})

    assert "produced no output" in str(excinfo.value)
    assert "boom" in str(excinfo.value)


def test_convert_honours_destination_scope(monkeypatch: pytest.MonkeyPatch) -> None:
    _configure_assets(converters=_converter_config())
    sandbox = _mock_sandbox(download=b"x")
    _install_sandbox(monkeypatch, sandbox)
    _install_thread_data(monkeypatch)

    result = _run_asset({"operation": "convert", "path": "/mnt/user-data/uploads/a.fbx", "converter": "fbx_to_obj", "crash_confirm": True, "destination": "workspace"}, {})

    assert result["out"]["path"] == "/mnt/user-data/workspace/a.obj"


def test_convert_applies_contract(monkeypatch: pytest.MonkeyPatch) -> None:
    _configure_assets(converters=_converter_config(), contracts={"game_ready": {"extensions": [".obj"]}})
    sandbox = _mock_sandbox(download=b"x")
    _install_sandbox(monkeypatch, sandbox)
    _install_thread_data(monkeypatch)

    result = _run_asset({"operation": "convert", "path": "/mnt/user-data/workspace/a.fbx", "converter": "fbx_to_obj", "crash_confirm": True, "contract": "game_ready"}, {})

    assert result["out"]["contract"] == "game_ready"


# ── registry wiring ───────────────────────────────────────────────────────────


def test_asset_node_is_registered_idempotent() -> None:
    from deerflow.workflow.executors import build_default_registry
    from deerflow.workflow.registry import crash_confirm_required
    from deerflow.workflow.schema import NodeType

    registration = build_default_registry().get(NodeType.DATA_ASSET)
    assert registration is not None
    assert registration.idempotent is True
    assert registration.requires_confirmation is False
    # Mutating operations gate themselves on crash_confirm rather than being
    # marked dangerous nodes.
    assert crash_confirm_required(NodeType.DATA_ASSET) is False
