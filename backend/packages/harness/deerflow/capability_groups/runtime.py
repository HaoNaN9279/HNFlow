"""Runtime content loaded from active capability groups.

Capability groups are more than a tool allow-list: their ``rules/`` files are
operator-authored instructions and their ``skills/`` packages are deferred
procedural knowledge.  This module turns the installed packages into stable,
source-addressable runtime objects so prompt assembly and preview share one
loader.

Only metadata is exposed for skills here.  The full ``SKILL.md`` body is read
on demand by the scoped reader tool built in ``workflow/capability_skills.py``;
putting every skill body in the prompt would defeat deferred loading.
"""

from __future__ import annotations

import logging
from dataclasses import dataclass
from pathlib import Path

from deerflow.capability_groups.discovery import load_capability_group_closure
from deerflow.skills.frontmatter import split_skill_markdown

logger = logging.getLogger(__name__)


class CapabilityContentError(ValueError):
    """A capability group's runtime content is malformed or unreadable."""


@dataclass(frozen=True)
class CapabilityRule:
    """One ``rules/**/*.md`` document from an active group."""

    group_name: str
    group_guid: str
    group_version: str
    path: str
    content: str

    @property
    def source(self) -> str:
        return f"capability_group:{self.group_name}@{self.group_version}/{self.path}"

    @property
    def label(self) -> str:
        return f"Rule: {self.group_name} / {self.path}"


@dataclass(frozen=True)
class CapabilitySkill:
    """Metadata for one capability-group skill package.

    ``skill_dir`` and ``skill_file`` are host paths used only by the scoped
    reader tool.  They are intentionally not rendered into the prompt.
    """

    group_name: str
    group_guid: str
    group_version: str
    name: str
    description: str
    path: str
    skill_dir: Path
    skill_file: Path

    @property
    def source(self) -> str:
        return f"capability_group:{self.group_name}@{self.group_version}/{self.path}"

    @property
    def label(self) -> str:
        return f"Skill: {self.group_name} / {self.name}"


def _ordered_groups(references: list[str], *, user_id: str | None) -> list:
    return load_capability_group_closure(references, user_id=user_id, bases_first=True)


def load_capability_rules(
    references: list[str],
    *,
    user_id: str | None = None,
) -> list[CapabilityRule]:
    """Load every Markdown rule from the active group closure.

    Dependencies (``extends`` bases) come first.  A derived group may replace a
    base rule at the same relative path; its position stays at the base's
    position so prompt ordering remains deterministic.
    """
    rules: dict[str, CapabilityRule] = {}
    order: list[str] = []
    for group in _ordered_groups(references, user_id=user_id):
        for file in group.files:
            if file.category != "rules" or not file.is_markdown:
                continue
            path = group.root / file.path
            try:
                content = path.read_text(encoding="utf-8", errors="replace")
            except OSError as exc:
                raise CapabilityContentError(f"capability group '{group.name}@{group.version}' rule '{file.path}' cannot be read: {exc}") from exc
            rule = CapabilityRule(
                group_name=group.name,
                group_guid=group.guid,
                group_version=group.version,
                path=file.path,
                content=content,
            )
            if file.path not in rules:
                order.append(file.path)
            rules[file.path] = rule
    return [rules[path] for path in order]


def load_capability_skills(
    references: list[str],
    *,
    user_id: str | None = None,
) -> list[CapabilitySkill]:
    """Load skill metadata from every active capability group.

    Skill names must be unique across the active closure: the model selects a
    skill by name, so silently letting a later group shadow an earlier one
    would make the prompt describe one skill and the reader return another.
    """
    skills: dict[str, CapabilitySkill] = {}
    order: list[str] = []
    for group in _ordered_groups(references, user_id=user_id):
        for file in group.files:
            if file.category != "skills" or file.name != "SKILL.md" or not file.is_markdown:
                continue
            skill_file = group.root / file.path
            try:
                content = skill_file.read_text(encoding="utf-8", errors="replace")
            except OSError as exc:
                raise CapabilityContentError(f"capability group '{group.name}@{group.version}' skill '{file.path}' cannot be read: {exc}") from exc
            parts, error = split_skill_markdown(content)
            if parts is None:
                logger.warning(
                    "Skipping capability skill without valid frontmatter: %s (%s)",
                    skill_file,
                    error,
                )
                continue
            name = parts.metadata.get("name")
            description = parts.metadata.get("description")
            if not isinstance(name, str) or not name.strip():
                logger.warning("Skipping capability skill with no name: %s", skill_file)
                continue
            if not isinstance(description, str) or not description.strip():
                logger.warning("Skipping capability skill with no description: %s", skill_file)
                continue
            name = name.strip()
            existing = skills.get(name)
            if existing is not None and existing.skill_file != skill_file:
                raise CapabilityContentError(f"duplicate capability skill name '{name}' in '{existing.group_name}@{existing.group_version}' and '{group.name}@{group.version}'")
            skill = CapabilitySkill(
                group_name=group.name,
                group_guid=group.guid,
                group_version=group.version,
                name=name,
                description=description.strip(),
                path=file.path,
                skill_dir=skill_file.parent,
                skill_file=skill_file,
            )
            if name not in skills:
                order.append(name)
            skills[name] = skill
    return [skills[name] for name in order]


__all__ = [
    "CapabilityContentError",
    "CapabilityRule",
    "CapabilitySkill",
    "load_capability_rules",
    "load_capability_skills",
]
