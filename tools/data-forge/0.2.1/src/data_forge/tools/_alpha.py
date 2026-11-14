"""Shared alpha compositing utilities for image tools.

Provides compositing functions to flatten images with transparency onto
a solid background, used by resize, remove_bg and other tools.
"""

from __future__ import annotations

from PIL import Image


def _parse_hex_color(hex_str: str) -> tuple[int, int, int]:
    """Parse a hex color string to an RGB tuple.

    Args:
        hex_str: Color in ``"#RRGGBB"`` format.

    Returns:
        RGB tuple of integers (0-255).

    Raises:
        ValueError: If *hex_str* is not a valid ``"#RRGGBB"`` hex string.

    Example:
        >>> _parse_hex_color("#FF0000")
        (255, 0, 0)
        >>> _parse_hex_color("#abcdef")
        (171, 205, 239)
    """
    if not isinstance(hex_str, str):
        raise ValueError(
            f"Invalid hex color: {hex_str!r}. Expected '#RRGGBB' format."
        )
    if not hex_str.startswith("#") or len(hex_str) != 7:
        raise ValueError(
            f"Invalid hex color: {hex_str!r}. Expected '#RRGGBB' format."
        )
    try:
        r = int(hex_str[1:3], 16)
        g = int(hex_str[3:5], 16)
        b = int(hex_str[5:7], 16)
    except (ValueError, IndexError):
        raise ValueError(
            f"Invalid hex color: {hex_str!r}. Expected '#RRGGBB' format."
        )
    return (r, g, b)


def composite_on_background(
    img: Image.Image,
    background_color: tuple[int, int, int],
) -> Image.Image:
    """Composite an image with transparency onto a solid background.

    Handles various image modes (RGBA, LA, P, CMYK, RGB, L) and ensures
    the output is always an RGB mode image.

    Args:
        img: Source :class:`~PIL.Image.Image`. Supported modes:
            ``RGBA``, ``LA``, ``P`` (with transparency), ``CMYK``,
            ``RGB``, and ``L``.
        background_color: RGB tuple ``(r, g, b)`` for the background.

    Returns:
        An ``RGB`` mode Image with transparency composited onto
        *background_color*.

    Example:
        >>> from PIL import Image
        >>> img = Image.new("RGBA", (10, 10), (255, 0, 0, 128))
        >>> result = composite_on_background(img, (255, 255, 255))
        >>> result.mode
        'RGB'
    """
    # CMYK → RGB conversion (no alpha, just transform)
    if img.mode == "CMYK":
        img = img.convert("RGB")

    # P mode with transparency info → convert to RGBA first
    if img.mode == "P" and "transparency" in img.info:
        img = img.convert("RGBA")

    # RGB: already correct, passthrough
    if img.mode == "RGB":
        return img

    # L (grayscale): no alpha to composite, just convert to RGB
    if img.mode == "L":
        return img.convert("RGB")

    # RGBA compositing
    if img.mode == "RGBA":
        background = Image.new("RGB", img.size, background_color)
        background.paste(img, mask=img.split()[3])
        return background

    # LA compositing — composite onto L-mode background, then convert to RGB
    if img.mode == "LA":
        l_bg = Image.new("L", img.size, _rgb_to_luminance(background_color))
        l_bg.paste(img, mask=img.split()[1])
        return l_bg.convert("RGB")

    # Fallback for any other mode: convert to RGBA, then composite
    rgba = img.convert("RGBA")
    background = Image.new("RGB", rgba.size, background_color)
    background.paste(rgba, mask=rgba.split()[3])
    return background


def _rgb_to_luminance(rgb: tuple[int, int, int]) -> int:
    """Convert an RGB color to its luminance (grayscale) value.

    Uses the ITU-R BT.601 standard formula:
    ``Y = 0.299*R + 0.587*G + 0.114*B``

    Args:
        rgb: RGB tuple of integers (0-255).

    Returns:
        Integer luminance value (0-255).
    """
    return int(0.299 * rgb[0] + 0.587 * rgb[1] + 0.114 * rgb[2])
