"""Resolve project stacks into agent-agnostic injection plans."""

from __future__ import annotations

import hashlib
import json
import re
from pathlib import Path

from hnflow_stack.errors import HNFlowError
from hnflow_stack.frontmatter import frontmatter_text, parse_frontmatter
from hnflow_stack.loader import discover_tools
from hnflow_stack.model import (
    GroupMeta,
    GroupRef,
    ModuleMeta,
    ProjectStack,
    ResolvedAgent,
    ResolvedCommand,
    ResolvedFlow,
    ResolvedGroup,
    ResolvedPlan,
    ResolvedRule,
    ResolvedSkill,
    ToolMeta,
    _flow_files,
    read_json,
)
from hnflow_stack.model_layers import (
    DEFAULT_MODEL_LAYER,
    is_model_layer,
    model_layer_catalog,
)
from hnflow_stack.modules import (
    activate_modules,
    discover_modules,
    nested_agents_md_files,
)
from hnflow_stack.naming import (
    DEFAULT_PREFIX,
    canonical_name,
    content_key,
    qualified_id,
)
from hnflow_stack.project import read_stack, resolve_order
from hnflow_stack.repo import default_core

SCHEMA_VERSION = 2
MODE_PROJECT = "project"
MODE_CAPABILITIES = "capabilities"
_AGENTS_MD_NESTED = "nested"
_MODES = {MODE_PROJECT, MODE_CAPABILITIES}
_RULE_SCOPES = {"global", "module", "paths"}
_AGENT_MODES = {"primary", "subagent", "all"}
_SKILL_NAME = re.compile(r"^[a-z0-9]+(-[a-z0-9]+)*$")
_COMMAND_NAME = re.compile(r"^[a-z][a-z0-9_-]*$")
_MODEL_ID = re.compile(r"^[a-z0-9][a-z0-9_-]*$")
_FLOW_ID = re.compile(r"^[a-z0-9][a-z0-9._-]*$")
_HOST_MODEL_FIELDS = (
    "provider",
    "temperature",
    "permission",
    "permissions",
    "reasoningEffort",
    "reasoning_effort",
    "modelName",
    "model_name",
)
_AGENTS_MD_NAME = "agents-md"


def resolve_project(
    repo: Path, project: Path, *, mode: str = MODE_PROJECT
) -> ResolvedPlan:
    """Read a project's stack and build a fail-open injection plan.

    ``mode="HNFlow"`` keeps Core loaded even when the project has no
    ``.hnflow/stack.json`` and reports ``active=true``; the default
    ``project`` mode preserves the historical inactive result.
    """
    stack = read_stack(project)
    return build_plan(repo, project, stack, strict=False, mode=mode)


