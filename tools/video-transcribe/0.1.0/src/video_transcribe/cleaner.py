"""Job cleanup: keep only the final Markdown and the frame screenshots.

After the Markdown has been built, most of a job is intermediate scratch
(transcript, probe sheets, manifests, and — for downloaded videos — the video
itself). :func:`clean_job` removes all of that, leaving a small, shareable
result: the ``<slug>.md`` document and ``frames/frame_*.png``.
"""

from __future__ import annotations

import shutil
from pathlib import Path

from video_transcribe.paths import Job


def _is_kept_frame(path: Path) -> bool:
    """Return ``True`` for a captured screenshot (``frame_*.png``)."""
    return (
        path.is_file()
        and path.name.startswith("frame_")
        and path.suffix.lower() == ".png"
    )


def clean_job(job: Job) -> list[Path]:
    """Remove intermediate artifacts, keeping the Markdown and frames.

    Kept:

    * ``<job>/<slug>.md`` — the final document.
    * ``<job>/frames/frame_*.png`` — captured screenshots.

    Removed: the (in-job) video, ``audio/``, ``transcript.*``, ``scenes.json``,
    ``probe/``, ``marks.json``, ``frames/manifest.json``, review contact
    sheets, and ``job.json``. A local source video referenced by absolute path
    lives outside the job directory and is therefore left untouched.

    Args:
        job: The job to clean.

    Returns:
        The list of removed paths (files and directories), sorted.
    """
    removed: list[Path] = []
    keep_md = job.markdown_path
    frames_dir = job.frames_dir

    def remove(path: Path) -> None:
        if path.is_dir():
            shutil.rmtree(path)
        else:
            path.unlink()
        removed.append(path)

    for entry in sorted(job.root.iterdir()):
        if entry == keep_md:
            continue
        if entry == frames_dir and entry.is_dir():
            for sub in sorted(entry.iterdir()):
                if _is_kept_frame(sub):
                    continue
                remove(sub)
            continue
        remove(entry)

    return removed
