from dataclasses import dataclass, field
from enum import StrEnum
from pathlib import Path

from deerflow.constants import DEFAULT_SKILLS_CONTAINER_PATH
from deerflow.environment.spec import RequirementSpec

SKILL_MD_FILE = "SKILL.md"


class SkillCategory(StrEnum):
    """Source category for a skill.

    - ``PUBLIC``: built-in skill bundled with the platform, read-only.
    - ``CUSTOM``: user-authored skill that can be edited or deleted.
    - ``INTEGRATION``: managed third-party integration skill, read-only.
    - ``LEGACY``: global custom skill from before user-isolation migration,
      presented as read-only (visible but not editable/deletable). These
      skills are mounted at ``/mnt/skills/legacy/<name>/`` in the sandbox.
    """

    PUBLIC = "public"
    CUSTOM = "custom"
    INTEGRATION = "integrations"
    LEGACY = "legacy"


@dataclass(frozen=True)
class SecretRequirement:
    """A request-scoped secret a skill declares it needs (issue #3861).

    ``name`` is both the key looked up in the request's ``context.secrets`` and
    the environment variable name injected into the skill's sandbox subprocess
    when the skill is activated.
    """

    name: str
    optional: bool = False


@dataclass(frozen=True)
class GroupManifest:
    """Skill capability-group identity manifest (group.json content)."""

    guid: str
    aliases: tuple[str, ...] = ()
    created_at: str | None = None


@dataclass(frozen=True)
class DependencySpec:
    """A capability-group dependency declaration (frontmatter ``dependencies``)."""

    guid: str
    version: str


@dataclass(frozen=True)
class Skill:
    """Represents a skill with its metadata and file path"""

    name: str
    description: str
    license: str | None
    skill_dir: Path
    skill_file: Path
    relative_path: Path  # Relative path from category root to skill directory
    category: SkillCategory  # 'public' or 'custom'
    allowed_tools: tuple[str, ...] | None = None
    enabled: bool = False  # Whether this skill is enabled
    required_secrets: tuple[SecretRequirement, ...] = field(default_factory=tuple)
    # Whether declared secrets may bind when the skill is in-context via an
    # autonomous model load (skill_context), or only on explicit /slash
    # activation. Frontmatter: ``secrets-autonomous`` (default true).
    secrets_autonomous: bool = True
    # The current (latest) version of this skill entry. Defaults to "0.1.0" for
    # legacy skills that predate versioned-storage layout.
    version: str = "0.1.0"
    # Frontmatter ``compatibility`` declaration (T8 dependency resolution).
    # Stored as-is; None when absent or when the frontmatter value is not a
    # plain string.
    compatibility: str | None = None
    # Stable capability-group identifier (from group.json). None when the
    # skill predates group-manifest storage (lazily assigned on first load).
    skill_id: str | None = None
    # Frontmatter ``dependencies`` declarations (T8 dependency resolution).
    dependencies: tuple[DependencySpec, ...] | None = None
    # Frontmatter ``requires`` declarations (N11 environment probing): what this
    # capability group needs from the machine (executables, versions, paths,
    # runtimes, plugins). Probed and reported by ``deerflow.environment``; an
    # empty tuple means the skill declares nothing and is never gated.
    requirements: tuple[RequirementSpec, ...] = ()
    # N14 §5.5 capability contract. ``permissions`` is a declared minimal-purpose
    # subset of {fs, net, exec, secrets} (runtime adjudication by the tool gateway
    # is a follow-up); ``tool_schema_version`` flags a structural tool-schema
    # change; ``context_budget`` is the tool-description token budget. Unknown
    # values are dropped at parse time (see ``skills.parser``).
    permissions: tuple[str, ...] = ()
    tool_schema_version: str | None = None
    context_budget: int | None = None
    # N14 §5.5 composition: capability groups this package builds on
    # (``extends``) and whether the package's own ``allowed-tools`` **replace**
    # the inherited list instead of adding to it (``overlay``). Resolved by
    # ``deerflow.skills.composition``; a base that is not installed is reported
    # there rather than silently dropping the inherited tools.
    extends: tuple[str, ...] = ()
    overlay: bool = False

    @property
    def skill_path(self) -> str:
        """Returns the relative path from the category root (skills/{category}) to this skill's directory"""
        path = self.relative_path.as_posix()
        return "" if path == "." else path

    def get_container_path(self, container_base_path: str = DEFAULT_SKILLS_CONTAINER_PATH) -> str:
        """
        Get the full path to this skill in the container.

        Args:
            container_base_path: Base path where skills are mounted in the container

        Returns:
            Full container path to the skill directory
        """
        category_base = f"{container_base_path}/{self.category}"
        skill_path = self.skill_path
        if skill_path:
            return f"{category_base}/{skill_path}"
        return category_base

    def get_container_file_path(self, container_base_path: str = DEFAULT_SKILLS_CONTAINER_PATH) -> str:
        """
        Get the full path to this skill's main file (SKILL.md) in the container.

        Args:
            container_base_path: Base path where skills are mounted in the container

        Returns:
            Full container path to the skill's SKILL.md file
        """
        return f"{self.get_container_path(container_base_path)}/SKILL.md"

    def __repr__(self) -> str:
        return f"Skill(name={self.name!r}, description={self.description!r}, version={self.version!r}, category={self.category!r})"
