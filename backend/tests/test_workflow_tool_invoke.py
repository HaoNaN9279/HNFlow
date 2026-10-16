"""Tests for §25 工具节点化 — the ``tool:invoke`` node (`deerflow.workflow.executors.tool`).

Covers the executor's contract (argument interpolation, provider scoping,
fail-loud resolution, crash-confirm gate), its registration semantics
(non-idempotent + crash-confirm gated + pending-review), and a real direct
invocation of a runtime-injected tool.
"""

from __future__ import annotations

import asyncio
from typing import Annotated, Any

import pytest
from langchain_core.tools import InjectedToolArg, StructuredTool
from pydantic import BaseModel, Field

from deerflow.workflow.compiler import WorkflowCompileError, WorkflowRuntime, clear_compile_cache, compile_definition
from deerflow.workflow.danger import dangerous_node_types
from deerflow.workflow.executors import build_default_registry
from deerflow.workflow.executors.tool import exec_tool_invoke
from deerflow.workflow.registry import WorkflowExecutionError, crash_confirm_required
from deerflow.workflow.schema import Edge, Node, NodeType, Port, PortType, WorkflowDefinition
from deerflow.workflow.tool_gateway import PROVIDER_APP, PROVIDER_BUILTIN, StaticToolProvider, ToolGateway

# ── tool doubles ──────────────────────────────────────────────────────────────


class _EchoInput(BaseModel):
    text: str = Field(default="", description="text to echo")
    count: int = Field(default=0, description="a number")


def _echo_tool(name: str = "echo", seen: list[dict[str, Any]] | None = None) -> StructuredTool:
    async def _run(text: str = "", count: int = 0, runtime: Annotated[Any, InjectedToolArg] = None) -> str:
        if seen is not None:
            seen.append({"text": text, "count": count, "runtime": type(runtime).__name__})
        return f"echo:{text}:{count}"

    return StructuredTool.from_function(coroutine=_run, name=name, description="echo tool", args_schema=_EchoInput)


class _PlainInput(BaseModel):
    text: str = Field(default="", description="text to echo")


def _plain_tool(name: str = "plain") -> StructuredTool:
    """A tool that declares no injected runtime — the runtime must not be passed."""

    async def _run(text: str = "") -> str:
        return f"plain:{text}"

    return StructuredTool.from_function(coroutine=_run, name=name, description="plain tool", args_schema=_PlainInput)


def _gateway(**providers: dict[str, Any]) -> ToolGateway:
    gateway = ToolGateway()
    for provider_name, tools in providers.items():
        gateway.add_provider(StaticToolProvider(provider_name, tools))
    return gateway


def _runtime(context: dict[str, Any] | None = None, *, state: dict[str, Any] | None = None) -> WorkflowRuntime:
    return WorkflowRuntime(state=state or {}, context=context or {})


def _run(coro: Any) -> Any:
    return asyncio.run(coro)


@pytest.fixture(autouse=True)
def _isolate_cache():
    clear_compile_cache()
    yield
    clear_compile_cache()


# ── registration semantics ────────────────────────────────────────────────────


class TestRegistration:
    def test_registered_and_non_idempotent(self) -> None:
        registry = build_default_registry()
        assert NodeType.TOOL_INVOKE in registry
        assert registry.get(NodeType.TOOL_INVOKE).idempotent is False

    def test_crash_confirm_gated(self) -> None:
        assert crash_confirm_required(NodeType.TOOL_INVOKE) is True

    def test_pending_review(self) -> None:
        assert NodeType.TOOL_INVOKE in dangerous_node_types()

    def test_retry_is_refused_at_compile_time(self) -> None:
        # Non-idempotent nodes cannot be retried (§24.7) — the invoke may be a
        # mutation, so a retry could repeat it.
        definition = WorkflowDefinition(
            id="wf-invoke-retry",
            name="retry",
            nodes=[
                Node(id="start", type=NodeType.FLOW_START, outputs=[Port(name="input", type=PortType.DATA)]),
                Node(id="i1", type=NodeType.TOOL_INVOKE, params={"tool": "echo", "retry": {"max_attempts": 2}}, inputs=[Port(name="in", type=PortType.DATA)], outputs=[Port(name="out", type=PortType.DATA)]),
                Node(id="end", type=NodeType.FLOW_END, inputs=[Port(name="in", type=PortType.DATA)]),
            ],
            edges=[
                Edge(source="start", source_port="input", target="i1", target_port="in"),
                Edge(source="i1", source_port="out", target="end", target_port="in"),
            ],
        )
        with pytest.raises(WorkflowCompileError, match="retry"):
            compile_definition(definition, context=build_default_registry().build_context())


