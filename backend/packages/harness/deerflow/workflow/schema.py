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


# ── Enums ───────────────────────────────────────────────────────────────────────


class PortType(StrEnum):
    """Data type for a workflow port."""

    DATA = "data"
    FILE = "file"
    BOOL = "bool"
    ENUM = "enum"


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

    # Data transformation
    DATA_ASSIGN = "data:assign"
    DATA_CONVERT = "data:convert"
    DATA_FILE = "data:file"
    DATA_JSON = "data:json"
    DATA_REGEX = "data:regex"

    # External tools
    TOOL_BASH = "tool:bash"
    TOOL_HTTP = "tool:http"
    TOOL_NOTIFY = "tool:notify"
    TOOL_LOG = "tool:log"

    # AI
    AI_LLM_AGENT = "ai:llm_agent"

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
    capability_groups: list[str] = Field(default_factory=list)

    @field_validator("id", mode="before")
    @classmethod
    def _validate_id(cls, value: str) -> str:
        return _validate_id(value)


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
