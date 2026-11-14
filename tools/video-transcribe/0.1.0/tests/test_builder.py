"""Tests for Markdown assembly."""

from __future__ import annotations

import json
from pathlib import Path

from video_transcribe.builder import build, build_markdown, format_timestamp
from video_transcribe.capture import Frame, FrameManifest
from video_transcribe.paths import Job, JobMeta
from video_transcribe.transcript import Segment, Transcript


def _job(tmp_path: Path) -> Job:
    meta = JobMeta(title="我的教程", slug="我的教程", url="http://x", video="我的教程.mp4")
    job = Job.create(tmp_path / "我的教程", meta)
    (job.video_path).write_bytes(b"v")
    return job


def test_format_timestamp() -> None:
    assert format_timestamp(0) == "00:00:00"
    assert format_timestamp(65) == "00:01:05"
    assert format_timestamp(3725) == "01:02:05"


def test_frames_inserted_after_covering_segment(tmp_path: Path) -> None:
    job = _job(tmp_path)
    transcript = Transcript(
        language="Chinese",
        text="第一段第二段",
        segments=[Segment(0, 10, "第一段"), Segment(10, 20, "第二段")],
    )
    frames = FrameManifest(
        frames=[
            Frame(time=5, frame="frames/frame_0001.png", alt="图A", note="看A"),
            Frame(time=15, frame="frames/frame_0002.png", alt="图B", note=""),
        ]
    )

    md = build_markdown(job, transcript, frames)

    assert "# 我的教程" in md
    assert "![图A](frames/frame_0001.png)" in md
    assert "![图B](frames/frame_0002.png)" in md
    # 图A 在第一段之后、第二段之前
    assert md.index("第一段") < md.index("![图A]") < md.index("第二段")
    assert md.index("第二段") < md.index("![图B]")
    assert "*[00:00:05] 看A*" in md


def test_frames_sorted_chronologically(tmp_path: Path) -> None:
    job = _job(tmp_path)
    transcript = Transcript("x", "abc", [Segment(0, 100, "abc")])
    frames = FrameManifest(
        frames=[
            Frame(time=50, frame="frames/frame_0002.png", alt="后"),
            Frame(time=10, frame="frames/frame_0001.png", alt="先"),
        ]
    )
    md = build_markdown(job, transcript, frames)
    assert md.index("先") < md.index("后")


def test_multiple_frames_embedded_after_same_segment(tmp_path: Path) -> None:
    job = _job(tmp_path)
    transcript = Transcript("x", "ab", [Segment(0, 30, "第一段")])
    frames = FrameManifest(
        frames=[
            Frame(time=5, frame="frames/frame_0001.png", alt="甲"),
            Frame(time=15, frame="frames/frame_0002.png", alt="乙"),
            Frame(time=25, frame="frames/frame_0003.png", alt="丙"),
        ]
    )

    md = build_markdown(job, transcript, frames)

    assert md.index("第一段") < md.index("![甲]") < md.index("![乙]") < md.index("![丙]")


def test_no_segments_uses_full_text(tmp_path: Path) -> None:
    job = _job(tmp_path)
    transcript = Transcript("Chinese", "完整文本", [])
    md = build_markdown(job, transcript, FrameManifest())
    assert "完整文本" in md


def test_local_source_written_as_file(tmp_path: Path) -> None:
    meta = JobMeta(title="cam", slug="cam", url="", video=str(tmp_path / "cam.mp4"))
    job = Job.create(tmp_path / "cam", meta)
    transcript = Transcript("English", "hi", [Segment(0, 5, "hi")])

    md = build_markdown(job, transcript, FrameManifest())

    assert "- 来源: 本地文件 `cam.mp4`" in md
    assert "- 视频文件: `cam.mp4`" in md


def test_translations_replace_source_text(tmp_path: Path) -> None:
    job = _job(tmp_path)
    transcript = Transcript("English", "Hello world.", [Segment(0, 10, "Hello world.")])
    md = build_markdown(job, transcript, FrameManifest(), {0: "你好，世界。"})

    assert "你好，世界。" in md
    assert "Hello world." not in md
    assert "- 译文: 简体中文" in md


def test_missing_translation_falls_back_to_source(tmp_path: Path) -> None:
    job = _job(tmp_path)
    transcript = Transcript(
        "English", "a b c d", [Segment(0, 10, "a b"), Segment(10, 20, "c d")]
    )
    md = build_markdown(job, transcript, FrameManifest(), {0: "甲"})

    assert "甲" in md
    assert "c d" in md


def test_build_uses_translations_from_marks(tmp_path: Path) -> None:
    job = _job(tmp_path)
    Transcript("English", "Hello world.", [Segment(0, 10, "Hello world.")]).save(
        job.transcript_path
    )
    FrameManifest().save(job.frames_manifest_path)
    job.marks_path.write_text(
        json.dumps({"marks": [], "translations": [{"index": 0, "zh": "你好。"}]}),
        encoding="utf-8",
    )

    path = build(job)

    assert "你好。" in path.read_text(encoding="utf-8")
