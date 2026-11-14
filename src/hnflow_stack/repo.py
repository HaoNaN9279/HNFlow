"""Repository and global configuration discovery."""

from __future__ import annotations

import json
import os
from pathlib import Path

from hnflow_stack.errors import HNFlowError
from hnflow_stack.model import GroupRef

_GLOBAL_DIR = ".config"
_GLOBAL_NAME = "HNFlow"
_CONFIG_FILE = "config.json"
_DEFAULT_CORE = GroupRef(name="core", version="0.1.0")


def global_config_path() -> Path:
    """Return ``~/.config/hnflow-stack/config.json``."""
    return Path.home() / _GLOBAL_DIR / _GLOBAL_NAME / _CONFIG_FILE


def read_global_config() -> dict[str, object]:
    """Read the global HNFlow config, or an empty dict when absent."""
    path = global_config_path()
    if not path.is_file():
        return {}
    try:
        data = json.loads(path.read_text(encoding="utf-8-sig"))
    except UnicodeDecodeError as exc:
        raise HNFlowError(f"invalid UTF-8 in {path}: {exc}") from exc
    except json.JSONDecodeError as exc:
        raise HNFlowError(f"invalid JSON in {path}: {exc}") from exc
    except OSError as exc:
        raise HNFlowError(f"cannot read {path}: {exc}") from exc
    return data if isinstance(data, dict) else {}


def write_global_config(data: dict[str, object]) -> Path:
    """Write the global HNFlow config atomically and return its path."""
    path = global_config_path()
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_name(f"{path.name}.{os.getpid()}.tmp")
    try:
        temporary.write_text(
            json.dumps(data, ensure_ascii=False, indent=2) + "\n", encoding="utf-8"
        )
        os.replace(temporary, path)
    finally:
        if temporary.exists():
            temporary.unlink(missing_ok=True)
    return path


def default_core() -> GroupRef:
    """Return the configured default core group or ``core/0.1.0``."""
    data = read_global_config()
    core = data.get("core")
    if isinstance(core, dict):
        return GroupRef(
            name=str(core.get("name", "core")),
            version=str(core.get("version", _DEFAULT_CORE.version)),
        )
    return _DEFAULT_CORE


def find_repo(explicit: Path | None = None) -> Path:
    """Locate the HNFlow repository.

    Priority: explicit path, ``HNFLOW_HOME`` / ``HNFLOW_REPO``,
    global config ``repository``, current directory, home directory.
    """
    if explicit is not None:
        if (explicit / "capability-groups").is_dir():
            return explicit.resolve()
        raise HNFlowError(f"not a HNFlow repository: {explicit}")

    candidates: list[Path] = []
    for env_name in ("HNFLOW_HOME", "HNFLOW_REPO"):
        value = os.environ.get(env_name)
        if value:
            candidates.append(Path(value))
    configured = read_global_config().get("repository")
    if isinstance(configured, str) and configured:
        candidates.append(Path(configured))
    candidates.extend([Path.cwd(), Path.home()])

    for candidate in candidates:
        if (candidate / "capability-groups").is_dir():
            return candidate.resolve()

    raise HNFlowError(
        "HNFlow repository not found; pass --repo, set HNFLOW_HOME, "
        "or run `hnflow-stack init`"
    )
