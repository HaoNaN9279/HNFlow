"""Local-filesystem implementation of ``SkillStorage``.

T7-3: versioned storage layout.  Each skill version lives in its own
subdirectory::

    <root>/public/<name>/v0.1.0/SKILL.md        ← versioned
    <root>/custom/<name>/v0.1.0/SKILL.md        ← versioned
    <root>/custom/<name>/SKILL.md               ← legacy (v0.1.0)
    <root>/custom/.history/<name>.jsonl         ← unchanged
"""

from __future__ import annotations

import asyncio
import errno
import json
import logging
import os
import shutil
import tempfile
from collections.abc import Iterable
from contextlib import nullcontext
from datetime import UTC, datetime
from pathlib import Path

from deerflow.config.runtime_paths import resolve_path
from deerflow.constants import DEFAULT_SKILLS_CONTAINER_PATH
from deerflow.skills.permissions import make_skill_written_path_sandbox_readable
from deerflow.skills.storage.skill_storage import SKILL_MD_FILE, SkillStorage
from deerflow.skills.types import SkillCategory
from deerflow.skills.versions import (
    bump_patch,
    dir_name_to_version,
    is_version_dir_name,
    parse_version,
    select_current_version,
    sort_versions,
    version_to_dir_name,
)

logger = logging.getLogger(__name__)

# Bound for the best-effort temp-dir cleanup so a stalled filesystem (e.g. NFS)
# cannot hold back the install outcome propagating out of the finally block.
_INSTALL_TMP_CLEANUP_TIMEOUT_SECONDS = 5.0


# ---------------------------------------------------------------------------
# Shared helper — resolve the current version of a skill directory
# ---------------------------------------------------------------------------


def _resolve_skill_dir_current_version(skill_dir: Path) -> str | None:
    """Return the current version for *skill_dir*, or ``None``.

    Scans for version directories (``v0.1.0``, …) and picks the highest.
    When no version directories exist but a legacy ``SKILL.md`` is present
    directly under *skill_dir*, returns ``"0.1.0"`` (the semantic default).

    This is a pure helper — no filesystem writes, no side effects.
    """
    if not skill_dir.exists() or not skill_dir.is_dir():
        return None
    versions: list[str] = []
    try:
        for entry in skill_dir.iterdir():
            if entry.is_dir() and is_version_dir_name(entry.name):
                versions.append(dir_name_to_version(entry.name))
    except OSError:
        return None
    if versions:
        return select_current_version(versions)
    if (skill_dir / SKILL_MD_FILE).exists():
        return "0.1.0"
    return None


def _list_skill_dir_versions(skill_dir: Path) -> list[str]:
    """Return sorted version strings for a skill directory.

    Scans for ``is_version_dir_name`` subdirectories and returns
    ``sort_versions``-ordered bare semver strings (no ``v`` prefix).
    """
    if not skill_dir.exists() or not skill_dir.is_dir():
        return []
    versions: list[str] = []
    try:
        for entry in skill_dir.iterdir():
            if entry.is_dir() and is_version_dir_name(entry.name):
                versions.append(dir_name_to_version(entry.name))
    except OSError:
        return []
    return sort_versions(versions)


# ---------------------------------------------------------------------------
# Category-level iteration helper (shared by LocalSkillStorage and
# UserScopedSkillStorage)
# ---------------------------------------------------------------------------


