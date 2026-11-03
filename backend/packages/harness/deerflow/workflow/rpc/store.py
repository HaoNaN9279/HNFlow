"""Durable state for the headless engine.

Two things survive an engine restart: the LangGraph checkpoints (so a suspended
or interrupted run can continue) and the engine's own run/task records (so the
plugin can still list them). Both live under one directory:

```text
$DSH_HOME/hnflow/state/
├─ checkpoints.sqlite   # LangGraph checkpoint store (per-run thread ids)
├─ runs.json            # run records: status, definition, inputs, provenance
└─ tasks.json           # human-task rows, including pending ones
```

``DSH_HOME`` is inherited from the DSH process that spawned the engine;
``HNFLOW_ENGINE_STATE`` overrides the whole directory.

Persistence is best-effort by design: a failed write logs and keeps the run
alive, because losing a run is worse than losing the ability to list it.
"""

from __future__ import annotations

import json
import logging
import os
from pathlib import Path
from typing import Any

logger = logging.getLogger(__name__)

#: Environment override for the state directory.
STATE_DIR_ENV = "HNFLOW_ENGINE_STATE"
#: Bumped when the on-disk shape changes incompatibly.
STATE_VERSION = 1


def default_state_dir() -> Path:
    """Resolve the state directory from the environment."""
    explicit = os.environ.get(STATE_DIR_ENV, "").strip()
    if explicit:
        return Path(explicit).expanduser()
    dsh_home = os.environ.get("DSH_HOME", "").strip()
    if dsh_home:
        return Path(dsh_home).expanduser() / "hnflow" / "state"
    return Path.cwd() / ".hnflow-engine"


class EngineStore:
    """Read/write the engine's JSON records and locate the checkpoint file."""

    def __init__(self, directory: str | Path) -> None:
        self.directory = Path(directory)
        self.checkpoint_path = self.directory / "checkpoints.sqlite"
        self.runs_path = self.directory / "runs.json"
        self.tasks_path = self.directory / "tasks.json"

    def ensure(self) -> None:
        """Create the directory tree."""
        self.directory.mkdir(parents=True, exist_ok=True)

    def load_runs(self) -> list[dict[str, Any]]:
        """Read the persisted run records (empty when absent or unreadable)."""
        return self._read(self.runs_path, "runs")

    def save_runs(self, records: list[dict[str, Any]]) -> None:
        """Persist the run records."""
        self._write(self.runs_path, "runs", records)

    def load_tasks(self) -> list[dict[str, Any]]:
        """Read the persisted human-task rows (empty when absent or unreadable)."""
        return self._read(self.tasks_path, "tasks")

    def save_tasks(self, rows: list[dict[str, Any]]) -> None:
        """Persist the human-task rows."""
        self._write(self.tasks_path, "tasks", rows)

    # ── internals ──────────────────────────────────────────────────────────

    def _read(self, path: Path, key: str) -> list[dict[str, Any]]:
        """Read a versioned list document."""
        try:
            raw = json.loads(path.read_text(encoding="utf-8"))
        except FileNotFoundError:
            return []
        except Exception:  # noqa: BLE001 - a corrupt file must not stop the engine
            logger.warning("engine state %s is unreadable; starting from an empty %s list", path, key, exc_info=True)
            return []
        if not isinstance(raw, dict) or not isinstance(raw.get(key), list):
            logger.warning("engine state %s has an unexpected shape; ignoring it", path)
            return []
        return [row for row in raw[key] if isinstance(row, dict)]

    def _write(self, path: Path, key: str, rows: list[dict[str, Any]]) -> None:
        """Write a versioned list document atomically."""
        try:
            self.ensure()
            temp = path.with_suffix(f"{path.suffix}.tmp")
            temp.write_text(json.dumps({"version": STATE_VERSION, key: rows}, ensure_ascii=False), encoding="utf-8")
            temp.replace(path)
        except Exception:  # noqa: BLE001 - persistence loss must not fail the caller
            logger.warning("cannot persist engine state to %s", path, exc_info=True)


__all__ = ["EngineStore", "STATE_DIR_ENV", "default_state_dir"]
