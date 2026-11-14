"""Tests for local video import."""

from __future__ import annotations

from pathlib import Path

import pytest

from video_transcribe.downloader import import_video
from video_transcribe.errors import DownloadError


def test_import_video_creates_job(tmp_path: Path) -> None:
    source = tmp_path / "My Clip.mp4"
    source.write_bytes(b"video")
    out_root = tmp_path / "out"
    out_root.mkdir()

    job = import_video(source, out_root)

    assert job.root == out_root / "My Clip"
    assert job.meta.title == "My Clip"
    assert job.meta.url == ""
    assert job.video_path == source.resolve()
    assert (job.root / "job.json").is_file()


def test_import_video_missing_raises(tmp_path: Path) -> None:
    with pytest.raises(DownloadError):
        import_video(tmp_path / "nope.mp4", tmp_path)
