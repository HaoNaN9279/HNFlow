"""Batch caption editor for AI training datasets.

Edit caption ``.txt`` files in bulk — create, read, update, delete, search,
replace, and more. Designed for managing large caption datasets used in
image-generation model training.

Each caption is a ``.txt`` file whose filename (minus ``.txt``) typically
matches the corresponding image filename.
"""

from __future__ import annotations

import json
import re
from collections import Counter
from pathlib import Path
from typing import Any


class CaptionEditor:
    """Batch editor for caption (``.txt``) files in a directory.

    Args:
        directory: Path to the directory containing caption ``.txt`` files.
            Created automatically if it does not exist when writing.

    Example:
        >>> editor = CaptionEditor("captions/")
        >>> editor.list_captions()
        [Path('captions/001.txt'), Path('captions/002.txt')]
        >>> editor.read("001.txt")
        'a beautiful sunset over the ocean'
        >>> editor.search("sunset")
        {'001.txt': 'a beautiful sunset over the ocean'}
        >>> editor.replace("sunset", "sunrise")
        1
    """

    def __init__(self, directory: str | Path) -> None:
        self._dir = Path(directory)

    # ------------------------------------------------------------------
    # Internal helpers
    # ------------------------------------------------------------------

    def _ensure_dir(self) -> None:
        """Create the caption directory if it does not exist."""
        self._dir.mkdir(parents=True, exist_ok=True)

    def _resolve(self, filename: str) -> Path:
        """Resolve *filename* to a full path, normalizing the ``.txt`` suffix."""
        name = filename if filename.endswith(".txt") else f"{filename}.txt"
        return self._dir / name

    def _validate_exists(self, filename: str) -> Path:
        """Resolve and verify the file exists; raise if missing."""
        path = self._resolve(filename)
        if not path.is_file():
            raise FileNotFoundError(f"Caption not found: {path}")
        return path

    def _txt_files(self) -> list[Path]:
        """Return sorted list of all ``.txt`` files in the directory."""
        if not self._dir.is_dir():
            return []
        return sorted(
            f for f in self._dir.iterdir() if f.is_file() and f.suffix == ".txt"
        )

    # ------------------------------------------------------------------
    # Read / List
    # ------------------------------------------------------------------

    def list_captions(self) -> list[Path]:
        """List all ``.txt`` caption files in the directory.

        Returns:
            Sorted list of :class:`~pathlib.Path` objects.
        """
        return self._txt_files()

    def read(self, filename: str) -> str:
        """Read the full content of a single caption file.

        Args:
            filename: Caption filename with or without ``.txt`` suffix.

        Returns:
            The caption text.

        Raises:
            FileNotFoundError: If the file does not exist.
        """
        return self._validate_exists(filename).read_text(encoding="utf-8")

    def read_all(self) -> dict[str, str]:
        """Read every caption file in the directory.

        Returns:
            Dict mapping filename → caption text.
        """
        result: dict[str, str] = {}
        for path in self._txt_files():
            result[path.name] = path.read_text(encoding="utf-8")
        return result

    # ------------------------------------------------------------------
    # Create
    # ------------------------------------------------------------------

    def create(
        self,
        filename: str,
        content: str,
        *,
        overwrite: bool = False,
    ) -> Path:
        """Create a new caption file.

        Args:
            filename: Target filename with or without ``.txt`` suffix.
            content: Caption text content.
            overwrite: If ``True``, replace existing file. Defaults to ``False``.

        Returns:
            Path to the created file.

        Raises:
            FileExistsError: If the file already exists and ``overwrite=False``.
        """
        self._ensure_dir()
        path = self._resolve(filename)
        if path.exists() and not overwrite:
            raise FileExistsError(f"Caption already exists: {path}")
        path.write_text(content, encoding="utf-8")
        return path

    def create_batch(
        self,
        captions: dict[str, str],
        *,
        overwrite: bool = False,
    ) -> list[Path]:
        """Create multiple caption files at once.

        Args:
            captions: Dict mapping filename → caption text.
            overwrite: Replace existing files.

        Returns:
            Paths to created files.
        """
        results: list[Path] = []
        for filename, content in captions.items():
            results.append(self.create(filename, content, overwrite=overwrite))
        return results

    # ------------------------------------------------------------------
    # Update
    # ------------------------------------------------------------------

    def update(self, filename: str, content: str) -> Path:
        """Replace the entire content of a caption file.

        Args:
            filename: Target filename.
            content: New caption text.

        Returns:
            Path to the updated file.

        Raises:
            FileNotFoundError: If the file does not exist.
        """
        path = self._validate_exists(filename)
        path.write_text(content, encoding="utf-8")
        return path

    def append(
        self,
        filename: str,
        text: str,
        *,
        separator: str = " ",
    ) -> Path:
        """Append text to the end of a caption.

        Args:
            filename: Target filename.
            text: Text to append.
            separator: String inserted between existing content and new text.

        Returns:
            Path to the updated file.
        """
        path = self._validate_exists(filename)
        current = path.read_text(encoding="utf-8")
        new_content = current + separator + text if current else text
        path.write_text(new_content, encoding="utf-8")
        return path

    def prepend(
        self,
        filename: str,
        text: str,
        *,
        separator: str = " ",
    ) -> Path:
        """Prepend text to the beginning of a caption.

        Args:
            filename: Target filename.
            text: Text to prepend.
            separator: String inserted between new text and existing content.

        Returns:
            Path to the updated file.
        """
        path = self._validate_exists(filename)
        current = path.read_text(encoding="utf-8")
        new_content = text + separator + current if current else text
        path.write_text(new_content, encoding="utf-8")
        return path

    # ------------------------------------------------------------------
    # Delete
    # ------------------------------------------------------------------

    def delete(self, filename: str, *, missing_ok: bool = False) -> None:
        """Delete a caption file.

        Args:
            filename: Target filename.
            missing_ok: If ``True``, silently skip missing files.

        Raises:
            FileNotFoundError: If the file does not exist and ``missing_ok=False``.
        """
        path = self._resolve(filename)
        if not path.is_file():
            if missing_ok:
                return
            raise FileNotFoundError(f"Caption not found: {path}")
        path.unlink()

    def delete_all(self) -> int:
        """Delete every ``.txt`` caption file in the directory.

        Returns:
            Number of files deleted.
        """
        count = 0
        for path in self._txt_files():
            path.unlink()
            count += 1
        return count

    def delete_by_pattern(self, pattern: str, *, regex: bool = False) -> int:
        """Delete caption files whose names match a pattern.

        Args:
            pattern: Glob pattern (e.g. ``"img_*.txt"``) or regex pattern.
            regex: If ``True``, treat *pattern* as a regular expression.

        Returns:
            Number of files deleted.
        """
        count = 0
        for path in self._txt_files():
            name = path.name
            if regex:
                if re.search(pattern, name):
                    path.unlink()
                    count += 1
            else:
                if path.match(pattern):
                    path.unlink()
                    count += 1
        return count

    # ------------------------------------------------------------------
    # Search
    # ------------------------------------------------------------------

    def search(
        self,
        query: str,
        *,
        case_sensitive: bool = False,
        regex: bool = False,
    ) -> dict[str, str]:
        """Find captions containing *query*.

        Args:
            query: Search term or regex pattern.
            case_sensitive: If ``True``, match case exactly.
            regex: If ``True``, treat *query* as a regular expression.

        Returns:
            Dict mapping filename → full caption text for each match.
        """
        results: dict[str, str] = {}
        flags = 0 if case_sensitive else re.IGNORECASE

        for path in self._txt_files():
            content = path.read_text(encoding="utf-8")
            if regex:
                if re.search(query, content, flags):
                    results[path.name] = content
            else:
                target = query if case_sensitive else query.lower()
                source = content if case_sensitive else content.lower()
                if target in source:
                    results[path.name] = content

        return results

    def search_by_filename(
        self,
        pattern: str,
        *,
        regex: bool = False,
    ) -> dict[str, str]:
        """Find captions whose filenames match *pattern*.

        Args:
            pattern: Glob or regex pattern for filenames.
            regex: If ``True``, treat *pattern* as a regular expression.

        Returns:
            Dict mapping filename → caption text.
        """
        results: dict[str, str] = {}
        for path in self._txt_files():
            name = path.name
            matched = (
                re.search(pattern, name) if regex else path.match(pattern)
            )
            if matched:
                results[name] = path.read_text(encoding="utf-8")
        return results

    # ------------------------------------------------------------------
    # Batch replace
    # ------------------------------------------------------------------

    def replace(
        self,
        old: str,
        new: str,
        *,
        case_sensitive: bool = False,
        regex: bool = False,
    ) -> int:
        """Search-and-replace text across ALL captions in the directory.

        Args:
            old: Text or regex pattern to find.
            new: Replacement text. Supports ``\\1``, ``\\2``, etc.
                back-references when ``regex=True``.
            case_sensitive: If ``False`` (default), performs case-insensitive
                matching.
            regex: If ``True``, treat *old* as a regular expression.

        Returns:
            Number of files modified.
        """
        count = 0
        flags = 0 if case_sensitive else re.IGNORECASE

        for path in self._txt_files():
            content = path.read_text(encoding="utf-8")
            if regex:
                new_content, n = re.subn(old, new, content, flags=flags)
                if n > 0:
                    path.write_text(new_content, encoding="utf-8")
                    count += 1
            else:
                if case_sensitive:
                    new_content = content.replace(old, new)
                else:
                    new_content = _case_insensitive_replace(content, old, new)
                if new_content != content:
                    path.write_text(new_content, encoding="utf-8")
                    count += 1

        return count

    # ------------------------------------------------------------------
    # Rename
    # ------------------------------------------------------------------

    def rename(self, old_name: str, new_name: str) -> Path:
        """Rename a caption file.

        Args:
            old_name: Current filename.
            new_name: New filename. ``.txt`` suffix is auto-appended if missing.

        Returns:
            Path to the renamed file.

        Raises:
            FileNotFoundError: If *old_name* does not exist.
            FileExistsError: If *new_name* already exists.
        """
        src = self._validate_exists(old_name)
        dst = self._resolve(new_name)
        if dst.exists():
            raise FileExistsError(f"Target already exists: {dst}")
        return src.rename(dst)

    # ------------------------------------------------------------------
    # Deduplicate
    # ------------------------------------------------------------------

    def deduplicate(self, *, keep: str = "first") -> list[Path]:
        """Remove caption files with duplicate content.

        Args:
            keep: Which copy to keep — ``"first"`` (default) or ``"last"``.

        Returns:
            Paths of the removed (duplicate) files.
        """
        seen: dict[str, Path] = {}
        removed: list[Path] = []
        files = self._txt_files()

        for path in files:
            content = path.read_text(encoding="utf-8")
            if content in seen:
                if keep == "last":
                    removed.append(seen[content])
                    seen[content].unlink()
                    seen[content] = path
                else:
                    removed.append(path)
                    path.unlink()
            else:
                seen[content] = path

        return removed

    # ------------------------------------------------------------------
    # Stats
    # ------------------------------------------------------------------

    def stats(self) -> dict[str, Any]:
        """Return summary statistics about the caption directory.

        Returns:
            Dict with keys: ``file_count``, ``total_chars``, ``total_words``,
            ``total_lines``, ``avg_chars``, ``avg_words``, ``min_chars``,
            ``max_chars``, ``empty_count``.
        """
        files = self._txt_files()
        if not files:
            return {
                "file_count": 0,
                "total_chars": 0,
                "total_words": 0,
                "total_lines": 0,
                "avg_chars": 0.0,
                "avg_words": 0.0,
                "min_chars": 0,
                "max_chars": 0,
                "empty_count": 0,
            }

        char_counts: list[int] = []
        word_counts: list[int] = []
        line_counts: list[int] = []
        empty = 0

        for path in files:
            content = path.read_text(encoding="utf-8")
            chars = len(content)
            words = len(content.split())
            lines = content.count("\n") + (1 if content else 0)

            char_counts.append(chars)
            word_counts.append(words)
            line_counts.append(lines)
            if not content.strip():
                empty += 1

        return {
            "file_count": len(files),
            "total_chars": sum(char_counts),
            "total_words": sum(word_counts),
            "total_lines": sum(line_counts),
            "avg_chars": round(sum(char_counts) / len(files), 1),
            "avg_words": round(sum(word_counts) / len(files), 1),
            "min_chars": min(char_counts),
            "max_chars": max(char_counts),
            "empty_count": empty,
        }

    def word_frequency(self, *, top_n: int = 20, min_length: int = 2) -> list[tuple[str, int]]:
        """Return the most common words across all captions.

        Args:
            top_n: Number of top words to return.
            min_length: Minimum word length to include.

        Returns:
            List of ``(word, count)`` tuples sorted by frequency.
        """
        counter: Counter[str] = Counter()
        for path in self._txt_files():
            content = path.read_text(encoding="utf-8")
            words = re.findall(r"\w+", content.lower())
            counter.update(w for w in words if len(w) >= min_length)
        return counter.most_common(top_n)

    # ------------------------------------------------------------------
    # Export / Import
    # ------------------------------------------------------------------

    def export_json(
        self,
        output_path: str | Path,
        *,
        indent: int = 2,
    ) -> Path:
        """Export all captions to a JSON file.

        The output is a JSON object mapping filename → caption text.

        Args:
            output_path: Destination JSON file path.
            indent: JSON indentation level.

        Returns:
            Path to the created JSON file.
        """
        data = self.read_all()
        out = Path(output_path)
        out.write_text(
            json.dumps(data, ensure_ascii=False, indent=indent),
            encoding="utf-8",
        )
        return out

    def import_json(
        self,
        input_path: str | Path,
        *,
        overwrite: bool = False,
    ) -> list[Path]:
        """Import captions from a JSON file.

        Expects a JSON object mapping filename → caption text.

        Args:
            input_path: Source JSON file path.
            overwrite: If ``True``, overwrite existing caption files.

        Returns:
            Paths to created/updated caption files.

        Raises:
            FileNotFoundError: If *input_path* does not exist.
            ValueError: If the JSON structure is invalid.
        """
        src = Path(input_path)
        if not src.is_file():
            raise FileNotFoundError(f"JSON file not found: {src}")

        data = json.loads(src.read_text(encoding="utf-8"))
        if not isinstance(data, dict):
            raise ValueError("JSON file must contain a top-level object")

        if not all(isinstance(v, str) for v in data.values()):
            raise ValueError("All values in the JSON must be strings")

        results: list[Path] = []
        for filename, content in data.items():
            path = self._resolve(filename)
            if path.exists() and not overwrite:
                continue
            self._ensure_dir()
            path.write_text(content, encoding="utf-8")
            results.append(path)

        return results

    def export_csv(
        self,
        output_path: str | Path,
        *,
        delimiter: str = ",",
    ) -> Path:
        """Export all captions to a CSV file.

        Columns: ``filename,content``. Content is quoted if it contains
        the delimiter or newlines.

        Args:
            output_path: Destination CSV file path.
            delimiter: Column delimiter character.

        Returns:
            Path to the created CSV file.
        """
        import csv

        out = Path(output_path)
        with out.open("w", encoding="utf-8", newline="") as fh:
            writer = csv.writer(fh, delimiter=delimiter, quoting=csv.QUOTE_ALL)
            writer.writerow(["filename", "content"])
            for path in self._txt_files():
                content = path.read_text(encoding="utf-8")
                writer.writerow([path.name, content])
        return out

    def import_csv(
        self,
        input_path: str | Path,
        *,
        delimiter: str = ",",
        overwrite: bool = False,
    ) -> list[Path]:
        """Import captions from a CSV file.

        Expects columns: ``filename,content`` (header required).

        Args:
            input_path: Source CSV file path.
            delimiter: Column delimiter character.
            overwrite: Replace existing caption files.

        Returns:
            Paths to created/updated caption files.
        """
        import csv

        src = Path(input_path)
        if not src.is_file():
            raise FileNotFoundError(f"CSV file not found: {src}")

        results: list[Path] = []
        with src.open("r", encoding="utf-8", newline="") as fh:
            reader = csv.DictReader(fh, delimiter=delimiter)
            if "filename" not in (reader.fieldnames or []):
                raise ValueError("CSV must have a 'filename' column")
            if "content" not in (reader.fieldnames or []):
                raise ValueError("CSV must have a 'content' column")

            for row in reader:
                filename = row["filename"]
                content = row.get("content", "")
                path = self._resolve(filename)
                if path.exists() and not overwrite:
                    continue
                self._ensure_dir()
                path.write_text(content, encoding="utf-8")
                results.append(path)

        return results


