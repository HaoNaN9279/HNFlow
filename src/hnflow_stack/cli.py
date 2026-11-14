"""Command line interface for HNFlow."""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

from hnflow_stack import __version__
from hnflow_stack.bindings import (
    DEFAULT_AGENT,
    bind_layer,
    catalog_document,
    migrate_legacy,
    models_summary,
    set_default_layer,
    unbind_layer,
)
from hnflow_stack.errors import HNFlowError
from hnflow_stack.groups import groups_document
from hnflow_stack.loader import discover_groups, discover_tools, load_group
from hnflow_stack.model import (
    GroupMeta,
    GroupRef,
    ProjectStack,
    ResolvedGroup,
    ResolvedPlan,
    ResolvedRule,
)
from hnflow_stack.plugin import discover_plugins, status as plugin_status
from hnflow_stack.project import (
    activate,
    deactivate,
    init_stack,
    lock_path,
    missing_tools,
    parse_ref,
    read_stack,
    stack_path,
    tools_for_groups,
    write_lock,
    write_stack,
)
from hnflow_stack.preview import (
    DEFAULT_RULES_BYTES,
    DEFAULT_TEXT_BYTES,
    SessionView,
    build_session,
    dumps,
)
from hnflow_stack.repo import (
    default_core,
    find_repo,
    global_config_path,
    read_global_config,
    write_global_config,
)
from hnflow_stack.resolve import (
    MODE_PROJECT,
    MODE_CAPABILITIES,
    build_plan,
    resolve_project,
)
from hnflow_stack.rules import relative_to, rule_applies
from hnflow_stack.tools import exec_in_tool, run_tool


