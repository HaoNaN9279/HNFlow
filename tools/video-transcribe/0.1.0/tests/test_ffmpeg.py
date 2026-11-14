"""Tests for ffmpeg command construction."""

from __future__ import annotations

import subprocess
from pathlib import Path
from types import SimpleNamespace

import pytest

from video_transcribe import ffmpeg
from video_transcribe.errors import (
    AudioExtractionError,
    FrameCaptureError,
    ProbeError,
    SceneDetectionError,
)


def _patch_probe(monkeypatch, codec: str = "", duration: float = 0.0) -> None:
    """Make the header probe return a fixed codec/duration (no subprocess)."""
    monkeypatch.setattr(ffmpeg, "probe_video", lambda path: (duration, codec))


def test_extract_audio_builds_command(tmp_path: Path, monkeypatch) -> None:
    monkeypatch.setattr(ffmpeg, "get_ffmpeg", lambda: "ffmpeg-x")
    _patch_probe(monkeypatch)
    calls: list[list[str]] = []
    monkeypatch.setattr(ffmpeg.subprocess, "run", lambda cmd, **kw: calls.append(cmd))

    out = tmp_path / "audio" / "a.wav"
    ffmpeg.extract_audio(tmp_path / "v.mp4", out)

    assert calls[0][0] == "ffmpeg-x"
    assert "-vn" in calls[0]
    assert "pcm_s16le" in calls[0]
    assert str(out) == calls[0][-1]


def test_capture_frame_builds_command(tmp_path: Path, monkeypatch) -> None:
    monkeypatch.setattr(ffmpeg, "get_ffmpeg", lambda: "ffmpeg-x")
    _patch_probe(monkeypatch)
    calls: list[list[str]] = []
    monkeypatch.setattr(ffmpeg.subprocess, "run", lambda cmd, **kw: calls.append(cmd))

    out = tmp_path / "frame.png"
    ffmpeg.capture_frame(tmp_path / "v.mp4", 12.5, out)

    assert calls[0][0] == "ffmpeg-x"
    assert "-ss" in calls[0]
    assert "12.500" in calls[0]
    assert str(out) == calls[0][-1]


def test_capture_frame_window_uses_thumbnail_filter(tmp_path: Path, monkeypatch) -> None:
    monkeypatch.setattr(ffmpeg, "get_ffmpeg", lambda: "ffmpeg-x")
    _patch_probe(monkeypatch)
    calls: list[list[str]] = []
    monkeypatch.setattr(ffmpeg.subprocess, "run", lambda cmd, **kw: calls.append(cmd))

    out = tmp_path / "frame.png"
    ffmpeg.capture_frame_window(tmp_path / "v.mp4", 10.0, 14.0, out)

    assert "thumbnail" in calls[0]
    assert "-t" in calls[0]
    assert "4.000" in calls[0]  # duration = end - start


def test_extract_thumbnails_builds_command(tmp_path: Path, monkeypatch) -> None:
    monkeypatch.setattr(ffmpeg, "get_ffmpeg", lambda: "ffmpeg-x")
    _patch_probe(monkeypatch)
    calls: list[list[str]] = []

    def fake_run(cmd, **kw):
        calls.append(cmd)
        (tmp_path / "thumbs").mkdir(exist_ok=True)
        (tmp_path / "thumbs" / "thumb_00001.png").write_bytes(b"png")

    monkeypatch.setattr(ffmpeg.subprocess, "run", fake_run)

    count = ffmpeg.extract_thumbnails(
        tmp_path / "v.mp4", tmp_path / "thumbs", interval=2.0, width=240
    )

    assert "fps=1/2.0,scale=240:-2" in calls[0]
    assert count == 1


def test_extract_thumbnails_rejects_non_positive_interval(tmp_path: Path) -> None:
    with pytest.raises(ProbeError):
        ffmpeg.extract_thumbnails(tmp_path / "v.mp4", tmp_path / "t", interval=0, width=240)


def test_tile_images_builds_command(tmp_path: Path, monkeypatch) -> None:
    monkeypatch.setattr(ffmpeg, "get_ffmpeg", lambda: "ffmpeg-x")
    calls: list[list[str]] = []

    def fake_run(cmd, **kw):
        calls.append(cmd)
        (tmp_path / "sheet_0001.png").write_bytes(b"png")

    monkeypatch.setattr(ffmpeg.subprocess, "run", fake_run)

    sheets = ffmpeg.tile_images(
        str(tmp_path / "thumb_%05d.png"),
        tmp_path / "sheet_%04d.png",
        cols=5,
        rows=4,
    )

    assert "tile=5x4" in calls[0]
    assert len(sheets) == 1


def test_scene_change_times_parses_pts(tmp_path: Path, monkeypatch) -> None:
    monkeypatch.setattr(ffmpeg, "get_ffmpeg", lambda: "ffmpeg-x")
    _patch_probe(monkeypatch)
    stderr = (
        b"frame:0 pts:0 pts_time:4.766667\n"
        b"lavfi.scene_score=0.5\n"
        b"frame:1 pts:0 pts_time:12.5\n"
        b"lavfi.scene_score=0.4\n"
    )
    monkeypatch.setattr(
        ffmpeg.subprocess,
        "run",
        lambda cmd, **kw: SimpleNamespace(stderr=stderr),
    )

    times = ffmpeg.scene_change_times(tmp_path / "v.mp4", threshold=0.3)

    assert times == [0.0, 4.767, 12.5]


def test_extract_audio_failure_raises(tmp_path: Path, monkeypatch) -> None:
    monkeypatch.setattr(ffmpeg, "get_ffmpeg", lambda: "ffmpeg-x")
    _patch_probe(monkeypatch)

    def boom(cmd, **kw):
        raise subprocess.CalledProcessError(1, cmd, stderr=b"nope")

    monkeypatch.setattr(ffmpeg.subprocess, "run", boom)

    with pytest.raises(AudioExtractionError):
        ffmpeg.extract_audio(tmp_path / "v.mp4", tmp_path / "a.wav")


def test_capture_frame_failure_raises(tmp_path: Path, monkeypatch) -> None:
    monkeypatch.setattr(ffmpeg, "get_ffmpeg", lambda: "ffmpeg-x")
    _patch_probe(monkeypatch)

    def boom(cmd, **kw):
        raise subprocess.CalledProcessError(1, cmd, stderr=b"nope")

    monkeypatch.setattr(ffmpeg.subprocess, "run", boom)

    with pytest.raises(FrameCaptureError):
        ffmpeg.capture_frame(tmp_path / "v.mp4", 1.0, tmp_path / "f.png")


def test_scene_detection_failure_raises(tmp_path: Path, monkeypatch) -> None:
    monkeypatch.setattr(ffmpeg, "get_ffmpeg", lambda: "ffmpeg-x")
    _patch_probe(monkeypatch)

    def boom(cmd, **kw):
        raise subprocess.CalledProcessError(1, cmd, stderr=b"nope")

    monkeypatch.setattr(ffmpeg.subprocess, "run", boom)

    with pytest.raises(SceneDetectionError):
        ffmpeg.scene_change_times(tmp_path / "v.mp4")
