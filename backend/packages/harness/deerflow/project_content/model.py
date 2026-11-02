"""Runtime model for project-scoped content.

Project content is the layer *between* capability groups and the workflow node:
it carries the project's own instruction documents (``AGENTS.md``), rules,
skills and tool references.  None of these items is a capability group: there
is no GUID, no version, and no ``extends``.  Keeping a distinct model stops the
group semantics (version pinning, published-version immutability) from leaking
into files the project owner edits freely.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

#: Directory under ``.hnflow`` that mirrors the capability-group layout.
PROJECT_CONTENT_DIR = "content"

#: Default project-relative content root.
DEFAULT_CONTENT_ROOT = ".hnflow/content"

#: Industry-standard instruction documents, in broad-to-specific order.
INSTRUCTION_NAMES: tuple[str, ...] = ("AGENTS.md", "AGENTS.local.md")

#: Per-file instruction budget.  A giant AGENTS.md must not silently crowd out
#: every capability rule, so an oversized file is skipped with a warning.
MAX_INSTRUCTION_BYTES = 256 * 1024


@dataclass(frozen=True)
class ProjectInstruction:
    """One project instruction document (``AGENTS.md`` or an explicit entry)."""

    path: str
    content: str
    layer: str = "project"

    @property
    def source(self) -> str:
        return f"project:{self.path}"

    @property
    def label(self) -> str:
        return f"Project instruction: {self.path}"


@dataclass(frozen=True)
class ProjectRule:
    """One ``rules/**/*.md`` document from the project content root."""

    path: str
    content: str

    @property
    def source(self) -> str:
        return f"project:{self.path}"

    @property
    def label(self) -> str:
        return f"Project rule: {self.path}"


@dataclass(frozen=True)
class ProjectSkill:
    """One project skill package under ``content/skills/<name>/``."""

    name: str
    description: str
    path: str
    skill_dir: Path
    skill_file: Path

    @property
    def source(self) -> str:
        return f"project:{self.path}"

    @property
    def label(self) -> str:
        return f"Skill: project / {self.name}"


@dataclass(frozen=True)
class ProjectToolRef:
    """One project-declared tool reference and, when known, its package."""

    ref: str
    provider: str = ""
    name: str = ""
    version: str = ""
    path: str = ""
    error: str = ""

    def to_dict(self) -> dict[str, Any]:
        return {
            "ref": self.ref,
            "provider": self.provider,
            "name": self.name,
            "version": self.version,
            "path": self.path,
            "error": self.error,
        }


@dataclass(frozen=True)
class ProjectContent:
    """Everything the project contributes to a run, in prompt order."""

    root: Path
    content_root: Path | None = None
    instructions: tuple[ProjectInstruction, ...] = ()
    rules: tuple[ProjectRule, ...] = ()
    skills: tuple[ProjectSkill, ...] = ()
    tools: tuple[ProjectToolRef, ...] = ()
    tool_root: Path | None = None
    tool_refs: tuple[str, ...] = ()
    skill_shadow: str = "deny"
    allow_python_tools: bool = False
    warnings: tuple[str, ...] = field(default_factory=tuple)

    def is_empty(self) -> bool:
        return not (self.instructions or self.rules or self.skills or self.tool_refs)

    def summary_dict(self) -> dict[str, Any]:
        return {
            "root": str(self.root),
            "content_root": str(self.content_root) if self.content_root is not None else None,
            "instructions": [{"path": item.path, "layer": item.layer, "source": item.source} for item in self.instructions],
            "rules": [{"path": item.path, "source": item.source} for item in self.rules],
            "skills": [{"name": item.name, "description": item.description, "path": item.path, "source": item.source} for item in self.skills],
            "tools": [item.to_dict() for item in self.tools],
            "skill_shadow": self.skill_shadow,
            "allow_python_tools": self.allow_python_tools,
            "warnings": list(self.warnings),
        }


__all__ = [
    "DEFAULT_CONTENT_ROOT",
    "INSTRUCTION_NAMES",
    "MAX_INSTRUCTION_BYTES",
    "PROJECT_CONTENT_DIR",
    "ProjectContent",
    "ProjectInstruction",
    "ProjectRule",
    "ProjectSkill",
    "ProjectToolRef",
]
