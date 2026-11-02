import hashlib
import logging
import os
import re
import shutil
from dataclasses import dataclass
from pathlib import Path, PureWindowsPath

from deerflow.config.runtime_paths import runtime_home
from deerflow.utils.thread_id import validate_thread_id

# Virtual path prefix seen by agents inside the sandbox
VIRTUAL_PATH_PREFIX = "/mnt/user-data"

_SAFE_USER_ID_RE = re.compile(r"^[A-Za-z0-9_\-]+$")
_SAFE_INTEGRATION_ID_RE = re.compile(r"^[A-Za-z0-9_.\-]+$")
_UNSAFE_USER_ID_CHAR_RE = re.compile(r"[^A-Za-z0-9_\-]")
_SAFE_USER_ID_DIGEST_HEX_LEN = 16

logger = logging.getLogger(__name__)


def _default_local_base_dir() -> Path:
    """Return the caller project's writable DeerFlow state directory."""
    return runtime_home()


def _validate_thread_id(thread_id: str) -> str:
    """Validate a thread ID before using it in filesystem paths."""
    return validate_thread_id(thread_id)


def _validate_user_id(user_id: str) -> str:
    """Validate a user ID before using it in filesystem paths."""
    if not _SAFE_USER_ID_RE.match(user_id):
        raise ValueError(f"Invalid user_id {user_id!r}: only alphanumeric characters, hyphens, and underscores are allowed.")
    return user_id


def _validate_integration_id(integration_id: str) -> str:
    """Validate an integration ID before using it in filesystem paths."""
    if not _SAFE_INTEGRATION_ID_RE.match(integration_id):
        raise ValueError(f"Invalid integration_id {integration_id!r}: only alphanumeric characters, dots, hyphens, and underscores are allowed.")
    # The charset allows dots for names like ``some.integration``; reject the
    # bare ``.``/``..`` path components so a future caller cannot escape the
    # per-integration namespace via ``_join_host_path(..., integration_id, ...)``.
    if integration_id in {".", ".."}:
        raise ValueError(f"Invalid integration_id {integration_id!r}: '.' and '..' are not allowed.")
    return integration_id


def make_safe_user_id(raw: str) -> str:
    """Normalize an external identity into the user-id charset (``[A-Za-z0-9_-]``).

    IM channel ids (Feishu/Slack/Telegram) may contain characters that
    :func:`_validate_user_id` rejects. Already-safe ids pass through unchanged;
    lossy ones get a short digest suffix so two distinct inputs never share a
    storage bucket.
    """
    if not raw:
        raise ValueError("user_id must be a non-empty string.")
    sanitized = _UNSAFE_USER_ID_CHAR_RE.sub("-", raw)
    if sanitized == raw:
        return raw
    digest = hashlib.sha256(raw.encode("utf-8")).hexdigest()[:_SAFE_USER_ID_DIGEST_HEX_LEN]
    return f"{sanitized}-{digest}"


def _legacy_safe_user_id(raw: str, sanitized: str) -> str:
    """Bucket name produced by the previous (SHA-1) digest revision for ``raw``."""
    digest = hashlib.sha1(raw.encode("utf-8"), usedforsecurity=False).hexdigest()[:_SAFE_USER_ID_DIGEST_HEX_LEN]
    return f"{sanitized}-{digest}"


def _join_host_path(base: str, *parts: str) -> str:
    """Join host filesystem path segments while preserving native style.

    Docker Desktop on Windows expects bind mount sources to stay in Windows
    path form (for example ``C:\\repo\\backend\\.deer-flow``).  Using
    ``Path(base) / ...`` on a POSIX host can accidentally rewrite those paths
    with mixed separators, so this helper preserves the original style.
    """
    if not parts:
        return base

    if re.match(r"^[A-Za-z]:[\\/]", base) or base.startswith("\\\\") or "\\" in base:
        result = PureWindowsPath(base)
        for part in parts:
            result /= part
        return str(result)

    result = Path(base)
    for part in parts:
        result /= part
    return str(result)


