"""Tests for job cleanup."""

from __future__ import annotations

from pathlib import Path

from video_transcribe.cleaner import clean_job
from video_transcribe.paths import Job, JobMeta


def test_clean_keeps_md_and_frames(tmp_path: Path) -> None:
    meta = JobMeta(title="t", slug="t", url="http://x", video="t.mp4")
    job = Job.create(tmp_path / "t", meta)
    (job.root / "t.mp4").write_bytes(b"video")
    (job.root / "transcript.json").write_text("{}", encoding="utf-8")
    (job.root / "marks.json").write_text("{}", encoding="utf-8")
    (job.root / "scenes.json").write_text("{}", encoding="utf-8")
    (job.root / "audio").mkdir()
    (job.root / "audio" / "t.wav").write_bytes(b"wav")
    (job.root / "probe").mkdir()
    (job.root / "probe" / "index.json").write_text("{}", encoding="utf-8")
    job.frames_dir.mkdir()
    (job.frames_dir / "frame_0001.png").write_bytes(b"png")
    (job.frames_dir / "frame_0002.png").write_bytes(b"png")
    (job.frames_dir / "manifest.json").write_text("{}", encoding="utf-8")
    (job.frames_dir / "contact_sheet_0001.png").write_bytes(b"sheet")
    job.markdown_path.write_text("# doc", encoding="utf-8")

    clean_job(job)

    assert job.markdown_path.is_file()
    assert (job.frames_dir / "frame_0001.png").is_file()
    assert (job.frames_dir / "frame_0002.png").is_file()
    # Everything else is gone.
    assert not (job.root / "t.mp4").exists()
    assert not (job.root / "transcript.json").exists()
    assert not (job.root / "marks.json").exists()
    assert not (job.root / "scenes.json").exists()
    assert not (job.root / "audio").exists()
    assert not (job.root / "probe").exists()
    assert not (job.root / "job.json").exists()
    assert not (job.frames_dir / "manifest.json").exists()
    assert not (job.frames_dir / "contact_sheet_0001.png").exists()


def test_clean_leaves_local_source_outside_job(tmp_path: Path) -> None:
    source = tmp_path / "source.mp4"
    source.write_bytes(b"video")
    meta = JobMeta(title="cam", slug="cam", url="", video=str(source))
    job = Job.create(tmp_path / "cam", meta)
    job.markdown_path.write_text("# doc", encoding="utf-8")

    clean_job(job)

    assert source.is_file()  # original file untouched
    assert job.markdown_path.is_file()