def build_plan(
    repo: Path,
    project: Path,
    stack: ProjectStack | None,
    *,
    strict: bool = False,
    mode: str = MODE_PROJECT,
) -> ResolvedPlan:
    """Build a resolved plan from an already-loaded stack."""
    requested = _normalize_mode(mode)
    warnings: list[str] = []
    if requested == MODE_PROJECT and stack is None:
        return ResolvedPlan(
            schema_version=SCHEMA_VERSION,
            active=False,
            mode=requested,
            repository=_posix(repo),
            project=_posix(project),
            core=None,
            groups=[],
            rules=[],
            skills=[],
            agents={},
            commands={},
            mcp={},
            warnings=warnings,
            fingerprint=_fingerprint(repo, None, [], {}, requested),
            model_layers=model_layer_catalog(),
            model_default=DEFAULT_MODEL_LAYER,
        )

    stack = _stack_for_mode(stack, requested)
    if stack is None:  # pragma: no cover - defensive, mode helpers guarantee a stack
        raise HNFlowError("mode requires a project stack")
    groups = resolve_order(
        repo, stack, strict=strict, warnings=warnings, project=project
    )
    core_name = stack.core.name if stack.core is not None else ""
    core_meta = next((group for group in groups if group.name == core_name), None)
    if requested == MODE_CAPABILITIES and core_meta is None:
        # Core is mandatory in this mode: a stale configured version must not
        # remove it. Retry with the newest available core version.
        fallback = ProjectStack(
            schema_version=stack.schema_version,
            core=GroupRef("core", ""),
            agents=list(stack.agents),
            groups=list(stack.groups),
            agents_md=stack.agents_md,
        )
        fallback_groups = resolve_order(
            repo, fallback, strict=strict, warnings=warnings, project=project
        )
        fallback_core = next(
            (group for group in fallback_groups if group.name == "core"), None
        )
        if fallback_core is not None:
            groups = fallback_groups
            core_meta = fallback_core
            core_name = fallback_core.name
            warnings.append(
                f"core {stack.core.name}@{stack.core.version} unavailable; using core@{fallback_core.version}"
            )
    content = _collect_content(repo, project, stack, groups, warnings, strict)
    names: dict[str, dict[str, str]] = content["names"]  # type: ignore[assignment]
    module_metas = {group.name: list(group.active_modules) for group in groups}
    return ResolvedPlan(
        schema_version=SCHEMA_VERSION,
        active=True,
        mode=requested,
        repository=_posix(repo),
        project=_posix(project),
        core=_group_summary(core_meta) if core_meta is not None else None,
        groups=[
            _group_summary(group)
            for group in groups
            if core_meta is None or group.name != core_meta.name
        ],
        rules=content["rules"],  # type: ignore[arg-type]
        skills=content["skills"],  # type: ignore[arg-type]
        agents=content["agents"],  # type: ignore[arg-type]
        commands=content["commands"],  # type: ignore[arg-type]
        flows=content["flows"],  # type: ignore[arg-type]
        mcp=content["mcp"],  # type: ignore[arg-type]
        warnings=warnings,
        fingerprint=_fingerprint(
            repo, stack, groups, content["tools"], requested, content["files"]
        ),
        model_layers=model_layer_catalog(),
        model_default=DEFAULT_MODEL_LAYER,
        names=names,
        group_metas=groups,
        module_metas=module_metas,
    )


def _normalize_mode(mode: str) -> str:
    """Validate a resolve mode."""
    value = str(mode)
    if value not in _MODES:
        raise HNFlowError(
            f"unknown resolve mode: {value} (expected one of {', '.join(sorted(_MODES))})"
        )
    return value


def _stack_for_mode(
    stack: ProjectStack | None, mode: str
) -> ProjectStack | None:
    """Apply the mode's Core rule before resolution.

    HNFlow mode (the DSH plugin's mode) always keeps a Core reference, even
    without ``.hnflow/stack.json``; project mode leaves the stack untouched.
    """
    if mode != MODE_CAPABILITIES:
        return stack
    if stack is None:
        return ProjectStack(core=default_core())
    if stack.core is None:
        return ProjectStack(
            schema_version=stack.schema_version,
            core=default_core(),
            agents=list(stack.agents),
            groups=list(stack.groups),
            agents_md=stack.agents_md,
        )
    return stack


def _collect_content(
    repo: Path,
    project: Path,
    stack: ProjectStack,
    groups: list[GroupMeta],
    warnings: list[str],
    strict: bool,
) -> dict[str, object]:
    tools = _tool_index(repo)
    used_tools: dict[str, ToolMeta] = {}
    rules: list[ResolvedRule] = []
    skills: list[ResolvedSkill] = []
    agents: dict[str, ResolvedAgent] = {}
    commands: dict[str, ResolvedCommand] = {}
    flows: list[ResolvedFlow] = []
    mcp: dict[str, dict[str, object]] = {}
    files: set[Path] = set()
    names: dict[str, dict[str, str]] = {"agents": {}, "commands": {}, "skills": {}}
    agent_owners: dict[str, str] = {}
    command_owners: dict[str, str] = {}

    for group in groups:
        group.active_modules = activate_modules(
            group,
            discover_modules(group, warnings=warnings, strict=strict),
            warnings=warnings,
            strict=strict,
        )
        rules.extend(_collect_group_rules(group, warnings, strict, files))
        for module in group.active_modules:
            _collect_skills(module.root / "skills", group, module.path, skills, warnings)
        _collect_skills(group.root / "skills", group, "", skills, warnings)
        _collect_agents(group, agents, names, agent_owners, warnings, strict, files)
        _collect_commands(group, commands, names, command_owners, warnings, strict, files)
        _collect_flows(group, flows, warnings, files)
        _collect_mcp(group, tools, used_tools, mcp, warnings)

    if stack.agents_md == _AGENTS_MD_NESTED:
        rules.extend(_collect_nested_agents_md(project, files, warnings))

    deduped_skills = _dedupe_skills(skills, names, warnings, strict)
    return {
        "rules": rules,
        "skills": deduped_skills,
        "agents": agents,
        "commands": commands,
        "flows": flows,
        "mcp": mcp,
        "tools": used_tools,
        "files": files,
        "names": names,
    }


