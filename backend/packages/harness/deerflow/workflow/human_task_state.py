"""Human-task status machine and submission validation — pure functions.

Zero-IO, zero-``app.*`` dependency module backing the ``human:task`` node.  It
defines the :class:`HumanTaskStatus` state machine with its allowed-transition
table, derives an ``output_spec`` from a workflow node's ``outputs`` ports, and
validates a user submission against that spec plus optional validation rules.
The T12 CRUD API, T13 interrupt wiring, and T15 frontend form all share this
contract.
"""

from __future__ import annotations

import re
from enum import StrEnum
from typing import Any

from deerflow.workflow.schema import Node, PortType

# ── Status machine ──────────────────────────────────────────────────────────────


class HumanTaskStatus(StrEnum):
    """Lifecycle status of a human task.

    Transitions (see :data:`ALLOWED_TRANSITIONS`):

    - ``pending``   — awaiting a user action; may be submitted, skipped, reopened
      (a failed submission is rejected back into the work queue), or expired.
    - ``submitted`` — terminal; a valid submission was recorded.
    - ``skipped``   — terminal; the user declined to act.
    - ``reopened``  — a failed submission was rejected; may be re-submitted, skipped,
      rejected again (staying ``reopened``), or expired.
    - ``expired``   — terminal; the pending/reopened task timed out (trigger owned by T13+, not here).
    """

    PENDING = "pending"
    SUBMITTED = "submitted"
    SKIPPED = "skipped"
    REOPENED = "reopened"
    EXPIRED = "expired"


ALLOWED_TRANSITIONS: dict[HumanTaskStatus, frozenset[HumanTaskStatus]] = {
    HumanTaskStatus.PENDING: frozenset({HumanTaskStatus.SUBMITTED, HumanTaskStatus.SKIPPED, HumanTaskStatus.REOPENED, HumanTaskStatus.EXPIRED}),
    HumanTaskStatus.REOPENED: frozenset({HumanTaskStatus.SUBMITTED, HumanTaskStatus.SKIPPED, HumanTaskStatus.REOPENED, HumanTaskStatus.EXPIRED}),
    HumanTaskStatus.SUBMITTED: frozenset(),
    HumanTaskStatus.SKIPPED: frozenset(),
    HumanTaskStatus.EXPIRED: frozenset(),
}


def validate_transition(from_status: HumanTaskStatus, to_status: HumanTaskStatus) -> bool:
    """Return whether transitioning *from_status* → *to_status* is legal."""
    return to_status in ALLOWED_TRANSITIONS.get(from_status, frozenset())


# ── output_spec derivation ──────────────────────────────────────────────────────


def derive_output_spec(node: Node) -> dict[str, Any]:
    """Derive the submission ``output_spec`` from a node's ``outputs`` ports.

    Returns ``{"ports": [{"name", "type", "required", "description"}, ...]}``
    preserving port order.  ``inputs`` are deliberately excluded — an
    ``output_spec`` describes what the user must submit, which is the node's
    outputs.
    """
    ports = [
        {
            "name": port.name,
            "type": port.type.value,
            "required": port.required,
            "description": port.description,
        }
        for port in node.outputs
    ]
    return {"ports": ports}


# ── Submission validation ───────────────────────────────────────────────────────


def validate_human_task_submission(
    values: dict[str, Any],
    output_spec: dict[str, Any],
    validation_rules: dict[str, Any] | None = None,
) -> list[str]:
    """Validate a user submission; returns a list of error messages (empty = valid).

    ``output_spec`` is ``{"ports": [{"name", "type", "required", "description"}, ...]}``
    as produced by :func:`derive_output_spec`.

    ``validation_rules`` contract (reused by T13/T15):

    .. code-block:: python

        {
            "enum": {
                "<port_name>": {"enum": ["approve", "reject"]},
            },
            "pattern": {
                "<port_name>": {"pattern": "^[a-z]+$"},
            },
        }

    - ``enum`` rule: the field's value must equal one of the ``enum`` list entries
      (any JSON value may appear in the list).
    - ``pattern`` rule: the field's value must be a string matching
      ``re.fullmatch(pattern, value)``; a non-string value skips the rule.
    - Unknown top-level rule kinds, unknown field names, malformed rule shapes,
      and uncompilable regexes are silently skipped (fail-open — only rules that
      can be expressed are enforced).  No exception is ever raised here.

    Error message formats:

    - missing required value / value is ``None`` → ``"缺少必填字段: <name>"``
    - wrong type → ``"字段 <name> 类型错误: 期望 bool|file"``
    - enum mismatch → ``"字段 <name> 不在允许的枚举值中"``
    - pattern mismatch → ``"字段 <name> 格式不匹配"``
    """
    errors: list[str] = []

    ports = output_spec.get("ports")
    if not isinstance(ports, list):
        return errors

    for port in ports:
        if not isinstance(port, dict):
            continue
        name = port.get("name")
        if not isinstance(name, str):
            continue
        port_type = port.get("type")
        required = bool(port.get("required", False))
        value = values.get(name)

        if value is None:
            if required:
                errors.append(f"缺少必填字段: {name}")
            continue

        if port_type == PortType.BOOL.value:
            if not isinstance(value, bool):
                errors.append(f"字段 {name} 类型错误: 期望 bool")
        elif port_type == PortType.FILE.value:
            if not isinstance(value, str) or value == "":
                errors.append(f"字段 {name} 类型错误: 期望 file")
        # data / enum: loose — no type enforcement here (enum handled below).

    if isinstance(validation_rules, dict):
        _apply_enum_rules(values, validation_rules, errors)
        _apply_pattern_rules(values, validation_rules, errors)

    return errors


def _apply_enum_rules(values: dict[str, Any], validation_rules: dict[str, Any], errors: list[str]) -> None:
    """Apply ``enum`` rules: value must be a member of the rule's ``enum`` list."""
    enum_rules = validation_rules.get("enum")
    if not isinstance(enum_rules, dict):
        return
    for field_name, rule in enum_rules.items():
        if field_name not in values:
            continue
        value = values[field_name]
        if value is None or not isinstance(rule, dict):
            continue
        allowed = rule.get("enum")
        if not isinstance(allowed, list):
            continue
        if value not in allowed:
            errors.append(f"字段 {field_name} 不在允许的枚举值中")


def _apply_pattern_rules(values: dict[str, Any], validation_rules: dict[str, Any], errors: list[str]) -> None:
    """Apply ``pattern`` rules: string value must ``re.fullmatch`` the regex."""
    pattern_rules = validation_rules.get("pattern")
    if not isinstance(pattern_rules, dict):
        return
    for field_name, rule in pattern_rules.items():
        if field_name not in values:
            continue
        value = values[field_name]
        if not isinstance(value, str) or not isinstance(rule, dict):
            continue
        pattern = rule.get("pattern")
        if not isinstance(pattern, str):
            continue
        try:
            compiled = re.compile(pattern)
        except re.error:
            continue
        if compiled.fullmatch(value) is None:
            errors.append(f"字段 {field_name} 格式不匹配")
