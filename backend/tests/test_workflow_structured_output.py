"""Tests for the AI Result Schema contract on ``ai:llm_agent``."""

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
    AI_RESULT_PROTOCOL,
    StructuredOutputError,
    build_envelope,
    common_only_schema,
    extract_json_object,
    parse_schema,
    render_schema_references,
    schema_instruction,
    validate_envelope,
    validate_schema_references,
)

SCHEMA_RAW = {
    "version": 1,
    "max_repairs": 1,
    "custom_fields": [
        {"name": "score", "type": "number", "required": True, "description": "Score"},
    ],
}
SCHEMA = parse_schema(SCHEMA_RAW)
assert SCHEMA is not None


# ═══════════════════════════════════════════════════════════════════════════════
# Pure helpers
# ═══════════════════════════════════════════════════════════════════════════════


class TestSchemaParsing:
    def test_absent_returns_none(self) -> None:
        assert parse_schema(None) is None

    def test_common_fields_are_injected(self) -> None:
        assert SCHEMA["common_fields"] == ["summary", "status", "content", "artifacts", "metadata", "error"]
        assert SCHEMA["required"] == ["summary", "status", "content", "score"]

    def test_old_fields_map_is_rejected(self) -> None:
        with pytest.raises(StructuredOutputError, match="version"):
            parse_schema({"fields": {"summary": "data"}})

    def test_empty_custom_fields_is_valid(self) -> None:
        schema = parse_schema({"version": 1, "custom_fields": []})
        assert schema is not None
        assert schema["custom_fields"] == []

    def test_reserved_custom_name_is_rejected(self) -> None:
        with pytest.raises(StructuredOutputError, match="reserved"):
            parse_schema({"version": 1, "custom_fields": [{"name": "summary", "type": "data"}]})

    def test_enum_requires_values(self) -> None:
        with pytest.raises(StructuredOutputError, match="enum"):
            parse_schema({"version": 1, "custom_fields": [{"name": "kind", "type": "enum"}]})

    def test_unknown_type_is_rejected(self) -> None:
        with pytest.raises(StructuredOutputError, match="unknown type"):
            parse_schema({"version": 1, "custom_fields": [{"name": "blob", "type": "file"}]})

    def test_max_repairs_range(self) -> None:
        with pytest.raises(StructuredOutputError, match="max_repairs"):
            parse_schema({"version": 1, "max_repairs": 9, "custom_fields": []})


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


class TestValidateEnvelope:
    def test_ok(self) -> None:
        assert validate_envelope(
            {"summary": "s", "status": "ok", "content": "c", "custom": {"score": 3}},
            SCHEMA,
        ) == {"summary": "s", "status": "ok", "content": "c", "custom": {"score": 3}}

    def test_missing_required(self) -> None:
        with pytest.raises(StructuredOutputError, match="summary"):
            validate_envelope({"status": "ok", "content": "c", "custom": {"score": 3}}, SCHEMA)

    def test_wrong_custom_type(self) -> None:
        with pytest.raises(StructuredOutputError, match="score"):
            validate_envelope({"summary": "s", "status": "ok", "content": "c", "custom": {"score": "high"}}, SCHEMA)

    def test_bool_is_not_a_number(self) -> None:
        with pytest.raises(StructuredOutputError):
            validate_envelope({"summary": "s", "status": "ok", "content": "c", "custom": {"score": True}}, SCHEMA)

    def test_failed_requires_error(self) -> None:
        with pytest.raises(StructuredOutputError, match="error"):
            validate_envelope({"summary": "s", "status": "failed", "content": "c", "custom": {"score": 1}}, SCHEMA)

    def test_custom_must_be_an_object(self) -> None:
        with pytest.raises(StructuredOutputError, match="custom"):
            validate_envelope({"summary": "s", "status": "ok", "content": "c", "custom": []}, SCHEMA)

    def test_optional_null_is_treated_as_absent(self) -> None:
        assert validate_envelope(
            {"summary": "s", "status": "ok", "content": "c", "error": None, "custom": {"score": 1}},
            SCHEMA,
        ) == {"summary": "s", "status": "ok", "content": "c", "custom": {"score": 1}}

    def test_build_envelope(self) -> None:
        envelope = build_envelope(
            {"summary": "s", "status": "ok", "content": "c", "custom": {"score": 3}},
            SCHEMA,
            source_node="writer",
            run_id="run-1",
        )
        assert envelope["protocol"] == AI_RESULT_PROTOCOL
        assert envelope["source_node"] == "writer"
        assert envelope["run_id"] == "run-1"
        assert envelope["custom"] == {"score": 3}

    def test_common_only_schema(self) -> None:
        assert common_only_schema()["custom_fields"] == []


