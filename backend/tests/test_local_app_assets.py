"""Tests for N9 asset reporting in ``app:collect``.

The mock driver writes a real file into the app working directory, so the
collected host artifact can be fingerprinted for real (size / mtime / SHA-256)
while everything else stays offline.
"""

from __future__ import annotations

import asyncio
from pathlib import Path

import pytest

from deerflow.apps.drivers.mock import MOCK_ARTIFACT_NAME
from deerflow.apps.registry import AppRegistry
from deerflow.apps.session import AppSessionManager, reset_session_manager
from deerflow.assets.ref import AssetRef, fingerprint_file
from deerflow.config.apps_config import AppDefinition, AppsConfig
from deerflow.runtime.context_keys import APP_RUNTIME_CONTEXT_KEY
from deerflow.workflow.compiler import WorkflowRuntime
from deerflow.workflow.executors.local_app import _artifact_refs, exec_app_collect, exec_app_launch, exec_app_script


@pytest.fixture(autouse=True)
def _cleanup() -> object:
    yield
    reset_session_manager()


def _manager(tmp_path: Path) -> AppSessionManager:
    config = AppsConfig(enabled=True, definitions={"demo": AppDefinition(driver="mock", description="demo", working_dir=str(tmp_path))})
    return AppSessionManager(AppRegistry.from_config(config))


def _runtime(manager: AppSessionManager) -> WorkflowRuntime:
    return WorkflowRuntime(context={APP_RUNTIME_CONTEXT_KEY: manager}, state={})


def _collect(tmp_path: Path, *, params: dict | None = None, run_script: bool = True) -> dict:
    manager = _manager(tmp_path)
    rt = _runtime(manager)
    launched = asyncio.run(exec_app_launch(rt, {"app": "demo", "crash_confirm": True}, {}))
    session = launched["session"]
    if run_script:
        scripted = asyncio.run(exec_app_script(rt, {"app": "demo", "script": "render", "crash_confirm": True}, {"session": session}))
        session = scripted["session"]
    return asyncio.run(exec_app_collect(rt, {"app": "demo", **(params or {})}, {"session": session}))


def test_collect_reports_asset_refs_without_hash_by_default(tmp_path: Path) -> None:
    collected = _collect(tmp_path)

    assets = collected["assets"]
    assert len(assets) == 1
    ref = AssetRef.model_validate(assets[0])
    assert ref.scope == "host"
    assert Path(ref.path).name == MOCK_ARTIFACT_NAME
    assert ref.source == "app:collect"
    assert ref.size is not None and ref.size > 0
    assert ref.mtime is not None
    assert ref.sha256 is None  # hashing is opt-in
    assert ref.extension == ".txt"


def test_collect_backwards_compatible_outputs(tmp_path: Path) -> None:
    collected = _collect(tmp_path)

    assert collected["artifacts"] == [collected["out"]]
    assert collected["assets"][0]["path"] == collected["out"]
    assert collected["session"]["app_name"] == "demo"


def test_collect_hashes_when_requested(tmp_path: Path) -> None:
    collected = _collect(tmp_path, params={"hash": True})

    ref = AssetRef.model_validate(collected["assets"][0])
    assert ref.sha256 == fingerprint_file(ref.path)


def test_collect_reports_every_matched_artifact(tmp_path: Path) -> None:
    (tmp_path / "extra.txt").write_text("second", encoding="utf-8")

    collected = _collect(tmp_path, params={"globs": ["*.txt"]})

    assert len(collected["artifacts"]) == 2
    assert len(collected["assets"]) == 2
    assert {Path(ref["path"]).name for ref in collected["assets"]} == {MOCK_ARTIFACT_NAME, "extra.txt"}


def test_collect_with_no_matches_returns_empty_assets(tmp_path: Path) -> None:
    collected = _collect(tmp_path, params={"globs": ["*.nope"]})

    assert collected["artifacts"] == []
    assert collected["out"] is None
    assert collected["assets"] == []


def test_artifact_refs_tolerate_vanished_files(tmp_path: Path) -> None:
    missing = str(tmp_path / "gone.fbx")

    refs = _artifact_refs([missing], want_hash=True)

    assert len(refs) == 1
    assert refs[0]["path"] == missing
    assert refs[0]["size"] is None
    assert refs[0]["sha256"] is None
    assert refs[0]["mtime"] is None


def test_artifact_refs_are_json_safe(tmp_path: Path) -> None:
    import json

    target = tmp_path / "a.fbx"
    target.write_bytes(b"x")

    refs = _artifact_refs([str(target)], want_hash=False)

    assert json.loads(json.dumps(refs))[0]["uri"].startswith("asset://host/")
