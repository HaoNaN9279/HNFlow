"""AI Result Schema contract for ``ai:llm_agent`` nodes.

An AI node binds one ``data:schema`` node to both ``input_schema`` and
``output_schema``.  The same schema describes the result envelope produced by a
sender and consumed by a receiver, so an AI-to-AI edge carries one consistent
contract.

The schema has two layers:

* fixed HNFlow common fields (``summary`` / ``status`` / ``content`` /
  ``artifacts`` / ``metadata`` / ``error``), and
* user-authored ``custom_fields``.

Template prompts reference values from the incoming envelope with
``[schema.summary]`` / ``[schema.custom.<name>]`` placeholders.  This module
owns parsing, prompt instructions, envelope validation, and placeholder
rendering; it has no IO or LangGraph dependency.
"""

from __future__ import annotations

import json
import re
from typing import Any

AI_RESULT_PROTOCOL = "ai-result/v1"
AI_RESULT_SCHEMA_VERSION = 1

#: AI-node input/output ports carrying a ``data:schema`` record.
INPUT_SCHEMA_PORT = "input_schema"
OUTPUT_SCHEMA_PORT = "output_schema"

#: Compiler-injected executor params carrying the resolved schemas.
INPUT_SCHEMA_PARAM = "__input_schema"
OUTPUT_SCHEMA_PARAM = "__output_schema"

DEFAULT_MAX_REPAIRS = 1
MAX_REPAIRS_LIMIT = 5

SCHEMA_FIELD_TYPES: frozenset[str] = frozenset({"data", "number", "array", "record", "bool", "enum"})
CUSTOM_FIELD_NAME_RE = re.compile(r"^[a-z][a-z0-9_]{0,63}$")

COMMON_FIELDS: dict[str, dict[str, Any]] = {
    "summary": {
        "type": "data",
        "required": True,
        "description": "One-line human-readable summary of the result.",
    },
    "status": {
        "type": "enum",
        "required": True,
        "description": "Machine-readable outcome.",
        "enum_values": ["ok", "partial", "failed"],
    },
    "content": {
        "type": "data",
        "required": True,
        "description": "Primary deliverable content.",
    },
    "artifacts": {
        "type": "array",
        "required": False,
        "description": "File or asset references produced by the node.",
    },
    "metadata": {
        "type": "record",
        "required": False,
        "description": "Extensible non-business metadata.",
    },
    "error": {
        "type": "record",
        "required": False,
        "description": "Failure details; required when status is failed.",
    },
}

RESERVED_FIELD_NAMES: frozenset[str] = frozenset(COMMON_FIELDS) | frozenset({"protocol", "source_node", "run_id", "custom"})

_FENCE_RE = re.compile(r"```(?:json)?\s*(.*?)```", re.DOTALL)
_SCHEMA_REF_RE = re.compile(r"(?<!\[)\[schema\.([a-z][a-z0-9_]*(?:\.[a-z][a-z0-9_]*)*)\](?!\])")


class StructuredOutputError(ValueError):
    """A model response, schema, or schema reference is invalid."""


def _common_field_specs() -> dict[str, dict[str, Any]]:
    return {name: {**spec, "group": "common", "enum_values": list(spec.get("enum_values") or [])} for name, spec in COMMON_FIELDS.items()}


def _normalize_custom_field(raw: Any, index: int) -> dict[str, Any]:
    if not isinstance(raw, dict):
        raise StructuredOutputError(f"custom_fields[{index}] must be an object")
    name = raw.get("name")
    if not isinstance(name, str) or not CUSTOM_FIELD_NAME_RE.fullmatch(name):
        raise StructuredOutputError(f"custom_fields[{index}].name must match {CUSTOM_FIELD_NAME_RE.pattern!r}")
    if name in RESERVED_FIELD_NAMES:
        raise StructuredOutputError(f"custom field name '{name}' is reserved")
    field_type = raw.get("type")
    if field_type not in SCHEMA_FIELD_TYPES:
        raise StructuredOutputError(f"custom field '{name}' has unknown type {field_type!r}; allowed: {sorted(SCHEMA_FIELD_TYPES)}")
    required = raw.get("required", False)
    if not isinstance(required, bool):
        raise StructuredOutputError(f"custom field '{name}'.required must be a boolean")
    description = raw.get("description", "")
    if not isinstance(description, str):
        raise StructuredOutputError(f"custom field '{name}'.description must be a string")
    if len(description) > 500:
        raise StructuredOutputError(f"custom field '{name}'.description must be at most 500 characters")
    enum_values_raw = raw.get("enum_values") or []
    if not isinstance(enum_values_raw, list):
        raise StructuredOutputError(f"custom field '{name}'.enum_values must be a list")
    enum_values = list(enum_values_raw)
    if field_type == "enum" and not enum_values:
        raise StructuredOutputError(f"enum field '{name}' requires at least one enum value")
    if field_type != "enum" and enum_values:
        raise StructuredOutputError(f"custom field '{name}' has enum_values but type is {field_type!r}")
    return {
        "type": field_type,
        "required": required,
        "description": description,
        "enum_values": enum_values,
        "group": "custom",
    }


