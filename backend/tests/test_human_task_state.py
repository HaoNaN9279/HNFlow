"""Tests for ``deerflow.workflow.human_task_state`` — HumanTask status machine + submission validation.

Covers:
- ``HumanTaskStatus`` literal values
- ``ALLOWED_TRANSITIONS`` full matrix + ``validate_transition`` agreement
- ``derive_output_spec`` (empty, order, field mapping, inputs ignored)
- ``validate_human_task_submission`` (required, None, type, enum/pattern rules,
  unknown-field skip, malformed-rule skip, valid submission)
- purity (repeat calls, no input mutation)
"""

from __future__ import annotations

from typing import Any

from deerflow.workflow.human_task_state import (
    ALLOWED_TRANSITIONS,
    HumanTaskStatus,
    derive_output_spec,
    validate_human_task_submission,
    validate_transition,
)
from deerflow.workflow.schema import Node, NodeType, Port, PortType

# ═══════════════════════════════════════════════════════════════════════════════
# Helpers
# ═══════════════════════════════════════════════════════════════════════════════


def _node(*, outputs: list[Port] | None = None, inputs: list[Port] | None = None) -> Node:
    return Node(id="ht", type=NodeType.HUMAN_TASK, inputs=inputs or [], outputs=outputs or [])


def _spec(ports: list[dict[str, Any]]) -> dict[str, Any]:
    return {"ports": ports}


# ═══════════════════════════════════════════════════════════════════════════════
# HumanTaskStatus enum
# ═══════════════════════════════════════════════════════════════════════════════


def test_status_enum_literals() -> None:
    """Enum members carry the exact wire literals."""
    assert HumanTaskStatus.PENDING.value == "pending"
    assert HumanTaskStatus.SUBMITTED.value == "submitted"
    assert HumanTaskStatus.SKIPPED.value == "skipped"
    assert HumanTaskStatus.REOPENED.value == "reopened"
    assert HumanTaskStatus.EXPIRED.value == "expired"


def test_status_enum_members() -> None:
    """The enum exposes exactly the five documented members."""
    assert set(HumanTaskStatus) == {
        HumanTaskStatus.PENDING,
        HumanTaskStatus.SUBMITTED,
        HumanTaskStatus.SKIPPED,
        HumanTaskStatus.REOPENED,
        HumanTaskStatus.EXPIRED,
    }


# ═══════════════════════════════════════════════════════════════════════════════
# ALLOWED_TRANSITIONS + validate_transition
# ═══════════════════════════════════════════════════════════════════════════════


def test_allowed_transitions_table_shape() -> None:
    """Every status has a row; terminal states have empty target sets."""
    assert set(ALLOWED_TRANSITIONS) == set(HumanTaskStatus)
    assert ALLOWED_TRANSITIONS[HumanTaskStatus.PENDING] == frozenset({HumanTaskStatus.SUBMITTED, HumanTaskStatus.SKIPPED, HumanTaskStatus.REOPENED, HumanTaskStatus.EXPIRED})
    assert ALLOWED_TRANSITIONS[HumanTaskStatus.REOPENED] == frozenset({HumanTaskStatus.SUBMITTED, HumanTaskStatus.SKIPPED, HumanTaskStatus.REOPENED, HumanTaskStatus.EXPIRED})
    assert ALLOWED_TRANSITIONS[HumanTaskStatus.SUBMITTED] == frozenset()
    assert ALLOWED_TRANSITIONS[HumanTaskStatus.SKIPPED] == frozenset()
    assert ALLOWED_TRANSITIONS[HumanTaskStatus.EXPIRED] == frozenset()


def test_pending_transitions() -> None:
    """pending → submitted/skipped/reopened/expired are legal; nothing else is."""
    assert validate_transition(HumanTaskStatus.PENDING, HumanTaskStatus.SUBMITTED) is True
    assert validate_transition(HumanTaskStatus.PENDING, HumanTaskStatus.SKIPPED) is True
    assert validate_transition(HumanTaskStatus.PENDING, HumanTaskStatus.EXPIRED) is True
    assert validate_transition(HumanTaskStatus.PENDING, HumanTaskStatus.REOPENED) is True
    assert validate_transition(HumanTaskStatus.PENDING, HumanTaskStatus.PENDING) is False


def test_reopened_transitions() -> None:
    """reopened → submitted/skipped/reopened/expired are legal; reopened → pending is not."""
    assert validate_transition(HumanTaskStatus.REOPENED, HumanTaskStatus.SUBMITTED) is True
    assert validate_transition(HumanTaskStatus.REOPENED, HumanTaskStatus.SKIPPED) is True
    assert validate_transition(HumanTaskStatus.REOPENED, HumanTaskStatus.EXPIRED) is True
    assert validate_transition(HumanTaskStatus.REOPENED, HumanTaskStatus.PENDING) is False
    assert validate_transition(HumanTaskStatus.REOPENED, HumanTaskStatus.REOPENED) is True


