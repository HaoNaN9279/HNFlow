"""Workflow definition layer data models — pure Pydantic v2 schemas.

This module defines the serialisable data model for workflow definitions:
enums for port/node types and Pydantic models for Port, Node, Edge,
WorkflowMetadata, and WorkflowDefinition.  It has zero dependency on
langgraph, langchain, or any app-layer code.
"""

from __future__ import annotations

import logging
import re
from enum import StrEnum
from typing import TYPE_CHECKING, Any

from pydantic import BaseModel, ConfigDict, Field, field_validator

from deerflow.config.agents_config import AGENT_NAME_PATTERN

if TYPE_CHECKING:
    from deerflow.skills.catalog import SkillCatalog

logger = logging.getLogger(__name__)

# ── ID validation ───────────────────────────────────────────────────────────────

_ID_PATTERN = re.compile(r"^[A-Za-z0-9_-]{1,64}$")


def _validate_id(value: str) -> str:
    """Validate a workflow component id against the safe-identifier contract."""
    if not isinstance(value, str) or not _ID_PATTERN.match(value):
        raise ValueError(f"id must match {_ID_PATTERN.pattern!r} (1-64 safe ASCII chars); got {value!r}")
    return value


def _validate_agent_name(value: str | None) -> str | None:
    """Validate an optional custom-agent name (primary identity binding).

    ``None`` is legal — an AI node without an explicit binding falls back to the
    default lead agent. Any non-``None`` value must be a string matching the
    shared :data:`AGENT_NAME_PATTERN` (``^[A-Za-z0-9-]+$``) imported from
    ``deerflow.config.agents_config``.
    """
    if value is None:
        return None
    if not isinstance(value, str):
        raise ValueError(f"agent_name must be a string or None; got {value!r}")
    if not AGENT_NAME_PATTERN.fullmatch(value):
        raise ValueError(f"agent_name must match {AGENT_NAME_PATTERN.pattern!r}; got {value!r}")
    return value


# ── Enums ───────────────────────────────────────────────────────────────────────


class PortType(StrEnum):
    """Data type for a workflow port.

    ``data`` / ``file`` / ``bool`` / ``enum`` are the original scalar-ish
    contracts; ``number`` / ``array`` / ``record`` extend the set for the
    richer payloads AI nodes and structured-output contracts produce
    (numeric values, JSON arrays, and JSON objects respectively).  Port
    compatibility stays strict same-type matching (``ports_compatible``).
    """

    DATA = "data"
    FILE = "file"
    BOOL = "bool"
    ENUM = "enum"
    NUMBER = "number"
    ARRAY = "array"
    RECORD = "record"


class NodeType(StrEnum):
    """Workflow node kind with ``category:name`` values."""

    # Flow control
    FLOW_START = "flow:start"
    FLOW_END = "flow:end"
    FLOW_IF = "flow:if"
    FLOW_SWITCH = "flow:switch"
    FLOW_LOOP = "flow:loop"
    FLOW_PARALLEL = "flow:parallel"
    FLOW_WAIT = "flow:wait"
    FLOW_TRY = "flow:try"

    # Data transformation
    DATA_ASSIGN = "data:assign"
    DATA_CONVERT = "data:convert"
    DATA_FILE = "data:file"
    DATA_ASSET = "data:asset"
    DATA_SHARED = "data:shared"
    DATA_KNOWLEDGE = "data:knowledge"
    DATA_JSON = "data:json"
    DATA_REGEX = "data:regex"

    # External tools
    TOOL_BASH = "tool:bash"
    TOOL_HTTP = "tool:http"
    TOOL_NOTIFY = "tool:notify"
    TOOL_LOG = "tool:log"
    # §25 工具节点化：直接用图调用网关里的一个工具（不经 AI 节点工具集）。
    # ``params.tool`` 必填；``params.provider`` 可选（builtin/sandbox/app 消歧）。
    TOOL_INVOKE = "tool:invoke"

    # AI
    AI_LLM_AGENT = "ai:llm_agent"

    # Local professional software (N5, plan §6.7 / §17)
    APP_LAUNCH = "app:launch"
    APP_SCRIPT = "app:script"
    APP_WAIT = "app:wait"
    APP_COLLECT = "app:collect"

    # Human interaction
    HUMAN_TASK = "human:task"

    # Composition
    NESTED_SUBWORKFLOW = "nested:subworkflow"


# ── Models ──────────────────────────────────────────────────────────────────────


class Port(BaseModel):
    """A typed input or output port on a workflow node."""

    model_config = ConfigDict(extra="forbid")

    name: str
    type: PortType
    required: bool = False
    description: str | None = None


class Node(BaseModel):
    """A single node in a workflow graph."""

    model_config = ConfigDict(extra="forbid")

    id: str
    type: NodeType
    inputs: list[Port] = Field(default_factory=list)
    outputs: list[Port] = Field(default_factory=list)
    params: dict[str, Any] = Field(default_factory=dict)
    # Capability supplier groups, not identity candidates: each group contributes
    # its allowed-tools union plus rules merged into the prompt. The node's
    # primary identity is bound via ``agent_name`` instead.
    capability_groups: list[str] = Field(default_factory=list)
    # Primary identity binding for AI nodes: a custom-agent name (e.g.
    # "publisher"). ``None`` (default) means the lead agent. Must match the
    # custom-agent name grammar ``^[A-Za-z0-9-]+$``.
    agent_name: str | None = None

    @field_validator("id", mode="before")
    @classmethod
    def _validate_id(cls, value: str) -> str:
        return _validate_id(value)

    @field_validator("agent_name", mode="before")
    @classmethod
    def _validate_agent_name(cls, value: str | None) -> str | None:
        return _validate_agent_name(value)