def join_host_path(base: str, *parts: str) -> str:
    """Join host filesystem path segments while preserving native style."""
    return _join_host_path(base, *parts)


# ── N11 data-directory model ─────────────────────────────────────────────────

#: Whose data a directory holds.
SCOPE_GLOBAL = "global"
SCOPE_PER_USER = "per-user"

DATA_DIR_SCOPES: frozenset[str] = frozenset({SCOPE_GLOBAL, SCOPE_PER_USER})


@dataclass(frozen=True)
class DataDir:
    """One directory in the single-machine data layout (N11, plan §22).

    ``required`` means "this application must be able to use it" — it drives
    :meth:`Paths.ensure_data_dirs`, so an optional directory is never created
    speculatively.  ``purpose`` is a human sentence, because the point of the
    layout is that an operator can read it and know what a directory is for.
    """

    name: str
    path: Path
    purpose: str = ""
    scope: str = SCOPE_GLOBAL
    required: bool = True

    def __post_init__(self) -> None:
        if self.scope not in DATA_DIR_SCOPES:
            raise ValueError(f"unknown data-dir scope {self.scope!r}; expected one of {sorted(DATA_DIR_SCOPES)}")

    def to_dict(self) -> dict[str, object]:
        return {"name": self.name, "path": str(self.path), "purpose": self.purpose, "scope": self.scope, "required": self.required}


@dataclass(frozen=True)
class DataDirStatus:
    """What :meth:`Paths.check_data_dirs` observed about one directory.

    ``writable`` is three-valued: ``True``/``False`` are answers, ``None`` means
    the directory does not exist (or could not be judged), which is not the same
    as "not writable".
    """

    name: str
    path: Path
    purpose: str = ""
    scope: str = SCOPE_GLOBAL
    required: bool = True
    exists: bool = False
    writable: bool | None = None

    @property
    def ok(self) -> bool:
        """Whether this directory is usable as it stands."""
        return self.exists and self.writable is not False

    @property
    def problem(self) -> str:
        """Empty when fine; otherwise the shortest honest description."""
        if not self.exists:
            return "does not exist"
        if self.writable is False:
            return "not writable"
        return ""

    def to_dict(self) -> dict[str, object]:
        return {
            "name": self.name,
            "path": str(self.path),
            "purpose": self.purpose,
            "scope": self.scope,
            "required": self.required,
            "exists": self.exists,
            "writable": self.writable,
            "ok": self.ok,
            "problem": self.problem,
        }


def missing_required_data_dirs(statuses: list[DataDirStatus]) -> list[DataDirStatus]:
    """The required directories that are unusable — what a startup gate keys on."""
    return [status for status in statuses if status.required and not status.ok]


