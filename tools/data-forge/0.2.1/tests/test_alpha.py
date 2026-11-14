"""Tests for the shared alpha compositing module."""

from __future__ import annotations

import pytest
from PIL import Image

from data_forge.tools._alpha import _parse_hex_color, composite_on_background


class TestCompositeOnBackground:
    """Tests for composite_on_background."""

    def test_rgba_to_rgb_on_white(self) -> None:
        """RGBA (255,0,0,128) on white (255,255,255) → pixel (255,127,127)."""
        img = Image.new("RGBA", (10, 10), (255, 0, 0, 128))
        result = composite_on_background(img, (255, 255, 255))

        assert result.mode == "RGB"
        assert result.size == (10, 10)
        assert result.getpixel((0, 0)) == (255, 127, 127)

    def test_rgba_to_rgb_on_custom_color(self) -> None:
        """RGBA (255,0,0,128) on black (0,0,0) → pixel (128,0,0)."""
        img = Image.new("RGBA", (10, 10), (255, 0, 0, 128))
        result = composite_on_background(img, (0, 0, 0))

        assert result.mode == "RGB"
        assert result.getpixel((0, 0)) == (128, 0, 0)

    def test_la_to_l(self) -> None:
        """LA grayscale with alpha on white (255,) → RGB mode with correct pixel."""
        img = Image.new("LA", (10, 10), (128, 128))
        result = composite_on_background(img, (255, 255, 255))

        assert result.mode == "RGB"
        assert result.size == (10, 10)
        # LA (L=128, A=128) composited on white (L=255):
        # Pillow integer compositing: (128*128 + 255*127) // 255 = 191
        pixel = result.getpixel((0, 0))
        # All channels should be the same (grayscale → RGB)
        assert pixel[0] == pixel[1] == pixel[2]
        assert pixel[0] == 191

    def test_p_mode_with_transparency(self) -> None:
        """P mode with transparency info → converted to RGB correctly."""
        # Create RGBA first, then convert to P with transparency
        rgba = Image.new("RGBA", (10, 10), (128, 64, 32, 200))
        p_img = rgba.convert("P")
        # Pillow's convert("P") from RGBA preserves transparency in info
        result = composite_on_background(p_img, (255, 255, 255))

        assert result.mode == "RGB"
        assert result.size == (10, 10)

    def test_fully_transparent(self) -> None:
        """RGBA (0,0,0,0) → pure background color."""
        img = Image.new("RGBA", (5, 5), (0, 0, 0, 0))
        result = composite_on_background(img, (200, 100, 50))

        assert result.mode == "RGB"
        assert result.getpixel((0, 0)) == (200, 100, 50)

    def test_fully_opaque(self) -> None:
        """RGBA (255,0,0,255) → pure red (255,0,0)."""
        img = Image.new("RGBA", (5, 5), (255, 0, 0, 255))
        result = composite_on_background(img, (99, 99, 99))

        assert result.mode == "RGB"
        assert result.getpixel((0, 0)) == (255, 0, 0)

    def test_rgb_input_passthrough(self) -> None:
        """RGB input → returned unchanged."""
        img = Image.new("RGB", (10, 10), (100, 200, 50))
        result = composite_on_background(img, (255, 255, 255))

        assert result is img  # same object
        assert result.mode == "RGB"
        assert result.getpixel((0, 0)) == (100, 200, 50)

    def test_cmyk_input(self) -> None:
        """CMYK input → converted to RGB, then composited."""
        img = Image.new("CMYK", (8, 8), (50, 100, 150, 0))
        result = composite_on_background(img, (255, 255, 255))

        assert result.mode == "RGB"
        assert result.size == (8, 8)


class TestParseHexColor:
    """Tests for _parse_hex_color utility."""

    def test_valid_hex_color(self) -> None:
        """Valid '#RRGGBB' string returns correct RGB tuple."""
        assert _parse_hex_color("#FF0000") == (255, 0, 0)
        assert _parse_hex_color("#00FF00") == (0, 255, 0)
        assert _parse_hex_color("#0000FF") == (0, 0, 255)
        assert _parse_hex_color("#ABCDEF") == (171, 205, 239)
        assert _parse_hex_color("#123456") == (18, 52, 86)

    def test_hex_color_lowercase(self) -> None:
        """Lowercase hex values are parsed correctly."""
        assert _parse_hex_color("#ff0000") == (255, 0, 0)
        assert _parse_hex_color("#abcdef") == (171, 205, 239)

    def test_invalid_hex_color_raises_valueerror(self) -> None:
        """Invalid hex color strings raise ValueError."""
        invalid_cases = [
            "FF0000",       # missing #
            "#FF00",        # too short
            "#FF000000",    # too long
            "#GG0000",      # invalid hex chars
            "#FF 00 00",    # spaces
            "",             # empty
            "not a color",  # gibberish
            123,            # wrong type
            None,           # wrong type
        ]
        for case in invalid_cases:
            with pytest.raises(ValueError):
                _parse_hex_color(case)  # type: ignore[arg-type]
