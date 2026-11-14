"""Fill transparent areas of images with a specified background colour.

Composites images with alpha transparency onto a solid RGB background,
always producing RGB mode output regardless of the output format.
"""

from __future__ import annotations

import argparse
from pathlib import Path

from PIL import Image

from data_forge.tools._alpha import _parse_hex_color, composite_on_background


def fill_background(
    input: str | Path,
    output: str | Path,
    *,
    background_color: tuple[int, int, int] = (255, 255, 255),
) -> Path:
    """Fill transparent areas of a single image with a background colour.

    The output is always an RGB mode image, even when the output format
    supports alpha transparency (e.g. PNG).

    For RGB or L input images that have no transparency, the image is
    saved without modification (passthrough).

    Args:
        input: Path to the source image file.
        output: Path where the result will be saved.  The output is
            always written in RGB mode.
        background_color: RGB tuple ``(r, g, b)`` for the fill colour.
            Defaults to white ``(255, 255, 255)``.

    Returns:
        The output :class:`~pathlib.Path`.

    Raises:
        FileNotFoundError: If *input* does not exist.

    Example:
        >>> fill_background("logo.png", "filled.jpg")
        Path('filled.jpg')

        >>> fill_background("photo.png", "photo.jpg", background_color=(0, 255, 0))
        Path('photo.jpg')
    """
    src = Path(input)
    dst = Path(output)

    if not src.is_file():
        raise FileNotFoundError(f"Input file not found: {src}")

    dst.parent.mkdir(parents=True, exist_ok=True)

    with Image.open(src) as img:
        img.load()
        img = composite_on_background(img, background_color)
        # Always save as RGB — composite_on_background already returns RGB,
        # but ensure it in case the function signature changes.
        img = img.convert("RGB")
        img.save(dst)

    return dst


def fill_background_batch(
    input_dir: str | Path,
    output_dir: str | Path,
    *,
    background_color: tuple[int, int, int] = (255, 255, 255),
    overwrite: bool = False,
) -> list[Path]:
    """Fill transparent areas of all images in a directory.

    Non-image files are skipped.  Files that already exist in the output
    directory are skipped unless *overwrite* is ``True``.

    Each output file keeps the same filename as its input.  All outputs
    are written in RGB mode.

    Args:
        input_dir: Directory containing source images.
        output_dir: Directory where results will be saved.  Created
            automatically if it does not exist.
        background_color: RGB tuple ``(r, g, b)`` for the fill colour.
            Defaults to white ``(255, 255, 255)``.
        overwrite: If ``True``, overwrite existing output files.
            If ``False`` (default), skip files that already exist.

    Returns:
        List of :class:`~pathlib.Path` objects for each successfully
        processed output file, in sorted order.

    Raises:
        FileNotFoundError: If *input_dir* does not exist or is not a
            directory.

    Example:
        >>> fill_background_batch("photos/", "filled/")
        [Path('filled/img1.png'), Path('filled/img2.jpg')]

        >>> fill_background_batch("photos/", "filled/", overwrite=True)
        [Path('filled/img1.png'), Path('filled/img2.jpg')]
    """
    src_dir = Path(input_dir)
    dst_dir = Path(output_dir)

    if not src_dir.is_dir():
        raise FileNotFoundError(f"Input directory not found: {src_dir}")

    dst_dir.mkdir(parents=True, exist_ok=True)

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
        for f in src_dir.iterdir()
        if f.is_file() and f.suffix.lower() in _supported
    )

    results: list[Path] = []

    for src in image_files:
        dst = dst_dir / src.name

        if dst.exists() and not overwrite:
            continue

        try:
            fill_background(src, dst, background_color=background_color)
            results.append(dst)
        except Exception:
            continue

    return results


# ---------------------------------------------------------------------------
# CLI
# ---------------------------------------------------------------------------


def _main() -> None:
    """CLI entry point for fill_background.

    Supports two subcommands:

    ``single``:
        Fill the background of a single image.

    ``batch``:
        Fill the background of all images in a directory.
    """
    parser = argparse.ArgumentParser(
        description="Fill transparent areas of images with a background colour.",
    )
    subparsers = parser.add_subparsers(dest="command", required=True)

    # --- single subcommand ---
    single_parser = subparsers.add_parser("single", help="Process a single image")
    single_parser.add_argument("--input", required=True, help="Source image path")
    single_parser.add_argument("--output", required=True, help="Output image path")
    single_parser.add_argument(
        "--background-color",
        default="#FFFFFF",
        help="Background colour in hex format (default: #FFFFFF)",
    )

    # --- batch subcommand ---
    batch_parser = subparsers.add_parser(
        "batch", help="Process all images in a directory"
    )
    batch_parser.add_argument("--input-dir", required=True, help="Source directory")
    batch_parser.add_argument("--output-dir", required=True, help="Output directory")
    batch_parser.add_argument(
        "--background-color",
        default="#FFFFFF",
        help="Background colour in hex format (default: #FFFFFF)",
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
        result = fill_background(args.input, args.output, background_color=bg_color)
        print(f"Processed: {result}")
    elif args.command == "batch":
        results = fill_background_batch(
            args.input_dir,
            args.output_dir,
            background_color=bg_color,
            overwrite=args.overwrite,
        )
        print(f"Processed {len(results)} image(s):")
        for path in results:
            print(f"  {path}")


if __name__ == "__main__":
    _main()