class TestSchemaReferences:
    def test_renders_common_and_custom(self) -> None:
        text = "S=[schema.summary] C=[schema.custom.score]"
        assert (
            render_schema_references(
                text,
                SCHEMA,
                {"summary": "ok", "custom": {"score": 3}},
            )
            == "S=ok C=3"
        )

    def test_unknown_reference_fails(self) -> None:
        with pytest.raises(StructuredOutputError, match="unknown schema field"):
            validate_schema_references("[schema.nope]", SCHEMA)

    def test_reference_without_input_schema_fails(self) -> None:
        with pytest.raises(StructuredOutputError, match="no input_schema"):
            validate_schema_references("[schema.summary]", None)

    def test_escaped_reference_is_literal(self) -> None:
        assert render_schema_references("[[schema.summary]]", SCHEMA, {}) == "[schema.summary]"

    def test_json_value_is_pretty_printed(self) -> None:
        assert '"a": 1' in render_schema_references(
            "[schema.metadata]",
            SCHEMA,
            {"metadata": {"a": 1}},
        )

    def test_instruction_lists_fields(self) -> None:
        text = schema_instruction(SCHEMA)
        assert "summary" in text and "score" in text and "custom" in text


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


class _FakeAdapter:
    def __init__(self, executor: _FakeExecutor) -> None:
        self.executor = executor

    async def execute(self, request: Any) -> Any:
        from deerflow.workflow.agent_port import AgentTurnResult

        raw = await self.executor._aexecute(request.task)
        return AgentTurnResult(
            status=raw.status,
            result=raw.result,
            error=raw.error,
            token_usage_records=raw.token_usage_records,
            stop_reason=raw.stop_reason,
            raw=raw,
        )


def _request(task: str) -> Any:
    from deerflow.workflow.agent_port import AgentTurnRequest

    return AgentTurnRequest(task=task)


class TestRepairLoop:
    @pytest.mark.asyncio
    async def test_valid_first_try_zero_repairs(self) -> None:
        executor = _FakeExecutor(['{"summary": "ok", "status": "ok", "content": "done", "custom": {"score": 5}}'])
        _result, output = await _run_structured_output(_FakeAdapter(executor), _request("PROMPT"), "PROMPT", SCHEMA, "ai")
        assert output["summary"] == "ok"
        assert output["custom"] == {"score": 5}
        assert output["__schema_repairs"] == 0
        assert len(executor.prompts) == 1

    @pytest.mark.asyncio
    async def test_invalid_then_valid_one_repair(self) -> None:
        executor = _FakeExecutor(["not json", '{"summary": "ok", "status": "ok", "content": "done", "custom": {"score": 5}}'])
        _result, output = await _run_structured_output(_FakeAdapter(executor), _request("PROMPT"), "PROMPT", SCHEMA, "ai")
        assert output["__schema_repairs"] == 1
        assert len(executor.prompts) == 2
        assert "invalid" in executor.prompts[1].lower()

    @pytest.mark.asyncio
    async def test_exhausted_repairs_fail_the_node(self) -> None:
        executor = _FakeExecutor(["bad", "still bad"])
        with pytest.raises(WorkflowExecutionError):
            await _run_structured_output(_FakeAdapter(executor), _request("PROMPT"), "PROMPT", SCHEMA, "ai")


# ═══════════════════════════════════════════════════════════════════════════════
# Compile-time binding validation
# ═══════════════════════════════════════════════════════════════════════════════


def _start() -> Node:
    return Node(id="start", type=NodeType.FLOW_START, outputs=[Port(name="input", type=PortType.DATA)])


def _end() -> Node:
    return Node(id="end", type=NodeType.FLOW_END, inputs=[Port(name="in", type=PortType.DATA)], outputs=[])


