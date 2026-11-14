"""Tests for model detection and download orchestration."""

from __future__ import annotations

import os
from pathlib import Path

import pytest

from video_transcribe import model_manager
from video_transcribe.errors import ModelError


def _fake_download(created: list[tuple[str, Path]]):
    def _download(repo: str, target: Path) -> None:
        target.mkdir(parents=True, exist_ok=True)
        (target / "config.json").write_text("{}", encoding="utf-8")
        created.append((repo, target))

    return _download


def test_status_empty(tmp_path: Path) -> None:
    result = model_manager.status(tmp_path)
    assert not result.asr_present
    assert not result.aligner_present
    assert not result.ready


def test_ensure_models_downloads_missing(tmp_path: Path, monkeypatch) -> None:
    created: list[tuple[str, Path]] = []
    monkeypatch.setattr(model_manager, "_download_hf", _fake_download(created))

    asr, aligner = model_manager.ensure_models(tmp_path, source="hf")

    assert asr.name == model_manager.ASR_DIRNAME
    assert aligner.name == model_manager.ALIGNER_DIRNAME
    assert len(created) == 2
    assert model_manager.status(tmp_path).ready


def test_ensure_models_skips_present(tmp_path: Path, monkeypatch) -> None:
    for name in (model_manager.ASR_DIRNAME, model_manager.ALIGNER_DIRNAME):
        target = tmp_path / name
        target.mkdir(parents=True)
        (target / "config.json").write_text("{}", encoding="utf-8")

    called: list = []
    monkeypatch.setattr(model_manager, "_download_hf", lambda *a: called.append(a))

    model_manager.ensure_models(tmp_path, source="hf")
    assert called == []


def test_ensure_models_unknown_source(tmp_path: Path) -> None:
    with pytest.raises(ModelError):
        model_manager.ensure_models(tmp_path, source="ftp")


def test_apply_proxy_sets_env(monkeypatch) -> None:
    for key in ("HTTPS_PROXY", "HTTP_PROXY", "https_proxy", "http_proxy"):
        monkeypatch.delenv(key, raising=False)

    model_manager._apply_proxy("http://proxy:8080")

    assert os.environ["HTTPS_PROXY"] == "http://proxy:8080"
    assert os.environ["HTTP_PROXY"] == "http://proxy:8080"
