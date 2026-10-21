"""Tests for the saved-definition AI contract migration."""

from __future__ import annotations

from deerflow.workflow.ai_contract_migration import migrate_definition


def _definition() -> dict:
    return {
        "id": "wf",
        "name": "Old workflow",
        "version": "0.1.0",
        "nodes": [
            {"id": "start", "type": "flow:start", "inputs": [], "outputs": [{"name": "out", "type": "data"}]},
            {
                "id": "ai",
                "type": "ai:llm_agent",
                "inputs": [{"name": "in", "type": "data"}],
                "outputs": [{"name": "out", "type": "data"}, {"name": "score", "type": "number"}],
                "params": {
                    "instruction": "Do {{in}}",
                    "output_schema": {"fields": {"score": "number"}},
                    "context_policy": {"examples": []},
                    "memory": {"scopes": ["session"]},
                    "retrieval": {"collection": "docs"},
                    "model_policy": {"prefer": "local"},
                    "autonomy": {"budgets": {"max_tokens": 1}},
                    "merge": {"in": "array"},
                    "rollback_on_failure": False,
                },
            },
            {"id": "end", "type": "flow:end", "inputs": [{"name": "in", "type": "data"}]},
        ],
        "edges": [
            {"source": "start", "source_port": "out", "target": "ai", "target_port": "in"},
            {"source": "ai", "source_port": "out", "target": "end", "target_port": "in"},
        ],
    }


def test_instruction_and_schema_become_input_nodes() -> None:
    result = migrate_definition(_definition())

    assert result.changed is True
    node_types = {node["id"]: node["type"] for node in result.definition["nodes"]}
    assert node_types["ai__task"] == "data:assign"
    assert node_types["ai__schema"] == "data:schema"
    ai = next(node for node in result.definition["nodes"] if node["id"] == "ai")
    assert ai["params"] == {}
    assert {"name": "template_prompt", "type": "data", "required": False} in ai["inputs"]
    assert {"name": "output_schema", "type": "record", "required": False} in ai["inputs"]
    assert any(edge["target"] == "ai" and edge["target_port"] == "template_prompt" for edge in result.definition["edges"])
    assert any(edge["target"] == "ai" and edge["target_port"] == "output_schema" for edge in result.definition["edges"])


def test_removed_knowledge_node_is_dropped() -> None:
    raw = _definition()
    raw["nodes"].append(
        {
            "id": "kb",
            "type": "data:knowledge",
            "inputs": [],
            "outputs": [{"name": "out", "type": "data"}],
            "params": {"operation": "retrieve"},
        }
    )
    raw["edges"].append({"source": "kb", "source_port": "out", "target": "ai", "target_port": "in"})
    raw["edges"] = [edge for edge in raw["edges"] if edge["target"] != "ai" or edge["target_port"] != "in"]
    raw["edges"].append({"source": "start", "source_port": "out", "target": "ai", "target_port": "in"})

    result = migrate_definition(raw)

    assert "kb" not in {node["id"] for node in result.definition["nodes"]}
    assert all(edge.get("source") != "kb" and edge.get("target") != "kb" for edge in result.definition["edges"])


def test_multi_inbound_ports_are_reported_not_rewritten() -> None:
    raw = _definition()
    raw["nodes"].append({"id": "a2", "type": "data:assign", "inputs": [], "outputs": [{"name": "out", "type": "data"}], "params": {"value": "x"}})
    raw["edges"].append({"source": "a2", "source_port": "out", "target": "ai", "target_port": "in"})

    result = migrate_definition(raw)

    assert result.conflicts
    assert "ai.in" in result.conflicts[0]