def _schema_node(node_id: str, raw: dict[str, Any] | None = None) -> Node:
    return Node(
        id=node_id,
        type=NodeType.DATA_SCHEMA,
        outputs=[Port(name="schema", type=PortType.RECORD)],
        params={"schema": raw or SCHEMA_RAW},
    )


def _ai(node_id: str, *, input_schema: bool = False, output_schema: bool = True) -> Node:
    inputs = [Port(name="in", type=PortType.DATA), Port(name="template_prompt", type=PortType.DATA)]
    if input_schema:
        inputs.append(Port(name="input_schema", type=PortType.RECORD))
    if output_schema:
        inputs.append(Port(name="output_schema", type=PortType.RECORD))
    return Node(id=node_id, type=NodeType.AI_LLM_AGENT, inputs=inputs, outputs=[Port(name="out", type=PortType.DATA)])


def _definition(*, writer_input: bool = False, reviewer_output: bool = True, source_schema: str = "schema", target_schema: str | None = None) -> WorkflowDefinition:
    target_schema = target_schema or source_schema
    nodes = [
        _start(),
        _ai("writer", input_schema=writer_input, output_schema=True),
        _ai("reviewer", input_schema=True, output_schema=reviewer_output),
        _end(),
        _schema_node("schema"),
    ]
    if target_schema != "schema":
        nodes.append(_schema_node(target_schema))
    edges = [
        Edge(source="start", source_port="input", target="writer", target_port="in"),
        Edge(source="start", source_port="input", target="writer", target_port="template_prompt"),
        Edge(source="schema", source_port="schema", target="writer", target_port="output_schema"),
        Edge(source="writer", source_port="out", target="reviewer", target_port="in"),
        Edge(source="start", source_port="input", target="reviewer", target_port="template_prompt"),
        Edge(source=target_schema, source_port="schema", target="reviewer", target_port="input_schema"),
        Edge(source="reviewer", source_port="out", target="end", target_port="in"),
    ]
    if reviewer_output:
        edges.append(Edge(source="schema", source_port="schema", target="reviewer", target_port="output_schema"))
    if writer_input:
        edges.append(Edge(source="schema", source_port="schema", target="writer", target_port="input_schema"))
    return WorkflowDefinition(id="test-wf", name="Test Workflow", nodes=nodes, edges=edges)


@pytest.fixture(autouse=True)
def _isolate() -> Any:
    clear_compile_cache()
    yield


class TestSchemaBindingValidation:
    def _compile(self, definition: WorkflowDefinition) -> Any:
        return compile_definition(definition, context=build_default_registry().build_context())

    def test_valid_same_schema_compiles(self) -> None:
        self._compile(_definition())

    def test_input_schema_requires_in_edge(self) -> None:
        definition = _definition(writer_input=True)
        definition.edges = [edge for edge in definition.edges if not (edge.target == "writer" and edge.target_port == "in")]
        with pytest.raises(WorkflowCompileError, match="incoming 'in'"):
            self._compile(definition)

    def test_cross_schema_delivery_is_compile_error(self) -> None:
        with pytest.raises(WorkflowCompileError, match="same data:schema node"):
            self._compile(_definition(target_schema="schema2"))

    def test_missing_receiver_schema_is_compile_error(self) -> None:
        definition = _definition()
        definition.edges = [edge for edge in definition.edges if not (edge.target == "reviewer" and edge.target_port == "input_schema")]
        with pytest.raises(WorkflowCompileError, match="both nodes to bind"):
            self._compile(definition)

    def test_old_schema_is_compile_error(self) -> None:
        definition = _definition()
        schema_node = next(node for node in definition.nodes if node.id == "schema")
        schema_node.params = {"schema": {"fields": {"summary": "data"}}}
        with pytest.raises(WorkflowCompileError, match="invalid schema"):
            self._compile(definition)

    @pytest.mark.asyncio
    async def test_schema_repairs_lands_on_reserved_channel(self) -> None:
        def _fake(_rt: Any, _p: dict, _i: dict) -> dict[str, Any]:
            return {"out": {}, "__schema_repairs": 2}

        ctx = build_default_registry().build_context()
        ctx.executors[NodeType.AI_LLM_AGENT] = _fake
        graph = compile_definition(_definition(), context=ctx)
        state = await graph.ainvoke({"wf:start:input": "seed"})

        assert state.get("wf:writer:__schema_repairs") == 2
