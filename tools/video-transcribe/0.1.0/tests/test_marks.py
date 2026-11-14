"""Tests for marks parsing."""

from __future__ import annotations

import json
from pathlib import Path

import pytest

from video_transcribe.errors import JobError
from video_transcribe.marks import Marks


def test_load_object_form(tmp_path: Path) -> None:
    path = tmp_path / "marks.json"
    path.write_text(
        json.dumps({"marks": [{"time": 10, "alt": "界面", "note": "看这里"}]}),
        encoding="utf-8",
    )
    marks = Marks.load(path)
    assert marks.marks[0].time == 10.0
    assert marks.marks[0].alt == "界面"


def test_load_bare_list_form(tmp_path: Path) -> None:
    path = tmp_path / "marks.json"
    path.write_text(json.dumps([{"time": 1.5, "alt": "a"}]), encoding="utf-8")
    assert Marks.load(path).marks[0].alt == "a"


def test_sorted(tmp_path: Path) -> None:
    path = tmp_path / "marks.json"
    path.write_text(
        json.dumps({"marks": [{"time": 30, "alt": "b"}, {"time": 5, "alt": "a"}]}),
        encoding="utf-8",
    )
    assert [m.time for m in Marks.load(path).sorted()] == [5.0, 30.0]


def test_missing_file_raises(tmp_path: Path) -> None:
    with pytest.raises(JobError):
        Marks.load(tmp_path / "none.json")


def test_missing_time_raises(tmp_path: Path) -> None:
    path = tmp_path / "marks.json"
    path.write_text(json.dumps({"marks": [{"alt": "no time"}]}), encoding="utf-8")
    with pytest.raises(JobError):
        Marks.load(path)


def test_non_numeric_time_raises(tmp_path: Path) -> None:
    path = tmp_path / "marks.json"
    path.write_text(json.dumps({"marks": [{"time": "abc"}]}), encoding="utf-8")
    with pytest.raises(JobError):
        Marks.load(path)


def test_load_translations_list_form(tmp_path: Path) -> None:
    path = tmp_path / "marks.json"
    path.write_text(
        json.dumps(
            {
                "marks": [{"time": 1, "alt": "a"}],
                "translations": [
                    {"index": 0, "zh": "第一段。"},
                    {"index": 1, "text": "第二段。"},
                ],
            }
        ),
        encoding="utf-8",
    )
    marks = Marks.load(path)
    assert marks.translations == {0: "第一段。", 1: "第二段。"}


def test_load_translations_dict_form(tmp_path: Path) -> None:
    path = tmp_path / "marks.json"
    path.write_text(
        json.dumps({"marks": [], "translations": {"0": "甲。", "2": "乙。"}}),
        encoding="utf-8",
    )
    assert Marks.load(path).translations == {0: "甲。", 2: "乙。"}


def test_load_without_translations(tmp_path: Path) -> None:
    path = tmp_path / "marks.json"
    path.write_text(json.dumps({"marks": [{"time": 1, "alt": "a"}]}), encoding="utf-8")
    assert Marks.load(path).translations == {}


def test_time_alias_sets_zero_width_window(tmp_path: Path) -> None:
    path = tmp_path / "marks.json"
    path.write_text(json.dumps({"marks": [{"time": 7.5, "alt": "a"}]}), encoding="utf-8")
    mark = Marks.load(path).marks[0]
    assert mark.start == 7.5
    assert mark.end == 7.5


def test_load_window_form(tmp_path: Path) -> None:
    path = tmp_path / "marks.json"
    path.write_text(
        json.dumps({"marks": [{"start": 10.0, "end": 14.0, "alt": "a"}]}),
        encoding="utf-8",
    )
    mark = Marks.load(path).marks[0]
    assert mark.start == 10.0
    assert mark.end == 14.0
    assert mark.time == 10.0


def test_end_before_start_is_clamped(tmp_path: Path) -> None:
    path = tmp_path / "marks.json"
    path.write_text(
        json.dumps({"marks": [{"start": 10.0, "end": 5.0, "alt": "a"}]}),
        encoding="utf-8",
    )
    mark = Marks.load(path).marks[0]
    assert mark.end == mark.start == 10.0


def test_non_numeric_start_raises(tmp_path: Path) -> None:
    path = tmp_path / "marks.json"
    path.write_text(json.dumps({"marks": [{"start": "abc"}]}), encoding="utf-8")
    with pytest.raises(JobError):
        Marks.load(path)
