"""Exception hierarchy for video-transcribe."""

from __future__ import annotations


class VideoTranscribeError(Exception):
    """Base class for all video-transcribe errors."""


class JobError(VideoTranscribeError):
    """Raised when a job directory is missing or malformed."""


class DownloadError(VideoTranscribeError):
    """Raised when video download fails."""


class AudioExtractionError(VideoTranscribeError):
    """Raised when audio extraction via ffmpeg fails."""


class FrameCaptureError(VideoTranscribeError):
    """Raised when frame capture via ffmpeg fails."""


class ProbeError(VideoTranscribeError):
    """Raised when visual pre-sampling (contact sheets) fails."""


class SceneDetectionError(VideoTranscribeError):
    """Raised when scene-change detection via ffmpeg fails."""


class ModelError(VideoTranscribeError):
    """Raised when model detection or download fails."""


class TranscriptionError(VideoTranscribeError):
    """Raised when speech-to-text transcription fails."""
