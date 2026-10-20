"""On-demand reader for capability-group skills.

AI nodes see only skill names and descriptions in the prompt.  When the model
decides a skill is relevant it calls this scoped read-only tool, which mirrors
the generic agent's ``read_file`` flow without granting access to arbitrary
host paths.
"""

from __future__ import annotations

import re
from collections.abc import Sequence
from typing import TYPE_CHECKING, Any

if TYPE_CHECKING:
    from langchain.tools import BaseTool

    from deerflow.capability_groups.runtime import CapabilitySkill

_DRIVE_PREFIX = re.compile(r"^[A-Za-z]:")


def _error(message: str) -> str:
    return f"Error: {message}"


def _resolve_skill_path(skill: Any, relative_path: str) -> Any:
    """Resolve *relative_path* inside *skill* or return ``None`` on escape."""
    from pathlib import PurePosixPath

    raw = (relative_path or "SKILL.md").strip().replace("\\", "/")
    if not raw or raw.startswith("/") or _DRIVE_PREFIX.match(raw):
        return None
    pure = PurePosixPath(raw)
    if any(part in {"", ".", ".."} for part in pure.parts):
        return None
    root = skill.skill_dir.resolve()
    target = (root / pure).resolve()
    if not target.is_relative_to(root):
        return None
    return target


def build_read_capability_skill_tool(skills: Sequence[CapabilitySkill]) -> BaseTool:
    """Build ``read_capability_skill`` scoped to the active skill packages."""
    from langchain_core.tools import StructuredTool

    by_name = {skill.name: skill for skill in skills}
    names = ", ".join(sorted(by_name))

    def read_capability_skill(name: str, path: str = "SKILL.md") -> str:
        skill = by_name.get(name)
        if skill is None:
            return _error(f"unknown capability skill '{name}'; available: {names or '(none)'}")
        target = _resolve_skill_path(skill, path)
        if target is None:
            return _error(f"path '{path}' is outside capability skill '{name}'")
        try:
            if not target.is_file():
                return _error(f"file '{path}' does not exist in capability skill '{name}'")
            return target.read_text(encoding="utf-8", errors="replace")
        except OSError as exc:
            return _error(f"cannot read capability skill '{name}' path '{path}': {exc}")

    return StructuredTool.from_function(
        func=read_capability_skill,
        name="read_capability_skill",
        description=(
            "Read a capability-group skill's full SKILL.md or one of its supporting files. "
            "The system prompt lists skill names and descriptions only; call this tool when "
            "you need the full instructions. Available skills: "
            f"{names or '(none)'}."
        ),
    )


__all__ = ["build_read_capability_skill_tool"]
