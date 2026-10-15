"""Tests for N14 section 24.4 structured output on ``ai:llm_agent``.

``params.output_schema`` binds a model's JSON output to typed output ports, with
a bounded repair loop; ``__schema_repairs`` is surfaced on
``wf:<node_id>:__schema_repairs``.
"""

from __future__ import annotations

from types import SimpleNamespace
from typing import Any

import pytest

from deerflow.workflow.compiler import (
    WorkflowCompileError,
    clear_compile_cache,
    compile_definition,
)
from deerflow.workflow.executors import WorkflowExecutionError, build_default_registry
from deerflow.workflow.executors.ai import _run_structured_output
from deerflow.workflow.schema import (
    Edge,
    Node,
    NodeType,
    Port,
    PortType,
    WorkflowDefinition,
)
from deerflow.workflow.structured_output import (
    StructuredOutputError,
    extract_json_object,
    parse_output_schema,
    schema_instruction,
    validate_payload,
)

SCHEMA = {"fields": {"summary": "data", "score": "number"}, "required": ["summary", "score"], "enum_values": {}, "max_repairs": 1}


# ═══════════════════════════════════════════════════════════════════════════════
# Pure helpers
# ═══════════════════════════════════════════════════════════════════════════════


class TestSchemaParsing:
    def test_absent_returns_none(self) -> None:
        assert parse_output_schema({}) is None

    def test_required_defaults_to_all_fields(self) -> None:
        schema = parse_output_schema({"output_schema": {"fields": {"a": "data", "b": "number"}}})
        assert schema is not None
        assert schema["required"] == ["a", "b"]
        assert schema["max_repairs"] == 1

    def test_empty_fields_raises(self) -> None:
        with pytest.raises(StructuredOutputError):
            parse_output_schema({"output_schema": {"fields": {}}})


class TestExtractJson:
    def test_bare_object(self) -> None:
        assert extract_json_object('{"a": 1}') == {"a": 1}

    def test_fenced_object(self) -> None:
        assert extract_json_object('```json\n{"a": 1}\n```') == {"a": 1}

    def test_object_embedded_in_prose(self) -> None:
        assert extract_json_object('Here you go: {"a": 1} — done.') == {"a": 1}

    def test_non_object_raises(self) -> None:
        with pytest.raises(StructuredOutputError):
            extract_json_object("no json here")


class TestValidatePayload:
    def test_ok(self) -> None:
        assert validate_payload({"summary": "s", "score": 3}, SCHEMA) == {"summary": "s", "score": 3}

    def test_missing_required(self) -> None:
        with pytest.raises(StructuredOutputError, match="summary"):
            validate_payload({"score": 3}, SCHEMA)

    def test_wrong_type(self) -> None:
        with pytest.raises(StructuredOutputError, match="score"):
            validate_payload({"summary": "s", "score": "high"}, SCHEMA)

    def test_bool_is_not_a_number(self) -> None:
        with pytest.raises(StructuredOutputError):
            validate_payload({"summary": "s", "score": True}, SCHEMA)

    def test_enum_out_of_range(self) -> None:
        schema = {"fields": {"kind": "enum"}, "required": ["kind"], "enum_values": {"kind": ["a", "b"]}, "max_repairs": 1}
        with pytest.raises(StructuredOutputError):
            validate_payload({"kind": "c"}, schema)
        assert validate_payload({"kind": "a"}, schema) == {"kind": "a"}

    def test_instruction_lists_fields(self) -> None:
        text = schema_instruction(SCHEMA)
        assert "summary" in text and "score" in text


# ═══════════════════════════════════════════════════════════════════════════════
# Repair loop
# ═══════════════════════════════════════════════════════════════════════════════


class _FakeExecutor:
    def __init__(self, texts: list[str]) -> None:
        self.texts = list(texts)
        self.prompts: list[str] = []

    async def _aexecute(self, prompt: str) -> Any:
        self.prompts.append(prompt)
        text = self.texts.pop(0)
        return SimpleNamespace(status=SimpleNamespace(value="completed"), result=text, error=None, token_usage_records=[], stop_reason=None)


