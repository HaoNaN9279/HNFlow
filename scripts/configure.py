#!/usr/bin/env python3
"""Bootstrap the unified ``hnflow-data/`` user-data directory.

Actual user configuration and runtime data are never tracked by Git.  The
tracked ``config-examples/`` tree (plus the root example files) is the source
of templates.  This script copies a template only when the target is missing,
so re-running it never overwrites a user's configuration.
"""

from __future__ import annotations

import argparse
import os
import shutil
import sys
from pathlib import Path

USER_DATA_DIRNAME = "hnflow-data"


def _data_home(project_root: Path) -> Path:
    raw = os.getenv("HNFLOW_HOME") or os.getenv("DEER_FLOW_HOME")
    return Path(raw).resolve() if raw else project_root / USER_DATA_DIRNAME


def copy_if_missing(src: Path, dst: Path) -> None:
    if dst.exists():
        return
    if not src.exists():
        raise FileNotFoundError(f"Missing template file: {src}")
    dst.parent.mkdir(parents=True, exist_ok=True)
    shutil.copy2(src, dst)


def copy_tree_if_missing(src: Path, dst: Path) -> None:
    if not src.is_dir():
        return
    for source in src.rglob("*"):
        if not source.is_file() or "__pycache__" in source.parts or source.suffix == ".pyc":
            continue
        target = dst / source.relative_to(src)
        if not target.exists():
            target.parent.mkdir(parents=True, exist_ok=True)
            shutil.copy2(source, target)


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--seed-only", action="store_true", help="Seed missing templates without requiring a fresh config.")
    args = parser.parse_args(argv)

    project_root = Path(__file__).resolve().parent.parent
    data_home = _data_home(project_root)
    examples = project_root / "config-examples"

    config_path = data_home / "config.yaml"
    if config_path.exists() and not args.seed_only:
        print(f"Error: configuration already exists at {config_path}. Aborting.")
        print("Use 'make config-upgrade' to merge new fields, 'make data-migrate' to move legacy files,")
        print("or 'python scripts/configure.py --seed-only' to add missing examples.")
        return 1

    try:
        data_home.mkdir(parents=True, exist_ok=True)
        if not args.seed_only:
            copy_if_missing(project_root / "config.example.yaml", config_path)
        copy_if_missing(project_root / "extensions_config.example.json", data_home / "extensions_config.json")
        copy_if_missing(project_root / ".env.example", data_home / ".env")
        copy_if_missing(project_root / "frontend" / ".env.example", data_home / "frontend.env")
        copy_if_missing(examples / "prompts" / "lead-agent.md", data_home / "prompts" / "lead-agent.md")
        copy_if_missing(examples / "README.md", data_home / "README.md")

        copy_tree_if_missing(examples / "capability-groups", data_home / "capability-groups")
        copy_tree_if_missing(examples / "tools", data_home / "tools")
        copy_tree_if_missing(project_root / "skills" / "public", data_home / "skills" / "public")

        # Runtime-owned directories are created here so the first start has a
        # complete layout; nothing user-authored is overwritten by this step.
        for directory in (
            data_home / "users",
            data_home / "data",
            data_home / "locks",
            data_home / "undo",
            data_home / "backups",
            data_home / "skills" / "custom",
        ):
            directory.mkdir(parents=True, exist_ok=True)

        # Next.js only reads .env from its own working directory.  Keep the
        # authoritative copy in hnflow-data and project it for the dev server.
        frontend_env = data_home / "frontend.env"
        frontend_target = project_root / "frontend" / ".env"
        if frontend_env.exists() and not frontend_target.exists():
            shutil.copy2(frontend_env, frontend_target)
    except (FileNotFoundError, OSError) as exc:
        print("Error while generating configuration files:")
        print(f"  {exc}")
        if isinstance(exc, PermissionError):
            print("Hint: Check file permissions and ensure the files are not read-only or locked by another process.")
        return 1

    print("OK configuration files generated")
    print(f"  Root: {data_home}")
    print(f"  Main config: {config_path}")
    print("  Next: edit the config, then run 'make dev'.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
