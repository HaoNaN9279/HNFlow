"""Image format conversion tool.

Convert images between common formats (PNG, JPG, JPEG, WebP, BMP).
When converting from a format with alpha transparency to one that doesn't
support it, composites onto a background colour.
"""

from __future__ import annotations

import argparse
from pathlib import Path

from PIL import Image

from data_forge.tools._alpha import _parse_hex_color, composite_on_background
from data_forge.tools.resize import _NO_ALPHA_FORMATS, _SUPPORTED_EXTENSIONS


def _normalize_format(fmt: str) -> str:
    """Ensure a format string starts with a dot and is lowercase.

    Args:
        fmt: Format string (e.g. ``"jpg"``, ``".png"``).

    Returns:
        Normalized format with leading dot (e.g. ``".jpg"``, ``".png"``).
    """
    fmt = fmt.lower()
    if not fmt.startswith("."):
        fmt = "." + fmt
    return fmt


def convert_image(
    input: str | Path,
    output: str | Path,
    *,
    background_color: tuple[int, int, int] = (255, 255, 255),
) -> Path:
    """Convert a single image to another format.

    When converting from a format with alpha transparency to one that
    does not support it (JPEG, BMP, ICO), the transparent areas are
    composited onto *background_color*.

    Args:
        input: Path to the source image file.
        output: Path for the converted image. Format is determined by
            the file extension.
        background_color: RGB tuple used as the background when
            compositing alpha onto an opaque format. Defaults to white
            ``(255, 255, 255)``.

    Returns:
        The output :class:`~pathlib.Path`.

    Raises:
        FileNotFoundError: If *input* does not exist.
        ValueError: If the input or output file extension is not a
            supported format.

    Example:
        >>> convert_image("logo.png", "logo.jpg")
        Path('logo.jpg')

        >>> convert_image("photo.png", "photo.jpg", background_color=(0, 0, 0))
        Path('photo.jpg')
    """
    src = Path(input)
    dst = Path(output)

    if not src.is_file():
        raise FileNotFoundError(f"Input file not found: {src}")

    input_ext = src.suffix.lower()
    if input_ext not in _SUPPORTED_EXTENSIONS:
        raise ValueError(
            f"Unsupported input format: {input_ext!r}. "
            f"Supported formats: {', '.join(sorted(_SUPPORTED_EXTENSIONS))}"
        )

    output_ext = dst.suffix.lower()
    if output_ext not in _SUPPORTED_EXTENSIONS:
        raise ValueError(
            f"Unsupported output format: {output_ext!r}. "
            f"Supported formats: {', '.join(sorted(_SUPPORTED_EXTENSIONS))}"
        )

    dst.parent.mkdir(parents=True, exist_ok=True)

    with Image.open(src) as img:
        img.load()

        if output_ext in _NO_ALPHA_FORMATS:
            img = composite_on_background(img, background_color)

        img.save(dst)

    return dst


def convert_images(
    input_dir: str | Path,
    output_dir: str | Path,
    output_format: str,
    *,
    background_color: tuple[int, int, int] = (255, 255, 255),
    overwrite: bool = False,
) -> list[Path]:
    """Convert all images in a directory to another format.

    Non-image files are skipped. Files that already exist in the output
    directory are skipped unless *overwrite* is ``True``.

    Args:
        input_dir: Directory containing source images.
        output_dir: Directory where converted images will be saved.
            Created automatically if it does not exist.
        output_format: Target format (e.g. ``".jpg"``, ``"png"``).
        background_color: RGB tuple used as the background when
            compositing alpha onto an opaque format. Defaults to white
            ``(255, 255, 255)``.
        overwrite: If ``True``, overwrite existing files in the output
            directory. If ``False`` (default), skip files that already
            exist.

    Returns:
        List of :class:`~pathlib.Path` objects for each successfully
        processed output file, in sorted order.

    Raises:
        FileNotFoundError: If *input_dir* does not exist or is not a
            directory.
        ValueError: If *output_format* is not a supported format.

    Example:
        >>> convert_images("photos/", "jpg_output/", ".jpg")
        [Path('jpg_output/img1.jpg'), Path('jpg_output/img2.jpg')]
    """
    src_dir = Path(input_dir)
    dst_dir = Path(output_dir)

    if not src_dir.is_dir():
        raise FileNotFoundError(f"Input directory not found: {src_dir}")

    fmt = _normalize_format(output_format)
    if fmt not in _SUPPORTED_EXTENSIONS:
        raise ValueError(
            f"Unsupported output format: {fmt!r}. "
            f"Supported formats: {', '.join(sorted(_SUPPORTED_EXTENSIONS))}"
        )

    dst_dir.mkdir(parents=True, exist_ok=True)

    image_files = sorted(
        f
        for f in src_dir.iterdir()
        if f.is_file() and f.suffix.lower() in _SUPPORTED_EXTENSIONS
    )

    results: list[Path] = []

    for src in image_files:
        dst = dst_dir / (src.stem + fmt)

        if dst.exists() and not overwrite:
            continue

        try:
            convert_image(src, dst, background_color=background_color)
            results.append(dst)
        except Exception:
            continue

    return results


# ---------------------------------------------------------------------------
# CLI
# ---------------------------------------------------------------------------


def _main() -> None:
    """CLI entry point for image format conversion.

    Supports two subcommands:

    ``single``:
        Convert a single image file. Format is determined by the
        output file extension.

    ``batch``:
        Convert all images in a directory to a target format.
    """
    parser = argparse.ArgumentParser(
        description="Convert images between common formats.",
    )
    subparsers = parser.add_subparsers(dest="command", required=True)

    # --- single subcommand ---
    single_parser = subparsers.add_parser("single", help="Convert a single image")
    single_parser.add_argument("--input", required=True, help="Source image path")
    single_parser.add_argument("--output", required=True, help="Output image path")
    single_parser.add_argument(
        "--background-color",
        default="#FFFFFF",
        help="Background colour for alpha compositing (hex, default: #FFFFFF)",
    )

    # --- batch subcommand ---
    batch_parser = subparsers.add_parser(
        "batch", help="Convert all images in a directory"
    )
    batch_parser.add_argument("--input-dir", required=True, help="Source directory")
    batch_parser.add_argument("--output-dir", required=True, help="Output directory")
    batch_parser.add_argument(
        "--output-format",
        required=True,
        help="Target format (png, jpg, jpeg, webp, bmp)",
    )
    batch_parser.add_argument(
        "--background-color",
        default="#FFFFFF",
        help="Background colour for alpha compositing (hex, default: #FFFFFF)",
    )
    batch_parser.add_argument(
        "--overwrite",
        action="store_true",
        default=False,
        help="Overwrite existing output files",
    )

    args = parser.parse_args()

    bg_color = _parse_hex_color(args.background_color)

    if args.command == "single":
        result = convert_image(args.input, args.output, background_color=bg_color)
        print(f"Converted: {result}")
    elif args.command == "batch":
        results = convert_images(
            args.input_dir,
            args.output_dir,
            args.output_format,
            background_color=bg_color,
            overwrite=args.overwrite,
        )
        print(f"Converted {len(results)} image(s):")
        for path in results:
            print(f"  {path}")


if __name__ == "__main__":
    _main()
