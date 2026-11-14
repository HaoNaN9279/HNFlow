"""Minimal YAML frontmatter parsing for capability content."""

from __future__ import annotations

import re
from dataclasses import dataclass, field

_KEY = re.compile(r"^([A-Za-z0-9_-]+):\s*(.*)$")
_LIST_ITEM = re.compile(r"^\s*-\s+(.*)$")
_BLOCK_SCALARS = {"|", ">", "|-", "|+", ">-", ">+"}


@dataclass
class Frontmatter:
    """Parsed frontmatter data and document body."""

    data: dict[str, object] = field(default_factory=dict)
    body: str = ""


def parse_frontmatter(text: str) -> Frontmatter:
    """Parse a leading ``---`` frontmatter block without third-party YAML."""
    lines = text.splitlines()
    if not lines or lines[0].strip() != "---":
        return Frontmatter(body=text.strip())

    end = next((i for i in range(1, len(lines)) if lines[i].strip() == "---"), None)
    if end is None:
        return Frontmatter(body=text.strip())

    data: dict[str, object] = {}
    current_key = ""
    index = 1
    while index < end:
        line = lines[index]
        if not line.strip() or line.lstrip().startswith("#"):
            index += 1
            continue

        item = _LIST_ITEM.match(line)
        if item and current_key:
            value = unquote(item.group(1))
            existing = data.get(current_key)
            if isinstance(existing, list):
                existing.append(value)
            else:
                data[current_key] = [value]
            index += 1
            continue

        if line[0].isspace():
            index += 1
            continue

        match = _KEY.match(line)
        if match is None:
            index += 1
            continue

        current_key = match.group(1)
        raw = match.group(2).strip()
        if raw in _BLOCK_SCALARS:
            block, index = _read_block(lines, index + 1, end)
            data[current_key] = _render_block(block, raw)
            continue

        data[current_key] = parse_scalar(raw)
        index += 1

    return Frontmatter(data=data, body="\n".join(lines[end + 1 :]).strip())


def frontmatter_text(value: object) -> str:
    """Return a frontmatter value as trimmed text."""
    return value.strip() if isinstance(value, str) else ""


def parse_scalar(raw: str) -> object:
    """Parse one inline scalar or flow-style list."""
    value = raw.strip()
    if not value:
        return ""
    if value.startswith("[") and value.endswith("]"):
        items = value[1:-1].split(",")
        return [unquote(item) for item in items if item.strip()]
    return unquote(value)


def unquote(value: str) -> str:
    """Remove matching single or double quotes."""
    text = value.strip()
    if len(text) >= 2 and text[0] == text[-1] and text[0] in {"'", '"'}:
        return text[1:-1]
    return text


def _read_block(
    lines: list[str], start: int, end: int
) -> tuple[list[str], int]:
    block: list[str] = []
    indent: int | None = None
    index = start
    while index < end:
        line = lines[index]
        if not line.strip():
            block.append("")
            index += 1
            continue
        if not line[0].isspace():
            break
        if indent is None:
            indent = len(line) - len(line.lstrip(" "))
        block.append(line[indent:] if len(line) >= indent else line.lstrip())
        index += 1

    while block and not block[0].strip():
        block.pop(0)
    while block and not block[-1].strip():
        block.pop()
    return block, index


def _render_block(block: list[str], style: str) -> str:
    if style.startswith(">"):
        return " ".join(part.strip() for part in block if part.strip())
    return "\n".join(part.rstrip() for part in block)
