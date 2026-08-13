"""Tests for deerflow.workflow.workflow_io — validation, serialization, and ports_compatible."""

import json

import pytest

from deerflow.workflow.schema import (
    Edge,
    Node,
    NodeType,
    Port,
    PortType,
    WorkflowDefinition,
)
from deerflow.workflow.workflow_io import (
    deserialize,
    ports_compatible,
    serialize,
    validate_definition,
)

# ── 辅助构造 ──────────────────────────────────────────────────────────────────────


def _make_wf(nodes: list[Node] | None = None, edges: list[Edge] | None = None, **kwargs) -> WorkflowDefinition:
    return WorkflowDefinition(
        id="test-wf",
        name="Test Workflow",
        nodes=nodes or [],
        edges=edges or [],
        **kwargs,
    )


def _start_node() -> Node:
    return Node(id="start", type=NodeType.FLOW_START, outputs=[Port(name="out", type=PortType.DATA)])


def _end_node() -> Node:
    return Node(id="end", type=NodeType.FLOW_END, inputs=[Port(name="in", type=PortType.DATA)])


def _assign_node(id_: str = "assign") -> Node:
    return Node(
        id=id_,
        type=NodeType.DATA_ASSIGN,
        inputs=[Port(name="in", type=PortType.DATA)],
        outputs=[Port(name="out", type=PortType.DATA)],
    )


# ── 1. 合法 DAG 通过 ──────────────────────────────────────────────────────────────


class TestValidDAG:
    """validate_definition returns [] for a legal DAG."""

    def test_minimal_dag_passes(self):
        """FLOW_START → DATA_ASSIGN → FLOW_END passes validation."""
        wf = _make_wf(
            nodes=[_start_node(), _assign_node(), _end_node()],
            edges=[
                Edge(source="start", source_port="out", target="assign", target_port="in"),
                Edge(source="assign", source_port="out", target="end", target_port="in"),
            ],
        )
        errors = validate_definition(wf)
        assert errors == []


# ── 2. 环检测 ────────────────────────────────────────────────────────────────────


class TestCycleDetection:
    """Iterative DFS detects cycles and reports the full path."""

    def test_triangle_cycle_detected(self):
        """A→B→C→A is detected and reported with full cycle path."""
        nodes = [
            Node(id="A", type=NodeType.DATA_ASSIGN, inputs=[Port(name="in", type=PortType.DATA)], outputs=[Port(name="out", type=PortType.DATA)]),
            Node(id="B", type=NodeType.DATA_ASSIGN, inputs=[Port(name="in", type=PortType.DATA)], outputs=[Port(name="out", type=PortType.DATA)]),
            Node(id="C", type=NodeType.DATA_ASSIGN, inputs=[Port(name="in", type=PortType.DATA)], outputs=[Port(name="out", type=PortType.DATA)]),
        ]
        edges = [
            Edge(source="A", source_port="out", target="B", target_port="in"),
            Edge(source="B", source_port="out", target="C", target_port="in"),
            Edge(source="C", source_port="out", target="A", target_port="in"),
        ]
        wf = _make_wf(nodes=nodes, edges=edges)
        errors = validate_definition(wf)
        assert len(errors) >= 1
        # Error must contain a cycle description substring (plan: golden test 不锁顺序)
        cycle_found = any("A" in e and "B" in e and "C" in e and "→" in e for e in errors)
        assert cycle_found, f"Expected a cycle error mentioning A/B/C with arrows; got {errors}"

    def test_self_loop_detected(self):
        """A→A self-loop is detected."""
        nodes = [
            Node(id="A", type=NodeType.DATA_ASSIGN, inputs=[Port(name="in", type=PortType.DATA)], outputs=[Port(name="out", type=PortType.DATA)]),
        ]
        edges = [
            Edge(source="A", source_port="out", target="A", target_port="in"),
        ]
        wf = _make_wf(nodes=nodes, edges=edges)
        errors = validate_definition(wf)
        assert len(errors) >= 1
        assert any("A→A" in e for e in errors)

    def test_no_cycle_dag_passes(self):
        """Linear DAG with no cycles returns empty errors."""
        wf = _make_wf(
            nodes=[_start_node(), _assign_node("a1"), _assign_node("a2"), _end_node()],
            edges=[
                Edge(source="start", source_port="out", target="a1", target_port="in"),
                Edge(source="a1", source_port="out", target="a2", target_port="in"),
                Edge(source="a2", source_port="out", target="end", target_port="in"),
            ],
        )
        errors = validate_definition(wf)
        assert errors == []

    def test_parallel_edges_no_cycle(self):
        """Parallel edges A→B (twice) should not be falsely detected as cycles."""
        nodes = [
            Node(id="A", type=NodeType.DATA_ASSIGN, inputs=[Port(name="in", type=PortType.DATA)], outputs=[Port(name="out", type=PortType.DATA), Port(name="out2", type=PortType.DATA)]),
            Node(id="B", type=NodeType.DATA_ASSIGN, inputs=[Port(name="in", type=PortType.DATA), Port(name="in2", type=PortType.DATA)], outputs=[Port(name="out", type=PortType.DATA)]),
        ]
        edges = [
            Edge(source="A", source_port="out", target="B", target_port="in"),
            Edge(source="A", source_port="out2", target="B", target_port="in2"),
        ]
        wf = _make_wf(nodes=nodes, edges=edges)
        errors = validate_definition(wf)
        # Should not report a cycle; may report missing start/end, but those are separate
        cycle_errors = [e for e in errors if "cycle" in e.lower()]
        assert cycle_errors == [], f"Unexpected cycle errors: {cycle_errors}"


