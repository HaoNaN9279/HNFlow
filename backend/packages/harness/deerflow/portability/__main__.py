"""``python -m deerflow.portability`` — back up, inspect, and restore (N11b, §22).

::

    python -m deerflow.portability export  --output backup.zip [--include-assets]
    python -m deerflow.portability inspect --input  backup.zip
    python -m deerflow.portability import  --input  backup.zip [--force] [--dry-run] [--assets-dest DIR]

``export`` runs safely against a live install (the database is captured with
SQLite's online backup API).  ``import`` is an **offline** operation — it
overwrites the database file, so stop the Gateway before running it.

Exit codes (deliberately distinct so a script can tell apart "not allowed" from
"the tool itself broke"):

- ``0`` — the action succeeded (an import with ``--dry-run`` also returns 0).
- ``1`` — refused: an incompatible archive, or a non-empty target without
  ``--force``.  Nothing was changed.
- ``2`` — the operation could not run at all (bad archive, unreadable paths,
  a database file in use).
"""

from __future__ import annotations

import argparse
import json
import sys
from typing import Any

from deerflow.portability.service import export_backup, import_backup, inspect_backup


def _get_config() -> Any:
    from deerflow.config.app_config import get_app_config

    return get_app_config()


def _render_export(result: dict[str, Any]) -> str:
    manifest = result.get("manifest", {})
    lines = [
        f"exported backup: {result['output']}",
        f"  members: {result.get('member_count', 0)}  total: {result.get('total_bytes', 0)} bytes",
        f"  database included: {result.get('database_included')} ({manifest.get('database_backend')})",
    ]
    if result.get("excluded"):
        lines.append(f"  excluded: {', '.join(result['excluded'])}")
    for entry in manifest.get("entries", []):
        lines.append(f"    - {entry['name']} ({entry['kind']}): {entry['entry_count']} files, {entry['total_bytes']} bytes")
    return "\n".join(lines)


def _render_inspect(result: dict[str, Any]) -> str:
    manifest = result.get("manifest", {})
    compatibility = result.get("compatibility", {})
    lines = [
        f"archive: {result['archive']}",
        f"  created: {manifest.get('created_at')}  format: {manifest.get('format_version')}  platform: {manifest.get('platform')}",
        f"  config_version: {manifest.get('config_version')}  schema head: {manifest.get('schema_head')}",
        f"  database: {manifest.get('database_backend')} (included: {manifest.get('database_included')})",
        f"  members: {len(manifest.get('entries', []))}  total: {result.get('total_bytes', 0)} bytes",
        f"  compatible: {compatibility.get('compatible')}",
    ]
    if compatibility.get("reason"):
        lines.append(f"    reason: {compatibility['reason']}")
    for warning in compatibility.get("warnings", []):
        lines.append(f"    warning: {warning}")
    return "\n".join(lines)


def _render_import(result: dict[str, Any]) -> str:
    if not result.get("ok"):
        lines = ["import refused:"]
        lines.extend(f"  - {reason}" for reason in result.get("refusals", []))
        return "\n".join(lines)
    verb = "would restore" if result.get("dry_run") else "restored"
    lines = [f"{verb} {result.get('files', 0)} files ({result.get('total_bytes', 0)} bytes) from {result.get('archive')}"]
    for warning in result.get("warnings", []):
        lines.append(f"  warning: {warning}")
    for action in result.get("actions", []):
        if action.get("action") == "skip":
            lines.append(f"  skipped {action['name']}: {action.get('reason')}")
    return "\n".join(lines)


def _add_common(parser: argparse.ArgumentParser) -> None:
    parser.add_argument("--json", action="store_true", help="Print the result as JSON instead of text.")


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(prog="python -m deerflow.portability", description="Back up, inspect and restore a DeerFlow data directory (N11b).")
    sub = parser.add_subparsers(dest="command", required=True)

    export_parser = sub.add_parser("export", help="Write a backup archive.")
    export_parser.add_argument("--output", required=True, help="Destination .zip path.")
    export_parser.add_argument("--include-assets", action="store_true", help="Also package configured assets.roots (off by default).")
    _add_common(export_parser)

    inspect_parser = sub.add_parser("inspect", help="Read an archive's manifest and check compatibility.")
    inspect_parser.add_argument("--input", required=True, help="Archive .zip path.")
    _add_common(inspect_parser)

    import_parser = sub.add_parser("import", help="Restore an archive onto this machine (offline).")
    import_parser.add_argument("--input", required=True, help="Archive .zip path.")
    import_parser.add_argument("--force", action="store_true", help="Overwrite existing data (required when the target is non-empty).")
    import_parser.add_argument("--dry-run", action="store_true", help="Report what would be restored without writing.")
    import_parser.add_argument("--assets-dest", default=None, help="Directory to restore packaged assets into (required to restore assets).")
    _add_common(import_parser)

    args = parser.parse_args(argv)

    try:
        config = _get_config()
        if args.command == "export":
            result = export_backup(config, args.output, include_assets=args.include_assets)
            renderer = _render_export
        elif args.command == "inspect":
            result = inspect_backup(config, args.input)
            renderer = _render_inspect
        else:
            result = import_backup(config, args.input, force=args.force, dry_run=args.dry_run, assets_dest=args.assets_dest)
            renderer = _render_import
    except Exception as exc:  # noqa: BLE001 - the CLI must report, not traceback
        print(f"portability operation failed: {type(exc).__name__}: {exc}", file=sys.stderr)
        return 2

    if args.json:
        print(json.dumps(result, indent=2, ensure_ascii=False))
    else:
        print(renderer(result))

    return 0 if result.get("ok") else 1


if __name__ == "__main__":
    raise SystemExit(main())
