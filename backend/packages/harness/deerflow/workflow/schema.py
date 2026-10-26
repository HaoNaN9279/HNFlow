"""Workflow definition layer data models — pure Pydantic v2 schemas.

This module defines the serialisable data model for workflow definitions:
enums for port/node types and Pydantic models for Port, Node, Edge,
WorkflowMetadata, and WorkflowDefinition.  It has zero dependency on
langgraph, langchain, or any app-layer code.
"""

from __future__ import annotations

import logging
import re
from collections.abc import Mapping
from enum import StrEnum
from typing import TYPE_CHECKING, Any

from pydantic import BaseModel, ConfigDict, Field, field_validator

from deerflow.config.agents_config import AGENT_NAME_PATTERN

if TYPE_CHECKING:
    from deerflow.capability_groups import CapabilityGroup

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
    #: Pinned formal-specification reference (``SpecRef``).  Kept as a distinct
    #: type so a verifier cannot be wired from an arbitrary data payload.
    SPEC = "spec"


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
    FLOW_HANDOFF = "flow:handoff"

    # Data transformation
    DATA_ASSIGN = "data:assign"
    DATA_CONVERT = "data:convert"
    DATA_FILE = "data:file"
    DATA_ASSET = "data:asset"
    DATA_SHARED = "data:shared"
    DATA_SCHEMA = "data:schema"
    DATA_JSON = "data:json"
    DATA_REGEX = "data:regex"
    #: Formal-specification authoring / lifecycle node.
    DATA_SPEC = "data:spec"

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
    # Authoring-only capability-group selector (compile-time wiring).
    AI_CAPABILITY_GROUP = "ai:capability_group"
    # Reads the reserved final-prompt channel an AI node publishes.
    AI_PROMPT_PREVIEW = "ai:prompt_preview"

    # Local professional software (N5, plan §6.7 / §17)
    APP_LAUNCH = "app:launch"
    APP_SCRIPT = "app:script"
    APP_WAIT = "app:wait"
    APP_COLLECT = "app:collect"

    # Human interaction
    HUMAN_TASK = "human:task"
    # Explicit approve/reject gate with a static retry edge.
    HUMAN_REVIEW = "human:review"

    # Formal verification
    #: Three-valued verification gate.  Branch outputs are ``verified`` /
    #: ``failed`` / ``inconclusive``; the compiler routes on ``status``.
    VERIFY_GATE = "verify:gate"

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
    # 画布位置等纯 UI 数据。它不参与运行语义，但必须被 schema 显式接受：
    # 前端把 ``metadata.canvas`` 与定义一起保存，``extra="forbid"`` 曾让
    # 每次画布保存都 422。
    canvas: dict[str, Any] | None = None


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


def declared_capability_groups(node: Node) -> list[str]:
    """Return the capability-group identifiers a node declares."""
    return list(node.capability_groups)


def _group_for_reference(reference: str, groups: Mapping[str, CapabilityGroup]) -> CapabilityGroup | None:
    return groups.get(reference)


def collect_resolved_groups(
    definition: WorkflowDefinition,
    groups: Mapping[str, CapabilityGroup],
) -> list[str]:
    """Resolve referenced capability groups to ``guid@version`` snapshots.

    *groups* maps both group names and GUIDs to their current
    :class:`CapabilityGroup`.  Unknown references are logged and skipped so a
    save remains fail-open while the group is being authored.
    """
    resolved: list[str] = []
    for node in definition.nodes:
        for reference in declared_capability_groups(node):
            group = _group_for_reference(reference, groups)
            if group is None:
                logger.warning(
                    "Workflow node %r references unknown capability group %r — skipping",
                    node.id,
                    reference,
                )
                continue
            resolved.append(f"{group.guid}@v{group.version}")
            for base in group.extends:
                parent = _group_for_reference(base, groups)
                if parent is None:
                    logger.warning(
                        "Workflow node %r capability group %r extends unknown group %r",
                        node.id,
                        group.name,
                        base,
                    )
                    continue
                resolved.append(f"{parent.guid}@v{parent.version}")
    return list(dict.fromkeys(resolved))


def validate_capability_groups(
    definition: WorkflowDefinition,
    groups: Mapping[str, CapabilityGroup],
) -> list[str]:
    """Return one error for every referenced capability group that is missing."""
    errors: list[str] = []
    for node in definition.nodes:
        for reference in declared_capability_groups(node):
            if reference not in groups:
                errors.append(f"node '{node.id}': capability group '{reference}' is not installed")
    return errors


def validate_capability_tool_refs(
    definition: WorkflowDefinition,
    *,
    user_id: str | None = None,
    project_roots: tuple = (),
) -> list[str]:
    """Validate tool ids declared by installed capability groups.

    Custom ``tool:`` refs are checked against the package registry at save time.
    Provider refs (``mcp:`` / ``builtin:`` / ``sandbox:`` / ``app:``) are
    validated at run time because availability depends on live config/servers.
    Unknown capability groups stay fail-open here, matching the existing save
    contract while the group is being authored.
    """
    from deerflow.capability_groups import CapabilityGroupError, load_capability_group
    from deerflow.tools.packages import ToolPackageError, load_tool_package

    errors: list[str] = []
    for node in definition.nodes:
        for reference in declared_capability_groups(node):
            try:
                group = load_capability_group(reference, user_id=user_id, project_roots=project_roots)
            except CapabilityGroupError:
                # Unknown groups are an existing fail-open authoring state.
                continue
            for tool_ref in group.tools:
                prefix, _, value = tool_ref.partition(":")
                if prefix == "tool":
                    identifier, separator, version = value.rpartition("@v")
                    if not separator or not identifier or not version:
                        errors.append(f"node '{node.id}': capability group '{group.name}' has invalid tool reference '{tool_ref}' (expected tool:<guid>@v<version>)")
                        continue
                    try:
                        load_tool_package(identifier, version=version)
                    except ToolPackageError as exc:
                        errors.append(f"node '{node.id}': capability group '{group.name}' references unavailable tool package '{tool_ref}': {exc}")
                elif prefix == "mcp":
                    server, separator, tool_name = value.partition(":")
                    if not separator or not server or not tool_name or ":" in tool_name:
                        errors.append(f"node '{node.id}': capability group '{group.name}' has invalid MCP tool reference '{tool_ref}' (expected mcp:<server>:<tool>)")
                elif prefix not in {"builtin", "sandbox", "app"} or not value:
                    errors.append(f"node '{node.id}': capability group '{group.name}' has invalid tool reference '{tool_ref}'")
    return errors
