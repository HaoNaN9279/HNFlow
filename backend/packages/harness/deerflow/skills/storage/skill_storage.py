"""Abstract SkillStorage base class with template-method flows."""

from __future__ import annotations

import dataclasses
import json
import logging
import re
import uuid
from abc import ABC, abstractmethod
from collections.abc import Iterable
from datetime import UTC, datetime
from pathlib import Path

from deerflow.constants import DEFAULT_SKILLS_CONTAINER_PATH
from deerflow.skills.types import SKILL_MD_FILE, Skill, SkillCategory  # noqa: F401

logger = logging.getLogger(__name__)

_SKILL_NAME_PATTERN = re.compile(r"^[a-z0-9]+(?:-[a-z0-9]+)*$")


class SkillStorage(ABC):
    """Abstract base for skill storage backends.

    Subclasses implement a small set of storage-medium-specific atomic
    operations; this base class provides final template-method flows
    (load_skills, history serialisation, path helpers, validation) that
    compose them with protocol-level helpers.
    """

    def __init__(self, container_path: str = DEFAULT_SKILLS_CONTAINER_PATH) -> None:
        self._container_root = container_path

    # ------------------------------------------------------------------
    # Static protocol helpers (not storage-specific)
    # ------------------------------------------------------------------

    @staticmethod
    def validate_skill_name(name: str) -> str:
        """Validate and normalise a skill name; return the normalised form."""
        normalized = name.strip()
        if not _SKILL_NAME_PATTERN.fullmatch(normalized):
            raise ValueError("Skill name must be hyphen-case using lowercase letters, digits, and hyphens only.")
        if len(normalized) > 64:
            raise ValueError("Skill name must be 64 characters or fewer.")
        return normalized

    @staticmethod
    def validate_relative_path(relative_path: str, base_dir: Path) -> Path:
        """Validate *relative_path* against *base_dir* and return the resolved target.

        Checks that *relative_path* is non-empty, then joins it with *base_dir*
        and resolves the result (following symlinks).  Raises ``ValueError`` if
        the resolved target does not lie within *base_dir*.
        """
        if not relative_path:
            raise ValueError("relative_path must not be empty.")
        resolved_base = base_dir.resolve()
        target = (resolved_base / relative_path).resolve()
        try:
            target.relative_to(resolved_base)
        except ValueError as exc:
            raise ValueError("relative_path must resolve within the skill directory.") from exc
        return target

    @staticmethod
    def validate_skill_markdown_content(name: str, content: str) -> None:
        """Validate SKILL.md content: parse frontmatter and check name matches."""
        import tempfile

        from deerflow.skills.validation import _validate_skill_frontmatter

        with tempfile.TemporaryDirectory() as tmp_dir:
            temp_skill_dir = Path(tmp_dir) / SkillStorage.validate_skill_name(name)
            temp_skill_dir.mkdir(parents=True, exist_ok=True)
            (temp_skill_dir / SKILL_MD_FILE).write_text(content, encoding="utf-8")
            is_valid, message, parsed_name = _validate_skill_frontmatter(temp_skill_dir)
            if not is_valid:
                raise ValueError(message)
            if parsed_name != name:
                raise ValueError(f"Frontmatter name '{parsed_name}' must match requested skill name '{name}'.")

    def ensure_safe_support_path(self, name: str, relative_path: str) -> Path:
        """Validate and return the resolved absolute path for a support file."""
        _ALLOWED_SUPPORT_SUBDIRS = {"references", "templates", "scripts", "assets"}
        skill_dir = self.get_custom_skill_dir(self.validate_skill_name(name)).resolve()
        if not relative_path or relative_path.endswith("/"):
            raise ValueError("Supporting file path must include a filename.")
        relative = Path(relative_path)
        if relative.is_absolute():
            raise ValueError("Supporting file path must be relative.")
        if any(part in {"..", ""} for part in relative.parts):
            raise ValueError("Supporting file path must not contain parent-directory traversal.")
        top_level = relative.parts[0] if relative.parts else ""
        if top_level not in _ALLOWED_SUPPORT_SUBDIRS:
            raise ValueError(f"Supporting files must live under one of: {', '.join(sorted(_ALLOWED_SUPPORT_SUBDIRS))}.")
        target = (skill_dir / relative).resolve()
        allowed_root = (skill_dir / top_level).resolve()
        try:
            target.relative_to(allowed_root)
        except ValueError as exc:
            raise ValueError("Supporting file path must stay within the selected support directory.") from exc
        return target

    # ------------------------------------------------------------------
    # Abstract atomic operations (storage-medium specific)
    # ------------------------------------------------------------------

    @abstractmethod
    def get_skills_root_path(self) -> Path:
        """Absolute host path to the skills root, used for sandbox mounts.

        Origin: ``deerflow.skills.loader.get_skills_root_path``.
        """

    def validate_skill_file_path(self, skill_file: Path) -> Path:
        """Validate that *skill_file* is within an allowed root and return its resolved path.

        The default implementation checks that ``skill_file`` is under
        ``get_skills_root_path()`` — sufficient for :class:`LocalSkillStorage`
        where both public and custom skills live under the same root.

        :class:`UserScopedSkillStorage` overrides this to also accept files
        under the per-user custom root, because custom skills are stored in a
        separate directory tree that is not a sub-path of the global root.

        Raises:
            ValueError: if the resolved path escapes all allowed roots.
        """
        resolved_file = skill_file.resolve()
        resolved_root = self.get_skills_root_path().resolve()
        try:
            resolved_file.relative_to(resolved_root)
        except ValueError as exc:
            raise ValueError("Resolved skill file must stay within the configured skills root.") from exc
        return resolved_file

    @abstractmethod
    def _iter_skill_files(self) -> Iterable[tuple[SkillCategory, Path, Path]]:
        """Yield ``(category, category_root, skill_md_path)`` for every SKILL.md.

        Origin: extracted from directory-walk logic inside
        ``deerflow.skills.loader.load_skills``.
        """

    @abstractmethod
    def read_custom_skill(self, name: str, version: str | None = None) -> str:
        """Read SKILL.md content for a custom skill.

        When *version* is given, reads from that specific version directory.
        When *version* is ``None`` (default), reads from the current (highest)
        version, falling back to legacy-layout SKILL.md when no version
        directories exist.

        Origin: ``deerflow.skills.manager.read_custom_skill_content``.
        """

    @abstractmethod
    def write_custom_skill(self, name: str, relative_path: str, content: str, *, version: str | None = None) -> str:
        """Atomically write a text file under ``custom/<name>/v{version}/<relative_path>``.

        Returns the actual version string the file was written under (which may
        differ from the requested *version* when the target version directory
        already exists — the patch is incremented until a free directory is
        found).

        Origin: ``deerflow.skills.manager.atomic_write``.
        """

    def remove_custom_skill_file(self, name: str, relative_path: str) -> str:
        """Remove a supporting file and return its previous text content."""
        target = self.ensure_safe_support_path(name, relative_path)
        if not target.exists():
            raise FileNotFoundError(f"Supporting file '{relative_path}' not found for skill '{name}'.")
        previous_content = target.read_text(encoding="utf-8")
        target.unlink()
        return previous_content

    @abstractmethod
    async def ainstall_skill_from_archive(self, archive_path: str | Path) -> dict:
        """Async install of a skill from a ``.skill`` ZIP archive.

        Origin: ``deerflow.skills.installer.ainstall_skill_from_archive``.
        """

    def install_skill_from_archive(self, archive_path: str | Path) -> dict:
        """Sync wrapper — delegates to :meth:`ainstall_skill_from_archive`."""
        from deerflow.skills.installer import _run_async_install

        return _run_async_install(self.ainstall_skill_from_archive(archive_path))

    @abstractmethod
    def delete_custom_skill(self, name: str, *, history_meta: dict | None = None) -> None:
        """Delete a custom skill (validation + optional history + directory removal).

        Origin: ``app.gateway.routers.skills.delete_custom_skill`` + ``skill_manage_tool``.
        """

    @abstractmethod
    def custom_skill_exists(self, name: str) -> bool:
        """Origin: ``deerflow.skills.manager.custom_skill_exists``."""

    @abstractmethod
    def list_skill_versions(self, name: str) -> list[str]:
        """Return sorted list of all version strings for a custom skill.

        Returns an empty list when no versions exist.  Versions are sorted in
        ascending semver order.

        Origin: T7-3 versioned storage layer.
        """

    @abstractmethod
    def resolve_current_version(self, name: str) -> str | None:
        """Return the current (highest) version string for a skill, or ``None``.

        When no version directories exist but a legacy-layout ``SKILL.md`` is
        present, returns ``"0.1.0"`` (the semantic default for unversioned
        skills).  Returns ``None`` only when the skill has no content at all.

        Origin: T7-3 versioned storage layer.
        """

    @abstractmethod
    def public_skill_exists(self, name: str) -> bool:
        """Origin: ``deerflow.skills.manager.public_skill_exists``."""

    @abstractmethod
    def append_history(self, name: str, record: dict) -> None:
        """Append a JSONL history entry for ``name``.

        Origin: ``deerflow.skills.manager.append_history``.
        """

    @abstractmethod
    def read_history(self, name: str) -> list[dict]:
        """Return all history records for ``name``, oldest first.

        Origin: ``deerflow.skills.manager.read_history``.
        """

    # ------------------------------------------------------------------
    # Concrete path helpers (layout is part of the SKILL.md protocol)
    # ------------------------------------------------------------------

    def get_container_root(self) -> str:
        """Origin: ``deerflow.config.skills_config.SkillsConfig.container_path`` accessor."""
        return self._container_root

    def get_custom_skill_dir(self, name: str, version: str | None = None) -> Path:
        """Path to ``custom/<name>/v{version}/`` (or legacy layout for v0.1.0).

        When *version* is ``None``, resolves the current version directory or
        legacy layout.  Does not create the directory.

        Origin: ``deerflow.skills.manager.get_custom_skill_dir``.
        """
        normalized_name = self.validate_skill_name(name)
        return self.get_skills_root_path() / SkillCategory.CUSTOM.value / normalized_name

    def get_custom_skill_file(self, name: str, version: str | None = None) -> Path:
        """Path to ``custom/<name>/v{version}/SKILL.md`` (or legacy layout).

        Origin: ``deerflow.skills.manager.get_custom_skill_file``.
        """
        return self.get_custom_skill_dir(name, version=version) / SKILL_MD_FILE

    def get_skill_history_file(self, name: str) -> Path:
        """Path to ``custom/.history/<name>.jsonl``. Does not create parents.

        **Note:** This default implementation returns a path under the global
        skills root, which is correct for :class:`LocalSkillStorage` but
        **incorrect** for :class:`UserScopedSkillStorage`. Subclasses that
        redirect custom skill paths must override this method (as
        ``UserScopedSkillStorage`` already does).

        Origin: ``deerflow.skills.manager.get_skill_history_file``.
        """
        normalized_name = self.validate_skill_name(name)
        return self.get_skills_root_path() / SkillCategory.CUSTOM.value / ".history" / f"{normalized_name}.jsonl"

    # ------------------------------------------------------------------
    # Final template-method flows
    # ------------------------------------------------------------------

    @staticmethod
    def _ensure_skill_guid(skill: Skill) -> Skill:
        """Ensure *skill* has a stable ``skill_id``, generating one if absent.

        Reads/writes ``group.json`` in the skill directory.  Idempotent:
        when ``group.json`` already exists its ``guid`` is reused.
        """
        group_file = skill.skill_dir / "group.json"
        if group_file.exists():
            try:
                data = json.loads(group_file.read_text(encoding="utf-8"))
                existing = data.get("guid")
                if isinstance(existing, str) and existing:
                    return dataclasses.replace(skill, skill_id=existing)
            except (json.JSONDecodeError, OSError):
                pass

        guid = uuid.uuid4().hex
        group_data = {
            "guid": guid,
            "aliases": [],
            "created_at": datetime.now(UTC).isoformat(),
        }
        try:
            group_file.write_text(json.dumps(group_data), encoding="utf-8")
        except OSError:
            logger.warning("Failed to write group.json for skill %s", skill.name)
            # Persistence failed: keep the skill_id None so a later load retries
            # instead of serving an in-memory guid that is not durable (the
            # guid must be stable across loads).
            return skill
        return dataclasses.replace(skill, skill_id=guid)

    def load_skills(self, *, enabled_only: bool = False) -> list[Skill]:
        """Discover all skills, merge enabled state, sort and optionally filter.

        Origin: ``deerflow.skills.loader.load_skills``.
        """
        from deerflow.skills.parser import parse_skill_file

        skills_by_name: dict[str, Skill] = {}
        for category, category_root, md_path in self._iter_skill_files():
            skill = parse_skill_file(
                md_path,
                category=category,
                relative_path=md_path.parent.relative_to(category_root),
            )
            if skill:
                # T8: lazy GUID generation for writable categories.
                # PUBLIC and LEGACY skills are read-only / git-managed —
                # they must not have group.json written to them.
                if skill.skill_id is None and skill.category in (SkillCategory.CUSTOM, SkillCategory.INTEGRATION):
                    skill = SkillStorage._ensure_skill_guid(skill)
                skills_by_name[skill.name] = skill

        skills = list(skills_by_name.values())

        # Merge enabled state from extensions config (re-read every call so
        # changes made by another process are picked up immediately).
        # All skill categories (PUBLIC, LEGACY, CUSTOM) respect the
        # extensions_config enabled/disabled state.  CUSTOM skills default
        # to enabled when no explicit config entry exists (so newly
        # installed skills appear active without requiring a manual toggle).
        try:
            from deerflow.config.extensions_config import ExtensionsConfig

            extensions_config = ExtensionsConfig.from_file()
            skills = [dataclasses.replace(s, enabled=extensions_config.is_skill_enabled(s.name, s.category)) for s in skills]
        except Exception as e:
            logger.warning("Failed to load extensions config: %s", e)

        if enabled_only:
            skills = [s for s in skills if s.enabled]

        skills.sort(key=lambda s: s.name)
        return skills

    def ensure_custom_skill_is_editable(self, name: str) -> None:
        """Origin: ``deerflow.skills.manager.ensure_custom_skill_is_editable``.

        Only CUSTOM-category skills are editable. PUBLIC (built-in) and
        LEGACY (shared pre-migration) skills are read-only; attempting to
        edit them raises ``ValueError`` with a helpful suggestion.
        """
        if self.custom_skill_exists(name):
            return
        if self.public_skill_exists(name):
            raise ValueError(f"'{name}' is a built-in skill. To customise it, create a new skill with the same name under skills/custom/.")
        raise FileNotFoundError(f"Custom skill '{name}' not found.")
