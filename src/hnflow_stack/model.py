"""Data models for capability groups, tools, and project stacks."""

from __future__ import annotations

import json
from dataclasses import dataclass, field
from pathlib import Path

from hnflow_stack.errors import HNFlowError
from hnflow_stack.model_layers import DEFAULT_MODEL_LAYER

STACK_SCHEMA_VERSION = 2


@dataclass
class GroupRef:
    """Reference to one capability group version in the project stack."""

    name: str
    version: str = ""
    disable: list[str] = field(default_factory=list)


@dataclass
class GroupMeta:
    """Metadata from ``group.json`` plus resolved paths."""

    guid: str
    name: str
    version: str
    description: str
    permissions: list[str] = field(default_factory=list)
    extends: list[str] = field(default_factory=list)
    tools: list[str] = field(default_factory=list)
    tool_permissions: dict[str, list[str]] = field(default_factory=dict)
    root: Path = field(default_factory=Path)
    disabled_rules: list[str] = field(default_factory=list)

    @property
    def rules_root(self) -> Path:
        return self.root / "rules"

    @property
    def rules(self) -> list[Path]:
        return _md_rglob(self.rules_root)

    @property
    def agents(self) -> list[Path]:
        return _md_rglob(self.root / "agents")

    @property
    def commands(self) -> list[Path]:
        return _md_rglob(self.root / "commands")

    @property
    def skills_dir(self) -> Path | None:
        path = self.root / "skills"
        return path if path.is_dir() else None

    @property
    def references(self) -> list[Path]:
        return _md_rglob(self.root / "references")

    @property
    def flows(self) -> list[Path]:
        return _flow_files(self.root / "flows")

    @property
    def agents_md(self) -> Path | None:
        path = self.root / "AGENTS.md"
        return path if path.is_file() else None


@dataclass
class ToolMeta:
    """Metadata from ``tool.json`` plus its package root."""

    guid: str
    name: str
    tool_name: str
    version: str
    description: str
    provider: str
    permissions: list[str] = field(default_factory=list)
    entrypoint: str | None = None
    idempotent: bool = True
    source: dict[str, object] = field(default_factory=dict)
    run: dict[str, object] | None = None
    mcp: dict[str, object] | None = None
    root: Path = field(default_factory=Path)

    @property
    def id(self) -> str:
        return f"tool:{self.guid}@v{self.version}"

    @property
    def short_id(self) -> str:
        return f"{self.name}@{self.version}"


@dataclass
class ResolvedGroup:
    """One capability group in a resolved injection plan."""

    guid: str
    name: str
    version: str
    description: str
    root: str
    permissions: list[str] = field(default_factory=list)
    extends: list[str] = field(default_factory=list)
    tools: list[str] = field(default_factory=list)

    def to_dict(self) -> dict[str, object]:
        return {
            "guid": self.guid,
            "name": self.name,
            "version": self.version,
            "description": self.description,
            "root": self.root,
            "permissions": list(self.permissions),
            "extends": list(self.extends),
            "tools": list(self.tools),
        }


@dataclass
class ResolvedRule:
    """One validated rule file with its injection policy.

    ``scope`` is ``global`` (always injected) or ``paths`` (injected when the
    session working directory matches ``paths``). ``on_demand`` rules are never
    injected: only their description and file path reach the model, which reads
    the full text when the task touches that topic.
    """

    name: str
    path: str
    group: str
    id: str = ""
    kind: str = "rule"
    scope: str = "global"
    paths: list[str] = field(default_factory=list)
    on_demand: bool = False
    priority: int = 0
    description: str = ""

    def to_dict(self) -> dict[str, object]:
        return {
            "name": self.name,
            "id": self.id,
            "path": self.path,
            "group": self.group,
            "kind": self.kind,
            "scope": self.scope,
            "paths": list(self.paths),
            "on_demand": self.on_demand,
            "priority": self.priority,
            "description": self.description,
        }


@dataclass
class ResolvedSkill:
    """One validated skill directory."""

    name: str
    path: str
    group: str
    description: str = ""
    model: str | None = None
    id: str = ""
    host: str = ""

    def to_dict(self) -> dict[str, object]:
        data: dict[str, object] = {
            "name": self.name,
            "id": self.id,
            "path": self.path,
            "group": self.group,
            "description": self.description,
        }
        if self.model:
            data["model"] = self.model
        return data


