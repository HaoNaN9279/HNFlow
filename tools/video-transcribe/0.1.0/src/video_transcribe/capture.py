"""Frame capture: turn ``marks.json`` into extracted images + a manifest."""

from __future__ import annotations

import json
from dataclasses import asdict, dataclass, field
from pathlib import Path

from video_transcribe.errors import JobError
from video_transcribe.ffmpeg import capture_frame, capture_frame_window, tile_images
from video_transcribe.marks import Marks
from video_transcribe.paths import Job

DEFAULT_MANIFEST_COLS = 5
DEFAULT_MANIFEST_ROWS = 4
# Review sheets downscale each frame so full-resolution captures stay readable.
REVIEW_SHEET_WIDTH = 480


@dataclass
class Frame:
    """A captured frame paired with its timestamp and caption metadata."""

    time: float
    frame: str
    alt: str
    note: str = ""

    @classmethod
    def from_dict(cls, data: dict) -> "Frame":
        """Build a :class:`Frame` from a decoded mapping."""
        return cls(
            time=float(data.get("time", 0.0)),
            frame=str(data.get("frame", "")),
            alt=str(data.get("alt", "")),
            note=str(data.get("note", "")),
        )


@dataclass
class FrameManifest:
    """The list of captured frames, persisted to ``frames/manifest.json``."""

    frames: list[Frame] = field(default_factory=list)

    def save(self, path: Path) -> None:
        """Write the manifest as JSON to *path*."""
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(
            json.dumps(
                {"frames": [asdict(frame) for frame in self.frames]},
                ensure_ascii=False,
                indent=2,
            ),
            encoding="utf-8",
        )

    @classmethod
    def load(cls, path: Path) -> "FrameManifest":
        """Load a manifest from *path*.

        Raises:
            JobError: If the manifest is missing or invalid.
        """
        if not path.is_file():
            raise JobError(
                f"Frame manifest not found: {path}\nRun the 'capture' command first."
            )
        try:
            data = json.loads(path.read_text(encoding="utf-8"))
        except json.JSONDecodeError as exc:
            raise JobError(f"Invalid frame manifest: {exc}") from exc
        raw = data.get("frames", []) if isinstance(data, dict) else data
        return cls(frames=[Frame.from_dict(item) for item in raw])


def capture_frames(
    job: Job,
    *,
    cols: int = DEFAULT_MANIFEST_COLS,
    rows: int = DEFAULT_MANIFEST_ROWS,
    with_sheet: bool = True,
) -> FrameManifest:
    """Capture one frame per mark in ``marks.json``.

    A mark with a non-empty window (``end > start``) is captured with the
    ``thumbnail`` filter so the most representative frame inside the window is
    kept; a zero-width mark falls back to a single-point capture. Frames are
    named ``frame_0001.png`` … in chronological order under ``<job>/frames/``
    and a manifest is written to ``<job>/frames/manifest.json``.

    When *with_sheet* is set, contact sheets of the captured frames are written
    as ``<job>/frames/contact_sheet_0001.png`` … for quick human/AI review.

    Args:
        job: The job to process.
        cols: Contact-sheet columns for the review sheet.
        rows: Contact-sheet rows for the review sheet.
        with_sheet: Whether to render a review contact sheet.

    Returns:
        The resulting :class:`FrameManifest`.

    Raises:
        JobError: If ``marks.json`` is missing or has no marks.
        FrameCaptureError: If ffmpeg fails.
    """
    marks = Marks.load(job.marks_path)
    ordered = marks.sorted()
    if not ordered:
        raise JobError(f"No marks defined in {job.marks_path}")

    video_path = job.video_path
    frames_dir = job.frames_dir
    frames_dir.mkdir(parents=True, exist_ok=True)

    # Remove frames from any previous run so re-capture overwrites cleanly.
    for stale in frames_dir.glob("frame_*.png"):
        stale.unlink()
    for stale in frames_dir.glob("contact_sheet_*.png"):
        stale.unlink()

    frames: list[Frame] = []
    for index, mark in enumerate(ordered, start=1):
        filename = f"frame_{index:04d}.png"
        out_png = frames_dir / filename
        if mark.end > mark.start:
            capture_frame_window(video_path, mark.start, mark.end, out_png)
        else:
            capture_frame(video_path, mark.start, out_png)
        frames.append(
            Frame(
                time=mark.start,
                frame=f"frames/{filename}",
                alt=mark.alt,
                note=mark.note,
            )
        )

    manifest = FrameManifest(frames=frames)
    manifest.save(job.frames_manifest_path)

    if with_sheet and frames:
        tile_images(
            str(frames_dir / "frame_%04d.png"),
            frames_dir / "contact_sheet_%04d.png",
            cols=cols,
            rows=rows,
            scale_width=REVIEW_SHEET_WIDTH,
        )

    return manifest
