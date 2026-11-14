"""Tests for the fill_background image tool."""

from __future__ import annotations

from pathlib import Path

import pytest
from PIL import Image

from data_forge.tools.fill_background import fill_background, fill_background_batch


def _create_test_image(
    path: Path,
    size: tuple[int, int] = (10, 10),
    mode: str = "RGB",
    color: tuple[int, ...] = (255, 0, 0),
) -> Path:
    """Helper: create a solid-colour test image and save to *path*."""
    img = Image.new(mode, size, color)
    img.save(path)
    return path


class TestFillBackground:
    """Tests for fill_background — single file processing."""

    def test_rgba_png_to_jpg_default_white(self, tmp_path: Path) -> None:
        """RGBA → JPEG, default white (255,255,255) fill."""
        src = tmp_path / "input.png"
        dst = tmp_path / "output.jpg"
        Image.new("RGBA", (10, 10), (255, 0, 0, 128)).save(src)

        result = fill_background(src, dst)

        assert result == dst
        assert dst.is_file()
        with Image.open(dst) as out:
            assert out.mode == "RGB"
            pixel = out.getpixel((0, 0))
            # JPEG lossy compression may shift values by ±1–2
            assert abs(pixel[0] - 255) <= 2
            assert abs(pixel[1] - 127) <= 2
            assert abs(pixel[2] - 127) <= 2

    def test_rgba_png_to_jpg_custom_green(self, tmp_path: Path) -> None:
        """RGBA → JPEG, green (0,255,0) fill."""
        src = tmp_path / "input.png"
        dst = tmp_path / "output.jpg"
        Image.new("RGBA", (10, 10), (255, 0, 0, 128)).save(src)

        result = fill_background(src, dst, background_color=(0, 255, 0))

        assert result == dst
        with Image.open(dst) as out:
            assert out.mode == "RGB"
            pixel = out.getpixel((0, 0))
            # RGBA (255,0,0,128) on green (0,255,0) → (128, 127, 0)
            assert abs(pixel[0] - 128) <= 2
            assert abs(pixel[1] - 127) <= 2
            assert abs(pixel[2] - 0) <= 2

    def test_rgba_png_to_rgba_png_output_rgb(self, tmp_path: Path) -> None:
        """RGBA → PNG, output is RGB (not RGBA) even though PNG supports alpha."""
        src = tmp_path / "input.png"
        dst = tmp_path / "output.png"
        Image.new("RGBA", (10, 10), (255, 0, 0, 128)).save(src)

        result = fill_background(src, dst)

        assert result == dst
        with Image.open(dst) as out:
            assert out.mode == "RGB"
            # PNG is lossless, exact values expected
            assert out.getpixel((0, 0)) == (255, 127, 127)

    def test_rgb_jpg_noop(self, tmp_path: Path) -> None:
        """RGB JPEG input → passthrough, pixels unchanged (within JPEG tolerance)."""
        src = tmp_path / "input.jpg"
        dst = tmp_path / "output.jpg"
        _create_test_image(src, mode="RGB", color=(100, 200, 50))

        result = fill_background(src, dst)

        assert result == dst
        with Image.open(dst) as out:
            assert out.mode == "RGB"
            pixel = out.getpixel((0, 0))
            # JPEG re-encoding may shift values by ±1–2
            assert abs(pixel[0] - 100) <= 2
            assert abs(pixel[1] - 200) <= 2
            assert abs(pixel[2] - 50) <= 2

    def test_la_mode_to_rgb(self, tmp_path: Path) -> None:
        """LA grayscale+alpha → RGB after fill with white background."""
        src = tmp_path / "input.png"
        dst = tmp_path / "output.png"
        Image.new("LA", (10, 10), (128, 128)).save(src)

        result = fill_background(src, dst)

        assert result == dst
        with Image.open(dst) as out:
            assert out.mode == "RGB"
            pixel = out.getpixel((0, 0))
            # LA (L=128, A=128) on white → all channels should be ~191
            assert pixel[0] == pixel[1] == pixel[2]
            assert pixel[0] == 191

    def test_p_mode_with_transparency(self, tmp_path: Path) -> None:
        """P mode with transparency → correct fill, output RGB."""
        src = tmp_path / "input.png"
        dst = tmp_path / "output.png"
        # Create RGBA first, then convert to P (Pillow preserves transparency in info)
        rgba = Image.new("RGBA", (10, 10), (128, 64, 32, 200))
        rgba.save(src)

        # Re-open and re-save as P to get transparency in info
        with Image.open(src) as img:
            p_img = img.convert("P")
            p_img.save(src)

        result = fill_background(src, dst)

        assert result == dst
        with Image.open(dst) as out:
            assert out.mode == "RGB"
            assert out.size == (10, 10)

    def test_fully_transparent_to_solid(self, tmp_path: Path) -> None:
        """Fully transparent RGBA → pure background color."""
        src = tmp_path / "input.png"
        dst = tmp_path / "output.png"
        Image.new("RGBA", (10, 10), (0, 0, 0, 0)).save(src)

        result = fill_background(src, dst, background_color=(200, 100, 50))

        assert result == dst
        with Image.open(dst) as out:
            assert out.mode == "RGB"
            assert out.getpixel((0, 0)) == (200, 100, 50)

    def test_fully_opaque_unchanged(self, tmp_path: Path) -> None:
        """Fully opaque RGBA → visually same pixel values, output RGB."""
        src = tmp_path / "input.png"
        dst = tmp_path / "output.png"
        Image.new("RGBA", (10, 10), (255, 0, 0, 255)).save(src)

        result = fill_background(src, dst, background_color=(99, 99, 99))

        assert result == dst
        with Image.open(dst) as out:
            assert out.mode == "RGB"
            assert out.getpixel((0, 0)) == (255, 0, 0)

    def test_missing_input_raises(self, tmp_path: Path) -> None:
        """Missing input file raises FileNotFoundError."""
        src = tmp_path / "nonexistent.png"
        dst = tmp_path / "output.jpg"

        with pytest.raises(FileNotFoundError):
            fill_background(src, dst)


