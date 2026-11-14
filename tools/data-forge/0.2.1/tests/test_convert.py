"""Tests for the image format conversion tool."""

from __future__ import annotations

from pathlib import Path

import pytest
from PIL import Image

from data_forge.tools.convert import convert_image, convert_images


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


class TestConvertImage:
    """Tests for convert_image — single file conversion."""

    def test_png_rgba_to_jpg_default_bg(self, tmp_path: Path) -> None:
        """PNG RGBA → JPEG with default white background."""
        src = tmp_path / "input.png"
        dst = tmp_path / "output.jpg"
        Image.new("RGBA", (10, 10), (255, 0, 0, 128)).save(src)

        result = convert_image(src, dst)

        assert result == dst
        assert dst.is_file()
        with Image.open(dst) as out:
            assert out.mode == "RGB"
            pixel = out.getpixel((0, 0))
            # JPEG lossy compression may shift values by ±1–2
            assert abs(pixel[0] - 255) <= 2
            assert abs(pixel[1] - 127) <= 2
            assert abs(pixel[2] - 127) <= 2

    def test_png_rgba_to_jpg_custom_bg(self, tmp_path: Path) -> None:
        """PNG RGBA → JPEG with custom black (0,0,0) background."""
        src = tmp_path / "input.png"
        dst = tmp_path / "output.jpg"
        Image.new("RGBA", (10, 10), (255, 0, 0, 128)).save(src)

        result = convert_image(src, dst, background_color=(0, 0, 0))

        assert result == dst
        with Image.open(dst) as out:
            assert out.mode == "RGB"
            pixel = out.getpixel((0, 0))
            assert abs(pixel[0] - 128) <= 2
            assert abs(pixel[1] - 0) <= 2
            assert abs(pixel[2] - 0) <= 2

    def test_png_rgba_to_png_no_bg_needed(self, tmp_path: Path) -> None:
        """PNG RGBA → PNG preserves RGBA, no background fill needed."""
        src = tmp_path / "input.png"
        dst = tmp_path / "output.png"
        Image.new("RGBA", (10, 10), (255, 0, 0, 128)).save(src)

        result = convert_image(src, dst)

        assert result == dst
        with Image.open(dst) as out:
            assert out.mode == "RGBA"
            assert out.getpixel((0, 0)) == (255, 0, 0, 128)

    def test_jpg_to_png_simple(self, tmp_path: Path) -> None:
        """JPEG → PNG, simple format switch no alpha involved."""
        src = tmp_path / "input.jpg"
        dst = tmp_path / "output.png"
        _create_test_image(src, mode="RGB", color=(100, 200, 50))

        result = convert_image(src, dst)

        assert result == dst
        with Image.open(dst) as out:
            assert out.mode == "RGB"
            assert out.getpixel((0, 0)) == (100, 200, 50)

    def test_webp_alpha_to_jpeg(self, tmp_path: Path) -> None:
        """WebP with alpha → JPEG, background composited on white."""
        src = tmp_path / "input.webp"
        dst = tmp_path / "output.jpg"
        img = Image.new("RGBA", (10, 10), (255, 0, 0, 128))
        img.save(src, "WEBP", lossless=True)

        result = convert_image(src, dst)

        assert result == dst
        with Image.open(dst) as out:
            assert out.mode == "RGB"
            pixel = out.getpixel((0, 0))
            # JPEG lossy compression may shift values by ±1–2
            assert abs(pixel[0] - 255) <= 2
            assert abs(pixel[1] - 127) <= 2
            assert abs(pixel[2] - 127) <= 2

    def test_bmp_no_alpha_to_png(self, tmp_path: Path) -> None:
        """BMP → PNG, direct conversion with no alpha channel."""
        src = tmp_path / "input.bmp"
        dst = tmp_path / "output.png"
        _create_test_image(src, mode="RGB", color=(50, 100, 200))

        result = convert_image(src, dst)

        assert result == dst
        with Image.open(dst) as out:
            assert out.mode == "RGB"
            assert out.getpixel((0, 0)) == (50, 100, 200)

    def test_gif_to_jpeg(self, tmp_path: Path) -> None:
        """GIF → JPEG, first frame only converted to RGB."""
        src = tmp_path / "input.gif"
        dst = tmp_path / "output.jpg"
        _create_test_image(src, mode="RGB", color=(0, 255, 0))

        result = convert_image(src, dst)

        assert result == dst
        with Image.open(dst) as out:
            assert out.mode == "RGB"
            assert out.size == (10, 10)

    def test_unsupported_format_valueerror(self, tmp_path: Path) -> None:
        """Unsupported input format (.psd) raises ValueError."""
        src = tmp_path / "image.psd"
        src.write_bytes(b"dummy")
        dst = tmp_path / "output.jpg"

        with pytest.raises(ValueError, match=".psd"):
            convert_image(src, dst)

    def test_missing_input_filenotfound(self, tmp_path: Path) -> None:
        """Missing input file raises FileNotFoundError."""
        src = tmp_path / "nonexistent.png"
        dst = tmp_path / "output.jpg"

        with pytest.raises(FileNotFoundError):
            convert_image(src, dst)


