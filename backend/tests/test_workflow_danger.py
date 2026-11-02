"""Tests for deerflow.workflow.danger — pending-review node detection."""

from deerflow.workflow.danger import (
    collect_pending_review_nodes,
    dangerous_node_types,
    mark_pending_review,
)
from deerflow.workflow.schema import Node, NodeType, WorkflowDefinition, WorkflowMetadata


def _make_def(nodes: list[Node]) -> WorkflowDefinition:
    return WorkflowDefinition(id="wf-danger", name="Danger Test", nodes=nodes)


def _bash(node_id: str = "bash-1", **params: object) -> Node:
    return Node(id=node_id, type=NodeType.TOOL_BASH, params=params)


def _http(node_id: str = "http-1", **params: object) -> Node:
    return Node(id=node_id, type=NodeType.TOOL_HTTP, params=params)


# ── dangerous_node_types ───────────────────────────────────────────────────────


class TestDangerousNodeTypes:
    """dangerous_node_types() returns bash + http and nothing else."""

    def test_returns_frozenset_of_bash_and_http(self):
        types = dangerous_node_types()
        assert isinstance(types, frozenset)
        assert NodeType.TOOL_BASH in types
        assert NodeType.TOOL_HTTP in types

    def test_excludes_idempotent_types(self):
        types = dangerous_node_types()
        assert NodeType.FLOW_IF not in types
        assert NodeType.DATA_ASSIGN not in types
        assert NodeType.FLOW_START not in types


# ── collect_pending_review_nodes ───────────────────────────────────────────────


class TestCollectPendingReviewNodes:
    """Dangerous nodes without explicit crash_confirm=False are collected."""

    def test_marks_bash_and_http(self):
        wf = _make_def([_bash("bash-1"), _http("http-1")])
        assert collect_pending_review_nodes(wf) == ["bash-1", "http-1"]

    def test_ignores_idempotent_nodes(self):
        wf = _make_def(
            [
                Node(id="start", type=NodeType.FLOW_START),
                Node(id="if-1", type=NodeType.FLOW_IF),
                Node(id="assign-1", type=NodeType.DATA_ASSIGN),
                Node(id="end", type=NodeType.FLOW_END),
            ]
        )
        assert collect_pending_review_nodes(wf) == []

    def test_exempts_explicit_crash_confirm_false(self):
        wf = _make_def(
            [
                _bash("bash-1", crash_confirm=False),
                _http("http-1"),
                _bash("bash-2", crash_confirm=False),
            ]
        )
        assert collect_pending_review_nodes(wf) == ["http-1"]

    def test_crash_confirm_true_is_not_exempt(self):
        wf = _make_def([_bash("bash-1", crash_confirm=True)])
        assert collect_pending_review_nodes(wf) == ["bash-1"]

    def test_empty_nodes(self):
        assert collect_pending_review_nodes(_make_def([])) == []

    def test_preserves_definition_order(self):
        wf = _make_def([_bash("bash-2"), _http("http-1"), _bash("bash-1")])
        assert collect_pending_review_nodes(wf) == ["bash-2", "http-1", "bash-1"]

    def test_dedupes_repeated_dangerous_node_ids(self):
        wf = _make_def([_http("http-1"), _bash("bash-1"), _http("http-1"), _bash("bash-2")])
        assert collect_pending_review_nodes(wf) == ["http-1", "bash-1", "bash-2"]


# ── mark_pending_review ────────────────────────────────────────────────────────


class TestMarkPendingReview:
    """mark_pending_review() merges pending_review_nodes into metadata."""

    def test_sets_pending_review_nodes_when_danger_present(self):
        wf = _make_def([_bash("bash-1"), Node(id="if-1", type=NodeType.FLOW_IF)])
        meta = mark_pending_review(wf)
        assert meta.pending_review_nodes == ["bash-1"]

    def test_merges_and_preserves_existing_metadata_keys(self):
        wf = WorkflowDefinition(
            id="wf-mark",
            name="Mark Test",
            nodes=[_bash("bash-1")],
            metadata=WorkflowMetadata(resolved_groups=["g1"], created_at="2026-01-01T00:00:00"),
        )
        meta = mark_pending_review(wf)
        assert meta.pending_review_nodes == ["bash-1"]
        assert meta.resolved_groups == ["g1"]
        assert meta.created_at == "2026-01-01T00:00:00"
        assert meta.updated_at is None

    def test_empty_pending_sets_none_and_keeps_existing_keys(self):
        wf = WorkflowDefinition(
            id="wf-mark-empty",
            name="Mark Empty",
            nodes=[Node(id="if-1", type=NodeType.FLOW_IF)],
            metadata=WorkflowMetadata(resolved_groups=["g1"]),
        )
        meta = mark_pending_review(wf)
        assert meta.pending_review_nodes is None
        assert meta.resolved_groups == ["g1"]

    def test_overrides_existing_pending_review_nodes(self):
        wf = WorkflowDefinition(
            id="wf-mark-over",
            name="Mark Over",
            nodes=[_bash("bash-1")],
            metadata=WorkflowMetadata(pending_review_nodes=["stale-1"]),
        )
        meta = mark_pending_review(wf)
        assert meta.pending_review_nodes == ["bash-1"]

    def test_does_not_mutate_definition_metadata(self):
        wf = _make_def([_bash("bash-1")])
        mark_pending_review(wf)
        assert wf.metadata.pending_review_nodes is None
