"""Capability-group file discovery, classification, and one-line summaries."""

from __future__ import annotations

import re
from dataclasses import dataclass
from datetime import UTC, datetime
from pathlib import Path

#: Built-in content categories, in display order. Any other top-level directory
#: name is a valid category too; those are appended after these in alphabetical
#: order by :func:`category_sort_key`.
CAPABILITY_CATEGORIES: tuple[str, ...] = (
    "rules",
    "agents",
    "skills",
    "tools",
    "references",
    "templates",
    "assets",
    "evals",
    "other",
)

_CATEGORY_BY_DIR: dict[str, str] = {
    "rules": "rules",
    "agents": "agents",
    "agent": "agents",
    "skills": "skills",
    "tools": "tools",
    "scripts": "tools",
    "references": "references",
    "reference": "references",
    "templates": "templates",
    "assets": "assets",
    "evals": "evals",
}

_MARKDOWN_EXTENSIONS = frozenset({".md", ".markdown"})
_FRONTMATTER_RE = re.compile(r"^---\s*\n(.*?)\n---\s*\n?", re.DOTALL)
_SUMMARY_MAX_CHARS = 180
_SUMMARY_READ_BYTES = 16 * 1024


@dataclass(frozen=True)
class CapabilityGroupFile:
    """One content file inside a capability group."""

    path: str
    name: str
    category: str
    is_markdown: bool
    summary: str
    size: int
    modified_at: str

    def to_dict(self) -> dict[str, object]:
        return {
            "path": self.path,
            "name": self.name,
            "category": self.category,
            "is_markdown": self.is_markdown,
            "summary": self.summary,
            "size": self.size,
            "modified_at": self.modified_at,
        }


def classify_capability_file(relative_path: str) -> str:
    """Return the content category for a group-relative POSIX path.

    Known top-level directories map to their built-in category (``scripts`` →
    ``tools``, etc.). Any other top-level directory keeps its own name as the
    category, so users can introduce arbitrary categories by simply creating
    folders; nesting below that directory is preserved by the management page.
    """
    parts = [part for part in relative_path.replace("\\", "/").split("/") if part]
    if not parts:
        return "other"
    if len(parts) == 1 and parts[0].lower() == "skill.md":
        return "rules"
    known = _CATEGORY_BY_DIR.get(parts[0].lower())
    if known is not None:
        return known
    if len(parts) > 1:
        return parts[0]
    return "other"


def category_sort_key(category: str) -> tuple[int, str]:
    """Order built-in categories first, then arbitrary ones alphabetically."""
    try:
        return (CAPABILITY_CATEGORIES.index(category), "")
    except ValueError:
        return (len(CAPABILITY_CATEGORIES), category.lower())


def _strip_markdown(text: str) -> str:
    value = text.strip()
    value = re.sub(r"^#{1,6}\s*", "", value)
    value = re.sub(r"^[-*+]\s+", "", value)
    value = re.sub(r"^>\s*", "", value)
    value = re.sub(r"`([^`]*)`", r"\1", value)
    value = re.sub(r"!\[([^\]]*)\]\([^)]*\)", r"\1", value)
    value = re.sub(r"\[([^\]]*)\]\([^)]*\)", r"\1", value)
    value = re.sub(r"[*_~]+", "", value)
    return re.sub(r"\s+", " ", value).strip()


def summarize_markdown(text: str) -> str:
    """Extract a deterministic one-line summary from Markdown content."""
    source = text.lstrip("\ufeff")
    frontmatter = _FRONTMATTER_RE.match(source)
    if frontmatter:
        for line in frontmatter.group(1).splitlines():
            key, separator, value = line.partition(":")
            if separator and key.strip().lower() == "description":
                summary = _strip_markdown(value.strip().strip("\"'"))
                if summary:
                    return summary[:_SUMMARY_MAX_CHARS]
        source = source[frontmatter.end() :]

    paragraph: list[str] = []
    for raw_line in source.splitlines():
        line = raw_line.strip()
        if not line:
            if paragraph:
                break
            continue
        if line.startswith("```") or line.startswith("~~~"):
            break
        if line.startswith("|") and not paragraph:
            continue
        if line.startswith("#"):
            if paragraph:
                break
            continue
        paragraph.append(line)
        if len(" ".join(paragraph)) >= _SUMMARY_MAX_CHARS:
            break

    summary = _strip_markdown(" ".join(paragraph))
    if summary:
        return summary[:_SUMMARY_MAX_CHARS]

    for raw_line in source.splitlines():
        summary = _strip_markdown(raw_line)
        if summary:
            return summary[:_SUMMARY_MAX_CHARS]
    return ""


def _read_markdown_summary(path: Path) -> str:
    try:
        with path.open("rb") as handle:
            raw = handle.read(_SUMMARY_READ_BYTES)
    except OSError:
        return ""
    return summarize_markdown(raw.decode("utf-8", errors="replace"))


def _modified_at(path: Path) -> str:
    try:
        return datetime.fromtimestamp(path.stat().st_mtime, tz=UTC).isoformat()
    except OSError:
        return ""


def build_capability_contents(root: Path) -> list[CapabilityGroupFile]:
    """Return every regular content file under *root*, sorted by category/path.

    ``group.json`` is group metadata, not content, and hidden/temporary files are
    skipped. Symlinked files are skipped so a group cannot expose content from
    outside its own package.
    """
    root = root.resolve()
    files: list[CapabilityGroupFile] = []
    for path in root.rglob("*"):
        try:
            if path.is_symlink() or not path.is_file():
                continue
            relative = path.relative_to(root).as_posix()
        except (OSError, ValueError):
            continue
        name = path.name
        if name == "group.json" or name.startswith("."):
            continue
        if any(part.startswith(".") for part in Path(relative).parts):
            continue
        is_markdown = path.suffix.lower() in _MARKDOWN_EXTENSIONS
        try:
            size = path.stat().st_size
        except OSError:
            size = 0
        files.append(
            CapabilityGroupFile(
                path=relative,
                name=name,
                category=classify_capability_file(relative),
                is_markdown=is_markdown,
                summary=_read_markdown_summary(path) if is_markdown else "",
                size=size,
                modified_at=_modified_at(path),
            )
        )
    files.sort(key=lambda item: (category_sort_key(item.category), item.path.lower()))
    return files