def _collect_group_rules(
    group: GroupMeta,
    warnings: list[str],
    strict: bool,
    files: set[Path],
) -> list[ResolvedRule]:
    """Collect root and module rules, apply scope, ordering, and overrides."""
    entries: list[tuple[ResolvedRule, list[str]]] = []
    for module_path, module_paths, rule_files, agents_md in _rule_scopes(group):
        for file in rule_files:
            parsed = _read_frontmatter(file, warnings)
            if parsed is None:
                continue
            files.add(file)
            entry = _rule_entry(
                parsed.data, parsed.body, file, group, module_path, module_paths, warnings
            )
            if entry is not None:
                entries.append(entry)
        if agents_md is not None:
            files.add(agents_md)
            try:
                agents_md.read_text(encoding="utf-8-sig")
            except (OSError, UnicodeError) as exc:
                warnings.append(f"cannot read {agents_md.name}: {exc}")
                continue
            entries.append(
                _agents_md_entry(agents_md, group, module_path, module_paths)
            )

    entries.sort(key=lambda item: (_scope_depth(item[0]), item[0].priority, item[0].path))
    disabled = set(group.disabled_rules)
    kept: list[ResolvedRule] = []
    for rule, overrides in entries:
        if rule.id in disabled or rule.name in disabled:
            continue
        if overrides:
            kept = [existing for existing in kept if existing.name not in overrides]
        kept.append(rule)
    return kept


def _rule_scopes(
    group: GroupMeta,
) -> list[tuple[str, list[str], list[Path], Path | None]]:
    scopes: list[tuple[str, list[str], list[Path], Path | None]] = [
        ("", [], group.rules, group.agents_md)
    ]
    scopes.extend(
        (module.path, list(module.paths), module.rules, module.agents_md)
        for module in group.active_modules
    )
    return scopes


def _scope_depth(rule: ResolvedRule) -> int:
    return rule.module.count("/") + 1 if rule.module else 0


def _rule_entry(
    data: dict[str, object],
    body: str,
    file: Path,
    group: GroupMeta,
    module_path: str,
    module_paths: list[str],
    warnings: list[str],
) -> tuple[ResolvedRule, list[str]] | None:
    name = frontmatter_text(data.get("name"))
    if not name:
        warnings.append(f"rule {file.name} missing required frontmatter: name")
        return None
    default_scope = _default_scope(module_path, module_paths)
    declared_scope = frontmatter_text(data.get("scope"))
    scope = declared_scope or default_scope
    if scope not in _RULE_SCOPES:
        warnings.append(
            f"rule {file.name} has invalid scope: {scope} (expected one of "
            f"{', '.join(sorted(_RULE_SCOPES))})"
        )
        scope = default_scope
    if scope == "module" and not module_path:
        warnings.append(
            f"rule {file.name} uses scope 'module' outside a module; using 'global'"
        )
        scope = "global"
    paths = _str_values(data.get("paths"))
    if not declared_scope and paths:
        # Declaring paths without a scope narrows the rule to those paths.
        scope = "paths"
    if scope == "paths" and not paths:
        paths = list(module_paths)
    if scope == "paths" and not paths:
        warnings.append(
            f"rule {file.name} uses scope 'paths' without paths; using 'module'"
        )
        scope = default_scope if default_scope != "paths" else "global"
    rule = ResolvedRule(
        name=name,
        path=_posix(file),
        group=group.name,
        id=qualified_id(group.name, module_path, name),
        module=module_path,
        kind="rule",
        scope=scope,
        paths=paths,
        always=_to_bool(data.get("always"), default=True),
        priority=_to_int(data.get("priority"), default=0),
        description=frontmatter_text(data.get("description")),
    )
    return rule, _str_values(data.get("overrides"))


