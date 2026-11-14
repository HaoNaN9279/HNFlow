"""Tests for frame capture orchestration."""

from __future__ import annotations

import json
from pathlib import Path

import pytest

from video_transcribe import capture
from video_transcribe.capture import FrameManifest, capture_frames
from video_transcribe.errors import JobError
from video_transcribe.paths import Job, JobMeta


def _make_job(tmp_path: Path) -> Job:
    meta = JobMeta(title="t", slug="t", video="t.mp4")
    job = Job.create(tmp_path / "t", meta)
    job.video_path.write_bytes(b"video")
    return job


def _install_fakes(monkeypatch) -> dict[str, list]:
    """Patch out ffmpeg so capture writes fake files; return call log."""
    calls: dict[str, list] = {"single": [], "window": [], "sheet": []}

    def fake_single(video, time_seconds, out_png):
        out_png.parent.mkdir(parents=True, exist_ok=True)
        out_png.write_bytes(b"png")
        calls["single"].append((time_seconds, out_png.name))

    def fake_window(video, start, end, out_png):
        out_png.parent.mkdir(parents=True, exist_ok=True)
        out_png.write_bytes(b"png")
        calls["window"].append((start, end, out_png.name))

    def fake_sheet(input_pattern, out_pattern, *, cols, rows, scale_width=0):
        calls["sheet"].append((input_pattern, cols, rows))
        out = out_pattern.parent / "contact_sheet_0001.png"
        out.write_bytes(b"sheet")
        return [out]

    monkeypatch.setattr(capture, "capture_frame", fake_single)
    monkeypatch.setattr(capture, "capture_frame_window", fake_window)
    monkeypatch.setattr(capture, "tile_images", fake_sheet)
    return calls


def test_capture_writes_frames_and_manifest(tmp_path: Path, monkeypatch) -> None:
    job = _make_job(tmp_path)
    job.marks_path.write_text(
        json.dumps({"marks": [{"time": 30, "alt": "b"}, {"time": 5, "alt": "a"}]}),
        encoding="utf-8",
    )
    _install_fakes(monkeypatch)

    manifest = capture_frames(job)

    assert [f.frame for f in manifest.frames] == [
        "frames/frame_0001.png",
        "frames/frame_0002.png",
    ]
    # 按时间排序：先 5 秒
    assert manifest.frames[0].alt == "a"
    assert (job.frames_dir / "frame_0001.png").is_file()
    reloaded = FrameManifest.load(job.frames_manifest_path)
    assert len(reloaded.frames) == 2


def test_capture_uses_window_and_builds_sheet(tmp_path: Path, monkeypatch) -> None:
    job = _make_job(tmp_path)
    job.marks_path.write_text(
        json.dumps(
            {"marks": [{"start": 10, "end": 14, "alt": "a"}, {"time": 30, "alt": "b"}]}
        ),
        encoding="utf-8",
    )
    calls = _install_fakes(monkeypatch)

    capture_frames(job)

    assert calls["window"] == [(10.0, 14.0, "frame_0001.png")]
    assert calls["single"] == [(30.0, "frame_0002.png")]
    assert calls["sheet"]  # a review sheet was requested
    assert (job.frames_dir / "contact_sheet_0001.png").is_file()


def test_capture_no_sheet_skips_sheet(tmp_path: Path, monkeypatch) -> None:
    job = _make_job(tmp_path)
    job.marks_path.write_text(json.dumps({"marks": [{"time": 5, "alt": "a"}]}), encoding="utf-8")
    calls = _install_fakes(monkeypatch)

    capture_frames(job, with_sheet=False)

    assert calls["sheet"] == []
    assert not (job.frames_dir / "contact_sheet_0001.png").exists()


def test_capture_missing_marks_raises(tmp_path: Path) -> None:
    job = _make_job(tmp_path)
    with pytest.raises(JobError):
        capture_frames(job)


def test_capture_empty_marks_raises(tmp_path: Path) -> None:
    job = _make_job(tmp_path)
    job.marks_path.write_text(json.dumps({"marks": []}), encoding="utf-8")
    with pytest.raises(JobError):
        capture_frames(job)


def test_recapture_removes_stale_frames(tmp_path: Path, monkeypatch) -> None:
    job = _make_job(tmp_path)
    _install_fakes(monkeypatch)

    job.marks_path.write_text(
        json.dumps({"marks": [{"time": 5, "alt": "a"}, {"time": 20, "alt": "b"}]}),
        encoding="utf-8",
    )
    capture_frames(job)
    assert (job.frames_dir / "frame_0002.png").is_file()

    # Re-capture with fewer marks: the stale second frame must be removed.
    job.marks_path.write_text(
        json.dumps({"marks": [{"time": 5, "alt": "a"}]}), encoding="utf-8"
    )
    capture_frames(job)

    assert (job.frames_dir / "frame_0001.png").is_file()
    assert not (job.frames_dir / "frame_0002.png").exists()