class Edge(BaseModel):
    """A directed edge connecting two node ports."""

    model_config = ConfigDict(extra="forbid")

    source: str
    source_port: str
    target: str
    target_port: str
    condition: str | None = None


class WorkflowMetadata(BaseModel):
    """Workflow-level metadata (capability group snapshot placeholder)."""

    model_config = ConfigDict(extra="forbid")

    resolved_groups: list[str] | None = None
    created_at: str | None = None
    updated_at: str | None = None
    # 非幂等/危险节点（如 bash、http）的 id 列表，运行时确认留 T18；
    # None = 无待审核节点。
    pending_review_nodes: list[str] | None = None
    # 全量能力快照（§5.6）：一次运行的可复现依据。保存时固化，包含能力包
    # ``guid@v<version>``、模型 id/版本、采样参数等。None = 尚未固化。
    lockfile: dict[str, Any] | None = None
    # N14 共享工作区（黑板）：共享变量名 → 写策略 ``overwrite`` | ``array`` |
    # ``conflict``（默认 overwrite）。声明是全局的，避免同一 ``wf:shared:<name>``
    # 通道出现两种语义。None = 无共享变量。
    shared: dict[str, str] | None = None
    # N14 §24.10 运行级预算：``{max_total_tokens: int, on_exceed: warn|abort}``。
    # 由 compiler 节点包装层聚合每个节点的保留通道 ``wf:<node>:__token_usage``
    # 后强制；None = 不设运行级上限（节点级上限由 §24.5 autonomy 承担）。
    budget: dict[str, Any] | None = None
    # N14 §24.8 定义内嵌评测套件：``{fixture: ReplayFixture, cases: [...],
    # require_pass?: bool, on_miss?: error|live, initial_state?: {...}}``。
    # 定义自带 golden 夹具 + 断言，保存时可在 ``require_pass`` 下作为回归门，
    # 也可经 ``POST /api/workflows/{id}/evaluate`` 按需回放（离线确定性）。
    # None = 无内嵌套件（既有定义零行为变化）。
    evals: dict[str, Any] | None = None


class WorkflowDefinition(BaseModel):
    """Top-level workflow definition — the serialisable root document."""

    model_config = ConfigDict(extra="forbid")

    id: str
    name: str = Field(min_length=1)
    version: str = "0.1.0"
    nodes: list[Node] = Field(default_factory=list)
    edges: list[Edge] = Field(default_factory=list)
    metadata: WorkflowMetadata = Field(default_factory=WorkflowMetadata)

    @field_validator("id", mode="before")
    @classmethod
    def _validate_id(cls, value: str) -> str:
        return _validate_id(value)


# ── Capability-group resolution ────────────────────────────────────────────────


def collect_resolved_groups(
    definition: WorkflowDefinition,
    catalog: SkillCatalog,
) -> list[str]:
    """Collect the capability groups a workflow depends on, resolved to ``guid@version``.

    Walks every node's ``capability_groups`` (skill names at authoring time),
    maps each name to its skill via the catalog, and emits ``<guid>@v<version>``
    strings.  Names that do not resolve to an installed skill are skipped
    (backward compatible — a node may reference a not-yet-installed skill).
    Results are deduplicated and order-stable.
    """
    raw_entries: list[str] = []
    name_to_skill: dict[str, Any] = {s.name: s for s in catalog.skills}

    for node in definition.nodes:
        for name in node.capability_groups:
            skill = name_to_skill.get(name)
            if skill is None:
                logger.warning(
                    "Workflow node %r references unknown capability group %r — skipping",
                    node.id,
                    name,
                )
                continue
            if not skill.skill_id:
                logger.warning(
                    "Skill %r has no skill_id (public/legacy), skipping resolved group",
                    skill.name,
                )
                continue
            raw_entries.append(f"{skill.skill_id}@v{skill.version}")

    return list(dict.fromkeys(raw_entries))


def validate_capability_groups(
    definition: WorkflowDefinition,
    catalog: SkillCatalog,
) -> list[str]:
    """Validate that every referenced capability group exists in the catalog.

    Returns one error message per ``(node_id, group_name)`` whose skill is not
    installed.  Pure function — no IO.

    This is the *static existence* half of §5.4's capability-group validation;
    version-range checking lives in the dependency graph / lockfile layer.  It
    is intentionally exposed as a non-raising reporter: callers that need
    fail-open save behavior (a node may legitimately reference a skill that is
    installed later) collect and log the result, while callers that need a hard
    gate inspect a non-empty return value.
    """
    errors: list[str] = []
    known_names = {s.name for s in catalog.skills}
    for node in definition.nodes:
        for name in node.capability_groups:
            if name not in known_names:
                errors.append(f"node '{node.id}': capability group '{name}' is not installed")
    return errors