def build_parser() -> argparse.ArgumentParser:
    """Build the CLI argument parser."""
    parser = argparse.ArgumentParser(
        prog="hnflow-stack",
        description="Capability groups and tools for AI agent tools",
    )
    parser.add_argument("--version", action="version", version=__version__)
    parser.add_argument("--repo", type=Path, help="HNFlow repository root")
    parser.add_argument(
        "--project",
        type=Path,
        default=Path.cwd(),
        help="project root containing .hnflow (default: cwd)",
    )
    sub = parser.add_subparsers(dest="command", required=True)

    list_parser = sub.add_parser("list", help="list capability groups and tools")
    sub.add_parser("status", help="show project capability groups")
    sub.add_parser("sync", help="resolve the project stack and write lock.json")
    validate_parser = sub.add_parser(
        "validate", help="strictly validate the project stack and its content"
    )
    validate_parser.add_argument(
        "--json", action="store_true", help="write the result as JSON"
    )

    resolve_parser = sub.add_parser(
        "resolve", help="resolve the project stack into an injection plan"
    )
    resolve_parser.add_argument(
        "--json", action="store_true", help="write the plan as JSON"
    )
    resolve_parser.add_argument(
        "--project",
        dest="resolve_project",
        type=Path,
        default=None,
        help="project root containing .hnflow",
    )
    resolve_parser.add_argument(
        "--repo",
        dest="resolve_repo",
        type=Path,
        default=None,
        help="HNFlow repository root",
    )
    resolve_parser.add_argument(
        "--mode",
        choices=(MODE_PROJECT, MODE_CAPABILITIES),
        default=MODE_PROJECT,
        help=(
            "project: historical behavior (no stack means no Core); "
            "HNFlow: keep Core loaded in every workspace (DSH mode)"
        ),
    )

    rules_parser = sub.add_parser("rules", help="inspect resolved rules")
    rules_sub = rules_parser.add_subparsers(dest="rules_command", required=True)
    rules_list = rules_sub.add_parser("list", help="list rules in load order")
    rules_list.add_argument("--json", action="store_true", help="write JSON")
    rules_list.add_argument(
        "--mode", choices=(MODE_PROJECT, MODE_CAPABILITIES), default=MODE_PROJECT
    )
    rules_show = rules_sub.add_parser(
        "show", help="print the rules that apply to a project path"
    )
    rules_show.add_argument("--for", dest="for_path", default=".", help="project path")
    rules_show.add_argument("--json", action="store_true", help="write JSON")
    rules_show.add_argument(
        "--mode", choices=(MODE_PROJECT, MODE_CAPABILITIES), default=MODE_PROJECT
    )

    preview_parser = sub.add_parser(
        "preview", help="list the content a session would load at one path"
    )
    preview_parser.add_argument(
        "--agent", default="", help="agent persona name (default: first primary agent)"
    )
    preview_parser.add_argument(
        "--project",
        dest="resolve_project",
        type=Path,
        default=None,
        help="project root containing .hnflow (default: cwd)",
    )
    preview_parser.add_argument(
        "--repo",
        dest="resolve_repo",
        type=Path,
        default=None,
        help="HNFlow repository root",
    )
    preview_parser.add_argument(
        "--cwd", default="", help="project-relative working directory (default: root)"
    )
    preview_parser.add_argument(
        "--mode", choices=(MODE_PROJECT, MODE_CAPABILITIES), default=MODE_PROJECT
    )
    preview_parser.add_argument(
        "--max-rules-bytes",
        dest="max_rules_bytes",
        type=int,
        default=DEFAULT_RULES_BYTES,
        help="rendered rules budget",
    )
    preview_parser.add_argument("--json", action="store_true", help="write JSON")
    preview_parser.add_argument(
        "--with-text", action="store_true", help="embed the full text of each item"
    )
    preview_parser.add_argument(
        "--text-bytes",
        dest="text_bytes",
        type=int,
        default=DEFAULT_TEXT_BYTES,
        help="per-item text cap used by --with-text",
    )

    init = sub.add_parser("init", help="create .hnflow/stack.json")
    init.add_argument("--core", default="", help="core group as name@version")

    info = sub.add_parser("info", help="show capability group details")
    info.add_argument("group")
    info.add_argument("--group-version", default="")

    groups_parser = sub.add_parser(
        "groups", help="list every capability group with its activation state"
    )
    groups_parser.add_argument("--json", action="store_true", help="write JSON")
    groups_parser.add_argument(
        "--project",
        dest="resolve_project",
        type=Path,
        default=None,
        help="project root containing .hnflow (default: cwd)",
    )

    activate_parser = sub.add_parser("activate", help="activate capability groups")
    activate_parser.add_argument("groups", nargs="+", metavar="group[@version]")

    deactivate_parser = sub.add_parser("deactivate", help="deactivate capability groups")
    deactivate_parser.add_argument("groups", nargs="+")

    tool = sub.add_parser("tool", help="tool packages")
    tool_sub = tool.add_subparsers(dest="tool_command", required=True)
    tool_sub.add_parser("list", help="list tool packages")
    run = tool_sub.add_parser("run", help="run a tool CLI")
    run.add_argument("tool")
    run.add_argument("args", nargs=argparse.REMAINDER)
    serve = tool_sub.add_parser("serve", help="start a tool MCP server")
    serve.add_argument("tool")
    serve.add_argument("args", nargs=argparse.REMAINDER)
    execute = tool_sub.add_parser("exec", help="run a command in a tool environment")
    execute.add_argument("tool")
    execute.add_argument("args", nargs=argparse.REMAINDER)

    plugin = sub.add_parser("plugin", help="agent plugin adapters")
    plugin_sub = plugin.add_subparsers(dest="plugin_command", required=True)
    plugin_sub.add_parser("list", help="list adapters")
    plugin_status_parser = plugin_sub.add_parser("status", help="adapter status")
    plugin_status_parser.add_argument("agent")

    models = sub.add_parser("models", help="platform model layers and local bindings")
    models_sub = models.add_subparsers(dest="models_command", required=True)
    catalog = models_sub.add_parser("catalog", help="print the platform layer catalog")
    catalog.add_argument("--json", action="store_true", help="write JSON")
    show = models_sub.add_parser("show", help="print layers with local bindings")
    show.add_argument("--agent", default=DEFAULT_AGENT, help="adapter name (default: dsh)")
    show.add_argument("--json", action="store_true", help="write JSON")
    bind = models_sub.add_parser("bind", help="bind one layer to a host route")
    bind.add_argument("layer")
    bind.add_argument("--agent", default=DEFAULT_AGENT, help="adapter name (default: dsh)")
    bind.add_argument("--provider", required=True)
    bind.add_argument("--model", required=True)
    bind.add_argument("--effort", default="", help="optional reasoning effort")
    unbind = models_sub.add_parser("unbind", help="remove one layer binding")
    unbind.add_argument("layer")
    unbind.add_argument("--agent", default=DEFAULT_AGENT, help="adapter name (default: dsh)")
    default = models_sub.add_parser("default", help="set or clear the default layer")
    default.add_argument("layer", help="layer id or 'none'")
    default.add_argument("--agent", default=DEFAULT_AGENT, help="adapter name (default: dsh)")
    migrate = models_sub.add_parser("migrate", help="convert legacy models.layers")
    migrate.add_argument("--agent", default=DEFAULT_AGENT, help="adapter name (default: dsh)")

    return parser


