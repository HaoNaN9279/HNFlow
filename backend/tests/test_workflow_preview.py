"""Tests for the N10 action-preview primitive and its registered previewers.

The preview layer is deliberately pure: these tests assert the *description*
of a mutation (targets, fingerprints, recovery claim) and that no side effect
happens.  Sandboxes are mocked; host files use ``tmp_path``.
"""

from __future__ import annotations

import hashlib
import json
import os
from pathlib import Path
from typing import Any
from unittest.mock import MagicMock

import pytest

from deerflow.apps.registry import AppRegistry
from deerflow.apps.session import AppSessionManager, reset_session_manager
from deerflow.assets.ref import make_ref
from deerflow.config.apps_config import AppDefinition, AppsConfig
from deerflow.config.assets_config import load_assets_config_from_dict, reset_assets_config
from deerflow.runtime.context_keys import APP_RUNTIME_CONTEXT_KEY
from deerflow.workflow.compiler import WorkflowRuntime
from deerflow.workflow.executors import WorkflowExecutionError, build_default_registry
from deerflow.workflow.executors.asset import preview_asset
from deerflow.workflow.executors.data import preview_file
from deerflow.workflow.executors.local_app import preview_app_launch, preview_app_script
from deerflow.workflow.preview import (
    RECOVERY_APP_UNDO,
    RECOVERY_BACKUP,
    RECOVERY_NONE,
    build_target_resolver,
    declare,
    diff_targets,
    fingerprint_host_ref,
    fingerprint_sandbox_ref,
    is_observed,
    make_preview,
    observe,
)
from deerflow.workflow.schema import NodeType

# ── helpers ───────────────────────────────────────────────────────────────────


@pytest.fixture(autouse=True)
def _reset_configs() -> Any:
    reset_assets_config()
    yield
    reset_assets_config()
    reset_session_manager()


def _runtime(context: dict[str, Any] | None = None) -> WorkflowRuntime:
    return WorkflowRuntime(context=context or {}, config={}, state={})


def _node_params(**params: Any) -> dict[str, Any]:
    """Params as the compiler injects them (node identity included)."""
    return {"node_id": "n1", "node_type": "data:file", **params}