class TestFillBackgroundBatch:
    """Tests for fill_background_batch — batch processing."""

    def test_batch_directory(self, tmp_path: Path) -> None:
        """Batch: process multiple images in a directory."""
        src_dir = tmp_path / "src"
        dst_dir = tmp_path / "dst"
        src_dir.mkdir()

        _create_test_image(src_dir / "a.png", mode="RGB", color=(255, 0, 0))
        _create_test_image(src_dir / "b.jpg", mode="RGB", color=(0, 255, 0))
        _create_test_image(src_dir / "c.webp", mode="RGB", color=(0, 0, 255))

        results = fill_background_batch(src_dir, dst_dir)

        assert len(results) == 3
        for path in results:
            assert path.is_file()
            # Batch preserves original filename
            assert path.name in {"a.png", "b.jpg", "c.webp"}

    def test_batch_corrupted_image_skipped(self, tmp_path: Path) -> None:
        """Batch: corrupted image file is skipped gracefully."""
        src_dir = tmp_path / "src"
        dst_dir = tmp_path / "dst"
        src_dir.mkdir()

        _create_test_image(src_dir / "good.png", mode="RGB", color=(255, 0, 0))
        # Create a corrupted/invalid image file
        (src_dir / "bad.png").write_bytes(b"this is not a valid image file")

        results = fill_background_batch(src_dir, dst_dir)

        assert len(results) == 1
        assert results[0].name == "good.png"

    def test_batch_empty_output_for_empty_dir(self, tmp_path: Path) -> None:
        """Batch: empty input directory returns empty list."""
        src_dir = tmp_path / "src"
        dst_dir = tmp_path / "dst"
        src_dir.mkdir()

        results = fill_background_batch(src_dir, dst_dir)

        assert results == []


class TestCLI:
    """Tests for CLI argument parsing."""

    def test_invalid_hex_color_raises(self) -> None:
        """Invalid hex color in CLI raises ValueError via _parse_hex_color."""
        from data_forge.tools._alpha import _parse_hex_color

        with pytest.raises(ValueError, match="Invalid hex color"):
            _parse_hex_color("not-a-color")
