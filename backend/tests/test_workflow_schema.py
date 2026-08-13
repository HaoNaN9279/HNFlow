"""Tests for deerflow.workflow.schema — Pydantic v2 workflow data models."""

import copy
import json

import pytest
from pydantic import ValidationError

from deerflow.workflow.schema import (
    Edge,
    Node,
    NodeType,
    Port,
    PortType,
    WorkflowDefinition,
    WorkflowMetadata,
)

# ── 构造与往返 ──────────────────────────────────────────────────────────────────


class TestConstructionAndRoundTrip:
    """Construction, deep copy, model_dump / model_validate round-trip."""

    def test_minimal_workflow_definition(self):
        """WorkflowDefinition can be constructed with only id and name."""
        wf = WorkflowDefinition(id="test-wf", name="Test Workflow")
        assert wf.id == "test-wf"
        assert wf.name == "Test Workflow"
        assert wf.version == "0.1.0"
        assert wf.nodes == []
        assert wf.edges == []

    def test_deepcopy_preserves_equality(self):
        """copy.deepcopy of a WorkflowDefinition compares equal to original."""
        wf = WorkflowDefinition(id="wf-1", name="My Workflow")
        copied = copy.deepcopy(wf)
        assert copied == wf
        # mutate copy to confirm independence
        copied.nodes.append(Node(id="n1", type=NodeType.FLOW_START))
        assert wf.nodes == []

    def test_model_dump_roundtrip(self):
        """model_dump() → model_validate() preserves all fields."""
        wf = WorkflowDefinition(
            id="wf-round",
            name="Round Trip",
            nodes=[
                Node(id="start", type=NodeType.FLOW_START),
                Node(id="end", type=NodeType.FLOW_END),
            ],
            edges=[
                Edge(source="start", source_port="out", target="end", target_port="in"),
            ],
        )
        dumped = wf.model_dump()
        reloaded = WorkflowDefinition.model_validate(dumped)
        assert reloaded == wf
        assert reloaded.model_dump() == dumped

    def test_metadata_resolved_groups_defaults_to_none(self):
        """metadata.resolved_groups defaults to None when not provided."""
        wf = WorkflowDefinition(id="wf-meta", name="Meta Test")
        assert wf.metadata.resolved_groups is None

    def test_metadata_resolved_groups_explicit_preserved(self):
        """Explicit resolved_groups survives serialisation round-trip."""
        wf = WorkflowDefinition(
            id="wf-meta2",
            name="Meta Test 2",
            metadata=WorkflowMetadata(resolved_groups=["group-a", "group-b"]),
        )
        dumped = wf.model_dump()
        assert dumped["metadata"]["resolved_groups"] == ["group-a", "group-b"]
        reloaded = WorkflowDefinition.model_validate(dumped)
        assert reloaded.metadata.resolved_groups == ["group-a", "group-b"]


# ── 合法完整图 ──────────────────────────────────────────────────────────────────


class TestValidCompleteGraph:
    """A realistic three-node workflow with ports, edges, and a condition."""

    def test_complete_graph_json_serializable(self):
        """Complete graph serialises to plain JSON without errors."""
        wf = WorkflowDefinition(
            id="wf-graph",
            name="Complete Graph",
            nodes=[
                Node(
                    id="start",
                    type=NodeType.FLOW_START,
                    outputs=[Port(name="out", type=PortType.DATA)],
                ),
                Node(
                    id="assign",
                    type=NodeType.DATA_ASSIGN,
                    inputs=[Port(name="in", type=PortType.DATA, required=True)],
                    outputs=[Port(name="out", type=PortType.DATA)],
                    params={"key": "value"},
                ),
                Node(
                    id="end",
                    type=NodeType.FLOW_END,
                    inputs=[Port(name="in", type=PortType.DATA)],
                ),
            ],
            edges=[
                Edge(source="start", source_port="out", target="assign", target_port="in"),
                Edge(
                    source="assign",
                    source_port="out",
                    target="end",
                    target_port="in",
                    condition="success",
                ),
            ],
        )
        raw = wf.model_dump()
        # Must be JSON-serialisable
        serialized = json.dumps(raw)
        assert isinstance(serialized, str)
        # Round-trip through JSON
        round_tripped = json.loads(serialized)
        assert round_tripped["id"] == "wf-graph"
        assert len(round_tripped["nodes"]) == 3
        assert len(round_tripped["edges"]) == 2
        assert round_tripped["edges"][1]["condition"] == "success"


# ── 非法 id 拒绝（参数化）───────────────────────────────────────────────────────