@dataclass
class ResolvedAgent:
    """One validated agent definition."""

    name: str
    description: str
    mode: str
    system: str
    source: str
    group: str
    model: str | None = None
    id: str = ""
    system_path: str = ""
    label: str = ""

    def to_dict(self) -> dict[str, object]:
        data: dict[str, object] = {
            "name": self.name,
            "id": self.id,
            "description": self.description,
            "mode": self.mode,
            "system": self.system,
            "system_path": self.system_path,
            "source": self.source,
            "group": self.group,
            "label": self.label,
        }
        if self.model:
            data["model"] = self.model
        return data


@dataclass
class ResolvedCommand:
    """One validated command definition."""

    name: str
    description: str
    template: str
    source: str
    group: str
    agent: str | None = None
    model: str | None = None
    id: str = ""
    template_path: str = ""

    def to_dict(self) -> dict[str, object]:
        data: dict[str, object] = {
            "name": self.name,
            "id": self.id,
            "description": self.description,
            "template": self.template,
            "template_path": self.template_path,
            "source": self.source,
            "group": self.group,
        }
        if self.agent:
            data["agent"] = self.agent
        if self.model:
            data["model"] = self.model
        return data


@dataclass
class ResolvedFlow:
    """One workflow definition owned by a capability group."""

    name: str
    group: str
    path: str
    id: str = ""
    flow_id: str = ""
    description: str = ""
    tags: list[str] = field(default_factory=list)
    version: str = ""
    requires: list[str] = field(default_factory=list)

    def to_dict(self) -> dict[str, object]:
        return {
            "id": self.id,
            "flow_id": self.flow_id,
            "name": self.name,
            "path": self.path,
            "group": self.group,
            "description": self.description,
            "tags": list(self.tags),
            "version": self.version,
            "requires": list(self.requires),
        }


@dataclass
class ResolvedPlan:
    """Resolved, agent-agnostic injection plan."""

    schema_version: int
    active: bool
    mode: str
    repository: str
    project: str
    core: ResolvedGroup | None
    groups: list[ResolvedGroup]
    rules: list[ResolvedRule]
    skills: list[ResolvedSkill]
    agents: dict[str, ResolvedAgent]
    commands: dict[str, ResolvedCommand]
    mcp: dict[str, dict[str, object]]
    warnings: list[str]
    fingerprint: str
    flows: list[ResolvedFlow] = field(default_factory=list)
    model_layers: list[dict[str, object]] = field(default_factory=list)
    model_default: str = DEFAULT_MODEL_LAYER
    names: dict[str, dict[str, str]] = field(default_factory=dict)
    group_metas: list[GroupMeta] = field(default_factory=list, repr=False)

    def to_dict(self) -> dict[str, object]:
        """Serialize the plan into the single resolve API shape."""
        return {
            "schema_version": self.schema_version,
            "active": self.active,
            "mode": self.mode,
            "repository": self.repository,
            "project": self.project,
            "core": self.core.to_dict() if self.core is not None else None,
            "groups": [group.to_dict() for group in self.groups],
            "rules": [rule.to_dict() for rule in self.rules],
            "skills": [skill.to_dict() for skill in self.skills],
            "agents": {
                name: agent.to_dict() for name, agent in self.agents.items()
            },
            "commands": {
                name: command.to_dict() for name, command in self.commands.items()
            },
            "flows": [flow.to_dict() for flow in self.flows],
            "mcp": dict(self.mcp),
            "warnings": list(self.warnings),
            "fingerprint": self.fingerprint,
            "model_layers": [dict(layer) for layer in self.model_layers],
            "model_default": self.model_default,
            "names": {
                kind: dict(entries) for kind, entries in self.names.items()
            },
        }


