"""Lint behaviour: every check the offline tool claims to perform."""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any

from hnflow_forge.lint import lint_definition, lint_file, lint_text


def base_definition() -> dict[str, Any]:
    """A minimal valid flow: one agent node plus a trailing gate."""
    return {
        "schemaVersion": 2,
        "flow": {"id": "fl-test", "name": "测试流程"},
        "input": {
            "type": "object",
            "required": ["brief"],
            "properties": {"brief": {"type": "string"}},
            "additionalProperties": False,
        },
        "nodes": [
            {
                "id": "draft",
                "type": "agent",
                "preset": "hnflow",
                "instruction": "根据 {{input.brief}} 产出要点。",
                "input": {"type": "object", "required": ["brief"], "properties": {"brief": {"type": "string"}}},
                "output": {
                    "type": "object",
                    "required": ["points"],
                    "properties": {"points": {"type": "array", "items": {"type": "string"}}},
                    "additionalProperties": False,
                },
            },
            {"id": "approve", "type": "gate", "title": "确认"},
        ],
        "edges": [{"id": "e1", "from": "draft", "to": "approve", "when": {"kind": "status", "is": "done"}}],
    }


def codes(definition: dict[str, Any]) -> list[str]:
    """Run lint and return the error codes."""
    return [issue.code for issue in lint_definition(definition).errors]


def test_valid_definition_passes() -> None:
    report = lint_definition(base_definition())
    assert report.ok, [issue.as_dict() for issue in report.errors]


def test_missing_flow_id_is_an_error() -> None:
    definition = base_definition()
    del definition["flow"]["id"]
    assert "definition-invalid" in codes(definition)


def test_gate_branches_must_be_complete() -> None:
    definition = base_definition()
    definition["nodes"].append(
        {
            "id": "next",
            "type": "agent",
            "preset": "hnflow",
            "instruction": "继续。",
            "output": {"type": "object", "properties": {"ok": {"type": "boolean"}}},
        }
    )
    definition["edges"] = [
        {"id": "e1", "from": "draft", "to": "approve", "when": {"kind": "status", "is": "done"}},
        {"id": "e2", "from": "approve", "to": "next", "when": {"kind": "gate", "is": "approved"}},
    ]
    assert "gate-branches-incomplete" in codes(definition)


def test_cycle_is_rejected() -> None:
    definition = base_definition()
    definition["edges"] = [
        {"id": "e1", "from": "draft", "to": "approve", "when": {"kind": "status", "is": "done"}},
        {"id": "e2", "from": "approve", "to": "draft", "when": {"kind": "gate", "is": "approved"}},
        {"id": "e3", "from": "approve", "to": "draft", "when": {"kind": "gate", "is": "rejected"}},
        {"id": "e4", "from": "approve", "to": "draft", "when": {"kind": "gate", "is": "modified"}},
    ]
    assert "cycle-unsupported" in codes(definition)


def test_judge_cannot_share_producer_preset() -> None:
    definition = base_definition()
    definition["nodes"].append(
        {
            "id": "judge",
            "type": "judge",
            "preset": "hnflow",
            "instruction": "判定。",
            "criteria": "要点是否成立",
        }
    )
    definition["edges"].append({"id": "e2", "from": "draft", "to": "judge", "when": {"kind": "status", "is": "done"}})
    definition["edges"][0] = {"id": "e1", "from": "judge", "to": "approve", "when": {"kind": "verdict", "is": "accept"}}
    assert "judge-same-as-producer" in codes(definition)


def test_contract_mismatch_is_reported() -> None:
    definition = base_definition()
    definition["nodes"][0]["output"] = {
        "type": "object",
        "required": ["note"],
        "properties": {"note": {"type": "string"}},
        "additionalProperties": False,
    }
    definition["nodes"].append(
        {
            "id": "consume",
            "type": "agent",
            "preset": "hnflow",
            "instruction": "消费上游。",
            "input": {
                "type": "object",
                "required": ["points"],
                "properties": {"points": {"type": "array", "items": {"type": "string"}}},
                "additionalProperties": False,
            },
            "output": {"type": "object", "properties": {"ok": {"type": "boolean"}}},
        }
    )
    definition["edges"].append({"id": "e2", "from": "draft", "to": "consume", "when": {"kind": "status", "is": "done"}})
    definition["edges"][0]["to"] = "consume"
    definition["edges"].append({"id": "e3", "from": "consume", "to": "approve", "when": {"kind": "status", "is": "done"}})
    assert "contract-unsatisfiable" in codes(definition)


def test_unsupported_schema_keyword_is_reported() -> None:
    definition = base_definition()
    definition["nodes"][0]["output"]["properties"]["points"]["minItems"] = 1
    assert "schema-unsupported" in codes(definition)


def test_two_end_nodes_are_rejected() -> None:
    definition = base_definition()
    definition["nodes"].append(
        {
            "id": "extra",
            "type": "gate",
            "title": "另一条终点",
        }
    )
    assert "graph-shape-invalid" in codes(definition)


def test_merge_map_must_name_its_sources() -> None:
    definition = base_definition()
    definition["nodes"].append(
        {
            "id": "sink",
            "type": "merge",
            "from": ["draft"],
            "map": {"points": "other.output.points"},
            "output": {"type": "object"},
        }
    )
    definition["edges"].append({"id": "e2", "from": "draft", "to": "sink", "when": {"kind": "status", "is": "done"}})
    definition["edges"][0]["to"] = "approve"
    assert "merge-map-invalid" in codes(definition)


def test_non_default_preset_only_warns() -> None:
    definition = base_definition()
    definition["nodes"][0]["preset"] = "HNFlow"
    report = lint_definition(definition)
    assert report.ok
    assert any("HNFlow" in warning for warning in report.warnings)


def test_invalid_json_becomes_a_definition_error() -> None:
    report = lint_text("{ not json", "inline")
    assert not report.ok
    assert report.errors[0].code == "definition-invalid"


def test_unreadable_file_becomes_a_definition_error() -> None:
    report = lint_file(Path(__file__).with_name("does-not-exist.json"))
    assert not report.ok
    assert report.errors[0].code == "definition-invalid"


def test_valid_text_roundtrip() -> None:
    text = json.dumps(base_definition(), ensure_ascii=False)
    assert lint_text(text).ok
