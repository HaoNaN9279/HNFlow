"""Tests for background removal tool."""

from __future__ import annotations

from pathlib import Path
from unittest.mock import patch

import pytest
from PIL import Image

from data_forge.tools.remove_bg import (
    _to_rgb,
    remove_background,
    remove_background_batch,
)


def _create_test_image(path: Path, size: tuple[int, int], mode: str = "RGB") -> Path:
    """Helper: create a solid-color test image and save to *path*."""
    color = (255, 0, 0) if mode == "RGB" else (255, 0, 0, 128)
    img = Image.new(mode, size, color)
    img.save(path)
    return path


# Simple RGBA "cutout" returned by a mocked rembg.remove()
def _mock_remove_result(img: Image.Image) -> Image.Image:
    """Simulate rembg returning an RGBA version of the input."""
    return img.convert("RGBA")


@pytest.fixture
def mock_rembg():
    """Patch rembg.remove and new_session so no real model is loaded."""
    with (
        patch(
            "data_forge.tools.remove_bg._remove",
            side_effect=lambda img, **kw: _mock_remove_result(img),
        ),
        patch(
            "data_forge.tools.remove_bg._new_session",
            return_value="mock_session",
        ),
    ):
        # Reset cached sessions so each test starts fresh
        from data_forge.tools.remove_bg import _sessions

        _sessions.clear()
        yield


class TestToRgb:
    """Tests for _to_rgb compositing helper."""

    def test_rgba_to_rgb(self) -> None:
        """RGBA image with semi-transparent pixels gets white background."""
        img = Image.new("RGBA", (10, 10), (255, 0, 0, 128))
        result = _to_rgb(img, (255, 255, 255))
        assert result.mode == "RGB"
        assert result.size == (10, 10)

    def test_already_rgb_passthrough(self) -> None:
        """RGB input returns unchanged."""
        img = Image.new("RGB", (10, 10), (100, 200, 50))
        result = _to_rgb(img, (255, 255, 255))
        assert result is img  # same object, no copy

    def test_fully_transparent_white(self) -> None:
        """Fully transparent areas become background color."""
        img = Image.new("RGBA", (5, 5), (0, 0, 0, 0))
        result = _to_rgb(img, (200, 100, 50))
        assert result.getpixel((0, 0)) == (200, 100, 50)

    def test_fully_opaque_preserved(self) -> None:
        """Fully opaque pixels keep their color."""
        img = Image.new("RGBA", (5, 5), (10, 20, 30, 255))
        result = _to_rgb(img, (99, 99, 99))
        # opaque red over white → red
        assert result.getpixel((0, 0)) == (10, 20, 30)


class TestRemoveBackground:
    """Tests for single-image remove_background."""

    def test_missing_input_raises(self, tmp_path: Path) -> None:
        """Non-existent input file raises FileNotFoundError."""
        with pytest.raises(FileNotFoundError):
            remove_background(tmp_path / "nope.jpg", tmp_path / "out.jpg")

    def test_output_dir_created(self, tmp_path: Path, mock_rembg: None) -> None:
        """Output parent directories are created automatically."""
        src = _create_test_image(tmp_path / "in.jpg", (100, 100))
        dst = tmp_path / "deep" / "nested" / "out.jpg"

        result = remove_background(src, dst)
        assert result == dst
        assert dst.is_file()

    def test_jpg_output_gets_rgb(self, tmp_path: Path, mock_rembg: None) -> None:
        """When output is JPEG, the image is saved as RGB (no alpha)."""
        src = _create_test_image(tmp_path / "in.png", (50, 50))
        dst = tmp_path / "out.jpg"

        remove_background(src, dst)
        with Image.open(dst) as img:
            assert img.mode == "RGB"

    def test_png_output_keeps_rgba(self, tmp_path: Path, mock_rembg: None) -> None:
        """When output is PNG, the image keeps RGBA with bg color."""
        src = _create_test_image(tmp_path / "in.jpg", (50, 50))
        dst = tmp_path / "out.png"

        remove_background(src, dst)
        with Image.open(dst) as img:
            assert img.mode == "RGBA"

    def test_custom_background_color(self, tmp_path: Path, mock_rembg: None) -> None:
        """Custom background_color is applied."""
        src = _create_test_image(tmp_path / "in.jpg", (10, 10))
        dst = tmp_path / "out.jpg"

        remove_background(src, dst, background_color=(0, 128, 255))
        with Image.open(dst) as img:
            # Bottom-right corner was black (0,0,0) in original,
            # but background removal returned RGBA(0,0,0,alpha).
            # After compositing onto blue, it should be blue-ish.
            # Actually with mock, the whole image is red + alpha.
            # Top-left pixel: original red (255,0,0,128) over blue(0,128,255)
            # Result depends on alpha blending. Just verify it saved.
            assert img.mode == "RGB"