@dataclass
class ProjectStack:
    """Contents of ``.hnflow/stack.json``."""

    schema_version: int = STACK_SCHEMA_VERSION
    core: GroupRef | None = None
    agents: list[str] = field(default_factory=list)
    groups: list[GroupRef] = field(default_factory=list)
    agents_md: str = "off"

    def to_dict(self) -> dict[str, object]:
        data: dict[str, object] = {
            "schema_version": STACK_SCHEMA_VERSION,
            "agents": list(self.agents),
            "groups": [_group_ref_dict(ref) for ref in self.groups],
        }
        if self.core is not None:
            data["core"] = {"name": self.core.name, "version": self.core.version}
        if self.agents_md and self.agents_md != "off":
            data["agents_md"] = self.agents_md
        return data

    @classmethod
    def from_dict(cls, data: dict[str, object]) -> ProjectStack:
        if not isinstance(data, dict):
            raise HNFlowError("stack.json must be a JSON object")
        schema = data.get("schema_version", STACK_SCHEMA_VERSION)
        if schema != STACK_SCHEMA_VERSION:
            raise HNFlowError(
                f"unsupported stack schema_version: {schema} "
                f"(expected {STACK_SCHEMA_VERSION})"
            )
        core_data = data.get("core")
        core = None
        if isinstance(core_data, dict):
            core = GroupRef(
                name=str(core_data.get("name", "core")),
                version=str(core_data.get("version", "0.1.0")),
            )
        groups: list[GroupRef] = []
        raw_groups = data.get("groups", [])
        if not isinstance(raw_groups, list):
            raise HNFlowError("stack.json 'groups' must be an array")
        for item in raw_groups:
            if not isinstance(item, dict) or not item.get("name"):
                raise HNFlowError("stack.json group entries need a name")
            groups.append(
                GroupRef(
                    name=str(item["name"]),
                    version=str(item.get("version", "")),
                    disable=_str_list(item.get("disable")),
                )
            )
        agents = data.get("agents", [])
        agents_md = str(data.get("agents_md", "off") or "off")
        if agents_md not in {"off", "nested"}:
            raise HNFlowError(
                f"stack.json agents_md must be 'off' or 'nested', not '{agents_md}'"
            )
        return cls(
            schema_version=STACK_SCHEMA_VERSION,
            core=core,
            agents=[str(item) for item in agents] if isinstance(agents, list) else [],
            groups=groups,
            agents_md=agents_md,
        )


def _group_ref_dict(ref: GroupRef) -> dict[str, object]:
    """Serialize a group reference, omitting empty optional fields."""
    data: dict[str, object] = {"name": ref.name}
    if ref.version:
        data["version"] = ref.version
    if ref.disable:
        data["disable"] = list(ref.disable)
    return data


def _md_rglob(directory: Path) -> list[Path]:
    if not directory.is_dir():
        return []
    found: list[Path] = []
    for path in directory.rglob("*.md"):
        if not path.is_file():
            continue
        relative = path.relative_to(directory)
        if any(part.startswith(".") for part in relative.parts):
            continue
        found.append(path)
    return sorted(found)


def _flow_files(directory: Path) -> list[Path]:
    """Return workflow definitions under *directory* in stable order."""
    if not directory.is_dir():
        return []
    found: list[Path] = []
    for path in directory.rglob("*.flow.json"):
        if not path.is_file():
            continue
        relative = path.relative_to(directory)
        if any(part.startswith(".") for part in relative.parts):
            continue
        found.append(path)
    return sorted(found)


def _str_list(value: object) -> list[str]:
    if isinstance(value, list):
        return [str(item) for item in value]
    return []


def read_json(path: Path) -> dict[str, object]:
    """Read a JSON object from *path*."""
    try:
        data = json.loads(path.read_text(encoding="utf-8-sig"))
    except FileNotFoundError as exc:
        raise HNFlowError(f"missing file: {path}") from exc
    except UnicodeDecodeError as exc:
        raise HNFlowError(f"invalid UTF-8 in {path}: {exc}") from exc
    except json.JSONDecodeError as exc:
        raise HNFlowError(f"invalid JSON in {path}: {exc}") from exc
    except OSError as exc:
        raise HNFlowError(f"cannot read {path}: {exc}") from exc
    if not isinstance(data, dict):
        raise HNFlowError(f"{path} must contain a JSON object")
    return data