def _force_utf8_stdio() -> None:
    """Write UTF-8 even when stdout is a pipe.

    The plugin reads `--json` output as UTF-8; on Windows a piped stream would
    otherwise use the ANSI code page and turn CJK descriptions into invalid JSON.
    """
    for stream in (sys.stdout, sys.stderr):
        reconfigure = getattr(stream, "reconfigure", None)
        if not callable(reconfigure):
            continue
        try:
            reconfigure(encoding="utf-8", errors="replace")
        except (OSError, ValueError):
            pass


def main(argv: list[str] | None = None) -> int:
    """CLI entry point."""
    _force_utf8_stdio()
    parser = build_parser()
    args = parser.parse_args(argv)
    try:
        if args.command == "models":
            return _models(args)
        repo = find_repo(getattr(args, "resolve_repo", None) or args.repo)
        if getattr(args, "resolve_project", None) is not None:
            args.project = args.resolve_project
        return _dispatch(args, repo)
    except HNFlowError as exc:
        print(f"error: {exc}", file=sys.stderr)
        return 1


def _dispatch(args: argparse.Namespace, repo: Path) -> int:
    project = args.project.resolve()
    if args.command == "list":
        return _list(repo, project)
    if args.command == "status":
        return _status(project)
    if args.command == "init":
        return _init(repo, project, args.core)
    if args.command == "info":
        return _info(repo, project, args.group, args.group_version)
    if args.command == "groups":
        return _groups(repo, project, bool(getattr(args, "json", False)))
    if args.command == "activate":
        return _activate(repo, project, args.groups)
    if args.command == "deactivate":
        return _deactivate(project, args.groups)
    if args.command == "sync":
        return _sync(repo, project)
    if args.command == "validate":
        return _validate(repo, project, bool(getattr(args, "json", False)))
    if args.command == "rules":
        return _rules(repo, project, args)
    if args.command == "preview":
        return _preview(repo, project, args)
    if args.command == "resolve":
        return _resolve(
            repo,
            project,
            bool(getattr(args, "json", False)),
            str(getattr(args, "mode", MODE_PROJECT)),
        )
    if args.command == "tool":
        return _tool(repo, args)
    if args.command == "plugin":
        return _plugin(repo, args)
    raise HNFlowError(f"unknown command: {args.command}")


def _list(repo: Path, project: Path) -> int:
    groups = discover_groups(repo, project=project)
    print("Capability groups:")
    for group in groups:
        label = f"{group.name}@{group.version}" if group.version else group.name
        print(f"  {label}  {group.description}")
    tools = discover_tools(repo)
    print("\nTools:")
    for tool in tools:
        print(f"  {tool.short_id}  [{tool.provider}]  {tool.description}")
    return 0


def _groups(repo: Path, project: Path, as_json: bool) -> int:
    document = groups_document(repo, project)
    if as_json:
        _write_json(document)
        return 0
    print(f"repo: {document['repo']}")
    print(f"project: {document['project']}")
    for group in document["groups"]:
        mark = "*" if group["active"] else " "
        label = f"{group['name']}@{group['version']}" if group["version"] else group["name"]
        counts = ", ".join(
            f"{kind} {len(items)}" for kind, items in group["contents"].items() if items
        )
        print(f" {mark} {label}  {group['description']}")
        if counts:
            print(f"     {counts}")
    return 0


def _status(project: Path) -> int:
    stack = read_stack(project)
    if stack is None:
        print(f"no {stack_path(project)}")
        return 0
    print(f"schema_version: {stack.schema_version}")
    if stack.core:
        print(f"core: {stack.core.name}@{stack.core.version}")
    if stack.agents_md != "off":
        print(f"agents_md: {stack.agents_md}")
    if not stack.groups:
        print("groups: (none)")
    else:
        print("groups:")
        for ref in stack.groups:
            label = f"{ref.name}@{ref.version}" if ref.version else ref.name
            extra = ""
            if ref.disable:
                extra += f" disable={len(ref.disable)}"
            print(f"  {label}{extra}")
    if lock_path(project).is_file():
        print(f"lock: {lock_path(project)}")
    return 0


def _init(repo: Path, project: Path, core_value: str) -> int:
    core = parse_ref(core_value) if core_value else default_core()
    stack = init_stack(project, core)
    _remember_repository(repo, core)
    path = stack_path(project)
    print(f"created {path}")
    if stack.groups:
        print(f"existing groups: {len(stack.groups)}")
    return 0