class TestConvertImages:
    """Tests for convert_images — batch conversion."""

    def test_batch_mixed_formats_to_jpeg(self, tmp_path: Path) -> None:
        """Batch: PNG, JPG, WebP, BMP, GIF → JPEG, 5 outputs."""
        src_dir = tmp_path / "src"
        dst_dir = tmp_path / "dst"
        src_dir.mkdir()

        _create_test_image(src_dir / "a.png", mode="RGB", color=(255, 0, 0))
        _create_test_image(src_dir / "b.jpg", mode="RGB", color=(0, 255, 0))
        _create_test_image(src_dir / "c.webp", mode="RGB", color=(0, 0, 255))
        _create_test_image(src_dir / "d.bmp", mode="RGB", color=(255, 255, 0))
        _create_test_image(src_dir / "e.gif", mode="RGB", color=(255, 0, 255))

        results = convert_images(src_dir, dst_dir, ".jpg")

        assert len(results) == 5
        for path in results:
            assert path.suffix == ".jpg"
            assert path.is_file()

    def test_batch_non_image_files_skipped(self, tmp_path: Path) -> None:
        """Batch: .txt and .csv files are skipped."""
        src_dir = tmp_path / "src"
        dst_dir = tmp_path / "dst"
        src_dir.mkdir()

        _create_test_image(src_dir / "img.png", mode="RGB")
        (src_dir / "readme.txt").write_text("not an image")
        (src_dir / "data.csv").write_text("col1,col2")

        results = convert_images(src_dir, dst_dir, ".jpg")

        assert len(results) == 1
        assert results[0].stem == "img"

    def test_batch_empty_directory(self, tmp_path: Path) -> None:
        """Batch: empty input directory returns empty list."""
        src_dir = tmp_path / "src"
        dst_dir = tmp_path / "dst"
        src_dir.mkdir()

        results = convert_images(src_dir, dst_dir, ".png")

        assert results == []

    def test_batch_overwrite_false_skips(self, tmp_path: Path) -> None:
        """Batch: overwrite=False skips pre-existing output files."""
        src_dir = tmp_path / "src"
        dst_dir = tmp_path / "dst"
        src_dir.mkdir()
        dst_dir.mkdir()

        _create_test_image(src_dir / "img.png", mode="RGB", color=(255, 0, 0))
        pre_existing = _create_test_image(dst_dir / "img.jpg", mode="RGB", color=(0, 0, 0))

        results = convert_images(src_dir, dst_dir, ".jpg", overwrite=False)

        assert len(results) == 0
        with Image.open(pre_existing) as img:
            assert img.getpixel((0, 0)) == (0, 0, 0)

    def test_batch_overwrite_true_replaces(self, tmp_path: Path) -> None:
        """Batch: overwrite=True replaces pre-existing output files."""
        src_dir = tmp_path / "src"
        dst_dir = tmp_path / "dst"
        src_dir.mkdir()
        dst_dir.mkdir()

        _create_test_image(src_dir / "img.png", mode="RGB", color=(255, 0, 0))
        _create_test_image(dst_dir / "img.jpg", mode="RGB", color=(0, 0, 0))

        results = convert_images(src_dir, dst_dir, ".jpg", overwrite=True)

        assert len(results) == 1
        with Image.open(results[0]) as img:
            pixel = img.getpixel((0, 0))
            # JPEG lossy compression may shift values by ±1–2
            assert abs(pixel[0] - 255) <= 2
            assert abs(pixel[1] - 0) <= 2
            assert abs(pixel[2] - 0) <= 2

    def test_batch_output_dir_created(self, tmp_path: Path) -> None:
        """Batch: output directory is created automatically."""
        src_dir = tmp_path / "src"
        dst_dir = tmp_path / "sub" / "dst"
        src_dir.mkdir()

        assert not dst_dir.exists()
        _create_test_image(src_dir / "img.png", mode="RGB")

        results = convert_images(src_dir, dst_dir, ".jpg")

        assert dst_dir.is_dir()
        assert len(results) == 1
        assert results[0].is_file()