INVALID_IDS = [
    "a/b",  # slash
    "a\\b",  # backslash
    "..",  # parent dir
    "a b",  # space
    "x" * 65,  # too long (>64)
    "",  # empty
]


class TestInvalidIdRejection:
    """ID validator rejects unsafe characters and out-of-range lengths."""

    @pytest.mark.parametrize("bad_id", INVALID_IDS)
    def test_invalid_node_id_rejected(self, bad_id: str):
        """Node with an invalid id must raise ValidationError."""
        with pytest.raises(ValidationError):
            Node(id=bad_id, type=NodeType.FLOW_START)

    @pytest.mark.parametrize("bad_id", INVALID_IDS)
    def test_invalid_workflow_definition_id_rejected(self, bad_id: str):
        """WorkflowDefinition with an invalid id must raise ValidationError."""
        with pytest.raises(ValidationError):
            WorkflowDefinition(id=bad_id, name="Test")


# ── 枚举严格 ───────────────────────────────────────────────────────────────────


class TestEnumStrictness:
    """NodeType and PortType reject unknown values."""

    def test_valid_node_type_accepted(self):
        """Node with a valid type string is accepted."""
        node = Node(id="n1", type="flow:start")
        assert node.type == NodeType.FLOW_START

    def test_invalid_node_type_rejected(self):
        """Node with a bogus type raises ValidationError."""
        with pytest.raises(ValidationError):
            Node(id="n2", type="bogus")

    def test_invalid_port_type_rejected(self):
        """Port with a bogus type raises ValidationError."""
        with pytest.raises(ValidationError):
            Port(name="p1", type="bogus")


# ── extra 拒绝 ──────────────────────────────────────────────────────────────────


class TestExtraFieldsRejected:
    """ConfigDict(extra='forbid') rejects undeclared fields."""

    def test_workflow_definition_rejects_extra(self):
        """WorkflowDefinition with an undeclared field raises ValidationError."""
        with pytest.raises(ValidationError):
            WorkflowDefinition(id="wf-extra", name="Extra Test", bogus=1)


# ── agent_name 主身份绑定 ────────────────────────────────────────────────────────

INVALID_AGENT_NAMES = [
    "publisher_x",  # underscore
    "publisher x",  # space
    "pub..lisher",  # dots
    "publisher/1",  # slash
    "publisher$",  # special char
    "发布",  # non-ASCII
    "",  # empty
]


class TestAgentNameBinding:
    """Node.agent_name — primary identity binding for AI nodes."""

    def test_agent_name_constructs_and_roundtrips(self):
        """Node with agent_name="publisher" constructs and survives model_dump round-trip."""
        node = Node(id="ai-1", type=NodeType.AI_LLM_AGENT, agent_name="publisher")
        assert node.agent_name == "publisher"

        dumped = node.model_dump()
        assert dumped["agent_name"] == "publisher"
        reloaded = Node.model_validate(dumped)
        assert reloaded.agent_name == "publisher"

    def test_agent_name_defaults_to_none_legacy_json(self):
        """Legacy JSON without agent_name validates with agent_name == None."""
        node = Node.model_validate({"id": "n1", "type": "flow:start"})
        assert node.agent_name is None

    def test_agent_name_explicit_none(self):
        """agent_name=None is legal (explicit default-agent binding)."""
        node = Node(id="n2", type=NodeType.FLOW_START, agent_name=None)
        assert node.agent_name is None

    def test_workflow_definition_with_agent_bound_node_roundtrips(self):
        """A WorkflowDefinition embedding an agent-bound node round-trips."""
        wf = WorkflowDefinition(
            id="wf-agent",
            name="Agent WF",
            nodes=[Node(id="ai", type=NodeType.AI_LLM_AGENT, agent_name="publisher")],
        )
        reloaded = WorkflowDefinition.model_validate(wf.model_dump())
        assert reloaded.nodes[0].agent_name == "publisher"

    @pytest.mark.parametrize("bad_name", INVALID_AGENT_NAMES)
    def test_invalid_agent_name_rejected(self, bad_name: str):
        """Agent names failing the ^[A-Za-z0-9-]+$ grammar raise ValidationError."""
        with pytest.raises(ValidationError):
            Node(id="n", type=NodeType.FLOW_START, agent_name=bad_name)

    @pytest.mark.parametrize("bad_value", [123, True, 3.14, ["publisher"], {"name": "publisher"}])
    def test_non_string_agent_name_rejected(self, bad_value: object):
        """Non-string agent_name values raise ValidationError."""
        with pytest.raises(ValidationError):
            Node(id="n", type=NodeType.FLOW_START, agent_name=bad_value)