def _remember_repository(repo: Path, core: GroupRef | None = None) -> None:
    """Record the repository (and default core) in the global config.

    A read-only or missing home config directory must not abort activation:
    the project stack is already written and remains usable, so this only
    degrades to a warning that the next run has to pass ``--repo`` again.
    """
    try:
        config = read_global_config()
        config["schema_version"] = 1
        config["repository"] = str(repo.resolve())
        if core is not None:
            config["core"] = {"name": core.name, "version": core.version}
        write_global_config(config)
    except OSError as exc:
        print(
            f"warning: cannot update {global_config_path()}: {exc}",
            file=sys.stderr,
        )


def _info(repo: Path, project: Path, name: str, version: str) -> int:
    group = load_group(repo, name, version or None, project=project)
    stack = read_stack(project)
    if stack is not None:
        for ref in stack.groups:
            if ref.name != group.name:
                continue
            group.disabled_rules = list(ref.disable)
            break
    label = f"{group.name}@{group.version}" if group.version else group.name
    print(label)
    print(f"guid: {group.guid}")
    print(f"description: {group.description}")
    print(f"extends: {', '.join(group.extends) or '(none)'}")
    print(f"tools: {', '.join(group.tools) or '(none)'}")
    print(f"rules: {len(group.rules)}")
    print(f"agents: {len(group.agents)}")
    print(f"commands: {len(group.commands)}")
    print(f"skills: {_count_skills(group.root / 'skills')}")
    print(f"path: {group.root}")
    return 0


def _count_skills(root: Path) -> int:
    if not root.is_dir():
        return 0
    return sum(1 for _ in root.rglob("SKILL.md"))


def _activate(repo: Path, project: Path, values: list[str]) -> int:
    _remember_repository(repo)
    for value in values:
        ref = parse_ref(value)
        stack = activate(project, ref, repo)
        group = load_group(repo, ref.name, ref.version or None, project=project)
        missing = missing_tools(repo, [group])
        label = f"{group.name}@{group.version}" if group.version else group.name
        print(f"activated {label}")
        for item in missing:
            print(f"  warning: missing tool {item}", file=sys.stderr)
        print(f"  stack: {stack_path(project)} ({len(stack.groups)} groups)")
    return 0


def _deactivate(project: Path, values: list[str]) -> int:
    for name in values:
        stack = deactivate(project, name)
        print(f"deactivated {name} ({len(stack.groups)} groups)")
    return 0


def _sync(repo: Path, project: Path) -> int:
    stack = read_stack(project)
    if stack is None:
        raise HNFlowError(f"no {stack_path(project)}; run `hnflow-stack init`")
    plan = build_plan(repo, project, stack, strict=True)
    groups = plan.group_metas
    missing = missing_tools(repo, groups)
    path = write_lock(
        repo,
        project,
        stack,
        groups=groups,
        fingerprint=plan.fingerprint,
        warnings=plan.warnings,
    )
    print(f"resolved {len(groups)} groups")
    print(f"lock: {path}")
    print(f"tools: {len(tools_for_groups(repo, groups))}")
    for warning in plan.warnings:
        print(f"warning: {warning}", file=sys.stderr)
    for item in missing:
        print(f"warning: missing tool {item}", file=sys.stderr)
    return 0


def _resolve(repo: Path, project: Path, as_json: bool, mode: str) -> int:
    plan = resolve_project(repo, project, mode=mode)
    if as_json:
        output = json.dumps(
            plan.to_dict(), ensure_ascii=False, separators=(",", ":")
        )
        sys.stdout.buffer.write((output + "\n").encode("utf-8"))
        sys.stdout.buffer.flush()
        return 0

    print(f"active: {'true' if plan.active else 'false'}")
    print(f"mode: {plan.mode}")
    if plan.core is not None:
        print(f"core: {plan.core.name}@{plan.core.version}")
    print(f"groups: {len(plan.groups)}")
    print(f"rules: {len(plan.rules)}")
    print(f"skills: {len(plan.skills)}")
    print(f"agents: {len(plan.agents)}")
    print(f"commands: {len(plan.commands)}")
    print(f"mcp: {len(plan.mcp)}")
    for warning in plan.warnings:
        print(f"warning: {warning}", file=sys.stderr)
    return 0


