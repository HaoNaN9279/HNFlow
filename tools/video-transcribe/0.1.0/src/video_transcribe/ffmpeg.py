"""FFmpeg integration and helpers.

FFmpeg is provided by the ``imageio-ffmpeg`` wheel, which ships a private
binary inside the tool's virtual environment. The system ``PATH`` is never
consulted, so no global environment variable is modified or polluted.

An explicit binary can be forced via the ``VIDEO_TRANSCRIBE_FFMPEG``
environment variable, which is useful for testing.

:func:`probe_video` reads the container header (duration + video codec) from
``ffmpeg -i`` without decoding anything.
"""

from __future__ import annotations

import os
import re
import subprocess
from pathlib import Path

from video_transcribe.errors import (
    AudioExtractionError,
    FrameCaptureError,
    ProbeError,
    SceneDetectionError,
)

_ENV_OVERRIDE = "VIDEO_TRANSCRIBE_FFMPEG"

_DURATION_RE = re.compile(r"Duration:\s*(\d+):(\d+):(\d+(?:\.\d+)?)")
_CODEC_RE = re.compile(r"Video:\s*([A-Za-z0-9_]+)")
_PTS_TIME_RE = re.compile(r"pts_time:(\d+(?:\.\d+)?)")


def get_ffmpeg() -> str:
    """Locate the private ffmpeg executable.

    Resolution order:

    1. ``VIDEO_TRANSCRIBE_FFMPEG`` environment variable (if it is a file).
    2. The binary bundled with ``imageio-ffmpeg``.

    Returns:
        Absolute path to the ffmpeg executable.
    """
    override = os.environ.get(_ENV_OVERRIDE)
    if override and Path(override).is_file():
        return override

    import imageio_ffmpeg

    return imageio_ffmpeg.get_ffmpeg_exe()


def _run(cmd: list[str], *, error_cls: type[Exception], message: str) -> None:
    """Run a subprocess command, raising ``error_cls`` on failure."""
    try:
        subprocess.run(cmd, check=True, capture_output=True)
    except FileNotFoundError as exc:
        raise error_cls(f"Executable not found: {cmd[0]}") from exc
    except subprocess.CalledProcessError as exc:
        stderr = exc.stderr.decode("utf-8", errors="replace").strip()
        raise error_cls(f"{message}: {stderr or exc}") from exc


def _run_capture(
    cmd: list[str], *, error_cls: type[Exception], message: str
) -> str:
    """Run a subprocess command and return its decoded stderr.

    Raises:
        error_cls: If the executable is missing or exits non-zero.
    """
    try:
        proc = subprocess.run(cmd, check=True, capture_output=True)
    except FileNotFoundError as exc:
        raise error_cls(f"Executable not found: {cmd[0]}") from exc
    except subprocess.CalledProcessError as exc:
        stderr = exc.stderr.decode("utf-8", errors="replace").strip()
        raise error_cls(f"{message}: {stderr or exc}") from exc
    return proc.stderr.decode("utf-8", errors="replace")


def probe_video(video_path: Path) -> tuple[float, str]:
    """Return ``(duration_seconds, video_codec)`` for *video_path*.

    Uses ``ffmpeg -i`` header output, which exits non-zero because no output
    file is specified, so the result is parsed from stderr directly.

    Returns:
        Duration in seconds (``0.0`` if unknown) and the video codec name
        (empty string if unknown).
    """
    cmd = [get_ffmpeg(), "-hide_banner", "-i", str(video_path)]
    result = subprocess.run(cmd, check=False, capture_output=True)
    stderr = result.stderr.decode("utf-8", errors="replace")

    duration = 0.0
    match = _DURATION_RE.search(stderr)
    if match:
        hours, minutes, seconds = match.groups()
        duration = int(hours) * 3600 + int(minutes) * 60 + float(seconds)

    codec = ""
    codec_match = _CODEC_RE.search(stderr)
    if codec_match:
        codec = codec_match.group(1).lower()

    return duration, codec


def extract_audio(video_path: Path, out_wav: Path) -> None:
    """Extract mono 16 kHz PCM audio from *video_path*.

    Args:
        video_path: Source video file.
        out_wav: Destination WAV file (parent created if missing).

    Raises:
        AudioExtractionError: If ffmpeg fails.
    """
    out_wav.parent.mkdir(parents=True, exist_ok=True)
    cmd = [
        get_ffmpeg(),
        "-y",
        "-loglevel", "error",
        "-i", str(video_path),
        "-vn",
        "-ac", "1",
        "-ar", "16000",
        "-c:a", "pcm_s16le",
        str(out_wav),
    ]
    _run(cmd, error_cls=AudioExtractionError, message=f"Failed to extract audio from {video_path}")


def capture_frame(video_path: Path, time_seconds: float, out_png: Path) -> None:
    """Capture a single video frame at *time_seconds*.

    Args:
        video_path: Source video file.
        time_seconds: Timestamp (seconds) to seek to.
        out_png: Destination PNG file (parent created if missing).

    Raises:
        FrameCaptureError: If ffmpeg fails.
    """
    out_png.parent.mkdir(parents=True, exist_ok=True)
    cmd = [
        get_ffmpeg(),
        "-y",
        "-loglevel", "error",
        "-ss", f"{max(time_seconds, 0.0):.3f}",
        "-i", str(video_path),
        "-frames:v", "1",
        "-q:v", "2",
        str(out_png),
    ]
    _run(
        cmd,
        error_cls=FrameCaptureError,
        message=f"Failed to capture frame at {time_seconds:.3f}s from {video_path}",
    )