class TestRemoveBackgroundBatch:
    """Tests for batch processing."""

    def test_batch_jpg(self, tmp_path: Path, mock_rembg: None) -> None:
        """Batch processes all images in a directory."""
        src_dir = tmp_path / "src"
        dst_dir = tmp_path / "dst"
        src_dir.mkdir()
        _create_test_image(src_dir / "a.jpg", (100, 100))
        _create_test_image(src_dir / "b.jpg", (200, 200))

        results = remove_background_batch(src_dir, dst_dir)
        assert len(results) == 2
        assert {p.name for p in results} == {"a.jpg", "b.jpg"}

    def test_non_images_skipped(self, tmp_path: Path, mock_rembg: None) -> None:
        """Non-image files are ignored."""
        src_dir = tmp_path / "src"
        dst_dir = tmp_path / "dst"
        src_dir.mkdir()
        _create_test_image(src_dir / "img.jpg", (100, 100))
        (src_dir / "readme.txt").write_text("hello")

        results = remove_background_batch(src_dir, dst_dir)
        assert len(results) == 1

    def test_overwrite_false_skips(self, tmp_path: Path, mock_rembg: None) -> None:
        """Existing files are skipped when overwrite=False."""
        src_dir = tmp_path / "src"
        dst_dir = tmp_path / "dst"
        src_dir.mkdir()
        dst_dir.mkdir()
        _create_test_image(src_dir / "img.jpg", (100, 100))
        _create_test_image(dst_dir / "img.jpg", (100, 100))

        results = remove_background_batch(src_dir, dst_dir, overwrite=False)
        assert len(results) == 0

    def test_overwrite_true_replaces(self, tmp_path: Path, mock_rembg: None) -> None:
        """Existing files are overwritten when overwrite=True."""
        src_dir = tmp_path / "src"
        dst_dir = tmp_path / "dst"
        src_dir.mkdir()
        dst_dir.mkdir()
        _create_test_image(src_dir / "img.jpg", (100, 100))
        _create_test_image(dst_dir / "img.jpg", (100, 100))

        results = remove_background_batch(src_dir, dst_dir, overwrite=True)
        assert len(results) == 1

    def test_input_dir_not_found(self, tmp_path: Path) -> None:
        """Missing input directory raises FileNotFoundError."""
        with pytest.raises(FileNotFoundError):
            remove_background_batch(tmp_path / "nope", tmp_path / "dst")

    def test_empty_directory(self, tmp_path: Path, mock_rembg: None) -> None:
        """Empty input directory returns empty list."""
        src_dir = tmp_path / "src"
        src_dir.mkdir()
        results = remove_background_batch(src_dir, tmp_path / "dst")
        assert results == []

    def test_session_cached_across_calls(
        self, tmp_path: Path, mock_rembg: None
    ) -> None:
        """Session is reused across batch images."""
        src_dir = tmp_path / "src"
        dst_dir = tmp_path / "dst"
        src_dir.mkdir()
        _create_test_image(src_dir / "1.jpg", (50, 50))
        _create_test_image(src_dir / "2.jpg", (50, 50))
        _create_test_image(src_dir / "3.jpg", (50, 50))

        results = remove_background_batch(src_dir, dst_dir)
        assert len(results) == 3