class TestRepairLoop:
    @pytest.mark.asyncio
    async def test_valid_first_try_zero_repairs(self) -> None:
        executor = _FakeExecutor(['{"summary": "ok", "score": 5}'])
        _result, output = await _run_structured_output(executor, "PROMPT", SCHEMA, "ai")
        assert output["summary"] == "ok"
        assert output["score"] == 5
        assert output["__schema_repairs"] == 0
        assert len(executor.prompts) == 1

    @pytest.mark.asyncio
    async def test_invalid_then_valid_one_repair(self) -> None:
        executor = _FakeExecutor(["not json", '{"summary": "ok", "score": 5}'])
        _result, output = await _run_structured_output(executor, "PROMPT", SCHEMA, "ai")
        assert output["__schema_repairs"] == 1
        assert len(executor.prompts) == 2
        # The repair prompt carries the validation error.
        assert "invalid" in executor.prompts[1].lower()

    @pytest.mark.asyncio
    async def test_exhausted_repairs_fail_the_node(self) -> None:
        executor = _FakeExecutor(["bad", "still bad"])
        with pytest.raises(WorkflowExecutionError):
            await _run_structured_output(executor, "PROMPT", SCHEMA, "ai")


# ═══════════════════════════════════════════════════════════════════════════════
# Compile-time binding validation + channel lift
# ═══════════════════════════════════════════════════════════════════════════════


def _start() -> Node:
    return Node(id="start", type=NodeType.FLOW_START, inputs=[], outputs=[Port(name="input", type=PortType.DATA)])


def _end() -> Node:
    return Node(id="end", type=NodeType.FLOW_END, inputs=[Port(name="in", type=PortType.DATA)], outputs=[])


def _ai(schema: dict[str, Any] | None, outputs: list[Port] | None = None) -> Node:
    params: dict[str, Any] = {"instruction": "x"}
    if schema is not None:
        params["output_schema"] = schema
    return Node(
        id="ai",
        type=NodeType.AI_LLM_AGENT,
        params=params,
        inputs=[Port(name="in", type=PortType.DATA)],
        outputs=outputs if outputs is not None else [Port(name="out", type=PortType.DATA), Port(name="summary", type=PortType.DATA), Port(name="score", type=PortType.NUMBER)],
    )


def _def(ai: Node) -> WorkflowDefinition:
    edges = [
        Edge(source="start", source_port="input", target="ai", target_port="in"),
        Edge(source="ai", source_port="out", target="end", target_port="in"),
    ]
    return WorkflowDefinition(id="test-wf", name="Test Workflow", nodes=[_start(), ai, _end()], edges=edges)


@pytest.fixture(autouse=True)
def _isolate() -> Any:
    clear_compile_cache()
    yield


class TestSchemaBindingValidation:
    def _compile(self, ai: Node) -> Any:
        return compile_definition(_def(ai), context=build_default_registry().build_context())

    def test_valid_schema_compiles(self) -> None:
        self._compile(_ai({"fields": {"summary": "data", "score": "number"}}))

    def test_field_without_port_is_compile_error(self) -> None:
        node = _ai({"fields": {"summary": "data", "missing": "data"}})
        with pytest.raises(WorkflowCompileError):
            self._compile(node)

    def test_port_type_mismatch_is_compile_error(self) -> None:
        node = _ai({"fields": {"summary": "data", "score": "data"}})  # score port is number
        with pytest.raises(WorkflowCompileError):
            self._compile(node)

    def test_unknown_type_is_compile_error(self) -> None:
        node = _ai({"fields": {"summary": "blob"}})
        with pytest.raises(WorkflowCompileError):
            self._compile(node)

    def test_max_repairs_out_of_range_is_compile_error(self) -> None:
        node = _ai({"fields": {"summary": "data", "score": "number"}, "max_repairs": 9})
        with pytest.raises(WorkflowCompileError):
            self._compile(node)

    def test_required_unknown_field_is_compile_error(self) -> None:
        node = _ai({"fields": {"summary": "data", "score": "number"}, "required": ["nope"]})
        with pytest.raises(WorkflowCompileError):
            self._compile(node)

    @pytest.mark.asyncio
    async def test_schema_repairs_lands_on_reserved_channel(self) -> None:
        def _fake(_rt: Any, _p: dict, _i: dict) -> dict[str, Any]:
            return {"out": "{}", "summary": "s", "score": 1, "__schema_repairs": 2}

        ctx = build_default_registry().build_context()
        ctx.executors[NodeType.AI_LLM_AGENT] = _fake
        graph = compile_definition(_def(_ai({"fields": {"summary": "data", "score": "number"}})), context=ctx)
        state = await graph.ainvoke({"wf:start:input": "seed"})

        assert state.get("wf:ai:__schema_repairs") == 2
