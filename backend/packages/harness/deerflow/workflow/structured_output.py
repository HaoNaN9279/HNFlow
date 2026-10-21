"""Structured-output contract for ``ai:llm_agent`` nodes (N14 §24.4).

An AI node binds a static schema from a ``data:schema`` node through its
``output_schema`` input port to map model output to typed ports.  This module is the dependency-free core shared by
the compiler (compile-time binding validation) and the AI executor (parse /
validate / repair): the schema is a **field → ``PortType`` map** rather than a
full JSON Schema, which keeps it aligned with the workflow port vocabulary and
needs no extra dependency.

Pure functions and one exception type only — no IO, no config, no LangGraph.
"""

from __future__ import annotations

import json
import re
from typing import Any

#: Field types accepted by ``output_schema.fields``.  Mirrors the port
#: vocabulary minus ``file`` (a model cannot meaningfully produce a host/sandbox
#: file reference as structured output in this MVP).
SCHEMA_FIELD_TYPES: frozenset[str] = frozenset({"data", "number", "array", "record", "bool", "enum"})

DEFAULT_MAX_REPAIRS = 1
MAX_REPAIRS_LIMIT = 5

#: AI-node input port carrying a static schema from a ``data:schema`` node.
OUTPUT_SCHEMA_PORT = "output_schema"

#: Compiler-injected executor param carrying the resolved schema.
OUTPUT_SCHEMA_PARAM = "__output_schema"

_FENCE_RE = re.compile(r"```(?:json)?\s*(.*?)```", re.DOTALL)


class StructuredOutputError(ValueError):
    """A model response (or the schema itself) is not valid structured output."""


def parse_output_schema(raw: Any) -> dict[str, Any] | None:
    """Normalize a schema payload; ``None`` when absent.

    Raises :class:`StructuredOutputError` for a structurally broken schema — the
    compiler turns that into a ``WorkflowCompileError``.
    """
    if raw is None:
        return None
    if not isinstance(raw, dict):
        raise StructuredOutputError("output_schema must be an object")
    fields = raw.get("fields")
    if not isinstance(fields, dict) or not fields:
        raise StructuredOutputError("output_schema.fields must be a non-empty object")
    enum_values_raw = raw.get("enum_values") or {}
    if not isinstance(enum_values_raw, dict):
        raise StructuredOutputError("output_schema.enum_values must be an object")
    required_raw = raw.get("required")
    if required_raw is None:
        required = list(fields)
    elif isinstance(required_raw, list):
        required = [str(x) for x in required_raw]
    else:
        raise StructuredOutputError("output_schema.required must be a list of field names")
    try:
        max_repairs = int(raw.get("max_repairs", DEFAULT_MAX_REPAIRS))
    except (TypeError, ValueError) as exc:
        raise StructuredOutputError("output_schema.max_repairs must be an integer") from exc
    return {
        "fields": {str(k): v for k, v in fields.items()},
        "required": required,
        "enum_values": {str(k): list(v) for k, v in enum_values_raw.items()},
        "max_repairs": max_repairs,
    }


def schema_instruction(schema: dict[str, Any]) -> str:
    """The prompt section instructing the model to emit a matching JSON object."""
    lines = [
        "Respond with a SINGLE JSON object (no prose, no code fences) with exactly these fields:",
        json.dumps(schema["fields"], ensure_ascii=False),
    ]
    if schema["required"]:
        lines.append("Required fields: " + ", ".join(schema["required"]))
    if schema["enum_values"]:
        lines.append("Allowed enum values: " + json.dumps(schema["enum_values"], ensure_ascii=False))
    return "\n".join(lines)


def extract_json_object(text: Any) -> dict[str, Any]:
    """Extract one JSON object from *text* (bare / fenced / embedded in prose)."""
    if not isinstance(text, str):
        raise StructuredOutputError("model output is not text")
    candidates: list[str] = []
    fenced = _FENCE_RE.search(text)
    if fenced is not None:
        candidates.append(fenced.group(1))
    candidates.append(text)
    start = text.find("{")
    end = text.rfind("}")
    if start != -1 and end > start:
        candidates.append(text[start : end + 1])
    for candidate in candidates:
        try:
            payload = json.loads(candidate.strip())
        except (ValueError, TypeError):
            continue
        if isinstance(payload, dict):
            return payload
    raise StructuredOutputError("model output is not a JSON object")


def _type_ok(value: Any, field_type: str, enum_values: list[Any] | None) -> bool:
    if field_type == "data":
        return True
    if field_type == "number":
        return isinstance(value, (int, float)) and not isinstance(value, bool)
    if field_type == "bool":
        return isinstance(value, bool)
    if field_type == "array":
        return isinstance(value, list)
    if field_type == "record":
        return isinstance(value, dict)
    if field_type == "enum":
        return enum_values is not None and value in enum_values
    return False


def validate_payload(payload: dict[str, Any], schema: dict[str, Any]) -> dict[str, Any]:
    """Validate *payload* against *schema*; return only the schema fields.

    Raises :class:`StructuredOutputError` listing every problem, so a repair turn
    can tell the model exactly what to fix.
    """
    fields = schema["fields"]
    required = set(schema["required"])
    enum_values = schema["enum_values"]
    errors: list[str] = []
    result: dict[str, Any] = {}
    for name, field_type in fields.items():
        if name not in payload:
            if name in required:
                errors.append(f"missing required field '{name}'")
            continue
        value = payload[name]
        if not _type_ok(value, field_type, enum_values.get(name)):
            errors.append(f"field '{name}' expected {field_type}, got {type(value).__name__}")
            continue
        result[name] = value
    if errors:
        raise StructuredOutputError("; ".join(errors))
    return result
