"""Project-scoped content: instructions, rules, skills and tool references.

A project may need content that no capability group provides — an
``AGENTS.md``, a repository-specific rule, a local skill, or a tool package
that only makes sense for this repository.  That layer lives in
``<project>/.hnflow/content`` and is loaded by :mod:`deerflow.project_content`
instead of the external VibeStack checkout.
"""

from deerflow.project_content.loader import (
    ProjectContentError,
    content_fingerprint,
    content_snapshot,
    discover_instructions,
    load_project_content,
    merge_project_skills,
    resolve_content_root,
    verify_project_content_snapshot,
)
from deerflow.project_content.model import (
    DEFAULT_CONTENT_ROOT,
    INSTRUCTION_NAMES,
    MAX_INSTRUCTION_BYTES,
    PROJECT_CONTENT_DIR,
    ProjectContent,
    ProjectInstruction,
    ProjectRule,
    ProjectSkill,
    ProjectToolRef,
)

__all__ = [
    "DEFAULT_CONTENT_ROOT",
    "INSTRUCTION_NAMES",
    "MAX_INSTRUCTION_BYTES",
    "PROJECT_CONTENT_DIR",
    "ProjectContent",
    "ProjectContentError",
    "ProjectInstruction",
    "ProjectRule",
    "ProjectSkill",
    "ProjectToolRef",
    "content_fingerprint",
    "content_snapshot",
    "discover_instructions",
    "load_project_content",
    "merge_project_skills",
    "resolve_content_root",
    "verify_project_content_snapshot",
]