def parse_schema(raw: Any) -> dict[str, Any] | None:
    """Normalize an AI Result Schema; ``None`` when absent.

    The old ``fields: {name: type}`` payload is intentionally not accepted.
    """
    if raw is None:
        return None
    if not isinstance(raw, dict):
        raise StructuredOutputError("schema must be an object")
    # The compiler injects an already-normalized schema into executor params.
    if raw.get("version") == AI_RESULT_SCHEMA_VERSION and isinstance(raw.get("fields"), dict) and "common_fields" in raw and "custom_fields" in raw:
        return raw
    version = raw.get("version")
    if version != AI_RESULT_SCHEMA_VERSION:
        raise StructuredOutputError(f"schema.version must be {AI_RESULT_SCHEMA_VERSION}")
    custom_fields_raw = raw.get("custom_fields", [])
    if not isinstance(custom_fields_raw, list):
        raise StructuredOutputError("schema.custom_fields must be a list")
    if len(custom_fields_raw) > 32:
        raise StructuredOutputError("schema.custom_fields may contain at most 32 entries")
    try:
        max_repairs = int(raw.get("max_repairs", DEFAULT_MAX_REPAIRS))
    except (TypeError, ValueError) as exc:
        raise StructuredOutputError("schema.max_repairs must be an integer") from exc
    if max_repairs < 0 or max_repairs > MAX_REPAIRS_LIMIT:
        raise StructuredOutputError(f"schema.max_repairs must be between 0 and {MAX_REPAIRS_LIMIT}")

    fields = _common_field_specs()
    custom_fields: list[str] = []
    for index, raw_field in enumerate(custom_fields_raw):
        spec = _normalize_custom_field(raw_field, index)
        name = raw_field["name"]
        if name in fields:
            raise StructuredOutputError(f"custom field name '{name}' duplicates a common field")
        fields[name] = spec
        custom_fields.append(name)

    required = [name for name, spec in fields.items() if spec["required"]]
    enum_values = {name: list(spec["enum_values"]) for name, spec in fields.items() if spec["enum_values"]}
    return {
        "version": AI_RESULT_SCHEMA_VERSION,
        "fields": fields,
        "common_fields": list(COMMON_FIELDS),
        "custom_fields": custom_fields,
        "required": required,
        "enum_values": enum_values,
        "max_repairs": max_repairs,
    }


def common_only_schema() -> dict[str, Any]:
    """The default output contract when no ``output_schema`` is bound."""
    schema = parse_schema({"version": AI_RESULT_SCHEMA_VERSION, "custom_fields": [], "max_repairs": DEFAULT_MAX_REPAIRS})
    assert schema is not None
    return schema


def _type_ok(value: Any, spec: dict[str, Any]) -> bool:
    field_type = spec["type"]
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
        return value in spec.get("enum_values", [])
    return False


def validate_envelope(payload: Any, schema: dict[str, Any]) -> dict[str, Any]:
    """Validate a result envelope and return only declared fields.

    ``payload`` is the canonical shape:
    ``{...common fields, "custom": {...custom fields}}``.
    """
    if not isinstance(payload, dict):
        raise StructuredOutputError("result envelope must be an object")
    custom_payload = payload.get("custom", {})
    if not isinstance(custom_payload, dict):
        raise StructuredOutputError("result envelope.custom must be an object")

    result: dict[str, Any] = {}
    errors: list[str] = []
    for name, spec in schema["fields"].items():
        source = custom_payload if spec["group"] == "custom" else payload
        if name not in source:
            if spec["required"]:
                errors.append(f"missing required field '{name}'")
            continue
        value = source[name]
        if value is None and not spec["required"]:
            continue
        if not _type_ok(value, spec):
            errors.append(f"field '{name}' expected {spec['type']}, got {type(value).__name__}")
            continue
        result[name] = value

    status = result.get("status")
    if status == "failed" and "error" not in result:
        errors.append("field 'error' is required when status is 'failed'")
    if errors:
        raise StructuredOutputError("; ".join(errors))

    common_result = {name: result[name] for name in schema["common_fields"] if name in result}
    custom_result = {name: result[name] for name in schema["custom_fields"] if name in result}
    return {**common_result, "custom": custom_result}


def validate_payload(payload: dict[str, Any], schema: dict[str, Any]) -> dict[str, Any]:
    """Backward-compatible name for :func:`validate_envelope`."""
    return validate_envelope(payload, schema)


