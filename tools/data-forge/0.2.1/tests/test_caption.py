"""Tests for the batch caption editor tool."""

from __future__ import annotations

import json
from pathlib import Path

import pytest

from data_forge.tools.caption import (
    CaptionEditor,
    batch_replace,
    caption_stats,
    deduplicate_captions,
    export_captions,
    import_captions,
    list_captions,
    read_all_captions,
    read_caption,
    search_captions,
)


def _make_caption(dir_path: Path, name: str, content: str) -> Path:
    """Helper: create a `.txt` caption file."""
    path = dir_path / (name if name.endswith(".txt") else f"{name}.txt")
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(content, encoding="utf-8")
    return path


# ---------------------------------------------------------------------------
# CaptionEditor tests
# ---------------------------------------------------------------------------


class TestCaptionEditor:
    """Tests for the CaptionEditor class."""

    # -- init / directory handling --

    def test_init_creates_nothing_for_read_ops(self, tmp_path: Path) -> None:
        """Directory is not created when only reading."""
        d = tmp_path / "captions"
        editor = CaptionEditor(d)
        assert editor.list_captions() == []

    def test_init_creates_dir_on_write(self, tmp_path: Path) -> None:
        """Directory is auto-created on create()."""
        d = tmp_path / "new_captions"
        editor = CaptionEditor(d)
        editor.create("test", "hello")
        assert d.is_dir()
        assert (d / "test.txt").read_text(encoding="utf-8") == "hello"

    # -- list_captions --

    def test_list_empty_dir(self, tmp_path: Path) -> None:
        """Empty directory returns empty list."""
        editor = CaptionEditor(tmp_path)
        assert editor.list_captions() == []

    def test_list_sorted(self, tmp_path: Path) -> None:
        """Files are returned sorted."""
        _make_caption(tmp_path, "c.txt", "c")
        _make_caption(tmp_path, "a.txt", "a")
        _make_caption(tmp_path, "b.txt", "b")
        editor = CaptionEditor(tmp_path)
        names = [p.name for p in editor.list_captions()]
        assert names == ["a.txt", "b.txt", "c.txt"]

    def test_list_ignores_non_txt(self, tmp_path: Path) -> None:
        """Only .txt files are listed."""
        _make_caption(tmp_path, "a.txt", "caption")
        (tmp_path / "image.png").write_text("not a caption")
        (tmp_path / "data.json").write_text("{}")
        editor = CaptionEditor(tmp_path)
        names = [p.name for p in editor.list_captions()]
        assert names == ["a.txt"]

    # -- read / read_all --

    def test_read_single(self, tmp_path: Path) -> None:
        """Read one caption by name."""
        _make_caption(tmp_path, "img01", "a beautiful sunset")
        editor = CaptionEditor(tmp_path)
        assert editor.read("img01.txt") == "a beautiful sunset"

    def test_read_without_suffix(self, tmp_path: Path) -> None:
        """Filename without .txt suffix works."""
        _make_caption(tmp_path, "img01.txt", "hello world")
        editor = CaptionEditor(tmp_path)
        assert editor.read("img01") == "hello world"

    def test_read_missing_raises(self, tmp_path: Path) -> None:
        """Reading a non-existent file raises FileNotFoundError."""
        editor = CaptionEditor(tmp_path)
        with pytest.raises(FileNotFoundError):
            editor.read("nope.txt")

    def test_read_all(self, tmp_path: Path) -> None:
        """read_all returns all captions."""
        _make_caption(tmp_path, "a.txt", "first")
        _make_caption(tmp_path, "b.txt", "second")
        editor = CaptionEditor(tmp_path)
        result = editor.read_all()
        assert result == {"a.txt": "first", "b.txt": "second"}

    def test_read_all_empty(self, tmp_path: Path) -> None:
        """read_all on empty dir returns empty dict."""
        editor = CaptionEditor(tmp_path)
        assert editor.read_all() == {}

    # -- create --

    def test_create_new(self, tmp_path: Path) -> None:
        """Create a new caption file."""
        editor = CaptionEditor(tmp_path)
        path = editor.create("new_cap", "some caption text")
        assert path == tmp_path / "new_cap.txt"
        assert path.read_text(encoding="utf-8") == "some caption text"

    def test_create_overwrite_false_raises(self, tmp_path: Path) -> None:
        """overwrite=False raises if file exists."""
        _make_caption(tmp_path, "exists.txt", "original")
        editor = CaptionEditor(tmp_path)
        with pytest.raises(FileExistsError):
            editor.create("exists.txt", "new content")

    def test_create_overwrite_true(self, tmp_path: Path) -> None:
        """overwrite=True replaces existing file."""
        _make_caption(tmp_path, "exists.txt", "original")
        editor = CaptionEditor(tmp_path)
        path = editor.create("exists.txt", "new content", overwrite=True)
        assert path.read_text(encoding="utf-8") == "new content"

    def test_create_batch(self, tmp_path: Path) -> None:
        """Create multiple captions at once."""
        editor = CaptionEditor(tmp_path)
        captions = {"a.txt": "first", "b.txt": "second", "c.txt": "third"}
        results = editor.create_batch(captions)
        assert len(results) == 3
        assert editor.read("a.txt") == "first"
        assert editor.read("b.txt") == "second"

    # -- update --

    def test_update_existing(self, tmp_path: Path) -> None:
        """Update replaces full content."""
        _make_caption(tmp_path, "img.txt", "old caption")
        editor = CaptionEditor(tmp_path)
        path = editor.update("img.txt", "brand new caption")
        assert path.read_text(encoding="utf-8") == "brand new caption"

    def test_update_missing_raises(self, tmp_path: Path) -> None:
        """Updating non-existent file raises FileNotFoundError."""
        editor = CaptionEditor(tmp_path)
        with pytest.raises(FileNotFoundError):
            editor.update("nope.txt", "content")

    # -- append / prepend --

    def test_append(self, tmp_path: Path) -> None:
        """Append text to the end."""
        _make_caption(tmp_path, "img.txt", "a cat")
        editor = CaptionEditor(tmp_path)
        path = editor.append("img.txt", "on a mat")
        assert path.read_text(encoding="utf-8") == "a cat on a mat"

    def test_append_empty_file(self, tmp_path: Path) -> None:
        """Appending to an empty file works without leading separator."""
        _make_caption(tmp_path, "img.txt", "")
        editor = CaptionEditor(tmp_path)
        path = editor.append("img.txt", "new text")
        assert path.read_text(encoding="utf-8") == "new text"

    def test_append_custom_separator(self, tmp_path: Path) -> None:
        """Custom separator between content."""
        _make_caption(tmp_path, "img.txt", "a cat")
        editor = CaptionEditor(tmp_path)
        path = editor.append("img.txt", "on a mat", separator=", ")
        assert path.read_text(encoding="utf-8") == "a cat, on a mat"

    def test_prepend(self, tmp_path: Path) -> None:
        """Prepend text to the beginning."""
        _make_caption(tmp_path, "img.txt", "on a mat")
        editor = CaptionEditor(tmp_path)
        path = editor.prepend("img.txt", "a cat")
        assert path.read_text(encoding="utf-8") == "a cat on a mat"

    def test_prepend_empty_file(self, tmp_path: Path) -> None:
        """Prepending to an empty file works without trailing separator."""
        _make_caption(tmp_path, "img.txt", "")
        editor = CaptionEditor(tmp_path)
        path = editor.prepend("img.txt", "new text")
        assert path.read_text(encoding="utf-8") == "new text"

    # -- delete --

    def test_delete_existing(self, tmp_path: Path) -> None:
        """Delete removes a caption file."""
        _make_caption(tmp_path, "img.txt", "caption")
        editor = CaptionEditor(tmp_path)
        editor.delete("img.txt")
        assert not (tmp_path / "img.txt").exists()

    def test_delete_missing_raises(self, tmp_path: Path) -> None:
        """Deleting non-existent file raises by default."""
        editor = CaptionEditor(tmp_path)
        with pytest.raises(FileNotFoundError):
            editor.delete("nope.txt")

    def test_delete_missing_ok(self, tmp_path: Path) -> None:
        """missing_ok=True silently ignores missing files."""
        editor = CaptionEditor(tmp_path)
        editor.delete("nope.txt", missing_ok=True)  # no exception

    def test_delete_by_pattern(self, tmp_path: Path) -> None:
        """Delete files matching a glob pattern."""
        _make_caption(tmp_path, "img_01.txt", "a")
        _make_caption(tmp_path, "img_02.txt", "b")
        _make_caption(tmp_path, "other.txt", "c")
        editor = CaptionEditor(tmp_path)
        count = editor.delete_by_pattern("img_*.txt")
        assert count == 2
        assert editor.list_captions() == [tmp_path / "other.txt"]

    def test_delete_by_pattern_regex(self, tmp_path: Path) -> None:
        """Delete files matching a regex pattern."""
        _make_caption(tmp_path, "img_01.txt", "a")
        _make_caption(tmp_path, "img_02.txt", "b")
        _make_caption(tmp_path, "photo_01.txt", "c")
        editor = CaptionEditor(tmp_path)
        count = editor.delete_by_pattern(r"^img_\d+\.txt$", regex=True)
        assert count == 2
        assert [p.name for p in editor.list_captions()] == ["photo_01.txt"]

    def test_delete_all(self, tmp_path: Path) -> None:
        """delete_all removes all .txt files."""
        _make_caption(tmp_path, "a.txt", "a")
        _make_caption(tmp_path, "b.txt", "b")
        editor = CaptionEditor(tmp_path)
        count = editor.delete_all()
        assert count == 2
        assert editor.list_captions() == []

    # -- search --

    def test_search_basic(self, tmp_path: Path) -> None:
        """Search finds captions containing query."""
        _make_caption(tmp_path, "a.txt", "a cat on a mat")
        _make_caption(tmp_path, "b.txt", "a dog in the park")
        _make_caption(tmp_path, "c.txt", "a bird on a wire")
        editor = CaptionEditor(tmp_path)
        result = editor.search("cat")
        assert result == {"a.txt": "a cat on a mat"}

    def test_search_case_insensitive(self, tmp_path: Path) -> None:
        """Search is case-insensitive by default."""
        _make_caption(tmp_path, "a.txt", "A CAT on a mat")
        editor = CaptionEditor(tmp_path)
        result = editor.search("cat")
        assert "a.txt" in result

    def test_search_case_sensitive(self, tmp_path: Path) -> None:
        """case_sensitive=True requires exact case match."""
        _make_caption(tmp_path, "a.txt", "A CAT on a mat")
        editor = CaptionEditor(tmp_path)
        result = editor.search("CAT", case_sensitive=True)
        assert "a.txt" in result
        result2 = editor.search("cat", case_sensitive=True)
        assert result2 == {}

    def test_search_regex(self, tmp_path: Path) -> None:
        """Search with regex pattern."""
        _make_caption(tmp_path, "a.txt", "image001.png")
        _make_caption(tmp_path, "b.txt", "image002.png")
        _make_caption(tmp_path, "c.txt", "no match here")
        editor = CaptionEditor(tmp_path)
        result = editor.search(r"image\d+\.png", regex=True)
        assert len(result) == 2

    def test_search_no_matches(self, tmp_path: Path) -> None:
        """No hits returns empty dict."""
        _make_caption(tmp_path, "a.txt", "hello world")
        editor = CaptionEditor(tmp_path)
        assert editor.search("zzz") == {}

    def test_search_by_filename(self, tmp_path: Path) -> None:
        """Search by filename glob."""
        _make_caption(tmp_path, "cat_01.txt", "a cat")
        _make_caption(tmp_path, "dog_01.txt", "a dog")
        editor = CaptionEditor(tmp_path)
        result = editor.search_by_filename("cat_*.txt")
        assert result == {"cat_01.txt": "a cat"}

    # -- replace --

    def test_replace_basic(self, tmp_path: Path) -> None:
        """Batch replace across all files."""
        _make_caption(tmp_path, "a.txt", "a red car")
        _make_caption(tmp_path, "b.txt", "a blue car")
        _make_caption(tmp_path, "c.txt", "a red bike")
        editor = CaptionEditor(tmp_path)
        count = editor.replace("car", "truck")
        assert count == 2
        assert editor.read("a.txt") == "a red truck"
        assert editor.read("c.txt") == "a red bike"  # unchanged

    def test_replace_case_insensitive(self, tmp_path: Path) -> None:
        """Replace is case-insensitive by default."""
        _make_caption(tmp_path, "a.txt", "A Red Car")
        editor = CaptionEditor(tmp_path)
        editor.replace("red", "blue")
        assert editor.read("a.txt") == "A blue Car"

    def test_replace_case_sensitive(self, tmp_path: Path) -> None:
        """Replace with case_sensitive=True."""
        _make_caption(tmp_path, "a.txt", "Red red RED")
        editor = CaptionEditor(tmp_path)
        editor.replace("red", "blue", case_sensitive=True)
        assert editor.read("a.txt") == "Red blue RED"

    def test_replace_regex(self, tmp_path: Path) -> None:
        """Replace with regex and back-references."""
        _make_caption(tmp_path, "a.txt", "img_001.png img_002.png")
        editor = CaptionEditor(tmp_path)
        editor.replace(r"img_(\d+)", r"photo_\1", regex=True)
        assert editor.read("a.txt") == "photo_001.png photo_002.png"

    def test_replace_no_matches(self, tmp_path: Path) -> None:
        """No files modified returns 0."""
        _make_caption(tmp_path, "a.txt", "hello")
        editor = CaptionEditor(tmp_path)
        count = editor.replace("zzz", "yyy")
        assert count == 0

    # -- rename --

    def test_rename(self, tmp_path: Path) -> None:
        """Rename a caption file."""
        _make_caption(tmp_path, "old.txt", "content")
        editor = CaptionEditor(tmp_path)
        result = editor.rename("old.txt", "new.txt")
        assert result == tmp_path / "new.txt"
        assert not (tmp_path / "old.txt").exists()
        assert result.read_text(encoding="utf-8") == "content"

    def test_rename_auto_suffix(self, tmp_path: Path) -> None:
        """Rename auto-appends .txt suffix."""
        _make_caption(tmp_path, "old.txt", "content")
        editor = CaptionEditor(tmp_path)
        result = editor.rename("old", "new")
        assert result == tmp_path / "new.txt"

    def test_rename_missing_raises(self, tmp_path: Path) -> None:
        """Renaming non-existent file raises."""
        editor = CaptionEditor(tmp_path)
        with pytest.raises(FileNotFoundError):
            editor.rename("nope.txt", "new.txt")

    def test_rename_target_exists_raises(self, tmp_path: Path) -> None:
        """Cannot rename to existing filename."""
        _make_caption(tmp_path, "a.txt", "a")
        _make_caption(tmp_path, "b.txt", "b")
        editor = CaptionEditor(tmp_path)
        with pytest.raises(FileExistsError):
            editor.rename("a.txt", "b.txt")

    # -- deduplicate --

    def test_deduplicate_keep_first(self, tmp_path: Path) -> None:
        """Duplicate content: keep first occurrence."""
        _make_caption(tmp_path, "a.txt", "same content")
        _make_caption(tmp_path, "b.txt", "same content")
        _make_caption(tmp_path, "c.txt", "different")
        editor = CaptionEditor(tmp_path)
        removed = editor.deduplicate(keep="first")
        assert len(removed) == 1
        assert removed[0].name == "b.txt"
        assert {p.name for p in editor.list_captions()} == {"a.txt", "c.txt"}

    def test_deduplicate_keep_last(self, tmp_path: Path) -> None:
        """Duplicate content: keep last occurrence."""
        _make_caption(tmp_path, "a.txt", "same content")
        _make_caption(tmp_path, "b.txt", "same content")
        editor = CaptionEditor(tmp_path)
        removed = editor.deduplicate(keep="last")
        assert len(removed) == 1
        assert removed[0].name == "a.txt"
        assert {p.name for p in editor.list_captions()} == {"b.txt"}

    def test_deduplicate_no_dupes(self, tmp_path: Path) -> None:
        """No duplicates returns empty list."""
        _make_caption(tmp_path, "a.txt", "first")
        _make_caption(tmp_path, "b.txt", "second")
        editor = CaptionEditor(tmp_path)
        removed = editor.deduplicate()
        assert removed == []
        assert len(editor.list_captions()) == 2

    # -- stats --

    def test_stats_basic(self, tmp_path: Path) -> None:
        """Stats on a populated directory."""
        _make_caption(tmp_path, "a.txt", "hello world")
        _make_caption(tmp_path, "b.txt", "short")
        _make_caption(tmp_path, "c.txt", "")  # empty
        editor = CaptionEditor(tmp_path)
        s = editor.stats()
        assert s["file_count"] == 3
        assert s["total_chars"] == len("hello world") + len("short")
        assert s["total_words"] == 3  # "hello","world","short"
        assert s["avg_chars"] > 0
        assert s["min_chars"] == 0
        assert s["max_chars"] == len("hello world")
        assert s["empty_count"] == 1

    def test_stats_empty_dir(self, tmp_path: Path) -> None:
        """Stats on empty directory returns zeros."""
        editor = CaptionEditor(tmp_path)
        s = editor.stats()
        assert s["file_count"] == 0
        assert s["total_chars"] == 0
        assert s["avg_chars"] == 0.0

    def test_word_frequency(self, tmp_path: Path) -> None:
        """Word frequency counts across all files."""
        _make_caption(tmp_path, "a.txt", "cat dog cat")
        _make_caption(tmp_path, "b.txt", "dog bird")
        editor = CaptionEditor(tmp_path)
        freq = editor.word_frequency(top_n=10, min_length=2)
        # cat: 2, dog: 2, bird: 1
        counts = {word: cnt for word, cnt in freq}
        assert counts["cat"] == 2
        assert counts["dog"] == 2
        assert counts["bird"] == 1

    # -- export / import JSON --

    def test_export_json(self, tmp_path: Path) -> None:
        """Export captions to JSON."""
        _make_caption(tmp_path, "a.txt", "hello")
        _make_caption(tmp_path, "b.txt", "world")
        editor = CaptionEditor(tmp_path)
        output = tmp_path / "export.json"
        result = editor.export_json(output)
        assert result == output
        data = json.loads(output.read_text(encoding="utf-8"))
        assert data == {"a.txt": "hello", "b.txt": "world"}

    def test_import_json(self, tmp_path: Path) -> None:
        """Import captions from JSON."""
        src = tmp_path / "source.json"
        src.write_text(
            json.dumps({"a.txt": "hello", "b.txt": "world"}),
            encoding="utf-8",
        )
        dst = tmp_path / "captions"
        editor = CaptionEditor(dst)
        results = editor.import_json(src)
        assert len(results) == 2
        assert editor.read("a.txt") == "hello"
        assert editor.read("b.txt") == "world"

    def test_import_json_overwrite(self, tmp_path: Path) -> None:
        """import_json with overwrite replaces existing."""
        dst = tmp_path / "captions"
        _make_caption(dst, "a.txt", "original")
        src = tmp_path / "source.json"
        src.write_text(
            json.dumps({"a.txt": "updated"}),
            encoding="utf-8",
        )
        editor = CaptionEditor(dst)
        editor.import_json(src, overwrite=True)
        assert editor.read("a.txt") == "updated"

    def test_import_json_skip_existing(self, tmp_path: Path) -> None:
        """import_json skips existing files when overwrite=False."""
        dst = tmp_path / "captions"
        _make_caption(dst, "a.txt", "original")
        src = tmp_path / "source.json"
        src.write_text(
            json.dumps({"a.txt": "new", "b.txt": "fresh"}),
            encoding="utf-8",
        )
        editor = CaptionEditor(dst)
        results = editor.import_json(src, overwrite=False)
        assert len(results) == 1  # only b.txt created
        assert editor.read("a.txt") == "original"

    def test_import_json_missing_file_raises(self, tmp_path: Path) -> None:
        """Missing JSON file raises FileNotFoundError."""
        editor = CaptionEditor(tmp_path)
        with pytest.raises(FileNotFoundError):
            editor.import_json(tmp_path / "nope.json")

    def test_import_json_invalid_structure_raises(self, tmp_path: Path) -> None:
        """Non-object JSON raises ValueError."""
        src = tmp_path / "bad.json"
        src.write_text('["not", "an", "object"]', encoding="utf-8")
        editor = CaptionEditor(tmp_path)
        with pytest.raises(ValueError):
            editor.import_json(src)

    def test_import_json_non_string_values_raises(self, tmp_path: Path) -> None:
        """Non-string values raise ValueError."""
        src = tmp_path / "bad.json"
        src.write_text('{"a.txt": 123}', encoding="utf-8")
        editor = CaptionEditor(tmp_path)
        with pytest.raises(ValueError):
            editor.import_json(src)

    # -- export / import CSV --

    def test_export_csv(self, tmp_path: Path) -> None:
        """Export captions to CSV."""
        _make_caption(tmp_path, "a.txt", "hello, world")
        _make_caption(tmp_path, "b.txt", "simple")
        editor = CaptionEditor(tmp_path)
        output = tmp_path / "export.csv"
        result = editor.export_csv(output)
        assert result == output
        content = output.read_text(encoding="utf-8")
        assert "filename" in content
        assert "content" in content
        assert "hello, world" in content

    def test_import_csv(self, tmp_path: Path) -> None:
        """Import captions from CSV."""
        src = tmp_path / "source.csv"
        src.write_text(
            'filename,content\n"a.txt","hello"\n"b.txt","world"\n',
            encoding="utf-8",
        )
        dst = tmp_path / "captions"
        editor = CaptionEditor(dst)
        results = editor.import_csv(src)
        assert len(results) == 2
        assert editor.read("a.txt") == "hello"

    # -- create with unicode --

    def test_create_unicode(self, tmp_path: Path) -> None:
        """Unicode (Chinese, emoji) captions work."""
        editor = CaptionEditor(tmp_path)
        path = editor.create("cn", "一只猫坐在窗台上 🐱")
        content = path.read_text(encoding="utf-8")
        assert "猫" in content
        assert "🐱" in content

    # -- read with trailing newline --

    def test_read_preserves_trailing_newline(self, tmp_path: Path) -> None:
        """Trailing newlines are preserved."""
        _make_caption(tmp_path, "a.txt", "hello\n")
        editor = CaptionEditor(tmp_path)
        assert editor.read("a.txt") == "hello\n"


