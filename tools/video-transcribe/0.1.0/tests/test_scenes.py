"""Tests for scene-change detection."""

from __future__ import annotations

from pathlib import Path

from video_transcribe import scenes
from video_transcribe.paths import Job, JobMeta
from video_transcribe.scenes import SceneList


def _job(tmp_path: Path) -> Job:
    meta = JobMeta(title="t", slug="t", video="t.mp4")
    job = Job.create(tmp_path / "t", meta)
    job.video_path.write_bytes(b"video")
    return job


def test_detect_writes_scenes_json(tmp_path: Path, monkeypatch) -> None:
    job = _job(tmp_path)
    monkeypatch.setattr(scenes, "scene_change_times", lambda path, *, threshold: [0.0, 12.3, 27.8])

    result = scenes.detect(job, threshold=0.3)

    assert result.scenes == [0.0, 12.3, 27.8]
    assert job.scenes_path.is_file()
    reloaded = SceneList.load(job.scenes_path)
    assert reloaded.threshold == 0.3
    assert reloaded.scenes == [0.0, 12.3, 27.8]
