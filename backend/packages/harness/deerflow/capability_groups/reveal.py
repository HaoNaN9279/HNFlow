"""Open a capability-group file in the host file manager."""

from __future__ import annotations

import os
import subprocess
import sys
from pathlib import Path


class RevealUnsupportedError(RuntimeError):
    """The host has no supported file-manager reveal operation."""


def resolve_reveal_target(group_root: Path, relative: str) -> Path:
    """Resolve a group-relative reveal path, allowing ``.`` for the group root."""
    normalized = relative.replace("\\", "/")
    if normalized.startswith("/") or ".." in Path(normalized).parts:
        raise ValueError("path must be relative to the capability group")
    root = group_root.resolve()
    target = root if normalized.strip() in {"", "."} else (root / normalized).resolve()
    if not target.is_relative_to(root):
        raise ValueError("path escapes the capability group")
    return target


def reveal_in_file_manager(path: Path) -> None:
    """Reveal *path* in the host file manager without invoking a shell."""
    target = path.resolve()
    if not target.exists():
        raise FileNotFoundError(target)
    is_directory = target.is_dir()

    if sys.platform == "win32":
        # ``explorer`` returns a non-zero status even on success; do not wait.
        # A directory opens as a folder; a file is selected in its parent.
        args = [str(target)] if is_directory else [f"/select,{target}"]
        subprocess.Popen(["explorer.exe", *args], close_fds=True)
        return
    if sys.platform == "darwin":
        args = [str(target)] if is_directory else ["-R", str(target)]
        subprocess.Popen(["open", *args], close_fds=True)
        return
    if sys.platform.startswith("linux"):
        subprocess.Popen(["xdg-open", str(target.parent if target.is_file() else target)], close_fds=True)
        return
    raise RevealUnsupportedError(f"file-manager reveal is not supported on {sys.platform!r} ({os.name})")
