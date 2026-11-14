"""Thin wrapper around the Qwen3-ASR model.

The heavy ``qwen_asr`` / ``torch`` imports are deferred until a model is
actually loaded, so lightweight CLI commands (``fetch``, ``build``) never
pay the import cost.
"""

from __future__ import annotations

from pathlib import Path

from video_transcribe.errors import TranscriptionError
from video_transcribe.transcript import Transcript, segments_from_time_stamps

DEFAULT_DEVICE = "cuda"


class Transcriber:
    """Loads a Qwen3-ASR model and transcribes audio files.

    Args:
        asr_dir: Local directory of the ASR model.
        aligner_dir: Local directory of the forced-aligner model (enables
            timestamps).
        device: Torch device string, e.g. ``"cuda"`` or ``"cpu"``.
        max_new_tokens: Maximum tokens generated per request.
    """

    def __init__(
        self,
        asr_dir: Path,
        aligner_dir: Path,
        *,
        device: str = DEFAULT_DEVICE,
        max_new_tokens: int = 2048,
    ) -> None:
        self._asr_dir = asr_dir
        self._aligner_dir = aligner_dir
        self._device = device
        self._max_new_tokens = max_new_tokens
        self._model = None

    def _ensure_loaded(self) -> None:
        """Load the model on first use."""
        if self._model is not None:
            return
        try:
            import torch
            from qwen_asr import Qwen3ASRModel
        except ImportError as exc:  # pragma: no cover - dependency installed by uv
            raise TranscriptionError("qwen-asr / torch are not installed") from exc

        dtype = torch.bfloat16 if self._device.startswith("cuda") else torch.float32

        if self._device.startswith("cuda") and not torch.cuda.is_available():
            raise TranscriptionError(
                "本机 CUDA 不可用（torch.cuda.is_available() 返回 False），"
                "无法使用 GPU 运行模型。请检查 CUDA / GPU 环境后重试；"
                "任务已停止。"
            )

        try:
            self._model = Qwen3ASRModel.from_pretrained(
                str(self._asr_dir),
                dtype=dtype,
                device_map=self._device,
                forced_aligner=str(self._aligner_dir),
                forced_aligner_kwargs=dict(dtype=dtype, device_map=self._device),
                max_new_tokens=self._max_new_tokens,
            )
        except Exception as exc:
            raise TranscriptionError(f"Failed to load Qwen3-ASR model: {exc}") from exc

    def transcribe(
        self,
        audio_path: Path,
        *,
        language: str | None = None,
        context: str | None = None,
    ) -> Transcript:
        """Transcribe an audio file into a timestamped transcript.

        Args:
            audio_path: Path to the audio file.
            language: Optional forced language (e.g. ``"Chinese"``);
                ``None`` lets the model auto-detect.
            context: Optional domain hint (professional terms, names) that
                biases the decoder toward correct vocabulary.

        Returns:
            The resulting :class:`Transcript`.

        Raises:
            TranscriptionError: If transcription fails or returns nothing.
        """
        self._ensure_loaded()
        assert self._model is not None  # narrowed by _ensure_loaded

        try:
            results = self._model.transcribe(
                audio=str(audio_path),
                language=language,
                context=context or "",
                return_time_stamps=True,
            )
        except Exception as exc:
            raise TranscriptionError(f"Transcription failed: {exc}") from exc

        if not results:
            raise TranscriptionError("Qwen3-ASR returned no results")

        result = results[0]
        result_text = str(getattr(result, "text", "") or "")
        time_stamps = list(getattr(result, "time_stamps", None) or [])
        segments = segments_from_time_stamps(result_text, time_stamps) if time_stamps else []
        return Transcript(
            language=str(getattr(result, "language", "") or ""),
            text=result_text,
            segments=segments,
        )
