"""Open a capability-group file in the host file manager."""

from __future__ import annotations

import os
import subprocess
import sys
from pathlib import Path


class RevealUnsupportedError(RuntimeError):
    """The host has no supported file-manager reveal operation."""


def reveal_in_file_manager(path: Path) -> None:
    """Reveal *path* in the host file manager without invoking a shell."""
    target = path.resolve()
    if not target.exists():
        raise FileNotFoundError(target)

    if sys.platform == "win32":
        # ``explorer`` returns a non-zero status even on success; do not wait.
        subprocess.Popen(["explorer.exe", f"/select,{target}"], close_fds=True)
        return
    if sys.platform == "darwin":
        subprocess.Popen(["open", "-R", str(target)], close_fds=True)
        return
    if sys.platform.startswith("linux"):
        subprocess.Popen(["xdg-open", str(target.parent if target.is_file() else target)], close_fds=True)
        return
    raise RevealUnsupportedError(f"file-manager reveal is not supported on {sys.platform!r} ({os.name})")
