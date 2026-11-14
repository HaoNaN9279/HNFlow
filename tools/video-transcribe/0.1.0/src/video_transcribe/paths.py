"""Job directory layout and naming helpers.

A *job* is a self-contained folder named after the video title. It holds the
downloaded video, extracted audio, ASR transcript, AI-produced frame marks,
captured frames, and the final Markdown document::

    <output_root>/<title>/
        job.json
        <title>.mp4
        audio/<title>.wav
        transcript.json
        transcript.txt
        scenes.json
        probe/index.json
        probe/thumbs/thumb_00001.png
        probe/sheet_0001.png
        marks.json
        frames/manifest.json
        frames/frame_0001.png
        <title>.md
"""

from __future__ import annotations

import json
import re
from dataclasses import asdict, dataclass
from datetime import datetime, timezone
from pathlib import Path

from video_transcribe.errors import JobError

_META_FILE = "job.json"
_VIDEO_SUFFIXES = frozenset({".mp4", ".mkv", ".webm", ".mov", ".m4v", ".avi", ".flv"})

# Characters illegal in Windows file names, plus control characters.
_INVALID_CHARS = re.compile(r'[<>:"/\\|?*\x00-\x1f]')
_WHITESPACE = re.compile(r"\s+")


def slugify(title: str, *, max_length: int = 120) -> str:
    """Convert a video title into a filesystem-safe name.

    Keeps Unicode letters (including Chinese) intact and only replaces
    characters that are illegal on common filesystems.

    Args:
        title: Raw video title.
        max_length: Maximum length of the resulting name.

    Returns:
        A safe name suitable for a directory and file stem.
    """
    name = _INVALID_CHARS.sub("_", title)
    name = _WHITESPACE.sub(" ", name).strip(" .")
    if len(name) > max_length:
        name = name[:max_length].rstrip(" .")
    return name or "video"


@dataclass
class JobMeta:
    """Persisted metadata for a job, stored in ``job.json``."""

    title: str
    slug: str
    url: str = ""
    video: str = ""
    created_at: str = ""

    @classmethod
    def from_dict(cls, data: dict) -> "JobMeta":
        """Build a :class:`JobMeta` from a decoded ``job.json`` mapping."""
        return cls(
            title=str(data.get("title", "")),
            slug=str(data.get("slug", "")),
            url=str(data.get("url", "")),
            video=str(data.get("video", "")),
            created_at=str(data.get("created_at", "")),
        )


@dataclass
class Job:
    """A transcription job directory."""

    root: Path
    meta: JobMeta

    # ------------------------------------------------------------------
    # Construction / persistence
    # ------------------------------------------------------------------

    @classmethod
    def create(cls, root: Path, meta: JobMeta) -> "Job":
        """Create the job directory and persist ``job.json``.

        Args:
            root: Job directory (created if missing).
            meta: Job metadata.

        Returns:
            The created :class:`Job`.
        """
        root.mkdir(parents=True, exist_ok=True)
        if not meta.created_at:
            meta.created_at = datetime.now(timezone.utc).isoformat()
        job = cls(root=root, meta=meta)
        job.save()
        return job

    @classmethod
    def load(cls, root: Path) -> "Job":
        """Load an existing job from its ``job.json``.

        Args:
            root: Job directory.

        Returns:
            The loaded :class:`Job`.

        Raises:
            JobError: If the directory or ``job.json`` is missing/invalid.
        """
        meta_path = root / _META_FILE
        if not meta_path.is_file():
            raise JobError(f"Not a job directory (missing {_META_FILE}): {root}")
        try:
            data = json.loads(meta_path.read_text(encoding="utf-8"))
        except json.JSONDecodeError as exc:
            raise JobError(f"Invalid {_META_FILE}: {exc}") from exc
        return cls(root=root, meta=JobMeta.from_dict(data))

    def save(self) -> None:
        """Write ``job.json`` back to disk."""
        self.root.mkdir(parents=True, exist_ok=True)
        (self.root / _META_FILE).write_text(
            json.dumps(asdict(self.meta), ensure_ascii=False, indent=2),
            encoding="utf-8",
        )

    # ------------------------------------------------------------------
    # Derived paths
    # ------------------------------------------------------------------

    @property
    def video_path(self) -> Path:
        """Path to the downloaded video file.

        When ``meta.video`` is set it is authoritative (the file is not
        required to exist yet). Otherwise the directory is scanned for a
        file with a known video suffix.

        Raises:
            JobError: If no video can be located.
        """
        if self.meta.video:
            return self.root / self.meta.video
        if self.root.is_dir():
            for path in sorted(self.root.iterdir()):
                if path.is_file() and path.suffix.lower() in _VIDEO_SUFFIXES:
                    return path
        raise JobError(f"No video file found in {self.root}")

    @property
    def audio_path(self) -> Path:
        """Path where the extracted WAV audio is stored."""
        return self.root / "audio" / f"{self.meta.slug}.wav"

    @property
    def transcript_path(self) -> Path:
        """Path to the ASR ``transcript.json``."""
        return self.root / "transcript.json"

    @property
    def transcript_text_path(self) -> Path:
        """Path to the plain-text transcript."""
        return self.root / "transcript.txt"

    @property
    def scenes_path(self) -> Path:
        """Path to the detected scene-boundary list (``scenes.json``)."""
        return self.root / "scenes.json"

    @property
    def probe_dir(self) -> Path:
        """Directory holding visual pre-sampling output."""
        return self.root / "probe"

    @property
    def probe_thumbs_dir(self) -> Path:
        """Directory holding individual probe thumbnails."""
        return self.probe_dir / "thumbs"

    @property
    def probe_index_path(self) -> Path:
        """Path to the probe index (``probe/index.json``)."""
        return self.probe_dir / "index.json"

    @property
    def marks_path(self) -> Path:
        """Path to the AI-produced ``marks.json``."""
        return self.root / "marks.json"

    @property
    def frames_dir(self) -> Path:
        """Directory holding captured frame images."""
        return self.root / "frames"

    @property
    def frames_manifest_path(self) -> Path:
        """Path to the captured-frames manifest."""
        return self.frames_dir / "manifest.json"

    @property
    def markdown_path(self) -> Path:
        """Path to the final Markdown document."""
        return self.root / f"{self.meta.slug}.md"