# ======================================================================
# Standalone convenience functions
# ======================================================================


def _case_insensitive_replace(text: str, old: str, new: str) -> str:
    """Replace *old* with *new* in *text*, ignoring case."""
    pattern = re.compile(re.escape(old), re.IGNORECASE)
    return pattern.sub(new, text)


def list_captions(directory: str | Path) -> list[Path]:
    """List all caption ``.txt`` files in a directory.

    Example:
        >>> list_captions("captions/")
        [Path('captions/img01.txt'), Path('captions/img02.txt')]
    """
    return CaptionEditor(directory).list_captions()


def read_caption(directory: str | Path, filename: str) -> str:
    """Read a single caption file's content.

    Example:
        >>> read_caption("captions/", "img01.txt")
        'a cat sitting on a windowsill'
    """
    return CaptionEditor(directory).read(filename)


def read_all_captions(directory: str | Path) -> dict[str, str]:
    """Read all caption files in a directory.

    Example:
        >>> read_all_captions("captions/")
        {'img01.txt': 'a cat sitting on a windowsill', 'img02.txt': 'a dog in the park'}
    """
    return CaptionEditor(directory).read_all()


def search_captions(
    directory: str | Path,
    query: str,
    *,
    case_sensitive: bool = False,
    regex: bool = False,
) -> dict[str, str]:
    """Search captions containing *query*.

    Example:
        >>> search_captions("captions/", "cat")
        {'img01.txt': 'a cat sitting on a windowsill'}
    """
    return CaptionEditor(directory).search(
        query, case_sensitive=case_sensitive, regex=regex
    )