def _iter_category_skill_files(category_root: Path) -> Iterable[tuple[Path, Path]]:
    """Yield ``(name_dir, skill_md_path)`` for every current-version skill under *category_root*.

    Walks *category_root* recursively via :func:`os.walk`, resolving version
    directories inline.  When a ``SKILL.md`` is found (inside a version
    directory or via legacy layout), that directory becomes a package
    boundary: deeper nested ``SKILL.md`` files are NOT yielded.

    Yields:
        ``(name_dir, skill_md_path)`` where *name_dir* is the skill's base
        directory (e.g. ``.../custom/demo-skill``) and *skill_md_path* is the
        ``SKILL.md`` (e.g. ``.../custom/demo-skill/v0.1.0/SKILL.md`` or
        ``.../custom/demo-skill/SKILL.md`` for legacy).
    """
    if not category_root.exists() or not category_root.is_dir():
        return

    for current_root, dir_names, file_names in os.walk(category_root, followlinks=True):
        dir_names[:] = sorted(name for name in dir_names if not name.startswith("."))

        # Version resolution: if any dir_names are version dirs, keep only the
        # highest version and remove the rest.
        version_dirs = [(d, dir_name_to_version(d)) for d in dir_names if is_version_dir_name(d)]
        if version_dirs:
            version_dirs.sort(key=lambda x: x[1])
            highest_str = version_dirs[-1][0]
            # Keep only the highest version dir; remove all others
            dir_names[:] = [d for d in dir_names if not is_version_dir_name(d) or d == highest_str]
            # Warn about skipped non-current versions
            for d, _v in version_dirs[:-1]:
                logger.warning("Skipping non-current version dir: %s/%s", current_root, d)

        if SKILL_MD_FILE not in file_names:
            continue

        # T7-7: When version directories exist, the legacy SKILL.md at this
        # level is not the current version — skip it and let os.walk recurse
        # into the highest version directory to find and yield the versioned
        # SKILL.md instead.
        if version_dirs:
            continue

        # A directory containing SKILL.md is a package boundary.
        dir_names.clear()
        yield Path(current_root), Path(current_root) / SKILL_MD_FILE