def capture_frame_window(
    video_path: Path, start: float, end: float, out_png: Path
) -> None:
    """Capture the most representative frame inside ``[start, end]``.

    The ``thumbnail`` filter analyses the frames in the window and emits the
    single frame that best represents the sequence, which avoids landing on a
    mid-transition or heavily motion-blurred frame.

    Args:
        video_path: Source video file.
        start: Window start (seconds).
        end: Window end (seconds); must be greater than *start*.
        out_png: Destination PNG file (parent created if missing).

    Raises:
        FrameCaptureError: If ffmpeg fails.
    """
    out_png.parent.mkdir(parents=True, exist_ok=True)
    duration = max(end - start, 0.0)
    cmd = [
        get_ffmpeg(),
        "-y",
        "-loglevel", "error",
        "-ss", f"{max(start, 0.0):.3f}",
        "-i", str(video_path),
        "-t", f"{duration:.3f}",
        "-vf", "thumbnail",
        "-frames:v", "1",
        "-q:v", "2",
        str(out_png),
    ]
    _run(
        cmd,
        error_cls=FrameCaptureError,
        message=f"Failed to capture frame in [{start:.3f}, {end:.3f}]s from {video_path}",
    )


def extract_thumbnails(
    video_path: Path,
    out_dir: Path,
    *,
    interval: float,
    width: int,
) -> int:
    """Extract evenly spaced thumbnails into *out_dir*.

    Frames are written as ``thumb_00001.png`` … at times ``0, interval,
    2*interval, …`` (approximately).

    Args:
        video_path: Source video file.
        out_dir: Directory to write thumbnails into (created if missing).
        interval: Seconds between thumbnails (must be > 0).
        width: Thumbnail width in pixels (height keeps aspect ratio).

    Returns:
        The number of thumbnails written.

    Raises:
        ProbeError: If *interval* is not positive or ffmpeg fails.
    """
    if interval <= 0:
        raise ProbeError(f"interval must be positive, got {interval}")

    out_dir.mkdir(parents=True, exist_ok=True)
    for stale in out_dir.glob("thumb_*.png"):
        stale.unlink()

    cmd = [
        get_ffmpeg(),
        "-y",
        "-loglevel", "error",
        "-i", str(video_path),
        "-vf", f"fps=1/{interval},scale={width}:-2",
        "-q:v", "3",
        str(out_dir / "thumb_%05d.png"),
    ]
    _run(cmd, error_cls=ProbeError, message=f"Failed to extract thumbnails from {video_path}")
    return len(list(out_dir.glob("thumb_*.png")))


def tile_images(
    input_pattern: str,
    out_pattern: Path,
    *,
    cols: int,
    rows: int,
    scale_width: int = 0,
) -> list[Path]:
    """Tile an image sequence into contact sheets.

    Reads frames matching *input_pattern* (an ffmpeg image2 pattern such as
    ``thumbs/thumb_%05d.png``) and writes contact sheets matching
    *out_pattern* (e.g. ``probe/sheet_%04d.png``), each holding ``cols * rows``
    cells. A final partial sheet is emitted for a non-multiple count.

    Args:
        input_pattern: ffmpeg image2 input pattern.
        out_pattern: ffmpeg image2 output pattern.
        cols: Number of columns per sheet.
        rows: Number of rows per sheet.
        scale_width: When positive, downscale each cell to this width first
            (keeps large source frames from producing oversized sheets).

    Returns:
        Sorted list of written sheet files.

    Raises:
        ProbeError: If the tiling ffmpeg invocation fails.
    """
    out_pattern.parent.mkdir(parents=True, exist_ok=True)
    for stale in out_pattern.parent.glob(out_pattern.name.replace("%04d", "*")):
        stale.unlink()

    filters = [f"tile={cols}x{rows}"]
    if scale_width > 0:
        filters.insert(0, f"scale={scale_width}:-2")

    cmd = [
        get_ffmpeg(),
        "-y",
        "-loglevel", "error",
        "-framerate", "1",
        "-i", input_pattern,
        "-vf", ",".join(filters),
        "-q:v", "3",
        str(out_pattern),
    ]
    _run(cmd, error_cls=ProbeError, message=f"Failed to tile images from {input_pattern}")

    return sorted(out_pattern.parent.glob(out_pattern.name.replace("%04d", "*")))


def scene_change_times(video_path: Path, *, threshold: float = 0.3) -> list[float]:
    """Detect scene-change (shot boundary) timestamps.

    Runs ffmpeg's scene-score ``select`` filter and parses the resulting
    ``pts_time`` values from the log. ``0.0`` is always included as the first
    boundary.

    Args:
        video_path: Source video file.
        threshold: Scene score above which a frame is a boundary (0–1).

    Returns:
        Sorted list of boundary timestamps in seconds, deduplicated.

    Raises:
        SceneDetectionError: If ffmpeg fails.
    """
    cmd = [
        get_ffmpeg(),
        "-hide_banner",
        "-loglevel", "info",
        "-i", str(video_path),
        "-an",
        "-vf", f"select='gt(scene,{threshold})',metadata=print",
        "-f", "null",
        "-",
    ]
    stderr = _run_capture(
        cmd,
        error_cls=SceneDetectionError,
        message=f"Failed to detect scenes in {video_path}",
    )

    times: list[float] = []
    for match in _PTS_TIME_RE.finditer(stderr):
        times.append(round(float(match.group(1)), 3))

    result = [0.0]
    for value in sorted(set(times)):
        if value > 0.0 and value not in result:
            result.append(value)
    return result