def batch_replace(
    directory: str | Path,
    old: str,
    new: str,
    *,
    case_sensitive: bool = False,
    regex: bool = False,
) -> int:
    """Search-and-replace text across all captions.

    Example:
        >>> batch_replace("captions/", "cat", "kitten")
        3  # 3 files modified
    """
    return CaptionEditor(directory).replace(
        old, new, case_sensitive=case_sensitive, regex=regex
    )


def export_captions(
    directory: str | Path,
    output_path: str | Path,
    *,
    fmt: str = "json",
) -> Path:
    """Export all captions to a JSON or CSV file.

    Args:
        directory: Caption directory.
        output_path: Destination file path. Extension determines format.
        fmt: ``"json"`` or ``"csv"``. Defaults to ``"json"``.

    Example:
        >>> export_captions("captions/", "captions.json")
        Path('captions.json')
    """
    editor = CaptionEditor(directory)
    if fmt == "csv" or str(output_path).endswith(".csv"):
        return editor.export_csv(output_path)
    return editor.export_json(output_path)


def import_captions(
    directory: str | Path,
    input_path: str | Path,
    *,
    overwrite: bool = False,
    fmt: str = "json",
) -> list[Path]:
    """Import captions from a JSON or CSV file.

    Args:
        directory: Target caption directory.
        input_path: Source file path.
        overwrite: Replace existing caption files.
        fmt: ``"json"`` or ``"csv"``.

    Example:
        >>> import_captions("captions/", "captions.json")
        [Path('captions/img01.txt'), Path('captions/img02.txt')]
    """
    editor = CaptionEditor(directory)
    if fmt == "csv" or str(input_path).endswith(".csv"):
        return editor.import_csv(input_path, overwrite=overwrite)
    return editor.import_json(input_path, overwrite=overwrite)


def caption_stats(directory: str | Path) -> dict[str, Any]:
    """Get summary statistics for a caption directory.

    Example:
        >>> caption_stats("captions/")
        {'file_count': 100, 'total_chars': 4520, 'avg_chars': 45.2, ...}
    """
    return CaptionEditor(directory).stats()


def deduplicate_captions(directory: str | Path, *, keep: str = "first") -> list[Path]:
    """Remove duplicate captions from a directory.

    Example:
        >>> deduplicate_captions("captions/")
        [Path('captions/dup.txt')]
    """
    return CaptionEditor(directory).deduplicate(keep=keep)