# ── 3. start/end 节点检查 ────────────────────────────────────────────────────────


class TestStartEndNodeChecks:
    """Exactly one flow:start (no incoming edges) and one flow:end (no outgoing edges)."""

    def test_missing_start_rejected(self):
        """Workflow without a flow:start node is rejected."""
        wf = _make_wf(nodes=[_assign_node(), _end_node()])
        errors = validate_definition(wf)
        assert any("start" in e.lower() for e in errors)

    def test_missing_end_rejected(self):
        """Workflow without a flow:end node is rejected."""
        wf = _make_wf(nodes=[_start_node(), _assign_node()])
        errors = validate_definition(wf)
        assert any("end" in e.lower() for e in errors)

    def test_multiple_start_rejected(self):
        """Multiple flow:start nodes are rejected."""
        nodes = [Node(id="start1", type=NodeType.FLOW_START), Node(id="start2", type=NodeType.FLOW_START)]
        wf = _make_wf(nodes=nodes)
        errors = validate_definition(wf)
        assert any("start" in e.lower() for e in errors)

    def test_start_with_incoming_edge_rejected(self):
        """A flow:start node with an incoming edge is rejected."""
        wf = _make_wf(
            nodes=[_start_node(), _assign_node(), _end_node()],
            edges=[
                Edge(source="assign", source_port="out", target="start", target_port="out"),
            ],
        )
        errors = validate_definition(wf)
        # The start node has an incoming edge — should be reported
        assert any("start" in e.lower() for e in errors)

    def test_end_with_outgoing_edge_rejected(self):
        """A flow:end node with an outgoing edge is rejected."""
        wf = _make_wf(
            nodes=[_start_node(), _end_node()],
            edges=[
                Edge(source="end", source_port="in", target="start", target_port="out"),
            ],
        )
        errors = validate_definition(wf)
        assert any("end" in e.lower() for e in errors)


# ── 4. edge 引用不存在的节点 ─────────────────────────────────────────────────────


class TestEdgeReferenceChecks:
    """Edges must reference existing node ids."""

    def test_edge_source_not_found_rejected(self):
        """Edge with nonexistent source node id is rejected."""
        wf = _make_wf(
            nodes=[_start_node(), _end_node()],
            edges=[Edge(source="ghost", source_port="out", target="end", target_port="in")],
        )
        errors = validate_definition(wf)
        assert any("ghost" in e for e in errors)

    def test_edge_target_not_found_rejected(self):
        """Edge with nonexistent target node id is rejected."""
        wf = _make_wf(
            nodes=[_start_node(), _end_node()],
            edges=[Edge(source="start", source_port="out", target="ghost", target_port="in")],
        )
        errors = validate_definition(wf)
        assert any("ghost" in e for e in errors)


# ── 5. edge 端口引用检查 ─────────────────────────────────────────────────────────


