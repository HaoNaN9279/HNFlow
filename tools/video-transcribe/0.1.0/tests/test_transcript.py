"""Tests for the transcript model and segmentation."""

from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path

import pytest

from video_transcribe.errors import TranscriptionError
from video_transcribe.transcript import (
    Segment,
    Transcript,
    segments_from_time_stamps,
)


@dataclass
class _Stamp:
    text: str
    start_time: float
    end_time: float


def test_segments_split_on_sentence_end() -> None:
    text = "Hello world. Goodbye moon."
    stamps = [
        _Stamp("Hello", 0.0, 0.5),
        _Stamp("world", 0.5, 1.0),
        _Stamp("Goodbye", 2.0, 2.5),
        _Stamp("moon", 2.5, 3.0),
    ]
    segments = segments_from_time_stamps(text, stamps)

    assert [s.text for s in segments] == ["Hello world.", "Goodbye moon."]
    assert segments[0].start == 0.0
    assert segments[0].end == 1.0
    assert segments[1].start == 2.0


def test_segments_preserve_spacing_and_punctuation() -> None:
    text = "Point deform. A lot of people use it."
    stamps = [
        _Stamp("Point", 0.0, 0.4),
        _Stamp("deform", 0.4, 0.9),
        _Stamp("A", 1.0, 1.1),
        _Stamp("lot", 1.1, 1.3),
        _Stamp("of", 1.3, 1.4),
        _Stamp("people", 1.4, 1.7),
        _Stamp("use", 1.7, 1.9),
        _Stamp("it", 1.9, 2.0),
    ]
    segments = segments_from_time_stamps(text, stamps)

    assert [s.text for s in segments] == ["Point deform.", "A lot of people use it."]


def test_segments_split_on_gap() -> None:
    text = "Alpha beta gamma delta"
    stamps = [
        _Stamp("Alpha", 0.0, 0.5),
        _Stamp("beta", 0.5, 1.0),
        _Stamp("gamma", 5.0, 5.5),
        _Stamp("delta", 5.5, 6.0),
    ]
    segments = segments_from_time_stamps(text, stamps)

    assert [s.text for s in segments] == ["Alpha beta", "gamma delta"]


def test_segments_respect_max_duration() -> None:
    text = " ".join(f"w{i}" for i in range(20))
    stamps = [_Stamp(f"w{i}", i * 5.0, i * 5.0 + 1.0) for i in range(20)]
    segments = segments_from_time_stamps(text, stamps, max_gap=100.0, max_duration=10.0)

    assert len(segments) > 1
    assert segments[0].text.startswith("w0")
    assert segments[-1].text.endswith("w19")


def test_segments_empty_input() -> None:
    assert segments_from_time_stamps("", []) == []


def test_transcript_roundtrip(tmp_path: Path) -> None:
    transcript = Transcript(
        language="Chinese",
        text="你好。",
        segments=[Segment(0.0, 1.0, "你好。")],
    )
    path = tmp_path / "transcript.json"
    transcript.save(path)

    loaded = Transcript.load(path)
    assert loaded.language == "Chinese"
    assert loaded.text == "你好。"
    assert loaded.segments[0].text == "你好。"


def test_transcript_load_missing_raises(tmp_path: Path) -> None:
    with pytest.raises(TranscriptionError):
        Transcript.load(tmp_path / "missing.json")


def test_transcript_load_invalid_json_raises(tmp_path: Path) -> None:
    path = tmp_path / "bad.json"
    path.write_text("{not json", encoding="utf-8")
    with pytest.raises(TranscriptionError):
        Transcript.load(path)