# ── guards ────────────────────────────────────────────────────────────────────


class TestGuards:
    def test_requires_crash_confirm(self) -> None:
        with pytest.raises(WorkflowExecutionError, match="crash_confirm"):
            _run(exec_tool_invoke(_runtime({"tool_gateway": _gateway(builtin={"echo": _echo_tool()})}), {"tool": "echo"}, {}))

    def test_missing_tool_param(self) -> None:
        with pytest.raises(WorkflowExecutionError, match="missing required param 'tool'"):
            _run(exec_tool_invoke(_runtime({"tool_gateway": _gateway()}), {"crash_confirm": True}, {}))

    def test_blank_tool_param(self) -> None:
        with pytest.raises(WorkflowExecutionError, match="missing required param 'tool'"):
            _run(exec_tool_invoke(_runtime({}), {"tool": "   ", "crash_confirm": True}, {}))

    def test_bad_provider_param(self) -> None:
        with pytest.raises(WorkflowExecutionError, match="'provider' must be a non-empty string"):
            _run(exec_tool_invoke(_runtime({}), {"tool": "echo", "provider": "  ", "crash_confirm": True}, {}))

    def test_missing_gateway_fails_loud(self) -> None:
        with pytest.raises(WorkflowExecutionError, match="tool_gateway"):
            _run(exec_tool_invoke(_runtime({}), {"tool": "echo", "crash_confirm": True}, {}))

    def test_unknown_tool_names_the_registered_providers(self) -> None:
        gateway = _gateway(builtin={"echo": _echo_tool()})
        with pytest.raises(WorkflowExecutionError) as excinfo:
            _run(exec_tool_invoke(_runtime({"tool_gateway": gateway}), {"tool": "nope", "crash_confirm": True}, {}))
        assert "could not be resolved" in str(excinfo.value)
        assert "builtin" in str(excinfo.value)

    def test_provider_scope_can_exclude_a_matching_tool(self) -> None:
        gateway = _gateway(builtin={"echo": _echo_tool()})
        with pytest.raises(WorkflowExecutionError, match="provider='app'"):
            _run(exec_tool_invoke(_runtime({"tool_gateway": gateway}), {"tool": "echo", "provider": PROVIDER_APP, "crash_confirm": True}, {}))

    def test_non_dict_arguments_rejected(self) -> None:
        gateway = _gateway(builtin={"echo": _echo_tool()})
        with pytest.raises(WorkflowExecutionError, match="'arguments' must be an object"):
            _run(exec_tool_invoke(_runtime({"tool_gateway": gateway}), {"tool": "echo", "arguments": "not-a-dict", "crash_confirm": True}, {}))

    def test_tool_failure_is_wrapped_with_its_own_message(self) -> None:
        class _BoomInput(BaseModel):
            text: str = Field(default="")

        async def _boom(text: str = "") -> str:
            raise RuntimeError("tool exploded")

        failing = StructuredTool.from_function(coroutine=_boom, name="boom", description="boom", args_schema=_BoomInput)
        gateway = _gateway(builtin={"boom": failing})
        with pytest.raises(WorkflowExecutionError, match="tool exploded"):
            _run(exec_tool_invoke(_runtime({"tool_gateway": gateway}), {"tool": "boom", "crash_confirm": True}, {}))


# ── happy path ────────────────────────────────────────────────────────────────