class TestEdgePortChecks:
    """Edges must reference existing port names on the source/target nodes."""

    def test_source_port_not_found_rejected(self):
        """Edge source_port not in source node outputs is rejected."""
        wf = _make_wf(
            nodes=[_start_node(), _end_node()],
            edges=[Edge(source="start", source_port="nonexistent", target="end", target_port="in")],
        )
        errors = validate_definition(wf)
        assert any("nonexistent" in e for e in errors)

    def test_target_port_not_found_rejected(self):
        """Edge target_port not in target node inputs is rejected."""
        wf = _make_wf(
            nodes=[_start_node(), _end_node()],
            edges=[Edge(source="start", source_port="out", target="end", target_port="nonexistent")],
        )
        errors = validate_definition(wf)
        assert any("nonexistent" in e for e in errors)


# ── 6. 端口类型不匹配 ─────────────────────────────────────────────────────────────


class TestPortTypeMismatch:
    """Edges connecting incompatible port types are rejected."""

    def test_data_to_file_mismatch_rejected(self):
        """data output → file input is rejected."""
        nodes = [
            Node(id="start", type=NodeType.FLOW_START, outputs=[Port(name="out", type=PortType.DATA)]),
            Node(id="end", type=NodeType.FLOW_END, inputs=[Port(name="in", type=PortType.FILE)]),
        ]
        wf = _make_wf(
            nodes=nodes,
            edges=[Edge(source="start", source_port="out", target="end", target_port="in")],
        )
        errors = validate_definition(wf)
        assert any("type" in e.lower() or "compatible" in e.lower() or "incompatible" in e.lower() for e in errors)


# ── 7. serialize / deserialize 幂等 ──────────────────────────────────────────────


class TestSerializeDeserializeIdempotent:
    """serialize → deserialize → serialize produces identical JSON output."""

    def test_roundtrip_idempotent(self):
        """Two serialize calls on the same definition yield identical bytes."""
        wf = _make_wf(
            nodes=[_start_node(), _assign_node(), _end_node()],
            edges=[
                Edge(source="start", source_port="out", target="assign", target_port="in"),
                Edge(source="assign", source_port="out", target="end", target_port="in"),
            ],
        )
        first = serialize(wf)
        reloaded = deserialize(first)
        second = serialize(reloaded)
        assert first == second, "serialize → deserialize → serialize must be idempotent"


# ── 8. serialize 输出 schema_version ─────────────────────────────────────────────


class TestSerializeOutput:
    """serialize produces the expected outer wrapper."""

    def test_output_contains_schema_version(self):
        """Serialized output contains "schema_version": 1 at the top level."""
        wf = _make_wf()
        text = serialize(wf)
        data = json.loads(text)
        assert data["schema_version"] == 1
        assert "workflow" in data

    def test_output_uses_indent_2_and_ascii(self):
        """Serialized output uses indent=2 and ensure_ascii=False."""
        wf = WorkflowDefinition(id="test-wf", name="测试")
        text = serialize(wf)
        # ensure_ascii=False preserves non-ASCII
        assert "测试" in text
        # indent=2: at least one line with leading 2 spaces
        lines = text.splitlines()
        indented = [line for line in lines if line.startswith("  ")]
        assert len(indented) > 0


# ── 9. deserialize schema_version 检查 ────────────────────────────────────────────


class TestDeserializeVersionChecks:
    """deserialize validates the schema_version field."""

    def test_higher_version_raises_valueerror(self):
        """schema_version > SCHEMA_VERSION raises ValueError."""
        data = json.dumps({"schema_version": 999, "workflow": {}})
        with pytest.raises(ValueError, match="schema version"):
            deserialize(data)

    def test_missing_version_raises_valueerror(self):
        """Missing schema_version key raises ValueError."""
        data = json.dumps({"workflow": {"id": "wf-1", "name": "Test"}})
        with pytest.raises(ValueError, match="schema_version"):
            deserialize(data)

    def test_lower_version_raises_notimplemented(self):
        """schema_version < SCHEMA_VERSION raises NotImplementedError (no migration yet)."""
        data = json.dumps({"schema_version": 0, "workflow": {"id": "wf-1", "name": "Test", "version": "0.1.0"}})
        with pytest.raises(NotImplementedError):
            deserialize(data)


# ── 10. 非法 params 类型 ─────────────────────────────────────────────────────────