class Paths:
    """
    Centralized path configuration for DeerFlow application data.

    Directory layout (host side):
        {base_dir}/
        ├── memory.json
        ├── USER.md          <-- global user profile (injected into all agents)
        ├── agents/
        │   └── {agent_name}/
        │       ├── config.yaml
        │       ├── SOUL.md  <-- agent personality/identity (injected alongside lead prompt)
        │       └── memory.json
        └── threads/
            └── {thread_id}/
                └── user-data/         <-- mounted as /mnt/user-data/ inside sandbox
                    ├── workspace/     <-- /mnt/user-data/workspace/
                    ├── uploads/       <-- /mnt/user-data/uploads/
                    └── outputs/       <-- /mnt/user-data/outputs/

    BaseDir resolution (in priority order):
        1. Constructor argument `base_dir`
        2. DEER_FLOW_HOME environment variable
        3. Caller project fallback: `{project_root}/.deer-flow`

    Single-machine data layout (N11, dev plan §22): :meth:`data_dirs` is the
    canonical, ordered list of the host directories this layout owns, with what
    each one is for.  §22 names four kinds of data (definitions / checkpoints /
    assets / app sessions); in this build three of them are **rows in the SQL
    database**, not directories — the mapping is stated in
    :meth:`data_dirs`'s docstring so an operator backing up a machine knows
    exactly which paths plus which database file constitute a complete copy.
    """

    def __init__(self, base_dir: str | Path | None = None) -> None:
        self._base_dir = Path(base_dir).resolve() if base_dir is not None else None

    @property
    def host_base_dir(self) -> Path:
        """Host-visible base dir for Docker volume mount sources.

        When running inside Docker with a mounted Docker socket (DooD), the Docker
        daemon runs on the host and resolves mount paths against the host filesystem.
        Set DEER_FLOW_HOST_BASE_DIR to the host-side path that corresponds to this
        container's base_dir so that sandbox container volume mounts work correctly.

        Falls back to base_dir when the env var is not set (native/local execution).
        """
        if env := os.getenv("DEER_FLOW_HOST_BASE_DIR"):
            return Path(env)
        return self.base_dir

    def _host_base_dir_str(self) -> str:
        """Return the host base dir as a raw string for bind mounts."""
        if env := os.getenv("DEER_FLOW_HOST_BASE_DIR"):
            return env
        return str(self.base_dir)

    @property
    def base_dir(self) -> Path:
        """Root directory for all application data."""
        if self._base_dir is not None:
            return self._base_dir

        if env_home := os.getenv("DEER_FLOW_HOME"):
            return Path(env_home).resolve()

        return _default_local_base_dir()

    @property
    def memory_file(self) -> Path:
        """Path to the persisted memory file: `{base_dir}/memory.json`."""
        return self.base_dir / "memory.json"

    @property
    def user_md_file(self) -> Path:
        """Path to the global user profile file: `{base_dir}/USER.md`."""
        return self.base_dir / "USER.md"

    @property
    def config_file(self) -> Path:
        """Primary application config: `{base_dir}/config.yaml`."""
        return self.base_dir / "config.yaml"

    @property
    def extensions_config_file(self) -> Path:
        """MCP/skills extension config: `{base_dir}/extensions_config.json`."""
        return self.base_dir / "extensions_config.json"

    @property
    def env_file(self) -> Path:
        """Environment/secret file: `{base_dir}/.env`."""
        return self.base_dir / ".env"

    @property
    def prompts_dir(self) -> Path:
        """User-editable prompt root: `{base_dir}/prompts/`."""
        return self.base_dir / "prompts"

    @property
    def lead_agent_prompt_file(self) -> Path:
        """Canonical Lead Agent prompt: `{base_dir}/prompts/lead-agent.md`."""
        return self.prompts_dir / "lead-agent.md"

    @property
    def legacy_soul_file(self) -> Path:
        """Pre-prompt-directory Lead Agent prompt: `{base_dir}/SOUL.md`."""
        return self.base_dir / "SOUL.md"

    @property
    def capability_groups_dir(self) -> Path:
        """User-editable capability groups: `{base_dir}/capability-groups/`."""
        return self.base_dir / "capability-groups"

    @property
    def tool_packages_dir(self) -> Path:
        """User-editable tool packages: `{base_dir}/tools/`."""
        return self.base_dir / "tools"

    @property
    def skills_dir(self) -> Path:
        """User-editable skills root: `{base_dir}/skills/`."""
        return self.base_dir / "skills"

    @property
    def backups_dir(self) -> Path:
        """Configuration/data backup root: `{base_dir}/backups/`."""
        return self.base_dir / "backups"

    @property
    def agents_dir(self) -> Path:
        """Legacy root for shared (pre user-isolation) custom agents: `{base_dir}/agents/`.

        New code should use :meth:`user_agents_dir` instead. This property remains
        only as a read-side fallback for installations that pre-date user isolation.
        """
        return self.base_dir / "agents"

    def agent_dir(self, name: str) -> Path:
        """Legacy per-agent directory (no user isolation): `{base_dir}/agents/{name}/`."""
        return self.agents_dir / name.lower()

    def agent_memory_file(self, name: str) -> Path:
        """Legacy per-agent memory file: `{base_dir}/agents/{name}/memory.json`."""
        return self.agent_dir(name) / "memory.json"

    def user_dir(self, user_id: str) -> Path:
        """Directory for a specific user: `{base_dir}/users/{user_id}/`."""
        return self.base_dir / "users" / _validate_user_id(user_id)

    def prepare_user_dir_for_raw_id(self, raw_user_id: str) -> str:
        """Return the safe user ID and migrate this ID's legacy unsafe-id bucket.

        A previous branch revision used SHA-1 for unsafe external user IDs.
        New IDs use SHA-256; the legacy bucket name is recomputed from the same
        raw ID, so only this user's own old bucket can ever be moved — a
        different raw ID sharing the sanitized prefix produces a different
        legacy digest and is never touched.
        """
        safe_user_id = make_safe_user_id(raw_user_id)
        sanitized = _UNSAFE_USER_ID_CHAR_RE.sub("-", raw_user_id)
        if safe_user_id == raw_user_id:
            return safe_user_id

        users_dir = self.base_dir / "users"
        target_dir = users_dir / safe_user_id
        legacy_dir = users_dir / _legacy_safe_user_id(raw_user_id, sanitized)
        try:
            if target_dir.exists() or not legacy_dir.is_dir():
                return safe_user_id
            legacy_dir.rename(target_dir)
            logger.info("Migrated legacy unsafe-id user directory to the current digest format")
        except OSError:
            logger.exception("Failed to migrate legacy unsafe-id user directory")
        return safe_user_id

    def user_memory_file(self, user_id: str) -> Path:
        """Per-user memory file: `{base_dir}/users/{user_id}/memory.json`."""
        return self.user_dir(user_id) / "memory.json"

    def user_agents_dir(self, user_id: str) -> Path:
        """Per-user root for that user's custom agents: `{base_dir}/users/{user_id}/agents/`."""
        return self.user_dir(user_id) / "agents"

    def user_agent_dir(self, user_id: str, agent_name: str) -> Path:
        """Per-user per-agent directory: `{base_dir}/users/{user_id}/agents/{name}/`."""
        return self.user_agents_dir(user_id) / agent_name.lower()

    def user_agent_memory_file(self, user_id: str, agent_name: str) -> Path:
        """Per-user per-agent memory: `{base_dir}/users/{user_id}/agents/{name}/memory.json`."""
        return self.user_agent_dir(user_id, agent_name) / "memory.json"

    def user_skills_dir(self, user_id: str) -> Path:
        """Per-user root for that user's custom skills: `{base_dir}/users/{user_id}/skills/`."""
        return self.user_dir(user_id) / "skills"

    def user_custom_skills_dir(self, user_id: str) -> Path:
        """Per-user custom skills directory: `{base_dir}/users/{user_id}/skills/custom/`.

        This is the user-scoped replacement for the global ``{base_dir}/skills/custom/``
        directory. Custom skills are written here; public skills remain under the
        global ``{base_dir}/skills/public/`` (read-only).
        """
        return self.user_skills_dir(user_id) / "custom"

    def integration_skills_dir(self) -> Path:
        """Globally installed managed integration skills.

        Layout: ``{base_dir}/integrations/skills/{provider}/{skill}/``. The
        package contents are shared and read-only; credentials and enabled
        state remain user-scoped elsewhere under ``users/{user_id}``.
        """
        return self.base_dir / "integrations" / "skills"

    @property
    def skills_view_dir(self) -> Path:
        """Global sandbox-visible skills projection: ``{base_dir}/skills_view/``."""
        return self.base_dir / "skills_view"

    @property
    def public_skills_view_dir(self) -> Path:
        """Enabled public skills exposed to sandboxes."""
        return self.skills_view_dir / "public"

    def user_skills_view_dir(self, user_id: str) -> Path:
        """Per-user sandbox-visible skills projection root."""
        return self.user_dir(user_id) / "skills_view"

    def user_custom_skills_view_dir(self, user_id: str) -> Path:
        """Enabled custom skills exposed to one user's sandboxes."""
        return self.user_skills_view_dir(user_id) / "custom"

    def user_legacy_skills_view_dir(self, user_id: str) -> Path:
        """Enabled legacy skills exposed to one user's sandboxes."""
        return self.user_skills_view_dir(user_id) / "legacy"

    def user_integration_skills_view_dir(self, user_id: str) -> Path:
        """Enabled managed integration skills exposed to one user's sandboxes."""
        return self.user_skills_view_dir(user_id) / "integrations"

    def thread_dir(self, thread_id: str, *, user_id: str | None = None) -> Path:
        """
        Host path for a thread's data.

        When *user_id* is provided:
            `{base_dir}/users/{user_id}/threads/{thread_id}/`
        Otherwise (legacy layout):
            `{base_dir}/threads/{thread_id}/`

        This directory contains a `user-data/` subdirectory that is mounted
        as `/mnt/user-data/` inside the sandbox.

        Raises:
            ValueError: If `thread_id` or `user_id` contains unsafe characters (path
                        separators or `..`) that could cause directory traversal.
        """
        if user_id is not None:
            return self.user_dir(user_id) / "threads" / _validate_thread_id(thread_id)
        return self.base_dir / "threads" / _validate_thread_id(thread_id)

    def sandbox_work_dir(self, thread_id: str, *, user_id: str | None = None) -> Path:
        """
        Host path for the agent's workspace directory.
        Host: `{base_dir}/threads/{thread_id}/user-data/workspace/`
        Sandbox: `/mnt/user-data/workspace/`
        """
        return self.thread_dir(thread_id, user_id=user_id) / "user-data" / "workspace"

    def sandbox_uploads_dir(self, thread_id: str, *, user_id: str | None = None) -> Path:
        """
        Host path for user-uploaded files.
        Host: `{base_dir}/threads/{thread_id}/user-data/uploads/`
        Sandbox: `/mnt/user-data/uploads/`
        """
        return self.thread_dir(thread_id, user_id=user_id) / "user-data" / "uploads"

    def sandbox_outputs_dir(self, thread_id: str, *, user_id: str | None = None) -> Path:
        """
        Host path for agent-generated artifacts.
        Host: `{base_dir}/threads/{thread_id}/user-data/outputs/`
        Sandbox: `/mnt/user-data/outputs/`
        """
        return self.thread_dir(thread_id, user_id=user_id) / "user-data" / "outputs"

    def acp_workspace_dir(self, thread_id: str, *, user_id: str | None = None) -> Path:
        """
        Host path for the ACP workspace of a specific thread.
        Host: `{base_dir}/threads/{thread_id}/acp-workspace/`
        Sandbox: `/mnt/acp-workspace/`

        Each thread gets its own isolated ACP workspace so that concurrent
        sessions cannot read each other's ACP agent outputs.
        """
        return self.thread_dir(thread_id, user_id=user_id) / "acp-workspace"

    def sandbox_user_data_dir(self, thread_id: str, *, user_id: str | None = None) -> Path:
        """
        Host path for the user-data root.
        Host: `{base_dir}/threads/{thread_id}/user-data/`
        Sandbox: `/mnt/user-data/`
        """
        return self.thread_dir(thread_id, user_id=user_id) / "user-data"

    def host_thread_dir(self, thread_id: str, *, user_id: str | None = None) -> str:
        """Host path for a thread directory, preserving Windows path syntax."""
        if user_id is not None:
            return _join_host_path(self._host_base_dir_str(), "users", _validate_user_id(user_id), "threads", _validate_thread_id(thread_id))
        return _join_host_path(self._host_base_dir_str(), "threads", _validate_thread_id(thread_id))

    def host_sandbox_user_data_dir(self, thread_id: str, *, user_id: str | None = None) -> str:
        """Host path for a thread's user-data root."""
        return _join_host_path(self.host_thread_dir(thread_id, user_id=user_id), "user-data")

    def host_sandbox_work_dir(self, thread_id: str, *, user_id: str | None = None) -> str:
        """Host path for the workspace mount source."""
        return _join_host_path(self.host_sandbox_user_data_dir(thread_id, user_id=user_id), "workspace")

    def host_sandbox_uploads_dir(self, thread_id: str, *, user_id: str | None = None) -> str:
        """Host path for the uploads mount source."""
        return _join_host_path(self.host_sandbox_user_data_dir(thread_id, user_id=user_id), "uploads")

    def host_sandbox_outputs_dir(self, thread_id: str, *, user_id: str | None = None) -> str:
        """Host path for the outputs mount source."""
        return _join_host_path(self.host_sandbox_user_data_dir(thread_id, user_id=user_id), "outputs")

    def host_acp_workspace_dir(self, thread_id: str, *, user_id: str | None = None) -> str:
        """Host path for the ACP workspace mount source."""
        return _join_host_path(self.host_thread_dir(thread_id, user_id=user_id), "acp-workspace")

    def host_user_custom_skills_dir(self, user_id: str) -> str:
        """Host path for a user's custom skills directory, preserving Windows path syntax."""
        return _join_host_path(self._host_base_dir_str(), "users", _validate_user_id(user_id), "skills", "custom")

    def host_integration_skills_dir(self) -> str:
        """Host path for globally installed managed integration skills."""
        return _join_host_path(self._host_base_dir_str(), "integrations", "skills")

    def host_user_integration_config_dir(self, user_id: str, integration_id: str) -> str:
        """Host path for a user's managed integration runtime config directory."""
        return _join_host_path(self._host_base_dir_str(), "users", _validate_user_id(user_id), "integrations", _validate_integration_id(integration_id), "config")

    def host_user_integration_data_dir(self, user_id: str, integration_id: str) -> str:
        """Host path for a user's managed integration runtime data directory."""
        return _join_host_path(self._host_base_dir_str(), "users", _validate_user_id(user_id), "integrations", _validate_integration_id(integration_id), "data")

    def ensure_thread_dirs(self, thread_id: str, *, user_id: str | None = None) -> None:
        """Create all standard sandbox directories for a thread.

        Directories are created with mode 0o777 so that sandbox containers
        (which may run as a different UID than the host backend process) can
        write to the volume-mounted paths without "Permission denied" errors.
        The explicit chmod() call is necessary because Path.mkdir(mode=...) is
        subject to the process umask and may not yield the intended permissions.

        Includes the ACP workspace directory so it can be volume-mounted into
        the sandbox container at ``/mnt/acp-workspace`` even before the first
        ACP agent invocation.
        """
        for d in [
            self.sandbox_work_dir(thread_id, user_id=user_id),
            self.sandbox_uploads_dir(thread_id, user_id=user_id),
            self.sandbox_outputs_dir(thread_id, user_id=user_id),
            self.acp_workspace_dir(thread_id, user_id=user_id),
        ]:
            d.mkdir(parents=True, exist_ok=True)
            d.chmod(0o777)

    def delete_thread_dir(self, thread_id: str, *, user_id: str | None = None) -> None:
        """Delete all persisted data for a thread.

        The operation is idempotent: missing thread directories are ignored.
        """
        thread_dir = self.thread_dir(thread_id, user_id=user_id)
        if thread_dir.exists():
            shutil.rmtree(thread_dir)

    # ── N11 data-directory convention ────────────────────────────────────────

    def data_dirs(
        self,
        *,
        memory_enabled: bool = True,
        database_dir: str | Path | None = None,
    ) -> list[DataDir]:
        """The canonical single-machine data layout (N11, plan §22).

        Returns the ordered list of host directories this layout owns, each with
        what it is for.  The list is the **specification**: the paths themselves
        are the existing :class:`Paths` accessors, unchanged — this method only
        names them in one place so a report, a startup check and (in N11b) a
        backup can agree on what "the data directory" means.

        Where §22's four kinds of data actually live in this build:

        - **definitions** → ``workflow_definitions`` rows in the SQL database.
        - **checkpoints** → LangGraph checkpoint tables in the same database.
        - **assets** → operator-owned paths listed in ``assets.roots`` (never
          DeerFlow's own directory; an empty allow-list means no host assets).
        - **app sessions** → ``app_instances`` rows in the same database, plus
          the live in-process instances.

        so ``database`` (when a file-backed SQLite is configured) is part of the
        answer even though it is not a subdirectory of ``base_dir``.

        ``required`` is derived from the caller's configuration rather than
        hard-coded: with memory disabled the derived retrieval index is not part
        of the layout, and with no file database there is no database directory.
        ``threads`` is the legacy pre-user-isolation layout and is never created
        by this application, so it is listed but not required.
        """

        base = self.base_dir
        dirs = [
            DataDir(
                name="base",
                path=base,
                purpose="Application data root (DEER_FLOW_HOME); holds memory.json, USER.md and the directories below.",
                required=True,
            ),
            DataDir(
                name="users",
                path=base / "users",
                purpose="Per-user isolation buckets: {user_id}/threads/{thread_id}/user-data/{workspace,uploads,outputs}, agents/, skills/, integrations/.",
                scope=SCOPE_PER_USER,
                required=True,
            ),
            DataDir(
                name="skills_view",
                path=self.skills_view_dir,
                purpose="Enabled-only skill projections that sandboxes bind-mount (public + per-user custom/legacy/integrations).",
                required=True,
            ),
            DataDir(
                name="integrations",
                path=self.integration_skills_dir(),
                purpose="Globally installed managed integration skill packages (read-only; credentials stay per-user).",
                required=True,
            ),
            DataDir(
                name="prompts",
                path=self.prompts_dir,
                purpose="User-editable agent prompts (Lead Agent identity and behavior).",
                required=True,
            ),
            DataDir(
                name="capability-groups",
                path=self.capability_groups_dir,
                purpose="External capability-group repository (clone or symlink); HNFlow reads it but never seeds or owns it.",
                required=False,
            ),
            DataDir(
                name="tools",
                path=self.tool_packages_dir,
                purpose="External custom tool-package repository (clone or symlink); HNFlow reads it but never seeds or owns it.",
                required=False,
            ),
            DataDir(
                name="skills",
                path=self.skills_dir,
                purpose="User-editable skills root (public defaults and custom packages).",
                required=False,
            ),
            DataDir(
                name="backups",
                path=self.backups_dir,
                purpose="Config and data backups created by setup/config-upgrade.",
                required=False,
            ),
            DataDir(
                name="locks",
                path=base / "locks",
                purpose="Cross-process file locks (N8 resource_lock / acquire_many).",
                required=True,
            ),
            DataDir(
                name="undo",
                path=base / "undo",
                purpose="N10 compensation backups ({run_id}/{node_id}/) — engine-private recovery material, deliberately outside assets.roots.",
                required=True,
            ),
        ]

        if memory_enabled:
            dirs.append(
                DataDir(
                    name="retrieval",
                    path=base / ".retrieval",
                    purpose="Derived memory retrieval index (rebuildable; safe to delete).",
                    required=False,
                )
            )

        if database_dir is not None:
            dirs.append(
                DataDir(
                    name="database",
                    path=Path(database_dir),
                    purpose="SQLite database directory: workflow definitions, checkpoints, app instances, runs, human tasks and undo records all live in <dir>/deerflow.db.",
                    required=True,
                )
            )

        dirs.append(
            DataDir(
                name="threads",
                path=base / "threads",
                purpose="Legacy (pre user-isolation) thread directories. Listed for completeness; never created or repaired here.",
                required=False,
            )
        )
        return dirs

    def check_data_dirs(
        self,
        *,
        memory_enabled: bool = True,
        database_dir: str | Path | None = None,
    ) -> list[DataDirStatus]:
        """Report existence and writability for every layout directory.

        **Read-only**: nothing is created and nothing is touched.  A missing
        directory is reported as such; ``writable`` is ``None`` for a missing
        directory (we cannot judge a directory that is not there) and never a
        guess.
        """
        statuses: list[DataDirStatus] = []
        for entry in self.data_dirs(memory_enabled=memory_enabled, database_dir=database_dir):
            try:
                exists = entry.path.is_dir()
            except OSError:
                exists = False
            writable: bool | None = None
            if exists:
                try:
                    writable = os.access(entry.path, os.W_OK)
                except OSError:
                    writable = None
            statuses.append(
                DataDirStatus(
                    name=entry.name,
                    path=entry.path,
                    purpose=entry.purpose,
                    scope=entry.scope,
                    required=entry.required,
                    exists=exists,
                    writable=writable,
                )
            )
        return statuses

    def ensure_data_dirs(
        self,
        *,
        memory_enabled: bool = True,
        database_dir: str | Path | None = None,
    ) -> list[Path]:
        """Create the **required** layout directories; idempotent.

        Only directories this application owns are created, and only the required
        ones — a non-required entry (the derived retrieval index, the legacy
        threads root) is left alone so a fresh install does not sprout directories
        that nothing is going to use.  Failures propagate: a data root that cannot
        be created is a real startup problem, not a warning.
        """
        created: list[Path] = []
        for entry in self.data_dirs(memory_enabled=memory_enabled, database_dir=database_dir):
            if not entry.required:
                continue
            entry.path.mkdir(parents=True, exist_ok=True)
            created.append(entry.path)
        return created

    def resolve_virtual_path(self, thread_id: str, virtual_path: str, *, user_id: str | None = None) -> Path:
        """Resolve a sandbox virtual path to the actual host filesystem path.

        Args:
            thread_id: The thread ID.
            virtual_path: Virtual path as seen inside the sandbox, e.g.
                          ``/mnt/user-data/outputs/report.pdf``.
                          Leading slashes are stripped before matching.
            user_id: Optional user ID for user-scoped path resolution.

        Returns:
            The resolved absolute host filesystem path.

        Raises:
            ValueError: If the path does not start with the expected virtual
                        prefix or a path-traversal attempt is detected.
        """
        stripped = virtual_path.lstrip("/")
        prefix = VIRTUAL_PATH_PREFIX.lstrip("/")

        # Require an exact segment-boundary match to avoid prefix confusion
        # (e.g. reject paths like "mnt/user-dataX/...").
        if stripped != prefix and not stripped.startswith(prefix + "/"):
            raise ValueError(f"Path must start with /{prefix}")

        relative = stripped[len(prefix) :].lstrip("/")
        base = self.sandbox_user_data_dir(thread_id, user_id=user_id).resolve()
        actual = (base / relative).resolve()

        try:
            actual.relative_to(base)
        except ValueError:
            raise ValueError("Access denied: path traversal detected")

        return actual


# ── Singleton ────────────────────────────────────────────────────────────

_paths: Paths | None = None


def get_paths() -> Paths:
    """Return the global Paths singleton (lazy-initialized)."""
    global _paths
    if _paths is None:
        _paths = Paths()
    return _paths


def resolve_path(path: str) -> Path:
    """Resolve *path* to an absolute ``Path``.

    Relative paths are resolved relative to the application base directory.
    Absolute paths are returned as-is (after normalisation).
    """
    p = Path(path)
    if not p.is_absolute():
        p = get_paths().base_dir / path
    return p.resolve()
