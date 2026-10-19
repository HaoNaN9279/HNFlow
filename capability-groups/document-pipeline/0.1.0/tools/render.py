"""Render a Markdown document to plain text for smoke tests."""

from pathlib import Path


def render(source: Path, destination: Path) -> None:
    text = source.read_text(encoding="utf-8")
    destination.write_text(text.replace("# ", ""), encoding="utf-8")