def build_envelope(payload: dict[str, Any], schema: dict[str, Any], *, source_node: str, run_id: str | None = None) -> dict[str, Any]:
    """Build the canonical AI Result Envelope from validated model fields."""
    common = {name: payload[name] for name in schema["common_fields"] if name in payload}
    common.setdefault("summary", "")
    common.setdefault("status", "ok")
    if common.get("content") is None:
        common["content"] = common.get("summary", "")
    common.setdefault("artifacts", [])
    common.setdefault("metadata", {})
    common.setdefault("error", None)
    return {
        "protocol": AI_RESULT_PROTOCOL,
        "source_node": source_node,
        "run_id": run_id,
        **common,
        "custom": dict(payload.get("custom") or {}),
    }


def schema_instruction(schema: dict[str, Any]) -> str:
    """The prompt section instructing the model to emit a matching envelope."""
    lines = [
        "Respond with a SINGLE JSON object (no prose, no code fences).",
        "The object MUST use this shape: common fields at the top level and custom fields inside 'custom'.",
        "Common fields:",
    ]
    for name in schema["common_fields"]:
        spec = schema["fields"][name]
        suffix = "required" if spec["required"] else "optional"
        enum_text = f" Allowed values: {json.dumps(spec['enum_values'], ensure_ascii=False)}." if spec["enum_values"] else ""
        lines.append(f"- {name} ({spec['type']}, {suffix}): {spec['description']}{enum_text}")
    if schema["custom_fields"]:
        lines.append("Custom fields (inside 'custom'):")
        for name in schema["custom_fields"]:
            spec = schema["fields"][name]
            suffix = "required" if spec["required"] else "optional"
            enum_text = f" Allowed values: {json.dumps(spec['enum_values'], ensure_ascii=False)}." if spec["enum_values"] else ""
            description = f" {spec['description']}" if spec["description"] else ""
            lines.append(f"- {name} ({spec['type']}, {suffix}):{description}{enum_text}")
    else:
        lines.append("Custom fields: none; use an empty 'custom' object.")
    lines.append("When status is 'failed', include a non-empty 'error' object.")
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


def _protected_refs_text(text: str) -> str:
    return text.replace("[[", "\x00").replace("]]", "\x01")


def _restore_refs_text(text: str) -> str:
    return text.replace("\x00", "[").replace("\x01", "]")


def schema_references(text: str) -> list[str]:
    """Return every ``[schema.<path>]`` reference in *text*, without duplicates."""
    return list(dict.fromkeys(match.group(1) for match in _SCHEMA_REF_RE.finditer(_protected_refs_text(text))))


def validate_schema_references(text: str, schema: dict[str, Any] | None) -> None:
    """Fail when *text* references a field the bound schema does not declare."""
    refs = schema_references(text)
    if not refs:
        return
    if schema is None:
        raise StructuredOutputError("template_prompt uses [schema.*] references but no input_schema is bound")
    for path in refs:
        if path in COMMON_FIELDS:
            continue
        if path.startswith("custom."):
            name = path[len("custom.") :]
            if name in schema["custom_fields"]:
                continue
        raise StructuredOutputError(f"template_prompt references unknown schema field '[schema.{path}]'")


def _render_schema_value(value: Any) -> str:
    if value is None:
        return ""
    if isinstance(value, str):
        return value
    return json.dumps(value, ensure_ascii=False, indent=2)


def render_schema_references(text: str, schema: dict[str, Any] | None, envelope: dict[str, Any] | None) -> str:
    """Replace ``[schema.*]`` placeholders with values from the incoming envelope."""
    if not text:
        return ""
    validate_schema_references(text, schema)
    if not schema_references(text):
        return _restore_refs_text(_protected_refs_text(text))
    if envelope is None:
        raise StructuredOutputError("template_prompt uses [schema.*] references but no incoming result envelope is available")

    def replace(match: re.Match[str]) -> str:
        path = match.group(1)
        if path in COMMON_FIELDS:
            return _render_schema_value(envelope.get(path))
        name = path[len("custom.") :]
        return _render_schema_value((envelope.get("custom") or {}).get(name))

    protected = _SCHEMA_REF_RE.sub(replace, _protected_refs_text(text))
    return _restore_refs_text(protected)


__all__ = [
    "AI_RESULT_PROTOCOL",
    "AI_RESULT_SCHEMA_VERSION",
    "COMMON_FIELDS",
    "CUSTOM_FIELD_NAME_RE",
    "DEFAULT_MAX_REPAIRS",
    "INPUT_SCHEMA_PARAM",
    "INPUT_SCHEMA_PORT",
    "MAX_REPAIRS_LIMIT",
    "OUTPUT_SCHEMA_PARAM",
    "OUTPUT_SCHEMA_PORT",
    "RESERVED_FIELD_NAMES",
    "SCHEMA_FIELD_TYPES",
    "StructuredOutputError",
    "build_envelope",
    "common_only_schema",
    "extract_json_object",
    "parse_schema",
    "render_schema_references",
    "schema_instruction",
    "schema_references",
    "validate_envelope",
    "validate_payload",
    "validate_schema_references",
]
