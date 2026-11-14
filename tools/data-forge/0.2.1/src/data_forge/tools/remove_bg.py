"""Background removal tool using rembg with BiRefNet.

Removes backgrounds from images and composites the foreground onto a
solid-color canvas (white by default).
"""

from __future__ import annotations

from pathlib import Path
from typing import Any

from PIL import Image

# ---------------------------------------------------------------------------
# Lazy imports — rembg is an optional dependency with heavy ONNX models.
# The session is created on first use and reused across calls.
# ---------------------------------------------------------------------------
_remove: Any = None
_new_session: Any = None
_sessions: dict[str, Any] = {}

# Formats that do not support alpha transparency — output must be RGB
_NO_ALPHA_FORMATS: frozenset[str] = frozenset({".jpg", ".jpeg", ".bmp", ".ico"})


def _ensure_rembg() -> None:
    """Import rembg on demand.  Raises ImportError if not installed."""
    global _remove, _new_session
    if _remove is None:
        from rembg import new_session as _ns
        from rembg import remove as _rm

        _remove = _rm
        _new_session = _ns


def _get_session(model: str, **kwargs: Any) -> Any:
    """Return (possibly cached) rembg session for *model*."""
    if model not in _sessions:
        _ensure_rembg()
        _sessions[model] = _new_session(model, **kwargs)
    return _sessions[model]


def _to_rgb(img: Image.Image, background_color: tuple[int, ...]) -> Image.Image:
    """Composite RGBA image onto a solid RGB background."""
    if img.mode == "RGB":
        return img
    background = Image.new("RGB", img.size, background_color)
    if img.mode in ("RGBA", "LA"):
        mask = img.split()[-1]
        background.paste(img, mask=mask)
    else:
        background.paste(img.convert("RGBA"), mask=img.convert("RGBA").split()[-1])
    return background


# ---------------------------------------------------------------------------
# Public API
# ---------------------------------------------------------------------------

AVAILABLE_MODELS: tuple[str, ...] = (
    "birefnet-general",
    "birefnet-general-lite",
    "birefnet-portrait",
    "birefnet-dis",
    "birefnet-hrsod",
    "birefnet-cod",
    "birefnet-massive",
)


def remove_background(
    input_path: str | Path,
    output_path: str | Path,
    *,
    model: str = "birefnet-general",
    background_color: tuple[int, int, int] = (255, 255, 255),
    alpha_matting: bool = False,
    **session_kwargs: Any,
) -> Path:
    """Remove the background of a single image.

    Args:
        input_path: Path to the source image.
        output_path: Path where the result will be saved.
        model: BiRefNet model variant (see ``AVAILABLE_MODELS``).
            Defaults to ``"birefnet-general"``.
        background_color: RGB color used to fill the removed background
            area.  Defaults to white ``(255, 255, 255)``.
        alpha_matting: If ``True``, apply alpha matting for finer edge
            detail.  Slower but produces cleaner edges.
        **session_kwargs: Extra keyword arguments forwarded to
            :func:`rembg.new_session` (e.g. ``providers``).

    Returns:
        The output :class:`~pathlib.Path`.

    Raises:
        FileNotFoundError: If *input_path* does not exist.
        ImportError: If ``rembg`` is not installed.
            Install with ``uv sync --extra rembg``.

    Example:
        >>> remove_background("photo.jpg", "result.jpg")
        Path('result.jpg')
        >>> remove_background("portrait.png", "cutout.png", model="birefnet-portrait")
        Path('cutout.png')
    """
    src = Path(input_path)
    dst = Path(output_path)

    if not src.is_file():
        raise FileNotFoundError(f"Input file not found: {src}")

    dst.parent.mkdir(parents=True, exist_ok=True)

    with Image.open(src) as img:
        img = img.convert("RGB")
        session = _get_session(model, **session_kwargs)

        result = _remove(
            img,
            session=session,
            alpha_matting=alpha_matting,
        )
        # result is RGBA; composite onto background if output format
        # doesn't support alpha
        ext = dst.suffix.lower()
        if ext in _NO_ALPHA_FORMATS:
            result = _to_rgb(result, background_color)
        else:
            bg = Image.new("RGBA", result.size, (*background_color, 255))
            result = Image.alpha_composite(bg, result)

        result.save(dst)
    return dst


def remove_background_batch(
    input_dir: str | Path,
    output_dir: str | Path,
    *,
    model: str = "birefnet-general",
    background_color: tuple[int, int, int] = (255, 255, 255),
    alpha_matting: bool = False,
    overwrite: bool = False,
    **session_kwargs: Any,
) -> list[Path]:
    """Remove backgrounds from all images in a directory.

    Args:
        input_dir: Directory containing source images.
        output_dir: Directory where results will be saved.
            Created automatically if it does not exist.
        model: BiRefNet model variant. Defaults to ``"birefnet-general"``.
        background_color: RGB fill color for removed background.
        alpha_matting: Enable fine edge detail (slower).
        overwrite: If ``True``, overwrite existing output files.
        **session_kwargs: Forwarded to :func:`rembg.new_session`.

    Returns:
        List of :class:`~pathlib.Path` for each processed output file.

    Raises:
        FileNotFoundError: If *input_dir* does not exist.
        ImportError: If ``rembg`` is not installed.
    """
    input_path = Path(input_dir)
    output_path = Path(output_dir)

    if not input_path.is_dir():
        raise FileNotFoundError(f"Input directory not found: {input_path}")

    output_path.mkdir(parents=True, exist_ok=True)

    # Supported image extensions (same as resize tool)
    _supported = frozenset(
        {
            ".avif",
            ".bmp",
            ".gif",
            ".ico",
            ".jfif",
            ".jpeg",
            ".jpg",
            ".pjp",
            ".pjpeg",
            ".png",
            ".tif",
            ".tiff",
            ".webp",
        }
    )

    image_files = sorted(
        f
        for f in input_path.iterdir()
        if f.is_file() and f.suffix.lower() in _supported
    )

    # Pre-warm session once for the batch
    _get_session(model, **session_kwargs)

    results: list[Path] = []

    for src in image_files:
        dst = output_path / src.name

        if dst.exists() and not overwrite:
            continue

        # Use same try/except pattern as resize tool and forward dataset errors
        try:
            remove_background(
                src,
                dst,
                model=model,
                background_color=background_color,
                alpha_matting=alpha_matting,
                **session_kwargs,
            )
            results.append(dst)
        except Exception:
            continue

    return results
