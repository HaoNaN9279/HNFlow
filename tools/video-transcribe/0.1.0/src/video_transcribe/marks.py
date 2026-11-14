"""AI-produced frame marks and translations (``marks.json``).

The agent inspects the transcript **plus the probe contact sheets**, decides
which moments require looking at the screen, and writes ``marks.json``. Each
mark may carry a time *window* (``start``/``end``) so the capture step can pick
the most representative frame inside it. It also provides a Simplified-Chinese
translation for each transcript segment; because that translated text carries
its own punctuation, it simultaneously restores punctuation that Qwen3-ASR
sometimes omits::

    {
      "marks": [
        {"start": 123.4, "end": 128.0, "alt": "节点编辑器界面", "note": "讲解节点连线"}
      ],
      "translations": [
        {"index": 0, "zh": "译文，专业术语可保留原文（如 Point Deform）。"}
      ]
    }

A single ``time`` field is still accepted and treated as a zero-width window
(``start == end``).
"""

from __future__ import annotations

import json
from dataclasses import dataclass, field
from pathlib import Path

from video_transcribe.errors import JobError


@dataclass
class Mark:
    """A time window that should be captured as a frame.

    Parameters:
        start: Window start in seconds.
        end: Window end in seconds (``>= start``); equal to *start* for a
            zero-width window.
        alt: Image alternative text.
        note: Optional caption note.
    """

    start: float
    end: float
    alt: str = ""
    note: str = ""

    @property
    def time(self) -> float:
        """The anchor timestamp (window start), used for ordering/placement."""
        return self.start

    @classmethod
    def from_dict(cls, data: dict) -> "Mark":
        """Build a :class:`Mark` from a decoded mapping.

        Accepts ``start``/``end`` or a single ``time`` alias.

        Raises:
            JobError: If no usable time field is present or it is not numeric.
        """
        raw_start = data.get("start", data.get("time"))
        if raw_start is None:
            raise JobError("Each mark requires a 'start' (or 'time') field in seconds")
        try:
            start = float(raw_start)
        except (TypeError, ValueError) as exc:
            raise JobError(f"Mark 'start' must be numeric: {raw_start!r}") from exc

        raw_end = data.get("end")
        end = start
        if raw_end is not None:
            try:
                end = float(raw_end)
            except (TypeError, ValueError) as exc:
                raise JobError(f"Mark 'end' must be numeric: {raw_end!r}") from exc
        end = max(end, start)

        return cls(
            start=start,
            end=end,
            alt=str(data.get("alt", "") or ""),
            note=str(data.get("note", "") or ""),
        )


def _parse_translations(raw: object) -> dict[int, str]:
    """Parse the ``translations`` field into ``{segment_index: 中文}``.

    Accepts a list of ``{"index": int, "zh"|"text": str}`` objects or a
    mapping of ``{"0": "…", "1": "…"}``.
    """
    result: dict[int, str] = {}
    if isinstance(raw, list):
        for item in raw:
            if not isinstance(item, dict) or "index" not in item:
                continue
            try:
                index = int(item["index"])
            except (TypeError, ValueError):
                continue
            text = str(item.get("zh", item.get("text", "")) or "")
            result[index] = text
    elif isinstance(raw, dict):
        for key, value in raw.items():
            try:
                index = int(key)
            except (TypeError, ValueError):
                continue
            result[index] = str(value or "")
    return result


@dataclass
class Marks:
    """The contents of ``marks.json``: frame marks plus zh translations."""

    marks: list[Mark] = field(default_factory=list)
    translations: dict[int, str] = field(default_factory=dict)

    @classmethod
    def load(cls, path: Path) -> "Marks":
        """Load marks from *path*.

        Accepts either ``{"marks": [...]}`` or a bare JSON list of marks.

        Args:
            path: Source ``marks.json`` file.

        Returns:
            The loaded :class:`Marks`.

        Raises:
            JobError: If the file is missing or invalid.
        """
        if not path.is_file():
            raise JobError(
                f"marks.json not found: {path}\n"
                "The AI agent must inspect transcript.json and write marks.json first."
            )
        try:
            data = json.loads(path.read_text(encoding="utf-8"))
        except json.JSONDecodeError as exc:
            raise JobError(f"Invalid marks.json: {exc}") from exc

        if isinstance(data, dict):
            raw_marks = data.get("marks", [])
            translations = _parse_translations(data.get("translations", []))
        else:
            raw_marks = data
            translations = {}

        if not isinstance(raw_marks, list):
            raise JobError("marks.json must be a list or an object with a 'marks' list")
        return cls(
            marks=[Mark.from_dict(item) for item in raw_marks],
            translations=translations,
        )

    def sorted(self) -> list[Mark]:
        """Return marks sorted chronologically by window start."""
        return sorted(self.marks, key=lambda mark: mark.start)

