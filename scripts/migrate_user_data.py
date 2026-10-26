#!/usr/bin/env python3
"""Copy legacy user configuration and runtime data into ``hnflow-data/``.

The migration is deliberately copy-only: the legacy files are never deleted,
so an operator can verify the new tree and roll back by pointing the process at
the old root again.  Existing target files are not overwritten unless
``--force`` is supplied.
"""

from __future__ import annotations

import argparse
import filecmp
import os
import shutil
import sys
from pathlib import Path


def _data_home(project_root: Path) -> Path:
    raw = os.getenv("HNFLOW_HOME") or os.getenv("DEER_FLOW_HOME")
    return Path(raw).resolve() if raw else project_root / "hnflow-data"


def _same_file(left: Path, right: Path) -> bool:
    try:
        return left.is_file() and right.is_file() and filecmp.cmp(left, right, shallow=False)
    except OSError:
        return False


class Migrator:
    def __init__(self, *, project_root: Path, target: Path, dry_run: bool, force: bool) -> None:
        self.project_root = project_root
        self.target = target
        self.dry_run = dry_run
        self.force = force
        self.copied: list[str] = []
        self.skipped: list[str] = []
        self.conflicts: list[str] = []

    def copy_file(self, source: Path, destination: Path, *, label: str) -> None:
        if not source.is_file():
            return
        if destination.is_file():
            if _same_file(source, destination):
                self.skipped.append(f"{label} (already matching)")
                return
            if not self.force:
                self.conflicts.append(f"{label}: {destination} already exists and differs")
                return
        if not self.dry_run:
            destination.parent.mkdir(parents=True, exist_ok=True)
            shutil.copy2(source, destination)
        self.copied.append(f"{label} -> {destination}")

    def copy_tree(self, source: Path, destination: Path, *, label: str) -> None:
        if not source.is_dir():
            return
        for item in sorted(source.rglob("*")):
            if not item.is_file() or "__pycache__" in item.parts or item.suffix == ".pyc":
                continue
            # Derived projections and lock state are rebuilt by the runtime;
            # copying them would both leak stale state and produce false
            # conflicts on a repeat migration.
            if "skills_view" in item.parts or ".projection" in item.name or item.name == ".skills_view.projection.lock":
                continue
            relative = item.relative_to(source)
            self.copy_file(item, destination / relative, label=f"{label}/{relative.as_posix()}")

    def run(self) -> int:
        if self.target.resolve() == (self.project_root / "backend" / ".deer-flow").resolve():
            print("Target is the legacy backend/.deer-flow directory; nothing to migrate.")
            return 0

        self.target.mkdir(parents=True, exist_ok=True)

        # Root-level configuration.
        self.copy_file(self.project_root / "config.yaml", self.target / "config.yaml", label="config.yaml")
        self.copy_file(self.project_root / "config.yaml.bak", self.target / "config.yaml.bak", label="config.yaml.bak")
        self.copy_file(self.project_root / "extensions_config.json", self.target / "extensions_config.json", label="extensions_config.json")
        self.copy_file(self.project_root / ".env", self.target / ".env", label=".env")
        self.copy_file(self.project_root / "frontend" / ".env", self.target / "frontend.env", label="frontend env")

        # Lead Agent prompt and user content.
        legacy_home = self.project_root / "backend" / ".deer-flow"
        self.copy_file(legacy_home / "SOUL.md", self.target / "prompts" / "lead-agent.md", label="lead-agent prompt")
        self.copy_file(legacy_home / ".jwt_secret", self.target / ".jwt_secret", label=".jwt_secret")
        self.copy_tree(self.project_root / "capability-groups", self.target / "capability-groups", label="capability-groups")
        self.copy_tree(self.project_root / "tools", self.target / "tools", label="tools")
        self.copy_tree(self.project_root / "skills" / "public", self.target / "skills" / "public", label="skills/public")
        self.copy_tree(self.project_root / "skills" / "custom", self.target / "skills" / "custom", label="skills/custom")

        # Legacy runtime tree.
        for name in ("users", "integrations", "channels", "locks", "undo"):
            self.copy_tree(legacy_home / name, self.target / name, label=name)
        self.copy_file(legacy_home / "data" / "deerflow.db", self.target / "data" / "deerflow.db", label="deerflow.db")

        # Ensure the layout directories exist even on a clean install.
        if not self.dry_run:
            for name in ("data", "users", "locks", "undo", "backups", "prompts", "capability-groups", "tools", "skills/custom"):
                (self.target / name).mkdir(parents=True, exist_ok=True)

        for entry in self.copied:
            print(f"  + {entry}")
        for entry in self.skipped:
            print(f"  = {entry}")
        for entry in self.conflicts:
            print(f"  ! {entry}", file=sys.stderr)

        if self.dry_run:
            print("\nDry run: no files were written.")
        elif not self.copied:
            print("\nNothing to copy.")
        else:
            print(f"\nCopied {len(self.copied)} file(s) into {self.target}.")

        if self.conflicts:
            print("Conflicts exist. Re-run with --force only after reviewing them.", file=sys.stderr)
            return 1
        return 0


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--dry-run", action="store_true", help="Report what would be copied without writing.")
    parser.add_argument("--force", action="store_true", help="Overwrite differing target files.")
    parser.add_argument("--target", type=Path, help="Override the unified data root.")
    args = parser.parse_args(argv)

    project_root = Path(__file__).resolve().parent.parent
    target = args.target.resolve() if args.target else _data_home(project_root)
    return Migrator(project_root=project_root, target=target, dry_run=args.dry_run, force=args.force).run()


if __name__ == "__main__":
    sys.exit(main())
