"""Batch image resize tool.

Resize all images in a directory to a target resolution, with optional
long-edge-fit mode that maintains aspect ratio.
"""

from __future__ import annotations

from pathlib import Path

from PIL import Image

# Image file extensions that Pillow can handle reliably
_SUPPORTED_EXTENSIONS: frozenset[str] = frozenset(
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

# Formats that do not support alpha transparency
_NO_ALPHA_FORMATS: frozenset[str] = frozenset({".jpg", ".jpeg", ".bmp", ".ico"})


def _is_supported_image(file: Path) -> bool:
    """Check if a file has a supported image extension."""
    return file.suffix.lower() in _SUPPORTED_EXTENSIONS


def _prepare_image_for_save(img: Image.Image, ext: str) -> Image.Image:
    """Convert image to a compatible mode for the target format.

    Formats that don't support alpha (JPEG, BMP, ICO) need conversion
    from modes with transparency (RGBA, LA, P with transparency).
    """
    if ext not in _NO_ALPHA_FORMATS:
        return img

    if img.mode == "RGBA":
        background = Image.new("RGB", img.size, (255, 255, 255))
        background.paste(img, mask=img.split()[3])
        return background

    if img.mode == "LA":
        background = Image.new("L", img.size, 255)
        if img.mode == "LA":
            background.paste(img, mask=img.split()[1])
        return background

    if img.mode == "P" and "transparency" in img.info:
        return img.convert("RGBA").convert("RGB")

    return img.convert("RGB") if img.mode != "RGB" else img


def _pad_image(
    img: Image.Image,
    target_size: tuple[int, int],
    background_color: tuple[int, ...],
) -> Image.Image:
    """Scale *img* to fit within *target_size* preserving aspect ratio,
    then paste it centered onto a canvas of *target_size* filled with
    *background_color*.
    """
    img_ratio = img.width / img.height
    target_ratio = target_size[0] / target_size[1]

    if img_ratio > target_ratio:
        # Image is wider — fit to target width
        new_w = target_size[0]
        new_h = round(target_size[0] / img_ratio)
    else:
        # Image is taller — fit to target height
        new_h = target_size[1]
        new_w = round(target_size[1] * img_ratio)

    scaled = img.resize((new_w, new_h), Image.Resampling.LANCZOS)

    canvas = Image.new("RGB", target_size, background_color)
    offset_x = (target_size[0] - new_w) // 2
    offset_y = (target_size[1] - new_h) // 2
    canvas.paste(scaled, (offset_x, offset_y))

    return canvas


def resize_images(
    input_dir: str | Path,
    output_dir: str | Path,
    width: int,
    height: int,
    *,
    fit_long_edge: bool = False,
    pad_to_fit: bool = False,
    background_color: tuple[int, ...] = (255, 255, 255),
    overwrite: bool = False,
) -> list[Path]:
    """Resize all images in a directory to a target resolution.

    Args:
        input_dir: Directory containing source images.
        output_dir: Directory where resized images will be saved.
            Created automatically if it does not exist.
        width: Target width in pixels.
        height: Target height in pixels.
        fit_long_edge: If ``True``, scale the image so its longer side fits
            within ``max(width, height)`` while preserving the original
            aspect ratio. Ignored when ``pad_to_fit=True``.
        pad_to_fit: If ``True``, scale the image to fit within
            ``width × height`` while preserving aspect ratio, then pad
            the remaining area with ``background_color`` to produce an
            output of exactly ``width × height``.
        background_color: RGB tuple used as the padding color when
            ``pad_to_fit=True``. Defaults to white ``(255, 255, 255)``.
        overwrite: If ``True``, overwrite existing files in the output
            directory. If ``False`` (default), skip files that already exist.

    Returns:
        List of :class:`~pathlib.Path` objects for each successfully
        processed output file, in sorted order.

    Raises:
        FileNotFoundError: If ``input_dir`` does not exist or is not a directory.
        ValueError: If ``width`` or ``height`` is not a positive integer.

    Example:
        >>> resize_images("photos/", "resized/", 800, 600)
        [Path('resized/img1.jpg'), Path('resized/img2.png')]

        >>> resize_images("photos/", "resized/", 800, 600, pad_to_fit=True)
        [Path('resized/img1.jpg'), Path('resized/img2.png')]
    """
    input_path = Path(input_dir)
    output_path = Path(output_dir)

    if not input_path.is_dir():
        raise FileNotFoundError(f"Input directory not found: {input_path}")
    if width <= 0 or height <= 0:
        raise ValueError(f"Width and height must be positive, got {width}×{height}")

    output_path.mkdir(parents=True, exist_ok=True)

    image_files = sorted(
        f for f in input_path.iterdir() if f.is_file() and _is_supported_image(f)
    )

    target_size = (width, height)

    results: list[Path] = []

    for src in image_files:
        dst = output_path / src.name

        if dst.exists() and not overwrite:
            continue

        try:
            with Image.open(src) as img:
                img.load()

                if pad_to_fit:
                    img = _pad_image(img, target_size, background_color)
                elif fit_long_edge:
                    max_dim = max(width, height)
                    img.thumbnail((max_dim, max_dim), Image.Resampling.LANCZOS)
                else:
                    img = img.resize(target_size, Image.Resampling.LANCZOS)

                img = _prepare_image_for_save(img, dst.suffix.lower())
                img.save(dst)
                results.append(dst)
        except Exception:
            continue

    return results
