"""Tests for visual pre-sampling (probe)."""

from __future__ import annotations

from pathlib import Path

from video_transcribe import ffmpeg, probe
from video_transcribe.paths import Job, JobMeta


def _job(tmp_path: Path) -> Job:
    meta = JobMeta(title="t", slug="t", video="t.mp4")
    job = Job.create(tmp_path / "t", meta)
    job.video_path.write_bytes(b"video")
    return job


def _fake_extract(count: int):
    def fn(video, out_dir, *, interval, width):
        out_dir.mkdir(parents=True, exist_ok=True)
        for i in range(1, count + 1):
            (out_dir / f"thumb_{i:05d}.png").write_bytes(b"png")
        return count

    return fn


def test_probe_builds_index(tmp_path: Path, monkeypatch) -> None:
    job = _job(tmp_path)
    monkeypatch.setattr(ffmpeg, "probe_video", lambda path: (6.0, ""))
    monkeypatch.setattr(probe, "extract_thumbnails", _fake_extract(3))

    def fake_tile(input_pattern, out_pattern, *, cols, rows, scale_width=0):
        out = out_pattern.parent / "sheet_0001.png"
        out.parent.mkdir(parents=True, exist_ok=True)
        out.write_bytes(b"sheet")
        return [out]

    monkeypatch.setattr(probe, "tile_images", fake_tile)

    index = probe.generate(job, interval=3.0, cols=2, rows=2, max_samples=240)

    assert index.interval == 3.0
    assert len(index.sheets) == 1
    assert [c.time for c in index.sheets[0].cells] == [0.0, 3.0, 6.0]
    assert index.sheets[0].cells[0].thumb == "probe/thumbs/thumb_00001.png"
    assert job.probe_index_path.is_file()

    reloaded = probe.ProbeIndex.load(job.probe_index_path)
    assert reloaded.cols == 2
    assert len(reloaded.sheets[0].cells) == 3


def test_probe_widens_interval_for_max_samples(tmp_path: Path, monkeypatch) -> None:
    job = _job(tmp_path)
    monkeypatch.setattr(ffmpeg, "probe_video", lambda path: (100.0, ""))
    monkeypatch.setattr(probe, "extract_thumbnails", _fake_extract(10))
    monkeypatch.setattr(
        probe,
        "tile_images",
        lambda input_pattern, out_pattern, *, cols, rows, scale_width=0: [
            _touch(out_pattern.parent / "sheet_0001.png")
        ],
    )

    index = probe.generate(job, interval=3.0, cols=5, rows=4, max_samples=10)

    # 100s / 10 samples => effective interval widened from 3s to 10s.
    assert index.interval == 10.0


def _touch(path: Path) -> Path:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_bytes(b"sheet")
    return path