def _agents_md_entry(
    file: Path,
    group: GroupMeta,
    module_path: str,
    module_paths: list[str],
) -> tuple[ResolvedRule, list[str]]:
    rule = ResolvedRule(
        name=_AGENTS_MD_NAME,
        path=_posix(file),
        group=group.name,
        id=qualified_id(group.name, module_path, _AGENTS_MD_NAME),
        module=module_path,
        kind="agents",
        scope=_default_scope(module_path, module_paths),
        paths=list(module_paths),
        always=True,
        priority=0,
        description="",
    )
    return rule, []


def _default_scope(module_path: str, module_paths: list[str]) -> str:
    if not module_path:
        return "global"
    return "paths" if module_paths else "module"


def _collect_nested_agents_md(
    project: Path, files: set[Path], warnings: list[str]
) -> list[ResolvedRule]:
    """Absorb project ``AGENTS.md`` files below the project root."""
    base = project.resolve()
    rules: list[ResolvedRule] = []
    for path in nested_agents_md_files(project):
        resolved = path.resolve()
        try:
            relative = resolved.relative_to(base).as_posix()
        except ValueError:
            continue
        directory = relative.rsplit("/", 1)[0] if "/" in relative else ""
        if not directory:
            # The project root AGENTS.md belongs to the host, not to HNFlow.
            continue
        try:
            path.read_text(encoding="utf-8-sig")
        except (OSError, UnicodeError) as exc:
            warnings.append(f"cannot read {relative}: {exc}")
            continue
        files.add(resolved)
        rules.append(
            ResolvedRule(
                name=_AGENTS_MD_NAME,
                path=resolved.as_posix(),
                group="project",
                id=qualified_id("project", directory, _AGENTS_MD_NAME),
                module=directory,
                kind="agents",
                scope="paths",
                paths=[f"{directory}/**"],
                always=True,
                priority=0,
                description="",
            )
        )
    rules.sort(key=lambda rule: (_scope_depth(rule), rule.path))
    return rules


def _collect_skills(
    root: Path,
    group: GroupMeta,
    module_path: str,
    skills: list[ResolvedSkill],
    warnings: list[str],
) -> None:
    for directory in _skill_dirs(root):
        _collect_skill(directory, group, module_path, skills, warnings)


def _collect_skill(
    directory: Path,
    group: GroupMeta,
    module_path: str,
    skills: list[ResolvedSkill],
    warnings: list[str],
) -> None:
    file = directory / "SKILL.md"
    parsed = _read_frontmatter(file, warnings)
    if parsed is None:
        return
    _check_host_model_fields(parsed.data, f"skill {directory.name}", warnings)
    name = frontmatter_text(parsed.data.get("name"))
    description = frontmatter_text(parsed.data.get("description"))
    missing = [
        key
        for key, value in (("name", name), ("description", description))
        if not value
    ]
    if missing:
        warnings.append(
            f"skill {directory.name} missing required frontmatter: {', '.join(missing)}"
        )
        return
    if len(name) > 64 or _SKILL_NAME.match(name) is None:
        warnings.append(f"skill {directory.name} has invalid name: {name}")
        return
    if name != directory.name:
        warnings.append(
            f"skill {directory.name} name does not match directory: {name}"
        )
        return
    if "metadata" in parsed.data:
        warnings.append(f"skill {directory.name} must not define metadata")
        return
    if len(description) > 1024:
        warnings.append(
            f"skill {directory.name} description exceeds 1024 characters"
        )
        return
    skills.append(
        ResolvedSkill(
            name=name,
            path=_posix(directory),
            group=group.name,
            description=description,
            model=_read_model(
                parsed.data, f"skill {directory.name}", warnings
            ),
            id=qualified_id(group.name, module_path, name),
            module=module_path,
            host=canonical_name(DEFAULT_PREFIX, group.name, module_path, name),
        )
    )