class LocalSkillStorage(SkillStorage):
    """Skill storage backed by the local filesystem.

    T7-3 versioned layout::

        <root>/public/<name>/v0.1.0/SKILL.md
        <root>/custom/<name>/v0.1.0/SKILL.md
        <root>/custom/<name>/SKILL.md              ← legacy (v0.1.0)
        <root>/custom/.history/<name>.jsonl
    """

    def __init__(
        self,
        host_path: str | None = None,
        container_path: str = DEFAULT_SKILLS_CONTAINER_PATH,
        app_config=None,
    ) -> None:
        super().__init__(container_path=container_path)
        if host_path is None:
            from deerflow.config import get_app_config

            config = app_config or get_app_config()
            self._app_config = config
            self._host_root: Path = config.skills.get_skills_path()
        else:
            self._app_config = app_config
            self._host_root = resolve_path(host_path)

    # ------------------------------------------------------------------
    # Path helpers — version-aware
    # ------------------------------------------------------------------

    def get_skills_root_path(self) -> Path:
        return self._host_root

    def _get_custom_skill_base_dir(self, name: str) -> Path:
        """Return ``<custom>/<name>/`` without any version subdirectory."""
        normalized_name = self.validate_skill_name(name)
        return self._host_root / SkillCategory.CUSTOM.value / normalized_name

    def get_custom_skill_dir(self, name: str, version: str | None = None) -> Path:
        """Version-aware custom skill directory.

        - *version* given → ``<custom>/<name>/v{version}/``
        - *version* ``None`` + current version dirs → highest version dir
        - *version* ``None`` + legacy ``SKILL.md`` → ``<custom>/<name>/``
        - *version* ``None`` + nothing → ``<custom>/<name>/`` (default for writes)
        """
        normalized_name = self.validate_skill_name(name)
        base_dir = self._host_root / SkillCategory.CUSTOM.value / normalized_name
        if version is not None:
            parsed = parse_version(version)
            return base_dir / version_to_dir_name(parsed)
        current = _resolve_skill_dir_current_version(base_dir)
        if current is not None:
            current_version_dir = base_dir / version_to_dir_name(current)
            if current_version_dir.exists() and current_version_dir.is_dir():
                return current_version_dir
            # Legacy layout: SKILL.md lives directly under base_dir
            return base_dir
        return base_dir

    def get_custom_skill_file(self, name: str, version: str | None = None) -> Path:
        """Version-aware custom SKILL.md path."""
        return self.get_custom_skill_dir(name, version=version) / SKILL_MD_FILE

    def list_skill_versions(self, name: str) -> list[str]:
        """Return sorted version strings for a custom skill."""
        normalized_name = self.validate_skill_name(name)
        base_dir = self._host_root / SkillCategory.CUSTOM.value / normalized_name
        return _list_skill_dir_versions(base_dir)

    def resolve_current_version(self, name: str) -> str | None:
        """Return the current (highest) version for a custom skill."""
        normalized_name = self.validate_skill_name(name)
        base_dir = self._host_root / SkillCategory.CUSTOM.value / normalized_name
        return _resolve_skill_dir_current_version(base_dir)

    # ------------------------------------------------------------------
    # Existence checks
    # ------------------------------------------------------------------

    def custom_skill_exists(self, name: str) -> bool:
        return self.resolve_current_version(name) is not None

    def public_skill_exists(self, name: str) -> bool:
        normalized_name = self.validate_skill_name(name)
        skill_dir = self._host_root / SkillCategory.PUBLIC.value / normalized_name
        return _resolve_skill_dir_current_version(skill_dir) is not None

    # ------------------------------------------------------------------
    # Skill iteration
    # ------------------------------------------------------------------

    def _iter_skill_files(self) -> Iterable[tuple[SkillCategory, Path, Path]]:
        """Yield ``(category, category_root, skill_md_path)`` for every current-version skill.

        Uses :func:`_iter_category_skill_files` for version resolution.
        """
        if not self._host_root.exists():
            return
        for category in SkillCategory:
            category_path = self._host_root / category.value
            if not category_path.exists() or not category_path.is_dir():
                continue
            for _name_dir, skill_md_path in _iter_category_skill_files(category_path):
                yield category, category_path, skill_md_path

    # ------------------------------------------------------------------
    # Read
    # ------------------------------------------------------------------

    def read_custom_skill(self, name: str, version: str | None = None) -> str:
        if version is not None:
            skill_file = self.get_custom_skill_file(name, version=version)
            if not skill_file.exists():
                raise FileNotFoundError(f"Skill '{name}' version {version} not found.")
            return skill_file.read_text(encoding="utf-8")
        # Current version (including legacy fallback)
        if not self.custom_skill_exists(name):
            raise FileNotFoundError(f"Custom skill '{name}' not found.")
        return self.get_custom_skill_file(name).read_text(encoding="utf-8")

    # ------------------------------------------------------------------
    # Write — version-aware with immutable bump + tree copy
    # ------------------------------------------------------------------

    def write_custom_skill(self, name: str, relative_path: str, content: str, *, version: str | None = None) -> str:
        """Atomically write a file under the skill's version directory.

        Returns the actual version string the file was written to.
        """
        normalized_name = self.validate_skill_name(name)
        base_dir = self._host_root / SkillCategory.CUSTOM.value / normalized_name

        # 1. Determine target version
        target_version = self._resolve_write_target_version(base_dir, normalized_name, relative_path, content, version)

        is_skill_md = relative_path == SKILL_MD_FILE or relative_path.endswith(f"/{SKILL_MD_FILE}")

        # 2. Bump to an unused version directory — every write creates a new
        #    version (immutable versioning).  For SKILL.md the target_version
        #    is already resolved from frontmatter or explicit arg; for support
        #    files without an explicit version we bump starting from current.
        if is_skill_md:
            target_version = self._ensure_version_available(base_dir, target_version)
        else:
            if version is not None:
                # Explicit version requested — respect it
                target_version = self._ensure_version_available(base_dir, target_version)
            else:
                # Auto-bump from current so the write never mutates a published version
                current_version = _resolve_skill_dir_current_version(base_dir)
                if current_version is None:
                    current_version = "0.1.0"
                target_version = self._ensure_version_available(base_dir, current_version)

        # 3. Rewrite frontmatter version when writing SKILL.md
        if is_skill_md:
            content = self._rewrite_frontmatter_version(content, target_version)

        # 4. For support files: copy entire current version tree into the new
        #    version directory before writing the support file
        current_version = _resolve_skill_dir_current_version(base_dir)
        if not is_skill_md and current_version is not None:
            self._copy_version_tree_if_needed(base_dir, current_version, target_version)

        # 5. Write the file atomically
        target_version_dir = base_dir / version_to_dir_name(target_version)
        target = self.validate_relative_path(relative_path, target_version_dir)
        target.parent.mkdir(parents=True, exist_ok=True)
        with tempfile.NamedTemporaryFile(
            "w",
            encoding="utf-8",
            delete=False,
            dir=str(target.parent),
        ) as tmp_file:
            tmp_file.write(content)
            tmp_path = Path(tmp_file.name)
        try:
            with self._skill_projection_mutation():
                tmp_path.replace(target)
                make_skill_written_path_sandbox_readable(target_version_dir, target)
        except Exception:
            tmp_path.unlink(missing_ok=True)
            raise

        return target_version

    # ------------------------------------------------------------------
    # Write helpers
    # ------------------------------------------------------------------

    def _resolve_write_target_version(
        self,
        base_dir: Path,
        normalized_name: str,
        relative_path: str,
        content: str,
        version: str | None,
    ) -> str:
        """Determine the target version for a write operation."""
        if version is not None:
            return parse_version(version)

        # Writing SKILL.md: extract version from frontmatter, fall back to current / "0.1.0"
        if relative_path == SKILL_MD_FILE or relative_path.endswith(f"/{SKILL_MD_FILE}"):
            fm_version = self._extract_frontmatter_version(content)
            if fm_version is not None:
                return fm_version
            current = _resolve_skill_dir_current_version(base_dir)
            return current if current is not None else "0.1.0"

        # Support file: use current version, fall back to "0.1.0"
        current = _resolve_skill_dir_current_version(base_dir)
        return current if current is not None else "0.1.0"

    @staticmethod
    def _extract_frontmatter_version(content: str) -> str | None:
        """Extract the ``version`` field from SKILL.md frontmatter, if present and valid."""
        from deerflow.skills.frontmatter import split_skill_markdown

        parts, _err = split_skill_markdown(content)
        if parts is None:
            return None
        raw = parts.metadata.get("version")
        if raw is None:
            return None
        try:
            return parse_version(str(raw))
        except ValueError:
            return None

    @staticmethod
    def _ensure_version_available(base_dir: Path, target_version: str) -> str:
        """Bump *target_version* until its directory does not exist.

        Returns the first available version."""
        current = target_version
        while (base_dir / version_to_dir_name(current)).exists():
            current = bump_patch(current)
        return current

    @staticmethod
    def _rewrite_frontmatter_version(content: str, target_version: str) -> str:
        """Rewrite the ``version`` field in SKILL.md frontmatter to *target_version*.

        Preserves all other frontmatter fields and formatting.
        If the frontmatter has no ``version`` line, inserts one after ``name``.
        """
        from deerflow.skills.frontmatter import split_skill_markdown

        parts, _err = split_skill_markdown(content)
        if parts is None:
            # No valid frontmatter — prepend one with version
            return f"---\nversion: {target_version}\n---\n\n{content}"

        metadata = parts.metadata
        metadata["version"] = target_version
        frontmatter_text = parts.frontmatter_text
        body = parts.body

        # Rebuild frontmatter: replace or insert version line
        lines = frontmatter_text.split("\n")
        new_lines: list[str] = []
        version_written = False

        for line in lines:
            stripped = line.strip()
            if stripped.startswith("version:") or stripped == "version:":
                new_lines.append(f"version: {target_version}")
                version_written = True
            else:
                new_lines.append(line)

        if not version_written:
            # Insert version after the line that starts with "name:"
            inserted = False
            final_lines: list[str] = []
            for line in new_lines:
                final_lines.append(line)
                if not inserted and (line.strip().startswith("name:") or line.strip() == "name:"):
                    final_lines.append(f"version: {target_version}")
                    inserted = True
            if not inserted:
                # No name: line found either — prepend version at top
                final_lines = [f"version: {target_version}"] + new_lines
            new_lines = final_lines

        new_frontmatter = "\n".join(new_lines)
        return f"---\n{new_frontmatter}\n---\n{body}"

    def _copy_version_tree_if_needed(self, base_dir: Path, current_version: str, target_version: str) -> None:
        """Copy the current version directory tree to the target version.

        Only copies when the target version directory does not already exist
        and the current version directory exists with content.
        """
        target_dir = base_dir / version_to_dir_name(target_version)
        if target_dir.exists():
            return
        current_dir = base_dir / version_to_dir_name(current_version)
        if not current_dir.exists() or not current_dir.is_dir():
            return
        # Only copy if the current version dir has content besides SKILL.md
        try:
            entries = list(current_dir.iterdir())
        except OSError:
            return
        target_dir.mkdir(parents=True, exist_ok=True)
        for entry in entries:
            dest = target_dir / entry.name
            if entry.is_dir():
                shutil.copytree(entry, dest)
            else:
                shutil.copy2(entry, dest)

    # ------------------------------------------------------------------
    # remove_custom_skill_file
    # ------------------------------------------------------------------

    def remove_custom_skill_file(self, name: str, relative_path: str) -> str:
        removal = ((SkillCategory.CUSTOM, Path(name)),)
        with self._skill_projection_mutation(remove=removal):
            return super().remove_custom_skill_file(name, relative_path)

    # ------------------------------------------------------------------
    # install_skill_from_archive
    # ------------------------------------------------------------------

    async def ainstall_skill_from_archive(self, archive_path: str | Path) -> dict:
        from deerflow.skills.installer import _scan_skill_archive_contents_or_raise

        logger.info("Installing skill from %s", archive_path)
        path = Path(archive_path)
        custom_dir = self._host_root / "custom"

        tmp = await asyncio.to_thread(tempfile.mkdtemp)
        try:
            skill_dir, skill_name, target = await asyncio.to_thread(self._prepare_skill_archive, path, Path(tmp), custom_dir, archive_path)

            await _scan_skill_archive_contents_or_raise(skill_dir, skill_name, app_config=self._app_config)

            await asyncio.to_thread(self._commit_skill_install, skill_dir, skill_name, custom_dir, target)
            logger.info("Skill %r installed to %s", skill_name, target)
        finally:
            try:
                await asyncio.wait_for(
                    asyncio.to_thread(self._cleanup_install_tmp, tmp),
                    timeout=_INSTALL_TMP_CLEANUP_TIMEOUT_SECONDS,
                )
            except TimeoutError:
                logger.warning("Timed out cleaning up skill install temp dir %s", tmp)

        return {
            "success": True,
            "skill_name": skill_name,
            "message": f"Skill '{skill_name}' installed successfully",
        }

    @staticmethod
    def _cleanup_install_tmp(tmp: str) -> None:
        try:
            shutil.rmtree(tmp)
        except OSError:
            logger.warning("Failed to clean up skill install temp dir %s", tmp, exc_info=True)

    def _prepare_skill_archive(self, path: Path, tmp_path: Path, custom_dir: Path, archive_path: str | Path) -> tuple[Path, str, Path]:
        import zipfile

        from deerflow.skills.installer import (
            SkillAlreadyExistsError,
            resolve_skill_dir_from_archive,
            safe_extract_skill_archive,
            scan_archive_preflight_or_raise,
        )
        from deerflow.skills.validation import _validate_skill_frontmatter

        if not path.is_file():
            if not path.exists():
                raise FileNotFoundError(f"Skill file not found: {archive_path}")
            raise ValueError(f"Path is not a file: {archive_path}")
        if path.suffix != ".skill":
            raise ValueError("File must have .skill extension")

        custom_dir.mkdir(parents=True, exist_ok=True)

        try:
            zf = zipfile.ZipFile(path, "r")
        except FileNotFoundError:
            raise FileNotFoundError(f"Skill file not found: {archive_path}") from None
        except (zipfile.BadZipFile, IsADirectoryError):
            raise ValueError("File is not a valid ZIP archive") from None

        with zf:
            scan_archive_preflight_or_raise(path, app_config=self._app_config)
            safe_extract_skill_archive(zf, tmp_path)

        skill_dir = resolve_skill_dir_from_archive(tmp_path)

        is_valid, message, skill_name = _validate_skill_frontmatter(skill_dir)
        if not is_valid:
            raise ValueError(f"Invalid skill: {message}")
        if not skill_name or "/" in skill_name or "\\" in skill_name or ".." in skill_name:
            raise ValueError(f"Invalid skill name: {skill_name}")

        # T7-7: resolve archive version from SKILL.md frontmatter
        from deerflow.skills.versions import version_to_dir_name

        skill_md_content = (skill_dir / SKILL_MD_FILE).read_text(encoding="utf-8")
        fm_version = self._extract_frontmatter_version(skill_md_content)
        install_version = fm_version if fm_version is not None else "0.1.0"
        version_dir = version_to_dir_name(install_version)

        target = custom_dir / skill_name / version_dir
        if target.exists():
            raise SkillAlreadyExistsError(f"Skill '{skill_name}' version {install_version} already exists")

        return skill_dir, skill_name, target

    def _commit_skill_install(self, skill_dir: Path, skill_name: str, custom_dir: Path, target: Path) -> None:
        from deerflow.skills.installer import _move_staged_skill_into_reserved_target

        with self._skill_projection_mutation():
            with tempfile.TemporaryDirectory(prefix=f".installing-{skill_name}-", dir=custom_dir) as staging_root:
                staging_target = Path(staging_root) / skill_name
                shutil.copytree(skill_dir, staging_target)
                _move_staged_skill_into_reserved_target(staging_target, target)
            make_skill_written_path_sandbox_readable(custom_dir, target)

    # ------------------------------------------------------------------
    # delete_custom_skill — removes entire <name>/ tree (all versions)
    # ------------------------------------------------------------------

    def delete_custom_skill(self, name: str, *, history_meta: dict | None = None) -> None:
        self.validate_skill_name(name)
        self.ensure_custom_skill_is_editable(name)
        # Delete the entire skill directory (all versions), not just the
        # current version subdirectory.
        target = self._get_custom_skill_base_dir(name)
        if history_meta is not None:
            prev_content = self.read_custom_skill(name)
            try:
                self.append_history(name, {**history_meta, "prev_content": prev_content})
            except OSError as e:
                if not isinstance(e, PermissionError) and e.errno not in {errno.EACCES, errno.EPERM, errno.EROFS}:
                    raise
                logger.warning(
                    "Skipping delete history write for custom skill %s due to readonly/permission failure; continuing with skill directory removal: %s",
                    name,
                    e,
                )
        removal = ((SkillCategory.CUSTOM, Path(name)),)
        with self._skill_projection_mutation(remove=removal):
            if target.exists():
                shutil.rmtree(target)

    # ------------------------------------------------------------------
    # Projection mutation context manager
    # ------------------------------------------------------------------

    def _skill_projection_mutation(
        self,
        *,
        remove: tuple[tuple[SkillCategory, Path], ...] = (),
        remove_names: tuple[str, ...] = (),
    ):
        if getattr(self, "user_id", None) is None:
            return nullcontext()
        from deerflow.skills.projection import skill_projection_mutation

        return skill_projection_mutation(self, "user", remove=remove, remove_names=remove_names)

    # ------------------------------------------------------------------
    # History
    # ------------------------------------------------------------------

    def append_history(self, name: str, record: dict) -> None:
        self.validate_skill_name(name)
        payload = {"ts": datetime.now(UTC).isoformat(), **record}
        history_path = self.get_skill_history_file(name)
        history_path.parent.mkdir(parents=True, exist_ok=True)
        with history_path.open("a", encoding="utf-8") as f:
            f.write(json.dumps(payload, ensure_ascii=False))
            f.write("\n")

    def read_history(self, name: str) -> list[dict]:
        self.validate_skill_name(name)
        history_path = self.get_skill_history_file(name)
        if not history_path.exists():
            return []
        records: list[dict] = []
        for line in history_path.read_text(encoding="utf-8").splitlines():
            if not line.strip():
                continue
            records.append(json.loads(line))
        return records