class TestIllegalParams:
    """validate_definition rejects non-JSON-compatible param values."""

    def test_set_param_rejected(self):
        """A param value of type set is rejected."""
        nodes = [
            Node(id="start", type=NodeType.FLOW_START, outputs=[Port(name="out", type=PortType.DATA)]),
            Node(id="bad", type=NodeType.DATA_ASSIGN, inputs=[Port(name="in", type=PortType.DATA)], outputs=[Port(name="out", type=PortType.DATA)], params={"items": {1, 2, 3}}),
            Node(id="end", type=NodeType.FLOW_END, inputs=[Port(name="in", type=PortType.DATA)]),
        ]
        wf = _make_wf(
            nodes=nodes,
            edges=[
                Edge(source="start", source_port="out", target="bad", target_port="in"),
                Edge(source="bad", source_port="out", target="end", target_port="in"),
            ],
        )
        errors = validate_definition(wf)
        assert any("param" in e.lower() for e in errors)


# ── 11. ports_compatible ──────────────────────────────────────────────────────────


class TestPortsCompatible:
    """ports_compatible: same type → True, different type → False."""

    def test_same_type_compatible(self):
        """Same PortType returns True."""
        assert ports_compatible(PortType.DATA, PortType.DATA) is True
        assert ports_compatible(PortType.FILE, PortType.FILE) is True
        assert ports_compatible(PortType.BOOL, PortType.BOOL) is True
        assert ports_compatible(PortType.ENUM, PortType.ENUM) is True

    def test_different_type_incompatible(self):
        """Different PortType returns False."""
        assert ports_compatible(PortType.DATA, PortType.FILE) is False
        assert ports_compatible(PortType.DATA, PortType.BOOL) is False
        assert ports_compatible(PortType.FILE, PortType.DATA) is False


# ── 12. subworkflow params shape 校验 ──────────────────────────────────────────────


def _subworkflow_node(params: dict | None = None) -> Node:
    return Node(
        id="sub",
        type=NodeType.NESTED_SUBWORKFLOW,
        inputs=[Port(name="in", type=PortType.DATA)],
        outputs=[Port(name="out", type=PortType.DATA)],
        params=params or {},
    )


def _wf_with_subworkflow(params: dict | None = None) -> WorkflowDefinition:
    return _make_wf(
        nodes=[_start_node(), _subworkflow_node(params), _end_node()],
        edges=[
            Edge(source="start", source_port="out", target="sub", target_port="in"),
            Edge(source="sub", source_port="out", target="end", target_port="in"),
        ],
    )


class TestSubworkflowParams:
    """validate_definition shape-checks params['subworkflow'] on nested:subworkflow nodes."""

    def test_valid_inline_spec_passes(self):
        """Inline spec with a model-validatable definition passes."""
        wf = _wf_with_subworkflow({"subworkflow": {"type": "inline", "definition": {"id": "sub-wf", "name": "Sub"}}})
        errors = validate_definition(wf)
        assert errors == []

    def test_valid_template_spec_passes(self):
        """Template spec with template_id + version passes."""
        wf = _wf_with_subworkflow({"subworkflow": {"type": "template", "template_id": "wf-abc", "version": "0.1.0"}})
        errors = validate_definition(wf)
        assert errors == []

    def test_missing_type_rejected(self):
        """Spec without a 'type' key is rejected."""
        wf = _wf_with_subworkflow({"subworkflow": {"definition": {"id": "sub-wf", "name": "Sub"}}})
        errors = validate_definition(wf)
        assert any("sub" in e and "'type'" in e for e in errors)

    def test_invalid_type_rejected(self):
        """Spec with an unknown 'type' value is rejected."""
        wf = _wf_with_subworkflow({"subworkflow": {"type": "bogus"}})
        errors = validate_definition(wf)
        assert any("sub" in e and "'type'" in e for e in errors)

    def test_inline_missing_definition_rejected(self):
        """Inline spec without 'definition' is rejected."""
        wf = _wf_with_subworkflow({"subworkflow": {"type": "inline"}})
        errors = validate_definition(wf)
        assert any("sub" in e and "definition" in e for e in errors)

    def test_template_missing_template_id_rejected(self):
        """Template spec without 'template_id' is rejected."""
        wf = _wf_with_subworkflow({"subworkflow": {"type": "template"}})
        errors = validate_definition(wf)
        assert any("sub" in e and "template_id" in e for e in errors)

    def test_inline_and_template_together_rejected(self):
        """Spec carrying both inline 'definition' and 'template_id' is rejected."""
        wf = _wf_with_subworkflow({"subworkflow": {"type": "inline", "definition": {"id": "sub-wf", "name": "Sub"}, "template_id": "wf-abc"}})
        errors = validate_definition(wf)
        assert any("sub" in e and "combine" in e for e in errors)

    def test_non_subworkflow_node_with_key_ignored(self):
        """A DATA_ASSIGN node carrying a 'subworkflow' key is not inspected."""
        assign = Node(
            id="assign",
            type=NodeType.DATA_ASSIGN,
            inputs=[Port(name="in", type=PortType.DATA)],
            outputs=[Port(name="out", type=PortType.DATA)],
            params={"subworkflow": {"type": "bogus"}},
        )
        wf = _make_wf(
            nodes=[_start_node(), assign, _end_node()],
            edges=[
                Edge(source="start", source_port="out", target="assign", target_port="in"),
                Edge(source="assign", source_port="out", target="end", target_port="in"),
            ],
        )
        errors = validate_definition(wf)
        assert errors == []