def _dedupe_skills(
    skills: list[ResolvedSkill],
    names: dict[str, dict[str, str]],
    warnings: list[str],
    strict: bool,
) -> list[ResolvedSkill]:
    """Keep one skill per host name; the later declaration wins."""
    by_host: dict[str, ResolvedSkill] = {}
    for skill in skills:
        previous = by_host.get(skill.host)
        if previous is not None and previous.id != skill.id:
            _report(
                warnings,
                strict,
                f"skill host name collision: {skill.host} "
                f"({previous.id} and {skill.id}); keeping {skill.id}",
            )
        by_host[skill.host] = skill
    result = list(by_host.values())
    for skill in result:
        names["skills"][skill.id] = skill.host
    return result


def _collect_agents(
    group: GroupMeta,
    agents: dict[str, ResolvedAgent],
    names: dict[str, dict[str, str]],
    owners: dict[str, str],
    warnings: list[str],
    strict: bool,
    files: set[Path],
) -> None:
    scopes = [("", group.agents)]
    scopes.extend((module.path, module.agents) for module in group.active_modules)
    for module_path, agent_files in scopes:
        for file in agent_files:
            parsed = _read_frontmatter(file, warnings)
            if parsed is None:
                continue
            files.add(file)
            label = f"agent {file.name}"
            _check_host_model_fields(parsed.data, label, warnings)
            name = frontmatter_text(parsed.data.get("name"))
            description = frontmatter_text(parsed.data.get("description"))
            mode = frontmatter_text(parsed.data.get("mode"))
            missing = [
                key
                for key, value in (
                    ("name", name),
                    ("description", description),
                    ("mode", mode),
                )
                if not value
            ]
            if missing:
                warnings.append(
                    f"{label} missing required frontmatter: {', '.join(missing)}"
                )
                continue
            if mode not in _AGENT_MODES:
                warnings.append(f"{label} has invalid mode: {mode}")
                continue
            agent_id = qualified_id(group.name, module_path, name)
            key = content_key(module_path, name)
            _claim(owners, key, agent_id, "agent", warnings, strict)
            agents[key] = ResolvedAgent(
                name=name,
                description=description,
                mode=mode,
                system=parsed.body,
                source=_posix(file),
                group=group.name,
                model=_read_model(parsed.data, label, warnings),
                id=agent_id,
                module=module_path,
                system_path=_posix(file),
                label=f"{group.name}/{module_path}" if module_path else group.name,
            )
            names["agents"][agent_id] = key


def _collect_commands(
    group: GroupMeta,
    commands: dict[str, ResolvedCommand],
    names: dict[str, dict[str, str]],
    owners: dict[str, str],
    warnings: list[str],
    strict: bool,
    files: set[Path],
) -> None:
    scopes = [("", group.commands)]
    scopes.extend((module.path, module.commands) for module in group.active_modules)
    for module_path, command_files in scopes:
        for file in command_files:
            parsed = _read_frontmatter(file, warnings)
            if parsed is None:
                continue
            files.add(file)
            label = f"command {file.name}"
            _check_host_model_fields(parsed.data, label, warnings)
            name = frontmatter_text(parsed.data.get("name"))
            description = frontmatter_text(parsed.data.get("description"))
            missing = [
                key
                for key, value in (("name", name), ("description", description))
                if not value
            ]
            if missing:
                warnings.append(
                    f"{label} missing required frontmatter: {', '.join(missing)}"
                )
                continue
            if len(name) > 64 or _COMMAND_NAME.match(name) is None:
                warnings.append(f"{label} has invalid name: {name}")
                continue
            command_id = qualified_id(group.name, module_path, name)
            key = content_key(module_path, name)
            _claim(owners, key, command_id, "command", warnings, strict)
            command = ResolvedCommand(
                name=name,
                description=description,
                agent=frontmatter_text(parsed.data.get("agent")) or None,
                template=parsed.body,
                source=_posix(file),
                group=group.name,
                model=_read_model(parsed.data, label, warnings),
                id=command_id,
                module=module_path,
                template_path=_posix(file),
            )
            commands[key] = command
            names["commands"][command_id] = canonical_name(
                DEFAULT_PREFIX, group.name, module_path, name
            )


