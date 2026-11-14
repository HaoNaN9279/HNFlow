"""``hnflow-forge`` CLI: offline lint and Markdown rendering for HNFlow flows.

Usage:
    hnflow-forge lint <flow.json> [--json]
    hnflow-forge render <flow.json> [--out review.md]

Exit codes: 0 ok, 1 definition has errors, 2 usage/IO failure.
"""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

from hnflow_forge.lint import Report, lint_file
from hnflow_forge.render import render_markdown

USAGE = """hnflow-forge 0.1.0 — HNFlow 流程离线预检

  hnflow-forge lint <定义文件> [--json]
  hnflow-forge render <定义文件> [--out <文件>]

离线预检不能确认宿主 preset allowlist 与模型层；最终以插件
`hnflow_author validate` 为准。
"""


def _print_report(report: Report, path: Path, as_json: bool) -> int:
    if as_json:
        print(json.dumps({"file": str(path), **report.as_dict()}, ensure_ascii=False, indent=2))
    else:
        status = "OK" if report.ok else f"FAIL（{len(report.errors)} 个错误）"
        print(f"hnflow-forge lint: {path}: {status}")
        for issue in report.errors:
            where = ""
            if issue.node_id:
                where = f" [node {issue.node_id}]"
            elif issue.edge_id:
                where = f" [edge {issue.edge_id}]"
            print(f"  × {issue.code}{where}: {issue.message}")
        for warning in report.warnings:
            print(f"  ！ {warning}")
        if report.ok and not report.warnings:
            print("  无问题。")
    return 0 if report.ok else 1


def _cmd_lint(args: argparse.Namespace) -> int:
    path = Path(args.file)
    report = lint_file(path)
    return _print_report(report, path, args.json)


def _cmd_render(args: argparse.Namespace) -> int:
    path = Path(args.file)
    try:
        definition = json.loads(path.read_text(encoding="utf-8-sig"))
        markdown = render_markdown(definition)
    except (OSError, ValueError, json.JSONDecodeError) as exc:
        print(f"hnflow-forge render: {path}: {exc}", file=sys.stderr)
        return 2
    if args.out:
        Path(args.out).write_text(markdown, encoding="utf-8")
        print(f"written {args.out}")
    else:
        print(markdown)
    return 0


def main(argv: list[str] | None = None) -> int:
    """Entry point used by ``[project.scripts]`` and ``python -m``."""
    parser = argparse.ArgumentParser(prog="hnflow-forge", description="HNFlow 流程离线预检与渲染", add_help=True)
    sub = parser.add_subparsers(dest="command")

    lint_parser = sub.add_parser("lint", help="静态校验流程定义")
    lint_parser.add_argument("file", help="流程定义 JSON 文件")
    lint_parser.add_argument("--json", action="store_true", help="输出机器可读结果")
    lint_parser.set_defaults(handler=_cmd_lint)

    render_parser = sub.add_parser("render", help="渲染 Markdown 评审稿")
    render_parser.add_argument("file", help="流程定义 JSON 文件")
    render_parser.add_argument("--out", help="写入文件而不是打印到 stdout")
    render_parser.set_defaults(handler=_cmd_render)

    args = parser.parse_args(argv)
    if not getattr(args, "handler", None):
        print(USAGE)
        return 2
    return args.handler(args)