# ── 13. agent_name 存在性校验 ──────────────────────────────────────────────────────


def _ai_node_with_agent(agent_name: str | None, id_: str = "ai") -> Node:
    return Node(
        id=id_,
        type=NodeType.AI_LLM_AGENT,
        inputs=[Port(name="in", type=PortType.DATA)],
        outputs=[Port(name="out", type=PortType.DATA)],
        agent_name=agent_name,
    )


def _wf_with_agent(agent_name: str | None) -> WorkflowDefinition:
    return _make_wf(
        nodes=[_start_node(), _ai_node_with_agent(agent_name), _end_node()],
        edges=[
            Edge(source="start", source_port="out", target="ai", target_port="in"),
            Edge(source="ai", source_port="out", target="end", target_port="in"),
        ],
    )


class TestAgentNameValidation:
    """validate_definition checks agent_name references when known_agent_names is provided."""

    def test_none_set_skips_validation(self):
        """known_agent_names=None (default) skips existence checks (backward compatible)."""
        wf = _wf_with_agent("publisher")
        errors = validate_definition(wf)
        assert errors == []

    def test_unknown_agent_name_rejected(self):
        """Unknown agent_name fails validation with the node path in the error."""
        wf = _wf_with_agent("publisher")
        errors = validate_definition(wf, known_agent_names={"researcher"})
        assert any("ai" in e and "publisher" in e and "agent_name" in e for e in errors)

    def test_known_agent_name_passes(self):
        """Known agent_name passes validation."""
        wf = _wf_with_agent("publisher")
        errors = validate_definition(wf, known_agent_names={"publisher", "researcher"})
        assert errors == []

    def test_none_agent_name_not_validated(self):
        """A node with agent_name=None is not subject to existence checks."""
        wf = _wf_with_agent(None)
        errors = validate_definition(wf, known_agent_names=set())
        assert errors == []

    def test_non_ai_node_with_agent_name_validated(self):
        """Any node type carrying agent_name is validated (binding implies existence)."""
        assign = Node(
            id="assign",
            type=NodeType.DATA_ASSIGN,
            inputs=[Port(name="in", type=PortType.DATA)],
            outputs=[Port(name="out", type=PortType.DATA)],
            agent_name="publisher",
        )
        wf = _make_wf(
            nodes=[_start_node(), assign, _end_node()],
            edges=[
                Edge(source="start", source_port="out", target="assign", target_port="in"),
                Edge(source="assign", source_port="out", target="end", target_port="in"),
            ],
        )
        errors = validate_definition(wf, known_agent_names={"researcher"})
        assert any("assign" in e and "publisher" in e and "agent_name" in e for e in errors)

    def test_empty_set_reports_all_bound_agents(self):
        """Empty known set reports every node with a bound agent_name."""
        nodes = [
            _start_node(),
            _ai_node_with_agent("a", id_="ai1"),
            _ai_node_with_agent("b", id_="ai2"),
            _end_node(),
        ]
        wf = _make_wf(
            nodes=nodes,
            edges=[
                Edge(source="start", source_port="out", target="ai1", target_port="in"),
                Edge(source="ai1", source_port="out", target="ai2", target_port="in"),
                Edge(source="ai2", source_port="out", target="end", target_port="in"),
            ],
        )
        errors = validate_definition(wf, known_agent_names=set())
        agent_errors = [e for e in errors if "agent_name" in e]
        assert len(agent_errors) == 2
