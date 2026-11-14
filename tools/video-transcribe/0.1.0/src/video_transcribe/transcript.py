"""Transcript data model and timestamp segmentation."""

from __future__ import annotations

import json
from dataclasses import asdict, dataclass, field
from pathlib import Path

from video_transcribe.errors import TranscriptionError

# Sentence-terminating characters used to split reconstructed text.
_SENTENCE_END = frozenset("。！？!?…\n.")


@dataclass
class Segment:
    """A contiguous spoken segment with start/end timestamps in seconds."""

    start: float
    end: float
    text: str

    @classmethod
    def from_dict(cls, data: dict) -> "Segment":
        """Build a :class:`Segment` from a decoded mapping."""
        return cls(
            start=float(data.get("start", 0.0)),
            end=float(data.get("end", 0.0)),
            text=str(data.get("text", "")),
        )


@dataclass
class Transcript:
    """A full transcription result."""

    language: str
    text: str
    segments: list[Segment] = field(default_factory=list)

    def to_dict(self) -> dict:
        """Return a JSON-serialisable mapping."""
        return {
            "language": self.language,
            "text": self.text,
            "segments": [asdict(segment) for segment in self.segments],
        }

    @classmethod
    def from_dict(cls, data: dict) -> "Transcript":
        """Build a :class:`Transcript` from a decoded mapping."""
        raw_segments = data.get("segments", [])
        segments = [Segment.from_dict(item) for item in raw_segments]
        return cls(
            language=str(data.get("language", "")),
            text=str(data.get("text", "")),
            segments=segments,
        )

    def save(self, path: Path) -> None:
        """Write the transcript as JSON to *path*.

        Args:
            path: Destination JSON file (parent created if missing).
        """
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(
            json.dumps(self.to_dict(), ensure_ascii=False, indent=2),
            encoding="utf-8",
        )

    @classmethod
    def load(cls, path: Path) -> "Transcript":
        """Load a transcript from *path*.

        Args:
            path: Source JSON file.

        Returns:
            The loaded :class:`Transcript`.

        Raises:
            TranscriptionError: If the file is missing or invalid.
        """
        if not path.is_file():
            raise TranscriptionError(f"Transcript not found: {path}")
        try:
            data = json.loads(path.read_text(encoding="utf-8"))
        except json.JSONDecodeError as exc:
            raise TranscriptionError(f"Invalid transcript JSON: {exc}") from exc
        return cls.from_dict(data)


def segments_from_time_stamps(
    text: str,
    time_stamps: list,
    *,
    max_gap: float = 1.5,
    max_duration: float = 30.0,
) -> list[Segment]:
    """Group word-level timestamps into sentence-level segments.

    Qwen3-ASR returns two things: a punctuated ``text`` string and a list of
    word-level ``time_stamps`` (words carry no spacing or punctuation). This
    function aligns the words back onto ``text`` by character position, then
    splits at sentence-ending punctuation, at silence gaps longer than
    ``max_gap``, or when a segment exceeds ``max_duration`` seconds.

    Args:
        text: The punctuated transcript (``result.text``).
        time_stamps: Objects exposing ``text``, ``start_time`` and
            ``end_time`` attributes (as produced by Qwen3-ASR).
        max_gap: Maximum silence gap (seconds) allowed inside a segment.
        max_duration: Maximum segment duration (seconds); ``None`` disables
            duration-based splitting.

    Returns:
        A list of non-empty :class:`Segment` objects in chronological order.
    """
    words: list[tuple[str, float, float]] = []
    for stamp in time_stamps:
        word = str(getattr(stamp, "text", "") or "").strip()
        if not word:
            continue
        start = float(getattr(stamp, "start_time", 0.0) or 0.0)
        end = float(getattr(stamp, "end_time", start) or start)
        words.append((word, start, end))

    if not words:
        return []

    if not text:
        text = " ".join(word for word, _, _ in words)

    # Align each word to a character span in `text`.
    lower = text.lower()
    spans: list[tuple[int, int]] = []
    cursor = 0
    for word, _, _ in words:
        index = lower.find(word.lower(), cursor)
        if index < 0:
            index = cursor
        spans.append((index, index + len(word)))
        cursor = index + len(word)

    segments: list[Segment] = []
    seg_first = 0
    seg_start = words[0][1]

    def emit(last: int) -> None:
        char_start = spans[seg_first][0]
        char_end = spans[last + 1][0] if last + 1 < len(spans) else len(text)
        segment_text = text[char_start:char_end].strip()
        if segment_text:
            segments.append(
                Segment(start=words[seg_first][1], end=words[last][2], text=segment_text)
            )

    for index in range(len(words) - 1):
        gap = words[index + 1][1] - words[index][2]
        between = text[spans[index][1]:spans[index + 1][0]]
        ends_sentence = any(char in _SENTENCE_END for char in between)
        too_long = max_duration is not None and (words[index][2] - seg_start) >= max_duration
        if ends_sentence or gap > max_gap or too_long:
            emit(index)
            seg_first = index + 1
            seg_start = words[index + 1][1]

    emit(len(words) - 1)
    return segments