def _sha(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def _host_ref(path: Path, *, with_hash: bool = False) -> Any:
    """An observed host ref for an existing *path*, fingerprinted like a preview would."""
    return fingerprint_host_ref(make_ref(str(path), scope="host", size=path.stat().st_size, sha256=_sha(path.read_bytes()) if with_hash else None))


# ── observed vs declared targets ──────────────────────────────────────────────


def test_declared_target_is_never_reinspected() -> None:
    ref = make_ref("/mnt/user-data/workspace/a.txt", scope="workspace")
    assert is_observed(ref) is False

    def _boom(_ref: Any) -> Any:  # pragma: no cover — must not be called
        raise AssertionError("a declared target must not be re-inspected")

    assert diff_targets([declare(ref)], _boom) == []


def test_diff_targets_reports_no_change_for_identical_fingerprint(tmp_path: Path) -> None:
    target = tmp_path / "a.txt"
    target.write_bytes(b"hello")

    assert diff_targets([observe(_host_ref(target, with_hash=True))], build_target_resolver()) == []


def test_diff_targets_reports_content_change(tmp_path: Path) -> None:
    target = tmp_path / "a.txt"
    target.write_bytes(b"hello")
    want = observe(_host_ref(target, with_hash=True))

    target.write_bytes(b"hello!")
    notes = diff_targets([want], build_target_resolver())

    assert len(notes) == 1
    assert "content changed" in notes[0]
    assert str(target) in notes[0]


def test_diff_targets_reports_disappearance(tmp_path: Path) -> None:
    target = tmp_path / "a.txt"
    target.write_bytes(b"hello")
    want = observe(_host_ref(target))

    target.unlink()
    notes = diff_targets([want], build_target_resolver())

    assert len(notes) == 1
    assert "disappeared" in notes[0]


def test_diff_targets_reports_appearance_of_an_observed_absence(tmp_path: Path) -> None:
    """ "Observed missing" is a real observation, so an appearance must be caught.

    This is the overwrite hazard an approval exists to prevent: the human
    confirmed "create this file", and while they were deciding something
    created it.
    """
    target = tmp_path / "new.txt"
    want = observe(fingerprint_host_ref(make_ref(str(target), scope="host")))  # stat fails → observed, no fingerprint
    assert want.ref.size is None

    target.write_bytes(b"created by someone else")
    notes = diff_targets([want], build_target_resolver())

    assert len(notes) == 1
    assert "appeared" in notes[0]


def test_diff_targets_reports_size_and_mtime_changes(tmp_path: Path) -> None:
    target = tmp_path / "a.txt"
    target.write_bytes(b"hello")
    stat_result = target.stat()
    want = observe(make_ref(str(target), scope="host", size=int(stat_result.st_size), mtime=float(stat_result.st_mtime)))

    target.write_bytes(b"hello world")
    notes = diff_targets([want], build_target_resolver())
    assert len(notes) == 1
    assert "size changed" in notes[0]

    # Same size, stale mtime → the weakest signal still catches it.
    target.write_bytes(b"hello")
    stale = observe(make_ref(str(target), scope="host", size=5, mtime=float(target.stat().st_mtime) - 100.0))
    notes = diff_targets([stale], build_target_resolver())
    assert len(notes) == 1
    assert "modified since the preview" in notes[0]


def test_diff_targets_reports_resolver_failure() -> None:
    def _boom(_ref: Any) -> Any:
        raise RuntimeError("probe unavailable")

    notes = diff_targets([observe(make_ref("/tmp/x", scope="host", size=1))], _boom)
    assert len(notes) == 1
    assert "cannot re-inspect" in notes[0]


def test_sandbox_resolver_requires_a_sandbox() -> None:
    ref = make_ref("/mnt/user-data/workspace/a.txt", scope="workspace")
    with pytest.raises(RuntimeError, match="no sandbox"):
        build_target_resolver()(ref)


def test_fingerprint_sandbox_ref_downloads_content() -> None:
    sandbox = MagicMock()
    sandbox.download_file.return_value = b"payload"
    ref = make_ref("/mnt/user-data/workspace/a.txt", scope="workspace", size=1, sha256=_sha(b"payload"))

    current = fingerprint_sandbox_ref(ref, sandbox)

    assert current.size == 7
    assert current.sha256 == _sha(b"payload")
    assert current.mtime is None  # the abstract Sandbox exposes no stat


def test_fingerprint_host_ref_hashes_only_when_expected(tmp_path: Path) -> None:
    target = tmp_path / "a.bin"
    target.write_bytes(b"payload")

    without_hash = fingerprint_host_ref(make_ref(str(target), scope="host", size=7))
    assert without_hash.size == 7
    assert without_hash.sha256 is None

    with_hash = fingerprint_host_ref(make_ref(str(target), scope="host", size=7, sha256=_sha(b"payload")))
    assert with_hash.sha256 == _sha(b"payload")


def test_make_preview_uses_compiler_injected_identity() -> None:
    preview = make_preview(_node_params(), action="x", summary="s", reversible=False, recovery=RECOVERY_NONE)

    assert preview.node_id == "n1"
    assert preview.node_type == "data:file"
    assert json.loads(json.dumps(preview.to_port()))["action"] == "x"


# ── data:file preview ─────────────────────────────────────────────────────────


def test_preview_file_returns_none_for_read() -> None:
    assert preview_file(_runtime(), _node_params(operation="read", path="/mnt/user-data/workspace/a.txt"), {}) is None


def test_preview_file_write_declares_target_without_content() -> None:
    preview = preview_file(
        _runtime(),
        _node_params(operation="write", path="/mnt/user-data/workspace/a.txt", content="secret-value"),
        {},
    )

    assert preview is not None
    assert preview.action == "overwrite_file"
    assert preview.reversible is True
    assert preview.recovery == RECOVERY_BACKUP
    assert [t.ref.path for t in preview.targets] == ["/mnt/user-data/workspace/a.txt"]
    assert preview.targets[0].observed is False  # sandbox target: declared, not downloaded
    assert preview.required_confirmations == ["crash_confirm"]
    # The content length is reported; the content itself never is.
    assert "12 characters" in preview.summary
    assert "secret-value" not in json.dumps(preview.to_port())


def test_preview_file_append_mode() -> None:
    preview = preview_file(
        _runtime(),
        _node_params(operation="write", path="/mnt/user-data/workspace/a.txt", content="x", append=True),
        {},
    )
    assert preview is not None
    assert preview.action == "append_file"
    assert "Append" in preview.summary


def test_preview_file_write_without_path_raises() -> None:
    with pytest.raises(WorkflowExecutionError, match="missing required param 'path'"):
        preview_file(_runtime(), _node_params(operation="write"), {})


# ── data:asset preview ────────────────────────────────────────────────────────


def test_preview_asset_returns_none_for_inspect() -> None:
    assert preview_asset(_runtime(), _node_params(operation="inspect", path="/tmp/a.fbx"), {}) is None


def test_preview_asset_import_observes_host_source(tmp_path: Path) -> None:
    load_assets_config_from_dict({"roots": [str(tmp_path)]})
    source = tmp_path / "chair.fbx"
    source.write_bytes(b"payload")

    preview = preview_asset(_runtime(), _node_params(operation="import", path=str(source)), {})

    assert preview is not None
    assert preview.action == "import_asset"
    assert preview.recovery == RECOVERY_BACKUP
    assert preview.sources[0].observed is True
    assert preview.sources[0].ref.sha256 == _sha(b"payload")
    # Sandbox target is declared only — no download just to describe the write.
    assert [t.ref.path for t in preview.targets] == ["/mnt/user-data/workspace/chair.fbx"]
    assert preview.targets[0].observed is False
    assert preview.risks == []


def test_preview_asset_import_declares_an_unreachable_source(tmp_path: Path) -> None:
    source = tmp_path / "chair.fbx"
    source.write_bytes(b"payload")

    preview = preview_asset(_runtime(), _node_params(operation="import", path=str(source)), {})

    assert preview is not None
    assert preview.sources[0].observed is False  # roots unset → nothing was inspected
    assert any("assets.roots is empty" in risk for risk in preview.risks)


def test_preview_asset_import_warns_when_source_exceeds_max_bytes(tmp_path: Path) -> None:
    load_assets_config_from_dict({"roots": [str(tmp_path)], "max_bytes": 4})
    source = tmp_path / "chair.fbx"
    source.write_bytes(b"payload")

    preview = preview_asset(_runtime(), _node_params(operation="import", path=str(source)), {})

    assert preview is not None
    assert any("assets.max_bytes" in risk for risk in preview.risks)


def test_preview_asset_import_requires_host_scope(tmp_path: Path) -> None:
    with pytest.raises(WorkflowExecutionError, match="import expects a host path"):
        preview_asset(_runtime(), _node_params(operation="import", path="/mnt/user-data/workspace/a.fbx"), {})


def test_preview_asset_export_observes_host_target_and_warns_on_overwrite(tmp_path: Path) -> None:
    load_assets_config_from_dict({"roots": [str(tmp_path)]})
    existing = tmp_path / "out.obj"
    existing.write_bytes(b"old")

    preview = preview_asset(
        _runtime(),
        _node_params(operation="export", path="/mnt/user-data/outputs/out.obj", hash=False),
        {},
    )

    assert preview is not None
    assert preview.action == "export_asset"
    assert [t.ref.path for t in preview.targets] == [os.path.normpath(str(existing))]
    assert preview.targets[0].observed is True  # the hazard is here, so it is inspected
    assert preview.targets[0].ref.size == 3
    assert any("already exists" in risk for risk in preview.risks)
    assert preview.required_confirmations == ["crash_confirm"]


def test_preview_asset_export_declares_target_without_roots(tmp_path: Path) -> None:
    preview = preview_asset(
        _runtime(),
        _node_params(operation="export", path="/mnt/user-data/outputs/out.obj", destination=str(tmp_path / "elsewhere.obj"), hash=False),
        {},
    )

    assert preview is not None
    assert preview.targets[0].observed is False
    assert any("assets.roots is empty" in risk for risk in preview.risks)


def test_preview_asset_export_rejects_host_source() -> None:
    with pytest.raises(WorkflowExecutionError, match="export expects a sandbox path"):
        preview_asset(_runtime(), _node_params(operation="export", path="/tmp/a.obj"), {})


def test_preview_asset_convert_unknown_converter_raises() -> None:
    with pytest.raises(WorkflowExecutionError, match="not declared under assets.converters"):
        preview_asset(_runtime(), _node_params(operation="convert", converter="nope", path="/mnt/user-data/workspace/a.fbx"), {})


def test_preview_asset_convert_describes_command_sandbox_execution(tmp_path: Path) -> None:
    load_assets_config_from_dict(
        {
            "converters": {"fbx_to_obj": {"from": ".fbx", "to": ".obj", "command": "assimp", "args": ["export", "{in}", "{out}"]}},
        }
    )

    preview = preview_asset(
        _runtime(),
        _node_params(operation="convert", converter="fbx_to_obj", path="/mnt/user-data/workspace/chair.fbx"),
        {},
    )

    assert preview is not None
    assert preview.action == "convert_asset"
    assert [t.ref.path for t in preview.targets] == ["/mnt/user-data/outputs/chair.obj"]
    assert "sandbox" in preview.summary


def test_preview_asset_unsupported_operation_raises() -> None:
    with pytest.raises(WorkflowExecutionError, match="unsupported operation"):
        preview_asset(_runtime(), _node_params(operation="move", path="/tmp/a.fbx"), {})


# ── app preview ───────────────────────────────────────────────────────────────


def _manager(tmp_path: Path) -> AppSessionManager:
    config = AppsConfig(enabled=True, definitions={"demo": AppDefinition(driver="mock", description="demo", working_dir=str(tmp_path))})
    return AppSessionManager(AppRegistry.from_config(config))


def test_preview_app_launch_describes_instance(tmp_path: Path) -> None:
    runtime = _runtime({APP_RUNTIME_CONTEXT_KEY: _manager(tmp_path)})

    preview = preview_app_launch(runtime, _node_params(app="demo"), {})

    assert preview.action == "launch_app"
    assert "demo" in preview.summary
    assert preview.reversible is False
    assert preview.recovery == RECOVERY_NONE
    assert preview.required_confirmations == ["crash_confirm"]


def test_preview_app_launch_attach_mode(tmp_path: Path) -> None:
    runtime = _runtime({APP_RUNTIME_CONTEXT_KEY: _manager(tmp_path)})

    preview = preview_app_launch(runtime, _node_params(app="demo", mode="attach"), {})

    assert preview.action == "attach_app"
    assert preview.summary.startswith("Attach to")


def test_preview_app_script_without_undo_support_is_irreversible(tmp_path: Path) -> None:
    """A driver that declares no undo support makes the action irreversible.

    (The generic ``cli`` driver states that plainly — a bare subprocess has no
    undo history the engine can drive.)
    """
    config = AppsConfig(enabled=True, definitions={"demo": AppDefinition(driver="cli", description="demo", command="demo-bin", working_dir=str(tmp_path))})
    runtime = _runtime({APP_RUNTIME_CONTEXT_KEY: AppSessionManager(AppRegistry.from_config(config))})

    preview = preview_app_script(runtime, _node_params(app="demo", script="render", args=["--x"]), {})

    assert preview.action == "run_script"
    assert preview.reversible is False
    assert preview.recovery == RECOVERY_NONE
    assert "render" in preview.summary
    assert "1 argument(s)" in preview.summary
    assert any("no undo support" in risk for risk in preview.risks)


def test_preview_app_script_with_undo_support_is_reversible(tmp_path: Path) -> None:
    """The mock driver implements native undo (N10), so the action is compensable."""
    runtime = _runtime({APP_RUNTIME_CONTEXT_KEY: _manager(tmp_path)})

    preview = preview_app_script(runtime, _node_params(app="demo", script="render"), {})

    assert preview.reversible is True
    assert preview.recovery == RECOVERY_APP_UNDO


def test_preview_app_script_missing_app_raises(tmp_path: Path) -> None:
    runtime = _runtime({APP_RUNTIME_CONTEXT_KEY: _manager(tmp_path)})
    with pytest.raises(WorkflowExecutionError, match="missing required param 'app'"):
        preview_app_script(runtime, _node_params(), {})


# ── registry plumbing ─────────────────────────────────────────────────────────


def test_default_registry_exposes_previews_for_mutating_types() -> None:
    context = build_default_registry().build_context()

    assert set(context.previews) == {
        NodeType.DATA_FILE,
        NodeType.DATA_ASSET,
        NodeType.APP_LAUNCH,
        NodeType.APP_SCRIPT,
    }
    # Read-only / control-flow types have nothing to preview.
    assert NodeType.FLOW_WAIT not in context.previews
    assert NodeType.APP_COLLECT not in context.previews
    assert NodeType.HUMAN_TASK not in context.previews


def test_placeholder_registry_has_no_previews() -> None:
    from deerflow.workflow.registry import _build_placeholder_registry

    assert _build_placeholder_registry().build_context().previews == {}