def _collect_flows(
    group: GroupMeta,
    flows: list[ResolvedFlow],
    warnings: list[str],
    files: set[Path],
) -> None:
    """Collect ``flows/*.flow.json`` from the group root and active modules."""
    seen = {flow.id for flow in flows}
    roots = [("", group.root)]
    roots.extend((module.path, module.root) for module in group.active_modules)
    for module_path, root in roots:
        for file in _flow_files(root / "flows"):
            files.add(file)
            try:
                data = read_json(file)
            except HNFlowError as exc:
                warnings.append(str(exc))
                continue
            if data.get("schemaVersion") != 2:
                warnings.append(f"{file}: unsupported flow schemaVersion")
                continue
            definition = data.get("flow")
            if not isinstance(definition, dict):
                warnings.append(f"{file}: missing flow object")
                continue
            flow_id = str(definition.get("id") or "").strip()
            if not _FLOW_ID.match(flow_id):
                warnings.append(f"{file}: invalid flow id '{flow_id}'")
                continue
            qualified = qualified_id(group.name, module_path, flow_id)
            if qualified in seen:
                warnings.append(f"{file}: duplicate flow id '{qualified}'")
                continue
            seen.add(qualified)
            tags = definition.get("tags")
            requires = definition.get("requires")
            flows.append(
                ResolvedFlow(
                    id=qualified,
                    flow_id=flow_id,
                    name=str(definition.get("name") or flow_id),
                    description=str(definition.get("description") or ""),
                    group=group.name,
                    module=module_path,
                    path=file.as_posix(),
                    tags=[str(tag) for tag in tags] if isinstance(tags, list) else [],
                    version=str(definition.get("version") or group.version),
                    requires=[str(name) for name in requires] if isinstance(requires, list) else [],
                )
            )


def _collect_mcp(
    group: GroupMeta,
    tools: dict[str, ToolMeta],
    used_tools: dict[str, ToolMeta],
    mcp: dict[str, dict[str, object]],
    warnings: list[str],
) -> None:
    scopes: list[tuple[str, list[str]]] = [("", group.tools)]
    scopes.extend((module.alias, module.tools) for module in group.active_modules)
    for alias, tool_ids in scopes:
        for tool_id in tool_ids:
            tool = tools.get(tool_id)
            if tool is None:
                warnings.append(f"tool not found for {group.name}: {tool_id}")
                continue
            used_tools[tool.id] = tool
            if not isinstance(tool.mcp, dict):
                continue
            server = tool.mcp
            if server.get("enabled") is False:
                continue
            server_name = str(server.get("name") or tool.name)
            suffix = f"{group.name}_{alias}_{server_name}" if alias else f"{group.name}_{server_name}"
            mcp[f"capability:{suffix}"] = {
                str(name): value for name, value in server.items() if name != "name"
            }


def _claim(
    owners: dict[str, str],
    key: str,
    entry_id: str,
    kind: str,
    warnings: list[str],
    strict: bool,
) -> None:
    """Record a plan key owner and flag genuine duplicates.

    The same key from a *different* group is the documented "later group
    overrides" behaviour; only the same qualified id twice is an error.
    """
    previous = owners.get(key)
    if previous is not None and previous == entry_id:
        _report(
            warnings,
            strict,
            f"duplicate {kind} {entry_id}: the same qualified id is defined twice",
        )
    owners[key] = entry_id


def _read_model(
    data: dict[str, object], label: str, warnings: list[str]
) -> str | None:
    """Read and validate a ``model`` layer id.

    The platform catalog is the single source of layer ids, so an unknown id is
    a content error here instead of a runtime-only plugin warning.
    """
    value = frontmatter_text(data.get("model"))
    if not value:
        return None
    if len(value) > 32 or _MODEL_ID.match(value) is None or not is_model_layer(value):
        warnings.append(f"{label} has invalid model layer: {value}")
        return None
    return value


def _check_host_model_fields(
    data: dict[str, object], label: str, warnings: list[str]
) -> None:
    """Reject host-specific model settings in capability-group content.

    A group may only name a platform layer. Provider ids, concrete model names,
    temperature, reasoning effort, and permission flags belong to the host
    adapter or its local binding, never to shared content.
    """
    for key in _HOST_MODEL_FIELDS:
        if key in data:
            warnings.append(
                f"{label} must not declare {key}; use model: <layer> instead"
            )


def _read_frontmatter(path: Path, warnings: list[str]):
    try:
        text = path.read_text(encoding="utf-8-sig")
    except (OSError, UnicodeError) as exc:
        warnings.append(f"cannot read {path.name}: {exc}")
        return None
    return parse_frontmatter(text)


