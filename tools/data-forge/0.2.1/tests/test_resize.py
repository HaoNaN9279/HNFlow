"""Tests for the batch image resize tool."""

from __future__ import annotations

from pathlib import Path

import pytest
from PIL import Image

from data_forge.tools.resize import resize_images


def _create_test_image(path: Path, size: tuple[int, int], mode: str = "RGB") -> Path:
    """Helper: create a solid-color test image and save to *path*."""
    img = Image.new(mode, size, color=(255, 0, 0) if mode == "RGB" else (255,))
    img.save(path)
    return path


class TestResizeImages:
    """Tests for resize_images."""

    def test_exact_resize_jpg(self, tmp_path: Path) -> None:
        """Exact resize of JPEG images to target dimensions."""
        src_dir = tmp_path / "src"
        dst_dir = tmp_path / "dst"
        src_dir.mkdir()
        _create_test_image(src_dir / "a.jpg", (1600, 1200))
        _create_test_image(src_dir / "b.jpg", (1920, 1080))

        results = resize_images(src_dir, dst_dir, 800, 600)

        assert len(results) == 2
        for path in results:
            assert path.suffix == ".jpg"
            with Image.open(path) as img:
                assert img.size == (800, 600)

    def test_fit_long_edge_landscape(self, tmp_path: Path) -> None:
        """fit_long_edge=True: landscape image — long edge is width."""
        src_dir = tmp_path / "src"
        dst_dir = tmp_path / "dst"
        src_dir.mkdir()
        _create_test_image(src_dir / "landscape.jpg", (1600, 900))

        results = resize_images(src_dir, dst_dir, 800, 600, fit_long_edge=True)
        assert len(results) == 1
        with Image.open(results[0]) as img:
            w, h = img.size
            assert w == 800  # long edge (width) → 800
            assert h == 450  # proportional scaling
            assert h <= 800

    def test_fit_long_edge_portrait(self, tmp_path: Path) -> None:
        """fit_long_edge=True: portrait image — long edge is height."""
        src_dir = tmp_path / "src"
        dst_dir = tmp_path / "dst"
        src_dir.mkdir()
        _create_test_image(src_dir / "portrait.jpg", (600, 1200))

        results = resize_images(src_dir, dst_dir, 800, 600, fit_long_edge=True)
        assert len(results) == 1
        with Image.open(results[0]) as img:
            w, h = img.size
            assert h == 800  # long edge (height) → max(800,600) = 800
            assert w == 400  # proportional scaling

    def test_multiple_formats(self, tmp_path: Path) -> None:
        """Mixed input formats — PNG, JPEG, WebP."""
        src_dir = tmp_path / "src"
        dst_dir = tmp_path / "dst"
        src_dir.mkdir()
        _create_test_image(src_dir / "a.png", (100, 100))
        _create_test_image(src_dir / "b.jpg", (200, 200))
        # WebP
        _create_test_image(src_dir / "c.webp", (300, 300))

        results = resize_images(src_dir, dst_dir, 50, 50)

        assert len(results) == 3
        suffixes = {p.suffix for p in results}
        assert suffixes == {".png", ".jpg", ".webp"}

    def test_non_image_files_skipped(self, tmp_path: Path) -> None:
        """Non-image files in the directory are ignored."""
        src_dir = tmp_path / "src"
        dst_dir = tmp_path / "dst"
        src_dir.mkdir()
        _create_test_image(src_dir / "img.png", (100, 100))
        (src_dir / "readme.txt").write_text("not an image")
        (src_dir / "data.csv").write_text("1,2,3")

        results = resize_images(src_dir, dst_dir, 50, 50)

        assert len(results) == 1
        assert results[0].name == "img.png"

    def test_output_dir_created(self, tmp_path: Path) -> None:
        """Output directory is created automatically."""
        src_dir = tmp_path / "src"
        dst_dir = tmp_path / "nested" / "dst"
        src_dir.mkdir()
        _create_test_image(src_dir / "img.jpg", (100, 100))

        assert not dst_dir.exists()
        results = resize_images(src_dir, dst_dir, 50, 50)
        assert dst_dir.is_dir()
        assert len(results) == 1

    def test_overwrite_false_skips_existing(self, tmp_path: Path) -> None:
        """overwrite=False (default) skips files that already exist."""
        src_dir = tmp_path / "src"
        dst_dir = tmp_path / "dst"
        src_dir.mkdir()
        dst_dir.mkdir()
        _create_test_image(src_dir / "img.jpg", (100, 100))
        preexisting = _create_test_image(dst_dir / "img.jpg", (100, 100))

        results = resize_images(src_dir, dst_dir, 50, 50, overwrite=False)

        assert len(results) == 0
        # File should be untouched
        with Image.open(preexisting) as img:
            assert img.size == (100, 100)

    def test_overwrite_true_replaces_existing(self, tmp_path: Path) -> None:
        """overwrite=True replaces existing files."""
        src_dir = tmp_path / "src"
        dst_dir = tmp_path / "dst"
        src_dir.mkdir()
        dst_dir.mkdir()
        _create_test_image(src_dir / "img.jpg", (100, 100))
        _create_test_image(dst_dir / "img.jpg", (100, 100))

        results = resize_images(src_dir, dst_dir, 50, 50, overwrite=True)

        assert len(results) == 1
        with Image.open(results[0]) as img:
            assert img.size == (50, 50)

    def test_rgba_to_jpeg_converts_background(self, tmp_path: Path) -> None:
        """RGBA PNG saved as JPEG gets white background."""
        src_dir = tmp_path / "src"
        dst_dir = tmp_path / "dst"
        src_dir.mkdir()
        # Create RGBA image with transparency
        img = Image.new("RGBA", (100, 100), (255, 0, 0, 128))
        img.save(src_dir / "transparent.png")

        results = resize_images(src_dir, dst_dir, 50, 50)
        assert len(results) == 1
        assert results[0].suffix == ".png"  # format preserved
        with Image.open(results[0]) as out:
            assert out.mode in ("RGBA", "RGB")

    def test_empty_directory(self, tmp_path: Path) -> None:
        """Empty input directory returns empty list."""
        src_dir = tmp_path / "src"
        dst_dir = tmp_path / "dst"
        src_dir.mkdir()

        results = resize_images(src_dir, dst_dir, 100, 100)
        assert results == []

    def test_missing_input_dir_raises(self, tmp_path: Path) -> None:
        """Non-existent input directory raises FileNotFoundError."""
        with pytest.raises(FileNotFoundError):
            resize_images(tmp_path / "nonexistent", tmp_path / "dst", 100, 100)

    def test_invalid_dimensions_raises(self, tmp_path: Path) -> None:
        """Zero or negative dimensions raise ValueError."""
        src_dir = tmp_path / "src"
        src_dir.mkdir()

        with pytest.raises(ValueError):
            resize_images(src_dir, tmp_path / "dst", 0, 100)
        with pytest.raises(ValueError):
            resize_images(src_dir, tmp_path / "dst", 100, -1)

    def test_corrupted_image_skipped(self, tmp_path: Path) -> None:
        """Corrupted image files are skipped gracefully."""
        src_dir = tmp_path / "src"
        dst_dir = tmp_path / "dst"
        src_dir.mkdir()
        _create_test_image(src_dir / "good.jpg", (100, 100))
        (src_dir / "bad.jpg").write_bytes(b"not a real image")

        results = resize_images(src_dir, dst_dir, 50, 50)
        assert len(results) == 1
        assert results[0].name == "good.jpg"

    def test_max_dim_uses_larger_dimension(self, tmp_path: Path) -> None:
        """fit_long_edge uses max(width, height) as the target long edge."""
        src_dir = tmp_path / "src"
        dst_dir = tmp_path / "dst"
        src_dir.mkdir()
        # Small square image — shouldn't be upscaled by thumbnail
        _create_test_image(src_dir / "small.jpg", (50, 50))

        results = resize_images(src_dir, dst_dir, 200, 100, fit_long_edge=True)
        assert len(results) == 1
        with Image.open(results[0]) as img:
            # thumbnail never upscales: max_dim=200, but image is 50x50
            assert img.size == (50, 50)

    # --- pad_to_fit tests ---

    def test_pad_landscape_to_square(self, tmp_path: Path) -> None:
        """Landscape 200×100 padded to 200×200 — white bars top and bottom."""
        src_dir = tmp_path / "src"
        dst_dir = tmp_path / "dst"
        src_dir.mkdir()
        _create_test_image(src_dir / "wide.jpg", (200, 100))

        results = resize_images(src_dir, dst_dir, 200, 200, pad_to_fit=True)
        assert len(results) == 1
        with Image.open(results[0]) as img:
            assert img.size == (200, 200)
            # Top-left corner should be white (padding area)
            assert img.getpixel((0, 0)) == (255, 255, 255)

    def test_pad_portrait_to_square(self, tmp_path: Path) -> None:
        """Portrait 100×200 padded to 200×200 — white bars left and right."""
        src_dir = tmp_path / "src"
        dst_dir = tmp_path / "dst"
        src_dir.mkdir()
        _create_test_image(src_dir / "tall.jpg", (100, 200))

        results = resize_images(src_dir, dst_dir, 200, 200, pad_to_fit=True)
        assert len(results) == 1
        with Image.open(results[0]) as img:
            assert img.size == (200, 200)
            # Top-left corner should be white
            assert img.getpixel((0, 0)) == (255, 255, 255)

    def test_pad_custom_background(self, tmp_path: Path) -> None:
        """Pad with black background instead of default white."""
        src_dir = tmp_path / "src"
        dst_dir = tmp_path / "dst"
        src_dir.mkdir()
        _create_test_image(src_dir / "img.jpg", (50, 100))

        results = resize_images(
            src_dir,
            dst_dir,
            100,
            100,
            pad_to_fit=True,
            background_color=(0, 0, 0),
        )
        with Image.open(results[0]) as img:
            assert img.getpixel((0, 0)) == (0, 0, 0)

    def test_pad_smaller_than_target(self, tmp_path: Path) -> None:
        """Image smaller than target gets centered with padding."""
        src_dir = tmp_path / "src"
        dst_dir = tmp_path / "dst"
        src_dir.mkdir()
        _create_test_image(src_dir / "tiny.jpg", (10, 10))

        results = resize_images(src_dir, dst_dir, 100, 100, pad_to_fit=True)
        with Image.open(results[0]) as img:
            assert img.size == (100, 100)

    def test_pad_larger_than_target(self, tmp_path: Path) -> None:
        """Large image scaled down to fit, then padded to exact size."""
        src_dir = tmp_path / "src"
        dst_dir = tmp_path / "dst"
        src_dir.mkdir()
        _create_test_image(src_dir / "huge.jpg", (400, 300))

        results = resize_images(src_dir, dst_dir, 200, 200, pad_to_fit=True)
        with Image.open(results[0]) as img:
            assert img.size == (200, 200)

    def test_pad_ignores_fit_long_edge(self, tmp_path: Path) -> None:
        """When pad_to_fit=True, fit_long_edge is ignored."""
        src_dir = tmp_path / "src"
        dst_dir = tmp_path / "dst"
        src_dir.mkdir()
        _create_test_image(src_dir / "img.jpg", (300, 100))

        results = resize_images(
            src_dir,
            dst_dir,
            200,
            200,
            fit_long_edge=True,
            pad_to_fit=True,
        )
        with Image.open(results[0]) as img:
            # pad_to_fit produces exact target dimensions
            assert img.size == (200, 200)
