"""Visual pre-sampling: timestamped thumbnail contact sheets.

Before the AI decides where to capture frames it needs to *see* the video.
:func:`generate` extracts evenly spaced thumbnails and tiles them into contact
sheets, then writes ``probe/index.json`` mapping every sheet cell back to its
timestamp so the agent can reason about what is on screen at each moment
instead of guessing from the transcript alone.

Layout::

    <job>/probe/thumbs/thumb_00001.png   # individual thumbnails
    <job>/probe/sheet_0001.png           # contact sheets (cols x rows)
    <job>/probe/index.json               # cell -> timestamp index
"""

from __future__ import annotations

import json
from dataclasses import asdict, dataclass, field
from pathlib import Path

from video_transcribe.ffmpeg import extract_thumbnails, tile_images
from video_transcribe.paths import Job

DEFAULT_INTERVAL = 3.0
DEFAULT_COLS = 5
DEFAULT_ROWS = 4
DEFAULT_THUMB_WIDTH = 240
DEFAULT_MAX_SAMPLES = 240


@dataclass
class ProbeCell:
    """A single contact-sheet cell and the timestamp it shows."""

    time: float
    thumb: str


@dataclass
class ProbeSheet:
    """A contact sheet image and its ordered cells."""

    file: str
    cells: list[ProbeCell] = field(default_factory=list)


@dataclass
class ProbeIndex:
    """The full probe result, persisted to ``probe/index.json``."""

    interval: float
    cols: int
    rows: int
    thumb_width: int
    sheets: list[ProbeSheet] = field(default_factory=list)

    def to_dict(self) -> dict:
        """Return a JSON-serialisable mapping."""
        return {
            "interval": self.interval,
            "cols": self.cols,
            "rows": self.rows,
            "thumb_width": self.thumb_width,
            "sheets": [
                {"file": sheet.file, "cells": [asdict(cell) for cell in sheet.cells]}
                for sheet in self.sheets
            ],
        }

    def save(self, path: Path) -> None:
        """Write the index as JSON to *path*."""
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(
            json.dumps(self.to_dict(), ensure_ascii=False, indent=2),
            encoding="utf-8",
        )

    @classmethod
    def load(cls, path: Path) -> "ProbeIndex":
        """Load a probe index from *path*."""
        data = json.loads(path.read_text(encoding="utf-8"))
        sheets = [
            ProbeSheet(
                file=str(raw.get("file", "")),
                cells=[
                    ProbeCell(time=float(c.get("time", 0.0)), thumb=str(c.get("thumb", "")))
                    for c in raw.get("cells", [])
                ],
            )
            for raw in data.get("sheets", [])
        ]
        return cls(
            interval=float(data.get("interval", DEFAULT_INTERVAL)),
            cols=int(data.get("cols", DEFAULT_COLS)),
            rows=int(data.get("rows", DEFAULT_ROWS)),
            thumb_width=int(data.get("thumb_width", DEFAULT_THUMB_WIDTH)),
            sheets=sheets,
        )


def generate(
    job: Job,
    *,
    interval: float = DEFAULT_INTERVAL,
    cols: int = DEFAULT_COLS,
    rows: int = DEFAULT_ROWS,
    thumb_width: int = DEFAULT_THUMB_WIDTH,
    max_samples: int = DEFAULT_MAX_SAMPLES,
) -> ProbeIndex:
    """Extract thumbnails and build contact sheets for *job*.

    Args:
        job: The job to sample.
        interval: Nominal seconds between thumbnails.
        cols: Contact-sheet columns.
        rows: Contact-sheet rows.
        thumb_width: Thumbnail width in pixels.
        max_samples: Cap on the number of thumbnails; the effective interval is
            widened (and the index reports the effective value) to stay within
            this bound over the whole video.

    Returns:
        The generated :class:`ProbeIndex`.

    Raises:
        ValueError: If *interval* is not positive.
        ProbeError: If ffmpeg fails.
    """
    per_sheet = max(cols * rows, 1)
    if interval <= 0:
        raise ValueError(f"interval must be positive, got {interval}")
    effective = interval

    # Widen the interval if the video would otherwise exceed max_samples.
    from video_transcribe.ffmpeg import probe_video

    duration, _ = probe_video(job.video_path)
    if max_samples > 0 and duration > 0:
        needed = duration / max_samples
        if needed > effective:
            effective = round(needed, 3)

    count = extract_thumbnails(
        job.video_path,
        job.probe_thumbs_dir,
        interval=effective,
        width=thumb_width,
    )

    thumbs = sorted(job.probe_thumbs_dir.glob("thumb_*.png"))
    sheets_out = tile_images(
        str(job.probe_thumbs_dir / "thumb_%05d.png"),
        job.probe_dir / "sheet_%04d.png",
        cols=cols,
        rows=rows,
    )

    sheets: list[ProbeSheet] = []
    for sheet_index, sheet_path in enumerate(sheets_out):
        cells: list[ProbeCell] = []
        for cell_index in range(per_sheet):
            flat = sheet_index * per_sheet + cell_index
            if flat >= count:
                break
            cells.append(
                ProbeCell(
                    time=round(flat * effective, 3),
                    thumb=f"probe/thumbs/{thumbs[flat].name}" if flat < len(thumbs) else "",
                )
            )
        sheets.append(ProbeSheet(file=f"probe/{sheet_path.name}", cells=cells))

    index = ProbeIndex(
        interval=effective,
        cols=cols,
        rows=rows,
        thumb_width=thumb_width,
        sheets=sheets,
    )
    index.save(job.probe_index_path)
    return index
