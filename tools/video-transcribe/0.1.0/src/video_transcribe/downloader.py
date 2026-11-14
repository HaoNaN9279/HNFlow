"""Video download via yt-dlp."""

from __future__ import annotations

from pathlib import Path
from typing import Any, cast

from video_transcribe.errors import DownloadError
from video_transcribe.ffmpeg import get_ffmpeg
from video_transcribe.paths import Job, JobMeta, slugify

_VIDEO_SUFFIXES = (".mp4", ".mkv", ".webm", ".mov", ".m4v", ".avi", ".flv")


def _find_video(job_root: Path, slug: str) -> Path:
    """Locate the downloaded video file inside *job_root*."""
    preferred = job_root / f"{slug}.mp4"
    if preferred.is_file():
        return preferred
    for path in sorted(job_root.iterdir()):
        if path.is_file() and path.suffix.lower() in _VIDEO_SUFFIXES:
            return path
    raise DownloadError(f"Downloaded video not found in {job_root}")


def import_video(path: Path, out_root: Path) -> Job:
    """Create a job from a local video file (no download).

    The job folder is named after the file stem. The source file is *not*
    copied: ``job.json`` records its absolute path so the video stays in
    place (and is untouched by ``clean``).

    Args:
        path: Path to an existing local video file.
        out_root: Root directory that will contain the job folder.

    Returns:
        The created :class:`Job`.

    Raises:
        DownloadError: If *path* is not an existing file.
    """
    source = path.expanduser().resolve()
    if not source.is_file():
        raise DownloadError(f"Local video file not found: {path}")

    slug = slugify(source.stem)
    job_root = out_root / slug
    job_root.mkdir(parents=True, exist_ok=True)
    meta = JobMeta(title=source.stem, slug=slug, url="", video=str(source))
    return Job.create(job_root, meta)


def download(url: str, out_root: Path, *, proxy: str | None = None) -> Job:
    """Download a video and create its job directory.

    The job folder is named after the sanitized video title and stores the
    video as ``<slug>.<ext>``.

    Args:
        url: Video page URL (YouTube, Vimeo, …).
        out_root: Root directory that will contain the job folder.
        proxy: Optional proxy URL.

    Returns:
        The created :class:`Job`.

    Raises:
        DownloadError: If metadata extraction or download fails.
    """
    try:
        import yt_dlp
    except ImportError as exc:  # pragma: no cover - dependency installed by uv
        raise DownloadError("yt-dlp is not installed") from exc

    base_opts: dict[str, Any] = {"quiet": True, "no_warnings": True, "noplaylist": True}
    if proxy:
        base_opts["proxy"] = proxy

    try:
        with yt_dlp.YoutubeDL(cast("Any", base_opts)) as ydl:
            info = ydl.extract_info(url, download=False)
    except Exception as exc:
        raise DownloadError(f"Failed to read video metadata: {exc}") from exc

    title = str((info or {}).get("title") or "video")
    slug = slugify(title)
    job_root = out_root / slug
    job_root.mkdir(parents=True, exist_ok=True)

    download_opts: dict[str, Any] = {
        **base_opts,
        "quiet": False,
        "noprogress": True,
        "format": "bv*+ba/b",
        "merge_output_format": "mp4",
        "outtmpl": str(job_root / f"{slug}.%(ext)s"),
        "ffmpeg_location": get_ffmpeg(),
    }

    try:
        with yt_dlp.YoutubeDL(cast("Any", download_opts)) as ydl:
            ydl.download([url])
    except Exception as exc:
        raise DownloadError(f"Failed to download video: {exc}") from exc

    video = _find_video(job_root, slug)
    meta = JobMeta(title=title, slug=slug, url=url, video=video.name)
    return Job.create(job_root, meta)