def test_terminal_states_have_no_transitions() -> None:
    """submitted / skipped / expired never transition to any status."""
    for terminal in (HumanTaskStatus.SUBMITTED, HumanTaskStatus.SKIPPED, HumanTaskStatus.EXPIRED):
        for target in HumanTaskStatus:
            assert validate_transition(terminal, target) is False, f"{terminal.value} → {target.value} must be illegal"


def test_validate_transition_matches_table() -> None:
    """validate_transition agrees with ALLOWED_TRANSITIONS for every (from, to) pair."""
    for src in HumanTaskStatus:
        for dst in HumanTaskStatus:
            assert validate_transition(src, dst) is (dst in ALLOWED_TRANSITIONS[src])


# ═══════════════════════════════════════════════════════════════════════════════
# derive_output_spec
# ═══════════════════════════════════════════════════════════════════════════════


def test_derive_output_spec_empty() -> None:
    """A node with no outputs yields an empty ports list."""
    assert derive_output_spec(_node()) == {"ports": []}


def test_derive_output_spec_order_and_fields() -> None:
    """Port order is preserved and every field maps correctly."""
    node = _node(
        outputs=[
            Port(name="approval", type=PortType.BOOL, required=True, description="是否批准"),
            Port(name="comment", type=PortType.DATA, required=False, description=None),
            Port(name="attachment", type=PortType.FILE, required=False, description="附件路径"),
        ]
    )
    spec = derive_output_spec(node)
    assert spec == {
        "ports": [
            {"name": "approval", "type": "bool", "required": True, "description": "是否批准"},
            {"name": "comment", "type": "data", "required": False, "description": None},
            {"name": "attachment", "type": "file", "required": False, "description": "附件路径"},
        ]
    }


def test_derive_output_spec_ignores_inputs() -> None:
    """inputs do not participate in output_spec."""
    node = _node(
        inputs=[Port(name="context", type=PortType.DATA, required=True)],
        outputs=[Port(name="approval", type=PortType.BOOL, required=True)],
    )
    spec = derive_output_spec(node)
    assert [p["name"] for p in spec["ports"]] == ["approval"]


# ═══════════════════════════════════════════════════════════════════════════════
# validate_human_task_submission
# ═══════════════════════════════════════════════════════════════════════════════

_BOOL_REQUIRED_SPEC = _spec([{"name": "approval", "type": "bool", "required": True, "description": None}])


def test_validate_missing_required() -> None:
    """A missing required port yields an error."""
    errors = validate_human_task_submission({}, _BOOL_REQUIRED_SPEC, None)
    assert errors == ["缺少必填字段: approval"]


def test_validate_required_none() -> None:
    """A required port set to None counts as missing."""
    errors = validate_human_task_submission({"approval": None}, _BOOL_REQUIRED_SPEC, None)
    assert errors == ["缺少必填字段: approval"]


def test_validate_type_mismatch_bool() -> None:
    """A bool port receiving a string yields a type error."""
    errors = validate_human_task_submission({"approval": "yes"}, _BOOL_REQUIRED_SPEC, None)
    assert errors == ["字段 approval 类型错误: 期望 bool"]


def test_validate_bool_accepts_bool() -> None:
    """A bool port accepts a real bool (including False)."""
    assert validate_human_task_submission({"approval": False}, _BOOL_REQUIRED_SPEC, None) == []


def test_validate_file_type() -> None:
    """A file port requires a non-empty string."""
    spec = _spec([{"name": "attachment", "type": "file", "required": True, "description": None}])
    assert validate_human_task_submission({"attachment": ""}, spec, None) == ["字段 attachment 类型错误: 期望 file"]
    assert validate_human_task_submission({"attachment": 42}, spec, None) == ["字段 attachment 类型错误: 期望 file"]
    assert validate_human_task_submission({"attachment": "/mnt/user-data/outputs/a.txt"}, spec, None) == []


def test_validate_data_and_enum_loose() -> None:
    """data/enum ports accept any JSON value (no type enforcement here)."""
    spec = _spec(
        [
            {"name": "data_val", "type": "data", "required": True, "description": None},
            {"name": "enum_val", "type": "enum", "required": True, "description": None},
        ]
    )
    errors = validate_human_task_submission({"data_val": {"nested": [1, 2]}, "enum_val": "anything"}, spec, None)
    assert errors == []