def _skill_dirs(root: Path) -> list[Path]:
    if not root.is_dir():
        return []
    found: list[Path] = []

    def walk(directory: Path, depth: int) -> None:
        try:
            entries = sorted(directory.iterdir(), key=lambda path: path.name)
        except OSError:
            return
        if any(entry.is_file() and entry.name == "SKILL.md" for entry in entries):
            found.append(directory)
            return
        if depth >= 6:
            return
        for entry in entries:
            if entry.is_dir() and not entry.name.startswith("."):
                walk(entry, depth + 1)

    walk(root, 0)
    return sorted(found)


def _tool_index(repo: Path) -> dict[str, ToolMeta]:
    index: dict[str, ToolMeta] = {}
    for tool in discover_tools(repo):
        index[tool.id] = tool
        index[tool.short_id] = tool
    return index


def _group_summary(group: GroupMeta) -> ResolvedGroup:
    return ResolvedGroup(
        guid=group.guid,
        name=group.name,
        version=group.version,
        description=group.description,
        root=_posix(group.root),
        permissions=list(group.permissions),
        extends=list(group.extends),
        tools=list(group.all_tools),
        modules=[_module_summary(module) for module in group.active_modules],
    )


def _module_summary(module: ModuleMeta) -> dict[str, object]:
    return {
        "path": module.path,
        "alias": module.alias,
        "title": module.title,
        "description": module.description,
        "root": _posix(module.root),
        "paths": list(module.paths),
        "default": module.default,
        "depends": list(module.depends),
        "tools": list(module.tools),
    }


def _fingerprint(
    repo: Path,
    stack: ProjectStack | None,
    groups: list[GroupMeta],
    tools: dict[str, ToolMeta],
    mode: str = MODE_PROJECT,
    files: object = None,
) -> str:
    digest = hashlib.sha256()
    digest.update(
        f"HNFlow-resolve-v{SCHEMA_VERSION}:{mode}\0".encode("utf-8")
    )
    for layer in model_layer_catalog():
        digest.update(f"model-layer:{layer['id']}\0".encode("utf-8"))
    if stack is not None:
        digest.update(
            json.dumps(
                stack.to_dict(), sort_keys=True, ensure_ascii=False
            ).encode("utf-8")
        )
    for group in groups:
        digest.update(f"group:{group.name}@{group.version}\0".encode("utf-8"))
        _hash_file(digest, group.root / "group.json", repo)
        for module in group.active_modules:
            meta_path = module.root / "module.json"
            if meta_path.is_file():
                _hash_file(digest, meta_path, repo)
    collected = files if isinstance(files, set) else set()
    for file in sorted(collected):
        _hash_file(digest, file, repo)
    for tool in sorted(tools.values(), key=lambda item: item.id):
        _hash_file(digest, tool.root / "tool.json", repo)
    return digest.hexdigest()


def _hash_file(digest: "hashlib._Hash", path: Path, repo: Path) -> None:
    try:
        content = path.read_bytes()
    except OSError:
        return
    try:
        relative = path.relative_to(repo).as_posix()
    except ValueError:
        relative = path.name
    digest.update(relative.encode("utf-8"))
    digest.update(b"\0")
    digest.update(content)
    digest.update(b"\0")


def _report(warnings: list[str], strict: bool, message: str) -> None:
    if strict:
        raise HNFlowError(message)
    warnings.append(message)


def _str_values(value: object) -> list[str]:
    if isinstance(value, list):
        return [str(item) for item in value if str(item).strip()]
    text = frontmatter_text(value)
    if not text:
        return []
    return [item.strip() for item in text.split(",") if item.strip()]


def _to_bool(value: object, *, default: bool) -> bool:
    text = frontmatter_text(value).strip().lower()
    if not text:
        return default
    if text in {"true", "yes", "on", "1"}:
        return True
    if text in {"false", "no", "off", "0"}:
        return False
    return default


def _to_int(value: object, *, default: int) -> int:
    text = frontmatter_text(value).strip()
    if not text:
        return default
    try:
        return int(text)
    except ValueError:
        return default


def _posix(path: Path) -> str:
    return path.resolve().as_posix()