# ---------------------------------------------------------------------------
# Standalone convenience function tests
# ---------------------------------------------------------------------------


class TestConvenienceFunctions:
    """Tests for standalone convenience functions."""

    def test_list_captions(self, tmp_path: Path) -> None:
        """Standalone list_captions works."""
        _make_caption(tmp_path, "a.txt", "a")
        _make_caption(tmp_path, "b.txt", "b")
        result = list_captions(tmp_path)
        assert len(result) == 2

    def test_read_caption(self, tmp_path: Path) -> None:
        """Standalone read_caption works."""
        _make_caption(tmp_path, "img.txt", "hello")
        assert read_caption(tmp_path, "img.txt") == "hello"

    def test_read_all_captions(self, tmp_path: Path) -> None:
        """Standalone read_all_captions works."""
        _make_caption(tmp_path, "a.txt", "1")
        _make_caption(tmp_path, "b.txt", "2")
        result = read_all_captions(tmp_path)
        assert result == {"a.txt": "1", "b.txt": "2"}

    def test_search_captions(self, tmp_path: Path) -> None:
        """Standalone search_captions works."""
        _make_caption(tmp_path, "a.txt", "a red car")
        _make_caption(tmp_path, "b.txt", "a blue bike")
        result = search_captions(tmp_path, "car")
        assert result == {"a.txt": "a red car"}

    def test_batch_replace(self, tmp_path: Path) -> None:
        """Standalone batch_replace works."""
        _make_caption(tmp_path, "a.txt", "a red car")
        _make_caption(tmp_path, "b.txt", "a blue car")
        count = batch_replace(tmp_path, "car", "truck")
        assert count == 2

    def test_caption_stats(self, tmp_path: Path) -> None:
        """Standalone caption_stats works."""
        _make_caption(tmp_path, "a.txt", "hello world")
        s = caption_stats(tmp_path)
        assert s["file_count"] == 1
        assert s["total_words"] == 2

    def test_export_import_roundtrip_json(self, tmp_path: Path) -> None:
        """Export then import JSON round-trips correctly."""
        _make_caption(tmp_path, "a.txt", "hello")
        _make_caption(tmp_path, "b.txt", "world")
        json_path = tmp_path / "caps.json"
        export_captions(tmp_path, json_path)

        dst = tmp_path / "restored"
        import_captions(dst, json_path)
        assert read_caption(dst, "a.txt") == "hello"
        assert read_caption(dst, "b.txt") == "world"

    def test_deduplicate_captions(self, tmp_path: Path) -> None:
        """Standalone deduplicate_captions works."""
        _make_caption(tmp_path, "a.txt", "dupe")
        _make_caption(tmp_path, "b.txt", "dupe")
        removed = deduplicate_captions(tmp_path)
        assert len(removed) == 1
