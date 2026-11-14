"""Markdown document assembly.

Combines the transcript with captured frames into a single Markdown file in
which every frame is embedded inline (``![](frames/...)``), so the image is
visible directly in a Markdown preview.
"""

from __future__ import annotations

from pathlib import Path

from video_transcribe.capture import Frame, FrameManifest
from video_transcribe.marks import Marks
from video_transcribe.paths import Job
from video_transcribe.transcript import Transcript

_DEFAULT_ALT = "关键画面"


def format_timestamp(seconds: float) -> str:
    """Format *seconds* as ``HH:MM:SS``.

    Args:
        seconds: Timestamp in seconds.

    Returns:
        A zero-padded ``HH:MM:SS`` string.
    """
    total = max(int(seconds), 0)
    hours, remainder = divmod(total, 3600)
    minutes, secs = divmod(remainder, 60)
    return f"{hours:02d}:{minutes:02d}:{secs:02d}"


def _frame_block(frame: Frame) -> list[str]:
    """Render a single frame as Markdown lines."""
    alt = frame.alt or _DEFAULT_ALT
    caption = f"*[{format_timestamp(frame.time)}]*"
    if frame.note:
        caption = f"*[{format_timestamp(frame.time)}] {frame.note}*"
    return [f"![{alt}]({frame.frame})", "", caption, ""]


def build_markdown(
    job: Job,
    transcript: Transcript,
    frames: FrameManifest,
    translations: dict[int, str] | None = None,
) -> str:
    """Build the Markdown document text.

    Args:
        job: The job (supplies title and source metadata).
        transcript: The ASR transcript.
        frames: The captured frames manifest.
        translations: Optional map of segment index → Simplified-Chinese
            translation. When present, the translation replaces the source
            text for that segment (and carries its own punctuation).

    Returns:
        The rendered Markdown document as a string.
    """
    translations = translations or {}
    ordered_frames = sorted(frames.frames, key=lambda frame: frame.time)
    video_name = Path(job.meta.video).name if job.meta.video else job.video_path.name
    lines: list[str] = [f"# {job.meta.title}", ""]

    if job.meta.url:
        lines.append(f"- 来源: {job.meta.url}")
    else:
        lines.append(f"- 来源: 本地文件 `{video_name}`")
    if transcript.language:
        lines.append(f"- 语言: {transcript.language}")
    if translations:
        lines.append("- 译文: 简体中文")
    lines.append(f"- 视频文件: `{video_name}`")
    lines.extend(["", "---", ""])

    frame_index = 0
    if transcript.segments:
        for index, segment in enumerate(transcript.segments):
            text = translations.get(index) or segment.text
            lines.extend([text, ""])
            while (
                frame_index < len(ordered_frames)
                and ordered_frames[frame_index].time <= segment.end
            ):
                lines.extend(_frame_block(ordered_frames[frame_index]))
                frame_index += 1
    elif transcript.text:
        lines.extend([translations.get(0) or transcript.text, ""])

    # Any frames past the last segment are appended at the end.
    while frame_index < len(ordered_frames):
        lines.extend(_frame_block(ordered_frames[frame_index]))
        frame_index += 1

    return "\n".join(lines).rstrip() + "\n"


def write_markdown(job: Job, text: str) -> Path:
    """Write the Markdown document to the job directory.

    Args:
        job: The job whose Markdown path is targeted.
        text: The document content.

    Returns:
        The path written to.
    """
    job.markdown_path.write_text(text, encoding="utf-8")
    return job.markdown_path


def build(job: Job) -> Path:
    """Load inputs and write the final Markdown document.

    Translations from ``marks.json`` are used when present.

    Args:
        job: The job to build.

    Returns:
        The path of the written Markdown file.
    """
    transcript = Transcript.load(job.transcript_path)
    frames = FrameManifest.load(job.frames_manifest_path)
    translations: dict[int, str] = {}
    if job.marks_path.is_file():
        translations = Marks.load(job.marks_path).translations
    return write_markdown(job, build_markdown(job, transcript, frames, translations))
