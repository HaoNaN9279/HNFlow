"""Explicit migration: move legacy skill directories to versioned layout.

Converts flat legacy skill directories into T7-3 versioned layout with
journal-assisted recovery.  Each skill directory ``<name>/`` with a
``SKILL.md`` at its root is migrated to ``<name>/v0.1.0/``, and the
frontmatter ``version`` field is inserted (or its mismatch logged).

Usage from ``backend/``::

    PYTHONPATH=. uv run python scripts/migrate_skills_versioned.py --dry-run
    PYTHONPATH=. uv run python scripts/migrate_skills_versioned.py
    PYTHONPATH=. uv run python scripts/migrate_skills_versioned.py --root /path/to/skills

Scope (runtime dynamic data only — ``public/`` is NOT in scope):
- ``<root>/custom/`` (global custom, legacy source)
- ``<root>/users/*/skills/custom/`` (per-user custom)
"""

from __future__ import annotations

import argparse
import json
import logging
import shutil
import uuid
from pathlib import Path
from typing import Any

from deerflow.skills.types import SKILL_MD_FILE
from deerflow.skills.versions import is_version_dir_name

logger = logging.getLogger(__name__)

_JOURNAL_FILENAME = ".skills-version-migration.json"
_RECOVERY_SUBDIR = ".recovery"
_MIGRATED_VERSION = "0.1.0"
_MIGRATED_DIR_NAME = "v0.1.0"

# ---------------------------------------------------------------------------
# Journal helpers (per-skill directory — independent recovery)
# ---------------------------------------------------------------------------


def _recover_if_needed(parent_dir: Path, skill_name: str) -> dict[str, Any] | None:
    """Check for a journal file for *skill_name* and recover or clean it up.

    Returns a recovery-action dict (``{"action": "rolled_back" | "cleaned_committed"}``)
    or ``None`` when no journal exists.

    ``parent_dir`` is the directory **containing** the skill directory
    (e.g. ``<root>/custom/`` for ``<root>/custom/<name>/``).
    """
    journal_path = parent_dir / f".skills-version-migration-{skill_name}.json"
    if not journal_path.exists():
        return None

    try:
        journal = json.loads(journal_path.read_text(encoding="utf-8"))
        operation_id = str(journal["operationId"])
        state = journal.get("state")
    except (OSError, json.JSONDecodeError, KeyError, TypeError) as exc:
        logger.warning("Invalid journal %s, removing: %s", journal_path, exc)
        journal_path.unlink(missing_ok=True)
        return None

    recovery_dir = parent_dir / _RECOVERY_SUBDIR / operation_id
    skill_dir = parent_dir / skill_name

    if state == "prepared":
        # Rollback: delete the version dir we created, restore original tree from backup
        version_dir = skill_dir / _MIGRATED_DIR_NAME
        if version_dir.exists():
            shutil.rmtree(version_dir)
        backup_source = recovery_dir / skill_name
        if backup_source.exists():
            # Restore each item from backup to skill_dir
            for item in backup_source.iterdir():
                dest = skill_dir / item.name
                if item.is_dir():
                    if dest.exists():
                        shutil.rmtree(dest)
                    shutil.copytree(item, dest)
                else:
                    shutil.copy2(item, dest)
        shutil.rmtree(recovery_dir, ignore_errors=True)
        journal_path.unlink(missing_ok=True)
        logger.info("Rolled back interrupted migration for %s", skill_name)
        return {"action": "rolled_back"}

    if state == "committed":
        shutil.rmtree(recovery_dir, ignore_errors=True)
        journal_path.unlink(missing_ok=True)
        logger.info("Cleaned up committed journal for %s", skill_name)
        return {"action": "cleaned_committed"}

    logger.warning("Unknown journal state %r for %s, removing journal", state, skill_name)
    journal_path.unlink(missing_ok=True)
    return None


