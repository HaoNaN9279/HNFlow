"""User-scoped SkillStorage that isolates custom skills per user.

Custom skills are stored under ``{base_dir}/users/{user_id}/skills/custom/``
instead of the global ``{base_dir}/skills/custom/``. Public skills are still
read from the global ``{base_dir}/skills/public/`` (read-only).

T7-3 versioned layout::

    <host_root>/public/<name>/v<semver>/SKILL.md        ← global, read-only
    <user_custom_root>/<name>/v<semver>/SKILL.md        ← per-user, read-write
    <user_custom_root>/<name>/SKILL.md                  ← legacy fallback
    <integrations_root>/<provider>/<name>/v<semver>/SKILL.md  ← global, read-only
    <user_custom_root>/.history/<name>.jsonl             ← per-user history
    <user_skills_root>/_skill_states.json                ← per-user enabled state
    <global_custom_root>/<name>/SKILL.md                 ← legacy fallback, read-only

Fallback: when a user has no custom skills yet, global ``skills/custom/``
skills are yielded as ``SkillCategory.LEGACY`` (read-only) so they are
visible but cannot be edited/deleted by the user. This preserves backward
compatibility during migration without leaking mutable access to legacy
skills. Legacy skills are mounted at ``/mnt/skills/legacy/<name>/`` in
the sandbox so their supporting files (references, templates, scripts,
assets) are accessible to the agent.

Enabled/disabled state for CUSTOM and LEGACY skills is stored per-user in
``_skill_states.json`` (keyed by skill name). PUBLIC skill state remains
global in ``extensions_config.json``. This prevents cross-user bleed when
two users own same-named custom skills.
"""

from __future__ import annotations

import asyncio
import dataclasses
import errno
import json
import logging
import os
import shutil
import tempfile
from collections.abc import Iterable
from pathlib import Path

from deerflow.constants import DEFAULT_SKILLS_CONTAINER_PATH
from deerflow.skills.permissions import make_skill_written_path_sandbox_readable
from deerflow.skills.storage.local_skill_storage import (
    LocalSkillStorage,
    _iter_category_skill_files,
    _list_skill_dir_versions,
    _resolve_skill_dir_current_version,
)
from deerflow.skills.storage.skill_storage import SKILL_MD_FILE
from deerflow.skills.types import SkillCategory

logger = logging.getLogger(__name__)


