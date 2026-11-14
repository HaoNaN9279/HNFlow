"""Qwen3-ASR model detection and download.

Only the 0.6B ASR model and its 0.6B forced aligner are used. Model weights
are large and are therefore never version-controlled; they live under the
tool's ``models/`` directory (git-ignored) and are downloaded on demand.
"""

from __future__ import annotations

import os
from dataclasses import dataclass
from pathlib import Path

from video_transcribe.errors import ModelError

ASR_REPO = "Qwen/Qwen3-ASR-0.6B"
ALIGNER_REPO = "Qwen/Qwen3-ForcedAligner-0.6B"
ASR_DIRNAME = "Qwen3-ASR-0.6B"
ALIGNER_DIRNAME = "Qwen3-ForcedAligner-0.6B"

DEFAULT_PROXY = "http://oversea.blackjack-local.com:1086"

# A model directory is considered present when it contains a config file.
_REQUIRED_FILE = "config.json"


@dataclass
class ModelStatus:
    """Presence information for the required models."""

    asr_dir: Path
    aligner_dir: Path
    asr_present: bool
    aligner_present: bool

    @property
    def ready(self) -> bool:
        """Whether both models are present."""
        return self.asr_present and self.aligner_present


def asr_dir(models_dir: Path) -> Path:
    """Return the expected directory of the ASR model."""
    return models_dir / ASR_DIRNAME


def aligner_dir(models_dir: Path) -> Path:
    """Return the expected directory of the forced aligner model."""
    return models_dir / ALIGNER_DIRNAME


def _is_present(path: Path) -> bool:
    """Return ``True`` if *path* looks like a downloaded model."""
    return (path / _REQUIRED_FILE).is_file()


def status(models_dir: Path) -> ModelStatus:
    """Inspect model presence under *models_dir*.

    Args:
        models_dir: Directory that holds (or will hold) the models.

    Returns:
        A :class:`ModelStatus` describing which models are present.
    """
    asr = asr_dir(models_dir)
    aligner = aligner_dir(models_dir)
    return ModelStatus(
        asr_dir=asr,
        aligner_dir=aligner,
        asr_present=_is_present(asr),
        aligner_present=_is_present(aligner),
    )


def _apply_proxy(proxy: str | None) -> None:
    """Export the proxy to the environment so download libraries honour it."""
    if not proxy:
        return
    for key in ("HTTPS_PROXY", "HTTP_PROXY", "https_proxy", "http_proxy"):
        os.environ.setdefault(key, proxy)


def _download_hf(repo: str, target: Path) -> None:
    """Download a model snapshot from Hugging Face."""
    try:
        from huggingface_hub import snapshot_download
    except ImportError as exc:  # pragma: no cover - dependency installed by uv
        raise ModelError("huggingface-hub is not installed") from exc

    try:
        snapshot_download(repo_id=repo, local_dir=str(target))
    except Exception as exc:
        raise ModelError(f"Failed to download {repo} from Hugging Face: {exc}") from exc


def _download_modelscope(repo: str, target: Path) -> None:
    """Download a model snapshot from ModelScope."""
    try:
        from modelscope import snapshot_download
    except ImportError as exc:
        raise ModelError(
            "modelscope is not installed; install with: uv sync --extra modelscope"
        ) from exc

    try:
        snapshot_download(repo, local_dir=str(target))
    except Exception as exc:
        raise ModelError(f"Failed to download {repo} from ModelScope: {exc}") from exc


def ensure_models(
    models_dir: Path,
    *,
    source: str = "hf",
    proxy: str | None = None,
) -> tuple[Path, Path]:
    """Ensure both models exist locally, downloading them when missing.

    Args:
        models_dir: Directory that holds the models.
        source: ``"hf"`` (Hugging Face) or ``"modelscope"``.
        proxy: Proxy URL applied to the download environment.

    Returns:
        A ``(asr_dir, aligner_dir)`` tuple of local model paths.

    Raises:
        ModelError: If *source* is unknown or a download fails.
    """
    if source not in {"hf", "modelscope"}:
        raise ModelError(f"Unknown model source: {source!r} (expected 'hf' or 'modelscope')")

    _apply_proxy(proxy)
    download = _download_hf if source == "hf" else _download_modelscope

    current = status(models_dir)
    if not current.asr_present:
        download(ASR_REPO, current.asr_dir)
    if not current.aligner_present:
        download(ALIGNER_REPO, current.aligner_dir)

    final = status(models_dir)
    if not final.ready:
        raise ModelError(
            f"Models are still incomplete after download: "
            f"asr={final.asr_present}, aligner={final.aligner_present}"
        )
    return final.asr_dir, final.aligner_dir