def _validate(repo: Path, project: Path, as_json: bool) -> int:
    """Strictly resolve the stack and report every diagnostic."""
    stack = read_stack(project)
    if stack is None:
        raise HNFlowError(f"no {stack_path(project)}; run `hnflow-stack init`")
    try:
        plan = build_plan(repo, project, stack, strict=True)
    except HNFlowError as exc:
        if as_json:
            payload = json.dumps(
                {"ok": False, "error": str(exc)}, ensure_ascii=False
            )
            sys.stdout.buffer.write((payload + "\n").encode("utf-8"))
            sys.stdout.buffer.flush()
        else:
            print(f"error: {exc}", file=sys.stderr)
        return 1
    if as_json:
        payload = json.dumps(
            {
                "ok": True,
                "groups": len(plan.group_metas),
                "rules": len(plan.rules),
                "warnings": list(plan.warnings),
                "fingerprint": plan.fingerprint,
            },
            ensure_ascii=False,
        )
        sys.stdout.buffer.write((payload + "\n").encode("utf-8"))
        sys.stdout.buffer.flush()
        return 0
    print("ok")
    print(f"groups: {len(plan.group_metas)}")
    print(f"rules: {len(plan.rules)}")
    for warning in plan.warnings:
        print(f"warning: {warning}", file=sys.stderr)
    return 0


def _rules(repo: Path, project: Path, args: argparse.Namespace) -> int:
    plan = resolve_project(repo, project, mode=str(args.mode))
    if args.rules_command == "list":
        if args.json:
            payload = {
                "mode": plan.mode,
                "rules": [rule.to_dict() for rule in plan.rules],
            }
            _write_json(payload)
            return 0
        for rule in plan.rules:
            mark = " (on demand)" if rule.on_demand else ""
            print(f"{rule.id}  ({rule.scope}{mark} · priority {rule.priority})")
        return 0
    if args.rules_command == "show":
        relative = relative_to(project, Path(args.for_path))
        matched = [rule for rule in plan.rules if rule_applies(rule, relative)]
        if args.json:
            payload = {
                "mode": plan.mode,
                "for": relative,
                "rules": [rule.to_dict() for rule in matched],
            }
            _write_json(payload)
            return 0
        if not matched:
            print(f"no rules apply to {relative}")
            return 0
        for rule in matched:
            print(f"--- {rule.id} ({rule.scope}) ---")
            try:
                text = Path(rule.path).read_text(encoding="utf-8-sig")
            except (OSError, UnicodeError) as exc:
                print(f"cannot read {rule.path}: {exc}", file=sys.stderr)
                continue
            print(text.rstrip())
        return 0
    raise HNFlowError(f"unknown rules command: {args.rules_command}")


STATUS_MARKS = {
    "injected": "+",
    "indexed": "~",
    "omitted": "!",
    "skipped": "-",
    "active": "*",
}


def _preview(repo: Path, project: Path, args: argparse.Namespace) -> int:
    view = build_session(
        repo,
        project,
        agent_name=str(getattr(args, "agent", "") or "") or None,
        cwd=str(getattr(args, "cwd", "") or "") or None,
        mode=str(getattr(args, "mode", MODE_PROJECT)),
        max_rules_bytes=int(getattr(args, "max_rules_bytes", DEFAULT_RULES_BYTES)),
        with_text=bool(getattr(args, "with_text", False)),
        text_bytes=int(getattr(args, "text_bytes", DEFAULT_TEXT_BYTES)),
    )
    if bool(getattr(args, "json", False)):
        _write_json(view.to_dict())
        return 0
    _print_session(view)
    return 0


def _print_session(view: SessionView) -> None:
    agent = view.agent
    label = str(agent.get("label") or agent.get("group") or "")
    layer = agent.get("model") or "-"
    print(f"Project   {view.project}  (mode: {view.mode})")
    print(f"Cwd       {view.cwd or '.'}")
    print(f"Agent     {agent.get('name')}  [{label}]  model: {layer} (default: {view.model.get('default')})")
    budget = view.budget
    print(
        f"Rules     {budget.get('used')}/{budget.get('limit')} bytes"
        f" · {budget.get('omitted')} omitted"
    )
    for section in view.sections:
        if not section.items:
            continue
        print(f"\n{section.title} ({len(section.items)})")
        for item in section.items:
            mark = STATUS_MARKS.get(item.status, "·")
            detail = item.group or ""
            extra = f"  [{detail}]" if detail else ""
            size = f"  {item.bytes}B" if item.bytes else ""
            print(f"  {mark} {item.id}{extra}{size}  {item.summary}")
    if view.warnings:
        print("\nWarnings")
        for warning in view.warnings:
            print(f"  ! {warning}")