def test_validate_enum_rule() -> None:
    """enum rule rejects out-of-set values and accepts in-set values."""
    spec = _spec([{"name": "decision", "type": "enum", "required": True, "description": None}])
    rules: dict[str, Any] = {"enum": {"decision": {"enum": ["approve", "reject"]}}}
    assert validate_human_task_submission({"decision": "maybe"}, spec, rules) == ["字段 decision 不在允许的枚举值中"]
    assert validate_human_task_submission({"decision": "approve"}, spec, rules) == []


def test_validate_pattern_rule() -> None:
    """pattern rule rejects non-matching strings and accepts matching ones."""
    spec = _spec([{"name": "comment", "type": "data", "required": True, "description": None}])
    rules: dict[str, Any] = {"pattern": {"comment": {"pattern": "^[a-z]{1,10}$"}}}
    assert validate_human_task_submission({"comment": "NOT LOWERCASE"}, spec, rules) == ["字段 comment 格式不匹配"]
    assert validate_human_task_submission({"comment": "okay"}, spec, rules) == []


def test_validate_pattern_invalid_regex_ignored() -> None:
    """An uncompilable pattern is silently skipped (fail-open)."""
    spec = _spec([{"name": "comment", "type": "data", "required": True, "description": None}])
    rules: dict[str, Any] = {"pattern": {"comment": {"pattern": "("}}}
    assert validate_human_task_submission({"comment": "anything"}, spec, rules) == []


def test_validate_pattern_skips_non_string_value() -> None:
    """pattern only constrains strings; non-string values are skipped."""
    spec = _spec([{"name": "comment", "type": "data", "required": True, "description": None}])
    rules: dict[str, Any] = {"pattern": {"comment": {"pattern": "^[a-z]+$"}}}
    assert validate_human_task_submission({"comment": 123}, spec, rules) == []


def test_validate_unknown_field_rule_skipped() -> None:
    """Rules naming a field absent from values are skipped without error."""
    spec = _spec([{"name": "approval", "type": "bool", "required": True, "description": None}])
    rules: dict[str, Any] = {"enum": {"not_submitted": {"enum": ["x"]}}}
    assert validate_human_task_submission({"approval": True}, spec, rules) == []


def test_validate_invalid_rule_structure_skipped() -> None:
    """Malformed rule structures are silently skipped, never raise."""
    spec = _spec([{"name": "approval", "type": "bool", "required": True, "description": None}])
    values = {"approval": True}
    # Top-level rules not a dict.
    assert validate_human_task_submission(values, spec, ["not", "a", "dict"]) == []
    # Rule bucket not a dict.
    assert validate_human_task_submission(values, spec, {"enum": "nonsense"}) == []
    # Per-field rule not a dict.
    assert validate_human_task_submission(values, spec, {"enum": {"approval": "nonsense"}}) == []
    # Enum list missing / wrong type.
    assert validate_human_task_submission(values, spec, {"enum": {"approval": {"other": 1}}}) == []
    assert validate_human_task_submission(values, spec, {"enum": {"approval": {"enum": "x"}}}) == []


def test_validate_valid_submission_empty_list() -> None:
    """A complete valid submission returns an empty error list."""
    spec = _spec(
        [
            {"name": "approval", "type": "bool", "required": True, "description": "是否批准"},
            {"name": "comment", "type": "data", "required": False, "description": None},
        ]
    )
    assert validate_human_task_submission({"approval": True, "comment": "LGTM"}, spec, None) == []


# ═══════════════════════════════════════════════════════════════════════════════
# Purity
# ═══════════════════════════════════════════════════════════════════════════════


def test_validate_is_pure_and_non_mutating() -> None:
    """Repeated calls are identical and the inputs are not mutated."""
    spec = _spec(
        [
            {"name": "approval", "type": "bool", "required": True, "description": None},
            {"name": "comment", "type": "data", "required": False, "description": None},
        ]
    )
    rules: dict[str, Any] = {"pattern": {"comment": {"pattern": "^[a-z]+$"}}}
    values = {"approval": True, "comment": "UPPER"}
    spec_before = {"ports": [dict(p) for p in spec["ports"]]}
    rules_before = {"pattern": {"comment": {"pattern": "^[a-z]+$"}}}
    values_before = dict(values)

    first = validate_human_task_submission(values, spec, rules)
    second = validate_human_task_submission(values, spec, rules)

    assert first == second
    assert first == ["字段 comment 格式不匹配"]
    assert values == values_before
    assert spec == spec_before
    assert rules == rules_before


def test_derive_output_spec_is_pure() -> None:
    """derive_output_spec returns equal results across calls and leaves the node untouched."""
    node = _node(outputs=[Port(name="approval", type=PortType.BOOL, required=True, description="是否批准")])
    first = derive_output_spec(node)
    second = derive_output_spec(node)
    assert first == second
    assert len(node.outputs) == 1