def _journal_prepare(parent_dir: Path, skill_name: str, recovery_root: Path, backup_source: Path) -> str:
    """Write a prepared journal for migrating *skill_name*.

    Copies the entire skill directory into *recovery_root*/*operation_id*/*skill_name*
    as the rollback backup, then writes the journal file.

    Returns the *operation_id* string.
    """
    operation_id = uuid.uuid4().hex
    backup_dest = recovery_root / operation_id / skill_name
    backup_dest.mkdir(parents=True, exist_ok=True)

    # Copy the full skill directory tree to backup
    for item in backup_source.iterdir():
        src = backup_source / item.name
        dst = backup_dest / item.name
        if item.is_dir():
            shutil.copytree(src, dst)
        else:
            shutil.copy2(src, dst)

    journal = {
        "operationId": operation_id,
        "state": "prepared",
        "skillName": skill_name,
    }
    journal_path = parent_dir / f".skills-version-migration-{skill_name}.json"
    journal_path.write_text(json.dumps(journal, ensure_ascii=False, indent=2), encoding="utf-8")
    return operation_id


def _journal_commit(parent_dir: Path, skill_name: str, operation_id: str) -> None:
    """Mark the journal as committed and clean up."""
    journal_path = parent_dir / f".skills-version-migration-{skill_name}.json"
    try:
        journal = json.loads(journal_path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as exc:
        logger.warning("Cannot read journal for commit: %s", exc)
        return

    journal["state"] = "committed"
    journal_path.write_text(json.dumps(journal, ensure_ascii=False, indent=2), encoding="utf-8")

    recovery_dir = parent_dir / _RECOVERY_SUBDIR / operation_id
    shutil.rmtree(recovery_dir, ignore_errors=True)
    journal_path.unlink(missing_ok=True)


# ---------------------------------------------------------------------------
# Frontmatter helpers
# ---------------------------------------------------------------------------


def _parse_skill_md_frontmatter(content: str) -> tuple[dict[str, str], str]:
    """Parse YAML-like frontmatter from SKILL.md content.

    Returns ``(metadata_dict, body_text)``.  If no frontmatter found,
    returns ``({}, content)``.
    """
    lines = content.split("\n")
    if not lines or lines[0].strip() != "---":
        return {}, content

    end_idx: int | None = None
    for i in range(1, len(lines)):
        if lines[i].strip() == "---":
            end_idx = i
            break

    if end_idx is None:
        return {}, content

    metadata: dict[str, str] = {}
    for line in lines[1:end_idx]:
        stripped = line.strip()
        if ":" in stripped:
            key, _, value = stripped.partition(":")
            key = key.strip()
            value = value.strip()
            if key:
                metadata[key] = value

    # Skip the blank separator line after closing --- if present
    body_start = end_idx + 1
    if body_start < len(lines) and lines[body_start].strip() == "":
        body_start += 1
    body = "\n".join(lines[body_start:])
    return metadata, body


def _insert_version_frontmatter(content: str) -> tuple[str, bool]:
    """Insert ``version: 0.1.0`` after the ``name:`` line in frontmatter.

    Returns ``(new_content, inserted)``.  If the version field already
    exists, returns the original content unchanged (``inserted=False``).
    """
    lines = content.split("\n")
    if not lines or lines[0].strip() != "---":
        # No frontmatter — prepend one
        return f"---\nversion: {_MIGRATED_VERSION}\n---\n\n{content}", True

    end_idx: int | None = None
    for i in range(1, len(lines)):
        if lines[i].strip() == "---":
            end_idx = i
            break

    if end_idx is None:
        return content, False

    # Check if version already exists
    for i in range(1, end_idx):
        stripped = lines[i].strip()
        if stripped.startswith("version:") or stripped == "version:":
            return content, False

    # Insert after name: line
    inserted = False
    new_inner: list[str] = []
    for i in range(1, end_idx):
        new_inner.append(lines[i])
        if not inserted:
            stripped = lines[i].strip()
            if stripped.startswith("name:") or stripped == "name:":
                new_inner.append(f"version: {_MIGRATED_VERSION}")
                inserted = True

    if not inserted:
        # No name: line — insert after the opening ---
        new_inner.insert(0, f"version: {_MIGRATED_VERSION}")

    result = ["---"]
    result.extend(new_inner)
    result.append("---")
    if end_idx + 1 < len(lines):
        result.extend(lines[end_idx + 1 :])
    return "\n".join(result), True


def _check_frontmatter_version(content: str) -> str | None:
    """Return the ``version`` value from SKILL.md frontmatter, or ``None``."""
    metadata, _body = _parse_skill_md_frontmatter(content)
    return metadata.get("version")


# ---------------------------------------------------------------------------
# Scanning
# ---------------------------------------------------------------------------


def _is_legacy_skill_dir(skill_dir: Path) -> bool:
    """Return ``True`` when *skill_dir* is a legacy skill directory.

    A legacy skill dir has a ``SKILL.md`` at its root and **no** version
    subdirectories (``vX.Y.Z``).
    """
    if not skill_dir.is_dir():
        return False
    if not (skill_dir / SKILL_MD_FILE).exists():
        return False
    try:
        for entry in skill_dir.iterdir():
            if entry.is_dir() and is_version_dir_name(entry.name):
                return False
    except OSError:
        return False
    return True


def _scan_legacy_skill_dirs(root: Path) -> list[Path]:
    """Scan *root* for legacy skill directories to migrate.

    Covers:
    - ``<root>/custom/`` (global custom)
    - ``<root>/users/*/skills/custom/`` (per-user custom)

    Each returned path is a ``<name>/`` directory containing a
    ``SKILL.md`` at its root with no version subdirectory.
    """
    legacy: list[Path] = []

    # Global custom
    global_custom = root / "custom"
    if global_custom.is_dir():
        for entry in sorted(global_custom.iterdir()):
            if _is_legacy_skill_dir(entry):
                legacy.append(entry)

    # Per-user custom
    users_dir = root / "users"
    if users_dir.is_dir():
        for user_dir in sorted(users_dir.iterdir()):
            if not user_dir.is_dir():
                continue
            user_custom = user_dir / "skills" / "custom"
            if user_custom.is_dir():
                for entry in sorted(user_custom.iterdir()):
                    if _is_legacy_skill_dir(entry):
                        legacy.append(entry)

    return legacy


# ---------------------------------------------------------------------------
# Migration
# ---------------------------------------------------------------------------


def _resolve_skills_root(args_root: Path | None) -> Path:
    """Resolve the skills root directory.

    *args_root* (from ``--root``) takes priority.  Falls back to
    ``deerflow.config.get_app_config().skills.get_skills_path()``.
    """
    if args_root is not None:
        return args_root.resolve()

    try:
        from deerflow.config import get_app_config

        config = get_app_config()
        return config.skills.get_skills_path().resolve()
    except Exception:
        # No config available — default to the well-known project skills dir
        return Path("skills").resolve()


def _migrate_skill_dir(
    skill_dir: Path,
    *,
    dry_run: bool = False,
) -> dict[str, Any]:
    """Migrate a single legacy skill directory to versioned layout.

    Returns a result dict with keys: ``"name"``, ``"status"``, ``"warnings"``.

    *status* is one of: ``"already_versioned"``, ``"no_skill_md"``,
    ``"migrated"``, ``"skipped_dry_run"``.
    """
    name = skill_dir.name
    parent_dir = skill_dir.parent
    result: dict[str, Any] = {"name": str(skill_dir), "status": "", "warnings": []}

    # First, recover any interrupted journal
    recovery_result = _recover_if_needed(parent_dir, name)

    # Check if already versioned
    try:
        for entry in skill_dir.iterdir():
            if entry.is_dir() and is_version_dir_name(entry.name):
                result["status"] = "already_versioned"
                if recovery_result:
                    result["warnings"].append(f"Recovery: {recovery_result['action']}")
                return result
    except OSError:
        pass

    # Check for SKILL.md
    skill_md = skill_dir / SKILL_MD_FILE
    if not skill_md.exists():
        result["status"] = "no_skill_md"
        return result

    if dry_run:
        result["status"] = "skipped_dry_run"
        return result

    # --- Perform migration with journal ---
    recovery_root = parent_dir / _RECOVERY_SUBDIR
    operation_id = _journal_prepare(parent_dir, name, recovery_root, skill_dir)

    try:
        # Read SKILL.md content before move
        original_content = skill_md.read_text(encoding="utf-8")

        # Create version directory
        version_dir = skill_dir / _MIGRATED_DIR_NAME
        version_dir.mkdir(parents=True, exist_ok=True)

        # Move all visible content (not dotfiles or the version dir itself) into version directory
        for item in list(skill_dir.iterdir()):
            if item.name.startswith("."):
                continue
            if item.name == _MIGRATED_DIR_NAME:
                continue
            dest = version_dir / item.name
            shutil.move(str(item), str(dest))

        # Insert version into frontmatter of migrated SKILL.md
        migrated_skill_md = version_dir / SKILL_MD_FILE
        if migrated_skill_md.exists():
            new_content, inserted = _insert_version_frontmatter(original_content)

            # Check frontmatter version for mismatch warning
            existing_version = _check_frontmatter_version(new_content)
            if existing_version is not None and existing_version != _MIGRATED_VERSION:
                result["warnings"].append(f"Frontmatter version '{existing_version}' ≠ directory version '{_MIGRATED_VERSION}' — preserved as-is; manual review may be needed.")

            if inserted:
                migrated_skill_md.write_text(new_content, encoding="utf-8")

        _journal_commit(parent_dir, name, operation_id)
        result["status"] = "migrated"
        return result

    except Exception:
        # Rollback: journal is still in "prepared" state — recovery on next run
        logger.exception("Migration failed for %s; journal left for recovery", name)
        result["status"] = "failed"
        return result


def _build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description="Migrate legacy skill directories to T7-3 versioned layout (journal-assisted recovery).")
    parser.add_argument(
        "--dry-run",
        action="store_true",
        help="Scan and report what would be migrated without making changes.",
    )
    parser.add_argument(
        "--root",
        type=Path,
        default=None,
        metavar="PATH",
        help=("Skills root directory. Defaults to the skills path from DeerFlow config, or './skills' if config is unavailable."),
    )
    return parser