def _write_json(payload: dict[str, object]) -> None:
    output = json.dumps(payload, ensure_ascii=False, separators=(",", ":"))
    sys.stdout.buffer.write((output + "\n").encode("utf-8"))
    sys.stdout.buffer.flush()


def _models(args: argparse.Namespace) -> int:
    """Dispatch ``hnflow-stack models`` commands without requiring a repository."""
    command = args.models_command
    if command == "catalog":
        return _emit_models(catalog_document(), bool(args.json))
    if command == "show":
        return _emit_models(models_summary(args.agent), bool(args.json))
    if command == "bind":
        state = bind_layer(
            args.layer,
            agent=args.agent,
            provider=args.provider,
            model=args.model,
            reasoning_effort=args.effort or None,
        )
        print(f"bound {args.layer} for {args.agent}")
        _print_binding_warnings(state.warnings)
        return 0
    if command == "unbind":
        state = unbind_layer(args.layer, agent=args.agent)
        print(f"unbound {args.layer} for {args.agent}")
        _print_binding_warnings(state.warnings)
        return 0
    if command == "default":
        layer = None if args.layer == "none" else args.layer
        state = set_default_layer(layer, agent=args.agent)
        print(f"default: {state.default or '(none)'}")
        _print_binding_warnings(state.warnings)
        return 0
    if command == "migrate":
        state = migrate_legacy(agent=args.agent)
        print(
            f"migrated {len(state.bindings)} layer(s) for {args.agent}"
            + (f"; default: {state.default}" if state.default else "")
        )
        _print_binding_warnings(state.warnings)
        return 0
    raise HNFlowError(f"unknown models command: {command}")


def _emit_models(document: dict[str, object], as_json: bool) -> int:
    """Render a catalog or binding summary."""
    if as_json:
        output = json.dumps(document, ensure_ascii=False, separators=(",", ":"))
        sys.stdout.buffer.write((output + "\n").encode("utf-8"))
        sys.stdout.buffer.flush()
        return 0
    if isinstance(document.get("config"), str):
        print(f"config: {document['config']}")
    print(f"default: {document.get('default', '')}")
    if "agent" in document:
        print(f"agent: {document['agent']}")
    layers = document.get("layers")
    for layer in layers if isinstance(layers, list) else []:
        if not isinstance(layer, dict):
            continue
        binding = layer.get("binding")
        if isinstance(binding, dict):
            route = f"{binding.get('provider')}/{binding.get('model')}"
            effort = binding.get("reasoningEffort")
            if effort:
                route = f"{route} · {effort}"
        else:
            route = "未绑定"
        print(f"  {str(layer.get('id', '')):<10} {layer.get('label', '')}  {route}")
    _print_binding_warnings(document.get("warnings", []))
    return 0


def _print_binding_warnings(warnings: object) -> None:
    if not isinstance(warnings, list):
        return
    for warning in warnings:
        print(f"warning: {warning}", file=sys.stderr)


def _tool(repo: Path, args: argparse.Namespace) -> int:
    if args.tool_command == "list":
        for tool in discover_tools(repo):
            print(f"{tool.id}  {tool.short_id}  [{tool.provider}]  {tool.description}")
        return 0
    extra = list(args.args)
    if extra and extra[0] == "--":
        extra = extra[1:]
    if args.tool_command == "exec":
        return exec_in_tool(repo, args.tool, extra)
    return run_tool(repo, args.tool, extra, serve=args.tool_command == "serve")


def _plugin(repo: Path, args: argparse.Namespace) -> int:
    if args.plugin_command == "list":
        for manifest in discover_plugins(repo):
            print(f"{manifest.get('agent')}@{manifest.get('version')}  {manifest.get('root')}")
        return 0
    if args.plugin_command == "status":
        data = plugin_status(repo, args.agent)
        print(f"agent: {data['agent']}")
        print(f"version: {data['version']}")
        print(f"source: {data['source']}")
        if data["target"]:
            print(f"target: {data['target']}")
            print(f"installed: {data['installed']}")
            print(f"skills: {data['skills_target']} ({data['skills_installed']})")
        else:
            print("install: external (dsh plugin add)")
        return 0
    raise HNFlowError(f"unknown plugin command: {args.plugin_command}")


if __name__ == "__main__":
    sys.exit(main())