class TestInvocation:
    def test_returns_text_data_and_provenance(self) -> None:
        gateway = _gateway(builtin={"echo": _echo_tool()})
        out = _run(exec_tool_invoke(_runtime({"tool_gateway": gateway}), {"tool": "echo", "arguments": {"text": "hi", "count": 3}, "crash_confirm": True}, {}))
        assert out["out"] == "echo:hi:3"
        assert out["result"] == "echo:hi:3"
        assert out["tool"] == "echo"
        assert out["provider"] == PROVIDER_BUILTIN

    def test_injected_tool_receives_a_tool_runtime(self) -> None:
        seen: list[dict[str, Any]] = []
        gateway = _gateway(builtin={"echo": _echo_tool(seen=seen)})
        _run(exec_tool_invoke(_runtime({"tool_gateway": gateway}, state={"k": 1}), {"tool": "echo", "arguments": {"text": "x"}, "crash_confirm": True}, {}))
        assert seen[0]["runtime"] == "ToolRuntime"

    def test_a_tool_without_the_injected_arg_still_works(self) -> None:
        # LangChain ignores the extra ``runtime`` key for a tool that does not
        # declare it — the reason this executor can drive both kinds.
        gateway = _gateway(builtin={"plain": _plain_tool()})
        out = _run(exec_tool_invoke(_runtime({"tool_gateway": gateway}), {"tool": "plain", "arguments": {"text": "y"}, "crash_confirm": True}, {}))
        assert out["out"] == "plain:y"

    def test_provider_scope_selects_the_right_provider(self) -> None:
        gateway = _gateway(builtin={"dup": _echo_tool("dup")}, app={"dup": _plain_tool("dup")})
        out = _run(exec_tool_invoke(_runtime({"tool_gateway": gateway}), {"tool": "dup", "provider": PROVIDER_APP, "arguments": {"text": "z"}, "crash_confirm": True}, {}))
        assert out["out"] == "plain:z"
        assert out["provider"] == PROVIDER_APP

    def test_non_string_result_is_json_encoded(self) -> None:
        class _DictInput(BaseModel):
            pass

        async def _run_dict() -> dict:
            return {"a": 1, "b": [2]}

        tool = StructuredTool.from_function(coroutine=_run_dict, name="dicts", description="d", args_schema=_DictInput)
        gateway = _gateway(builtin={"dicts": tool})
        out = _run(exec_tool_invoke(_runtime({"tool_gateway": gateway}), {"tool": "dicts", "crash_confirm": True}, {}))
        assert out["result"] == {"a": 1, "b": [2]}
        assert out["out"] == '{"a": 1, "b": [2]}'

    def test_no_arguments_is_allowed(self) -> None:
        gateway = _gateway(builtin={"plain": _plain_tool()})
        out = _run(exec_tool_invoke(_runtime({"tool_gateway": gateway}), {"tool": "plain", "crash_confirm": True}, {}))
        assert out["out"] == "plain:"


# ── argument interpolation ────────────────────────────────────────────────────


class TestArgumentInterpolation:
    def test_top_level_port_placeholder(self) -> None:
        gateway = _gateway(builtin={"echo": _echo_tool()})
        out = _run(exec_tool_invoke(_runtime({"tool_gateway": gateway}), {"tool": "echo", "arguments": {"text": "{{q}}"}, "crash_confirm": True}, {"q": "from-port"}))
        assert out["result"] == "echo:from-port:0"

    def test_exact_placeholder_keeps_the_input_type(self) -> None:
        gateway = _gateway(builtin={"echo": _echo_tool()})
        out = _run(exec_tool_invoke(_runtime({"tool_gateway": gateway}), {"tool": "echo", "arguments": {"count": "{{n}}"}, "crash_confirm": True}, {"n": 7}))
        assert out["result"] == "echo::7"

    def test_embedded_placeholder_is_stringified(self) -> None:
        gateway = _gateway(builtin={"echo": _echo_tool()})
        out = _run(exec_tool_invoke(_runtime({"tool_gateway": gateway}), {"tool": "echo", "arguments": {"text": "prefix-{{n}}-suffix"}, "crash_confirm": True}, {"n": 7}))
        assert out["result"] == "echo:prefix-7-suffix:0"

    def test_missing_port_becomes_empty(self) -> None:
        gateway = _gateway(builtin={"echo": _echo_tool()})
        out = _run(exec_tool_invoke(_runtime({"tool_gateway": gateway}), {"tool": "echo", "arguments": {"text": "{{absent}}"}, "crash_confirm": True}, {}))
        assert out["result"] == "echo::0"

    def test_nested_structures_are_interpolated(self) -> None:
        class _NestedInput(BaseModel):
            payload: dict = Field(default_factory=dict)

        async def _run_nested(payload: dict | None = None) -> str:
            return f"nested:{payload}"

        tool = StructuredTool.from_function(coroutine=_run_nested, name="nested", description="n", args_schema=_NestedInput)
        gateway = _gateway(builtin={"nested": tool})
        out = _run(
            exec_tool_invoke(
                _runtime({"tool_gateway": gateway}),
                {"tool": "nested", "arguments": {"payload": {"k": ["{{v}}", {"deep": "{{v}}"}]}}, "crash_confirm": True},
                {"v": "val"},
            )
        )
        assert out["result"] == "nested:{'k': ['val', {'deep': 'val'}]}"

    def test_non_placeholder_values_pass_through(self) -> None:
        gateway = _gateway(builtin={"echo": _echo_tool()})
        out = _run(exec_tool_invoke(_runtime({"tool_gateway": gateway}), {"tool": "echo", "arguments": {"text": "plain", "count": 5}, "crash_confirm": True}, {}))
        assert out["result"] == "echo:plain:5"