class UserScopedSkillStorage(LocalSkillStorage):
    """Skill storage with per-user isolation for custom skills.

    Inherits all public-skill behaviour from :class:`LocalSkillStorage`
    (reading from ``_host_root/public/``). Custom-skill paths are
    redirected to ``_user_custom_root`` so each user's custom skills
    live in their own directory tree.

    Fallback: when the user's custom directory is empty and the global
    ``skills/custom/`` has content, those legacy skills are loaded as
    ``SkillCategory.LEGACY`` — they appear in listings but are treated
    as read-only (cannot be edited/deleted). This preserves backward
    compatibility during migration without giving users mutable access
    to other users' legacy skills.

    **Design note**: once a user creates their first custom skill, the
    per-user directory exists and the global custom fallback no longer
    applies — LEGACY skills disappear from that user's listing. This is
    intentional (shadow-mount semantics: the user's own directory
    shadows the global one).
    """

    def __init__(
        self,
        user_id: str,
        host_path: str | None = None,
        container_path: str = DEFAULT_SKILLS_CONTAINER_PATH,
        app_config=None,
    ) -> None:
        super().__init__(host_path=host_path, container_path=container_path, app_config=app_config)

        from deerflow.config.paths import _validate_user_id, get_paths

        self._user_id = _validate_user_id(user_id)
        paths = get_paths()
        self._paths = paths
        self._user_custom_root: Path = paths.user_custom_skills_dir(self._user_id)
        self._integrations_root: Path = paths.integration_skills_dir()
        self._user_skills_root: Path = paths.user_skills_dir(self._user_id)
        self._global_custom_root: Path = self._host_root / SkillCategory.CUSTOM.value
        self._skill_states_file: Path = self._user_skills_root / "_skill_states.json"

    # ------------------------------------------------------------------
    # Per-user skill enabled state (CUSTOM / LEGACY only)
    # ------------------------------------------------------------------

    def _read_skill_states(self) -> dict[str, dict[str, bool]]:
        """Read per-user skill enabled states from ``_skill_states.json``.

        Returns a dict keyed by skill name, each value being
        ``{"enabled": True/False}``.  Returns an empty dict if the file
        does not exist or is unreadable.
        """
        if not self._skill_states_file.exists():
            return {}
        try:
            with open(self._skill_states_file, encoding="utf-8") as f:
                data = json.load(f)
            if isinstance(data, dict):
                return data
        except (json.JSONDecodeError, OSError):
            logger.warning("Failed to read skill states file %s", self._skill_states_file)
        return {}

    def _write_skill_states(self, states: dict[str, dict[str, bool]]) -> None:
        """Persist per-user skill enabled states to ``_skill_states.json``.

        Atomic write via a temp file in the same directory followed by
        ``Path.replace`` (POSIX-atomic on the same filesystem). Without this,
        a crash/SIGTERM/disk-full mid-write would leave the file truncated
        or empty; ``_read_skill_states`` would then return ``{}`` and
        ``get_skill_enabled_state`` would silently re-enable every skill
        the user had disabled. Mirrors the pattern used by
        ``LocalSkillStorage.write_custom_skill`` in this same module.
        """
        self._user_skills_root.mkdir(parents=True, exist_ok=True)
        fd, tmp_path_str = tempfile.mkstemp(
            dir=str(self._user_skills_root),
            prefix=".skill_states_",
            suffix=".json.tmp",
        )
        tmp_path = Path(tmp_path_str)
        try:
            with os.fdopen(fd, "w", encoding="utf-8") as f:
                json.dump(states, f, indent=2)
            tmp_path.replace(self._skill_states_file)
        except Exception:
            # Best-effort cleanup of the temp file on failure.
            try:
                tmp_path.unlink(missing_ok=True)
            except OSError:
                pass
            raise

    def get_skill_enabled_state(self, skill_name: str) -> bool:
        """Return the enabled state for a custom/legacy skill.

        Default is ``True`` (newly created skills are enabled by default).
        """
        states = self._read_skill_states()
        entry = states.get(skill_name)
        if entry is None:
            return True
        return entry.get("enabled", True)

    def set_skill_enabled_state(self, skill_name: str, enabled: bool) -> None:
        """Set the enabled state for a custom/legacy skill and persist."""
        removal_names = (skill_name,) if not enabled else ()
        with self._skill_projection_mutation(remove_names=removal_names):
            states = self._read_skill_states()
            states[skill_name] = {"enabled": enabled}
            self._write_skill_states(states)

    # ------------------------------------------------------------------
    # Path helpers — redirect custom skill paths to user directory
    # ------------------------------------------------------------------

    def _get_custom_skill_base_dir(self, name: str) -> Path:
        """Return ``<user_custom_root>/<name>/`` without version subdir."""
        normalized_name = self.validate_skill_name(name)
        return self._user_custom_root / normalized_name

    def get_custom_skill_dir(self, name: str, version: str | None = None) -> Path:
        """Per-user version-aware custom skill directory.

        Redirects to ``_user_custom_root`` instead of the global custom root.
        """
        normalized_name = self.validate_skill_name(name)
        base_dir = self._user_custom_root / normalized_name
        if version is not None:
            from deerflow.skills.versions import parse_version, version_to_dir_name

            parsed = parse_version(version)
            return base_dir / version_to_dir_name(parsed)
        current = _resolve_skill_dir_current_version(base_dir)
        if current is not None:
            from deerflow.skills.versions import version_to_dir_name

            current_version_dir = base_dir / version_to_dir_name(current)
            if current_version_dir.exists() and current_version_dir.is_dir():
                return current_version_dir
            return base_dir
        return base_dir

    def get_custom_skill_file(self, name: str, version: str | None = None) -> Path:
        """Per-user version-aware custom SKILL.md path."""
        return self.get_custom_skill_dir(name, version=version) / SKILL_MD_FILE

    def list_skill_versions(self, name: str) -> list[str]:
        """Return sorted version strings for a per-user custom skill."""
        normalized_name = self.validate_skill_name(name)
        base_dir = self._user_custom_root / normalized_name
        return _list_skill_dir_versions(base_dir)

    def resolve_current_version(self, name: str) -> str | None:
        """Return the current version for a per-user custom skill."""
        normalized_name = self.validate_skill_name(name)
        base_dir = self._user_custom_root / normalized_name
        return _resolve_skill_dir_current_version(base_dir)

    def get_skill_history_file(self, name: str) -> Path:
        """Per-user custom skill history: ``<user_custom_root>/.history/<name>.jsonl``."""
        normalized_name = self.validate_skill_name(name)
        return self._user_custom_root / ".history" / f"{normalized_name}.jsonl"

    # ------------------------------------------------------------------
    # Enabled state — override to use per-user state for custom/legacy
    # ------------------------------------------------------------------

    def load_skills(self, *, enabled_only: bool = False) -> list:
        """Discover all skills and merge enabled state per isolation scope.

        Delegates skill discovery and PUBLIC enabled-state to
        :meth:`LocalSkillStorage.load_skills` (which reads from the
        overridden ``_iter_skill_files``).  Then overrides CUSTOM/LEGACY
        enabled state with per-user ``_skill_states.json`` so that two
        users each owning a same-named custom skill can toggle independently.

        Calling ``super().load_skills()`` preserves the full template-method
        flow (discover → global enabled-state merge → filter → sort) so
        that patching ``LocalSkillStorage.load_skills`` in tests still
        intercepts the call.
        """
        # Let the parent do full discovery + global enabled-state merge.
        # The overridden _iter_skill_files() routes custom reads to
        # _user_custom_root and legacy reads to _global_custom_root.
        skills = super().load_skills(enabled_only=False)

        # Override enabled state for CUSTOM / LEGACY with per-user state,
        # ANDed with the global extensions_config default. This preserves a
        # pre-upgrade global disable of a shared custom/legacy skill from
        # being silently re-enabled by an absent per-user entry, while still
        # letting the per-user state override the global default when both
        # are present. PUBLIC skill state remains governed solely by
        # extensions_config (handled by ``super().load_skills`` above). Re-read
        # from disk here too so another worker's update cannot be masked by
        # this process's singleton cache while rebuilding a user projection.
        from deerflow.config.extensions_config import ExtensionsConfig

        extensions_config = ExtensionsConfig.from_file()
        skills = [
            dataclasses.replace(s, enabled=self.get_skill_enabled_state(s.name) and extensions_config.is_skill_enabled(s.name, s.category.value if hasattr(s.category, "value") else s.category))
            if dataclasses.is_dataclass(s) and not isinstance(s, type) and (s.category.value if hasattr(s.category, "value") else s.category) != SkillCategory.PUBLIC.value
            else s
            for s in skills
        ]

        if enabled_only:
            skills = [s for s in skills if s.enabled]

        return skills

    # ------------------------------------------------------------------
    # Skill iteration — public from global, custom from user dir + fallback
    # ------------------------------------------------------------------

    def public_skill_exists(self, name: str) -> bool:
        """Check if a skill exists as public **or** as a global-custom fallback.

        The global ``skills/custom/`` directory contains legacy skills that
        are presented as ``SkillCategory.LEGACY`` to users who have no
        per-user custom skills yet. This override ensures those skills are
        recognised as "read-only" so ``ensure_custom_skill_is_editable``
        can give a helpful error message instead of ``FileNotFoundError``.
        """
        normalized_name = self.validate_skill_name(name)
        # Standard public check (version-aware)
        public_dir = self._host_root / SkillCategory.PUBLIC.value / normalized_name
        if _resolve_skill_dir_current_version(public_dir) is not None:
            return True
        # Global custom fallback check (legacy skills visible to all users)
        legacy_dir = self._global_custom_root / normalized_name
        if _resolve_skill_dir_current_version(legacy_dir) is not None:
            return True
        return False

    def ensure_custom_skill_is_editable(self, name: str) -> None:
        """Override to handle global-custom fallback skills gracefully.

        When a user tries to edit/delete a legacy global-custom skill (one
        that appears as ``SkillCategory.LEGACY`` due to fallback), we tell
        them to create their own version rather than raising a confusing
        ``FileNotFoundError``.
        """
        if self.custom_skill_exists(name):
            return
        # Check both public and global-custom fallback
        normalized_name = self.validate_skill_name(name)
        is_global_public = _resolve_skill_dir_current_version(self._host_root / SkillCategory.PUBLIC.value / normalized_name) is not None
        is_global_custom_fallback = _resolve_skill_dir_current_version(self._global_custom_root / normalized_name) is not None
        if is_global_public:
            raise ValueError(f"'{name}' is a built-in skill. Use the skill_manage tool to create your own version — it will shadow the built-in one.")
        is_integration = any((candidate / SKILL_MD_FILE).exists() for candidate in self._integrations_root.glob(f"*/{normalized_name}") if candidate.is_dir())
        if is_global_custom_fallback:
            raise ValueError(f"'{name}' is a legacy shared skill (not editable). To customise it, create your own version with the same name — it will shadow the shared one.")
        if is_integration:
            raise ValueError(f"'{name}' is a managed integration skill and cannot be edited. Create a custom skill with another name if you need a modified workflow.")
        raise FileNotFoundError(f"Custom skill '{name}' not found.")

    def _iter_skill_files(self) -> Iterable[tuple[SkillCategory, Path, Path]]:
        # 1. Public skills: always from global root (version-aware)
        public_path = self._host_root / SkillCategory.PUBLIC.value
        for _name_dir, skill_md_path in _iter_category_skill_files(public_path):
            yield SkillCategory.PUBLIC, public_path, skill_md_path

        # 2. Managed integration skills: globally installed, read-only. Their
        # enabled state is still merged from this user's _skill_states.json.
        integration_path = self._integrations_root
        if integration_path.exists() and integration_path.is_dir():
            for current_root, dir_names, file_names in os.walk(integration_path, followlinks=True):
                dir_names[:] = sorted(name for name in dir_names if not name.startswith("."))
                if SKILL_MD_FILE not in file_names:
                    continue
                yield SkillCategory.INTEGRATION, integration_path, Path(current_root) / SKILL_MD_FILE

        # 3. Custom skills: prefer user-level directory (version-aware)
        user_custom_exists = False
        user_custom_path = self._user_custom_root
        if user_custom_path.exists() and user_custom_path.is_dir():
            for _name_dir, skill_md_path in _iter_category_skill_files(user_custom_path):
                user_custom_exists = True
                yield SkillCategory.CUSTOM, user_custom_path, skill_md_path

        # 4. Fallback: if user has no custom skills, load from global custom
        #    as LEGACY (read-only) so legacy skills are visible but not
        #    editable/deletable by the user. LEGACY skills are mounted at
        #    /mnt/skills/legacy/<name>/ in the sandbox so their supporting
        #    files (references, templates, scripts, assets) are accessible.
        if not user_custom_exists:
            global_custom_path = self._global_custom_root
            for _name_dir, skill_md_path in _iter_category_skill_files(global_custom_path):
                yield SkillCategory.LEGACY, global_custom_path, skill_md_path

    # ------------------------------------------------------------------
    # Install — redirect custom_dir to user directory
    # ------------------------------------------------------------------

    async def ainstall_skill_from_archive(self, archive_path: str | Path) -> dict:
        from deerflow.skills.installer import _scan_skill_archive_contents_or_raise

        logger.info("Installing skill from %s for user %s", archive_path, self._user_id)
        path = Path(archive_path)
        custom_dir = self._user_custom_root

        # Ensure user custom directory exists
        custom_dir.mkdir(parents=True, exist_ok=True)

        # The per-file security scan is an async LLM call and must stay on the
        # event loop; every filesystem phase around it runs in a worker thread.
        tmp = await asyncio.to_thread(tempfile.mkdtemp)
        try:
            skill_dir, skill_name, target = await asyncio.to_thread(self._prepare_skill_archive, path, Path(tmp), custom_dir, archive_path)

            await _scan_skill_archive_contents_or_raise(skill_dir, skill_name)

            skill_id = await asyncio.to_thread(self._commit_skill_install, skill_dir, skill_name, custom_dir, target)
            logger.info("Skill %r installed to %s for user %s", skill_name, target, self._user_id)
        finally:
            try:
                await asyncio.wait_for(
                    asyncio.to_thread(self._cleanup_install_tmp, tmp),
                    timeout=5.0,
                )
            except TimeoutError:
                logger.warning("Timed out cleaning up skill install temp dir %s", tmp)

        return {
            "success": True,
            "skill_name": skill_name,
            "skill_id": skill_id,
            "message": f"Skill '{skill_name}' installed successfully for user '{self._user_id}'",
        }

    # ------------------------------------------------------------------
    # Write — ensure user custom dir exists before writing
    # ------------------------------------------------------------------

    def write_custom_skill(self, name: str, relative_path: str, content: str, *, version: str | None = None) -> str:
        # Ensure user custom skills directory exists
        self._user_custom_root.mkdir(parents=True, exist_ok=True)
        normalized_name = self.validate_skill_name(name)
        base_dir = self._user_custom_root / normalized_name

        # Reuse the version resolution and bump logic from parent
        from deerflow.skills.versions import version_to_dir_name

        # 1. Determine target version
        target_version = self._resolve_write_target_version(base_dir, normalized_name, relative_path, content, version)

        is_skill_md = relative_path == SKILL_MD_FILE or relative_path.endswith(f"/{SKILL_MD_FILE}")

        # 2. Bump to an unused version directory — every write creates a new
        #    version (immutable versioning).
        if is_skill_md:
            target_version = self._ensure_version_available(base_dir, target_version)
        else:
            if version is not None:
                target_version = self._ensure_version_available(base_dir, target_version)
            else:
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
    # delete — removes entire <name>/ tree
    # ------------------------------------------------------------------

    def delete_custom_skill(self, name: str, *, history_meta: dict | None = None) -> None:
        self.validate_skill_name(name)
        self.ensure_custom_skill_is_editable(name)
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
    # Public helpers
    # ------------------------------------------------------------------

    @property
    def user_id(self) -> str:
        """The user ID this storage is scoped to."""
        return self._user_id

    def get_user_custom_root(self) -> Path:
        """Host path to this user's custom skills root directory."""
        return self._user_custom_root

    def get_integrations_root(self) -> Path:
        """Host path to the global managed integration skills root directory."""
        return self._integrations_root

    def get_user_integrations_root(self) -> Path:
        """Compatibility alias for :meth:`get_integrations_root`."""
        return self.get_integrations_root()

    # ------------------------------------------------------------------
    # Path validation — accept public, per-user custom, and integration roots
    # ------------------------------------------------------------------

    def validate_skill_file_path(self, skill_file: Path) -> Path:
        """Accept files under the public, per-user custom, or integration root.

        Custom and managed integration skills live outside ``_host_root``, so
        the default implementation's single-root check would reject them.
        """
        resolved_file = skill_file.resolve()
        allowed_roots = (
            self._host_root.resolve(),
            self._user_custom_root.resolve(),
            self._integrations_root.resolve(),
        )
        for allowed_root in allowed_roots:
            try:
                resolved_file.relative_to(allowed_root)
                return resolved_file
            except ValueError:
                continue
        raise ValueError(
            f"Resolved skill file {resolved_file} must stay within the global skills root "
            f"({self._host_root.resolve()}), the per-user custom root "
            f"({self._user_custom_root.resolve()}), or the managed integration skills root "
            f"({self._integrations_root.resolve()})."
        )