def main(argv: list[str] | None = None) -> int:
    args = _build_parser().parse_args(argv)
    logging.basicConfig(level=logging.INFO, format="%(levelname)s: %(message)s")

    root = _resolve_skills_root(args.root)
    logger.info("Skills root: %s", root)
    logger.info("Dry run: %s", args.dry_run)

    if not root.is_dir():
        logger.error("Skills root directory does not exist: %s", root)
        return 1

    legacy_dirs = _scan_legacy_skill_dirs(root)
    logger.info("Legacy skill directories found: %d", len(legacy_dirs))

    if not legacy_dirs:
        logger.info("Nothing to migrate.")
        return 0

    stats = {"migrated": 0, "skipped": 0, "failed": 0, "already_versioned": 0, "dry_run": 0}
    for skill_dir in legacy_dirs:
        result = _migrate_skill_dir(skill_dir, dry_run=args.dry_run)
        status = result["status"]
        name = result["name"]

        if status == "migrated":
            stats["migrated"] += 1
            logger.info("%s: migrated → v0.1.0", name)
        elif status == "skipped_dry_run":
            stats["dry_run"] += 1
            logger.info("%s: would migrate → v0.1.0", name)
        elif status == "already_versioned":
            stats["already_versioned"] += 1
            logger.info("%s: already versioned, skipped", name)
        elif status == "failed":
            stats["failed"] += 1
            logger.error("%s: FAILED (journal left for recovery)", name)
        elif status == "no_skill_md":
            stats["skipped"] += 1
            logger.warning("%s: no SKILL.md, skipped", name)

        for warning in result["warnings"]:
            logger.warning("  ⚠ %s: %s", name, warning)

    total = len(legacy_dirs)
    print(f"\nMigration summary: scanned={total} migrated={stats['migrated']} dry_run={stats['dry_run']} already_versioned={stats['already_versioned']} skipped={stats['skipped']} failed={stats['failed']}")

    return 1 if stats["failed"] > 0 else 0


if __name__ == "__main__":
    raise SystemExit(main())
