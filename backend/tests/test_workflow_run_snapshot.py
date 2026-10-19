"""Run-level definition snapshots must survive edits and round-trip."""

from __future__ import annotations

from deerflow.workflow.run_snapshot import (
    definition_content_hash,
    definition_snapshot,
    load_definition_snapshot,
)
from deerflow.workflow.schema import Node, NodeType, Port, PortType, WorkflowDefinition


def _definition(value: str) -> WorkflowDefinition:
    return WorkflowDefinition(
        id="wf-snapshot",
        name="Snapshot",
        nodes=[
            Node(id="start", type=NodeType.FLOW_START, outputs=[Port(name="in", type=PortType.DATA)]),
            Node(id="a", type=NodeType.DATA_ASSIGN, params={"value": value}, inputs=[Port(name="in", type=PortType.DATA)], outputs=[Port(name="out", type=PortType.DATA)]),
            Node(id="end", type=NodeType.FLOW_END, inputs=[Port(name="in", type=PortType.DATA)]),
        ],
        edges=[],
    )


def test_snapshot_roundtrips_and_hash_is_stable() -> None:
    original = _definition("v1")
    snapshot = definition_snapshot(original)

    assert snapshot["definition_hash"] == definition_content_hash(original)
    loaded = load_definition_snapshot({"definition": snapshot["definition"]})
    assert loaded is not None
    assert loaded.nodes[1].params == {"value": "v1"}
    assert definition_content_hash(loaded) == snapshot["definition_hash"]


def test_load_returns_none_for_legacy_or_malformed_kwargs() -> None:
    assert load_definition_snapshot(None) is None
    assert load_definition_snapshot({}) is None
    assert load_definition_snapshot({"definition": "not-a-dict"}) is None
    assert load_definition_snapshot({"definition": {"id": "broken"}}) is None
