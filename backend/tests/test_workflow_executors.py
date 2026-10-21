"""Tests for ``deerflow.workflow.executors`` — direct executor calls, compiled-graph
integration, registry completeness, and crash-confirm gates.

Covers T5-4 acceptance criteria:
- Every atomic node type ≥1 direct-call test (input → output assertion)
- Compiled-graph: loop fixed 3 iterations, parallel 2-branch concurrency, AI
  missing-instruction error, crash_confirm rejection / admission
- Registry idempotent coverage + default registry completeness
- Mock sandbox / httpx — no real external side-effects
"""

from __future__ import annotations

import asyncio
import logging
from typing import Any
from unittest.mock import AsyncMock, MagicMock, patch

import pytest

from deerflow.workflow.compiler import (
    WorkflowRuntime,
    clear_compile_cache,
    compile_definition,
)
from deerflow.workflow.executors import (
    ExecutorRegistration,
    ExecutorRegistry,
    WorkflowExecutionError,
    build_default_registry,
    crash_confirm_required,
    exec_assign,
    exec_bash,
    exec_convert,
    exec_file,
    exec_http,
    exec_human_task,
    exec_if,
    exec_json,
    exec_llm_agent,
    exec_log,
    exec_nested_subworkflow,
    exec_notify,
    exec_regex,
    exec_switch,
    exec_wait,
)
from deerflow.workflow.schema import (
    Edge,
    Node,
    NodeType,
    Port,
    PortType,
    WorkflowDefinition,
)

# ═══════════════════════════════════════════════════════════════════════════════
# Helpers (mirror compiler-test helpers)
# ═══════════════════════════════════════════════════════════════════════════════


def _make_def(nodes: list[Node] | None = None, edges: list[Edge] | None = None, **kwargs: Any) -> WorkflowDefinition:
    kwargs.setdefault("id", "test-wf")
    kwargs.setdefault("name", "Test Workflow")
    return WorkflowDefinition(nodes=nodes or [], edges=edges or [], **kwargs)


def _start_node(id_: str = "start") -> Node:
    return Node(id=id_, type=NodeType.FLOW_START, inputs=[], outputs=[Port(name="input", type=PortType.DATA)])


def _end_node(id_: str = "end") -> Node:
    return Node(id=id_, type=NodeType.FLOW_END, inputs=[Port(name="in", type=PortType.DATA)], outputs=[])


def _node(
    id_: str,
    node_type: NodeType = NodeType.DATA_ASSIGN,
    inputs: list[Port] | None = None,
    outputs: list[Port] | None = None,
    params: dict[str, Any] | None = None,
) -> Node:
    return Node(
        id=id_,
        type=node_type,
        params=params or {},
        inputs=inputs or [Port(name="in", type=PortType.DATA)],
        outputs=outputs or [Port(name="out", type=PortType.DATA)],
    )


def _dummy_runtime(**kwargs: Any) -> WorkflowRuntime:
    """Build a minimal ``WorkflowRuntime`` for direct executor calls."""
    return WorkflowRuntime(
        context=kwargs.pop("context", {}),
        config=kwargs.pop("config", {}),
        state=kwargs.pop("state", {}),
        **kwargs,
    )


async def _run(graph: Any, initial: dict[str, Any]) -> dict[str, Any]:
    return await graph.ainvoke(initial)


def _counting_executor(counter: list[int], label: str = "") -> Any:
    """Return an executor that appends 1 to *counter* and returns its input."""

    def _exec(_rt: Any, _p: dict, _i: dict) -> dict[str, Any]:
        counter.append(1)
        return {"out": f"{label}{_i.get('in', '')}"}

    return _exec


# ═══════════════════════════════════════════════════════════════════════════════
# Fixture: isolate cache per test
# ═══════════════════════════════════════════════════════════════════════════════


@pytest.fixture(autouse=True)
def _isolate_cache() -> Any:
    clear_compile_cache()
    yield


# ═══════════════════════════════════════════════════════════════════════════════
# 1. Direct executor calls — each atomic node type
# ═══════════════════════════════════════════════════════════════════════════════


class TestExecAssign:
    """data:assign — static value assignment or input passthrough."""

    def test_static_value(self) -> None:
        rt = _dummy_runtime()
        result = exec_assign(rt, {"value": 42}, {"in": None})
        assert result == {"out": 42}

    def test_passthrough(self) -> None:
        rt = _dummy_runtime()
        result = exec_assign(rt, {}, {"in": "hello"})
        assert result == {"out": "hello"}

    def test_passthrough_none_when_missing(self) -> None:
        rt = _dummy_runtime()
        result = exec_assign(rt, {}, {})
        assert result == {"out": None}


class TestExecConvert:
    """data:convert — type conversions."""

    def test_to_bool(self) -> None:
        rt = _dummy_runtime()
        assert exec_convert(rt, {"to": "bool"}, {"in": 1}) == {"out": True}
        assert exec_convert(rt, {"to": "bool"}, {"in": 0}) == {"out": False}
        assert exec_convert(rt, {"to": "bool"}, {"in": ""}) == {"out": False}
        assert exec_convert(rt, {"to": "bool"}, {"in": "x"}) == {"out": True}

    def test_to_int(self) -> None:
        rt = _dummy_runtime()
        assert exec_convert(rt, {"to": "int"}, {"in": "42"}) == {"out": 42}
        assert exec_convert(rt, {"to": "int"}, {"in": 3.14}) == {"out": 3}
        assert exec_convert(rt, {"to": "int"}, {"in": None}) == {"out": 0}

    def test_to_float(self) -> None:
        rt = _dummy_runtime()
        assert exec_convert(rt, {"to": "float"}, {"in": "3.14"}) == {"out": 3.14}
        assert exec_convert(rt, {"to": "float"}, {"in": 5}) == {"out": 5.0}
        assert exec_convert(rt, {"to": "float"}, {"in": None}) == {"out": 0.0}

    def test_to_str(self) -> None:
        rt = _dummy_runtime()
        assert exec_convert(rt, {"to": "str"}, {"in": 42}) == {"out": "42"}
        assert exec_convert(rt, {"to": "str"}, {"in": True}) == {"out": "True"}
        assert exec_convert(rt, {"to": "str"}, {"in": None}) == {"out": "None"}


class TestExecJson:
    """data:json — stringify and parse."""

    def test_stringify(self) -> None:
        rt = _dummy_runtime()
        result = exec_json(rt, {"operation": "stringify"}, {"in": {"a": 1}})
        assert result == {"out": '{"a": 1}'}

    def test_parse(self) -> None:
        rt = _dummy_runtime()
        result = exec_json(rt, {"operation": "parse"}, {"in": '{"a": 1}'})
        assert result == {"out": {"a": 1}}

    def test_parse_already_dict_passthrough(self) -> None:
        rt = _dummy_runtime()
        result = exec_json(rt, {"operation": "parse"}, {"in": {"a": 1}})
        assert result == {"out": {"a": 1}}


class TestExecRegex:
    """data:regex — pattern matching, group extraction, no-match."""

    def test_match(self) -> None:
        rt = _dummy_runtime()
        result = exec_regex(rt, {"pattern": r"\d+"}, {"in": "abc 123 def"})
        assert result == {"out": "123"}

    def test_group_extraction(self) -> None:
        rt = _dummy_runtime()
        result = exec_regex(rt, {"pattern": r"(\w+)@(\w+)"}, {"in": "user@host"})
        assert result == {"out": "user@host"}  # match.group() → full match

    def test_named_group(self) -> None:
        rt = _dummy_runtime()
        result = exec_regex(rt, {"pattern": r"(?P<user>\w+)@(?P<domain>\w+)", "group": "user"}, {"in": "alice@example"})
        assert result == {"out": "alice"}

    def test_no_match_returns_none(self) -> None:
        rt = _dummy_runtime()
        result = exec_regex(rt, {"pattern": r"XYZ"}, {"in": "abc"})
        assert result == {"out": None}


class TestExecFile:
    """data:file — read/write via (mocked) sandbox."""

    def test_read_mocked(self) -> None:
        """file:read calls sandbox.read_file with path and returns content."""
        mock_sandbox = MagicMock()
        mock_sandbox.read_file.return_value = "file contents here"

        with patch("deerflow.workflow.executors.data.sandbox_tools.ensure_sandbox_initialized", return_value=mock_sandbox):
            rt = _dummy_runtime()
            result = asyncio.run(exec_file(rt, {"operation": "read", "path": "/mnt/user-data/workspace/f.txt"}, {"in": None}))

        assert result == {"out": "file contents here"}
        mock_sandbox.read_file.assert_called_once_with("/mnt/user-data/workspace/f.txt", start_line=None, end_line=None)

    def test_write_mocked(self) -> None:
        """file:write with crash_confirm → calls sandbox.write_file."""
        mock_sandbox = MagicMock()
        mock_sandbox.download_file.return_value = b"old"

        with patch("deerflow.workflow.executors.data.sandbox_tools.ensure_sandbox_initialized", return_value=mock_sandbox):
            rt = _dummy_runtime()
            result = asyncio.run(exec_file(rt, {"operation": "write", "path": "/mnt/user-data/outputs/o.txt", "content": "hello", "crash_confirm": True}, {}))

        assert result == {"out": "hello"}
        mock_sandbox.write_file.assert_called_once_with("/mnt/user-data/outputs/o.txt", "hello", append=False)

    def test_write_missing_crash_confirm_raises(self) -> None:
        """file:write without crash_confirm → WorkflowExecutionError."""
        with patch("deerflow.workflow.executors.data.sandbox_tools.ensure_sandbox_initialized"):
            rt = _dummy_runtime()
            with pytest.raises(WorkflowExecutionError, match="crash_confirm"):
                asyncio.run(exec_file(rt, {"operation": "write", "path": "/tmp/x"}, {}))


class TestExecWait:
    """flow:wait — sleep then passthrough."""

    def test_duration_zero_passthrough(self) -> None:
        rt = _dummy_runtime()
        result = asyncio.run(exec_wait(rt, {"duration": 0}, {"in": "data"}))
        assert result == {"out": "data"}

    @pytest.mark.asyncio
    async def test_duration_positive(self) -> None:
        rt = _dummy_runtime()
        t0 = asyncio.get_event_loop().time()
        result = await exec_wait(rt, {"duration": 0.1}, {"in": "data"})
        elapsed = asyncio.get_event_loop().time() - t0
        assert result == {"out": "data"}
        assert elapsed >= 0.05, f"Expected at least 0.05s sleep, got {elapsed:.3f}s"


class TestExecSwitch:
    """flow:switch — match cases, no-match empty."""

    def test_match_case(self) -> None:
        rt = _dummy_runtime()
        result = exec_switch(rt, {"cases": [{"value": "a", "port": "branch_a"}, {"value": "b", "port": "branch_b"}]}, {"in": "a"})
        assert result == {"branch_a": True}

    def test_no_match_returns_empty(self) -> None:
        rt = _dummy_runtime()
        result = exec_switch(rt, {"cases": [{"value": "a", "port": "branch_a"}]}, {"in": "z"})
        assert result == {}


class TestExecIf:
    """flow:if selects exactly one branch and preserves its payload."""

    def test_truthy_input_selects_true_port(self) -> None:
        rt = _dummy_runtime()
        result = exec_if(rt, {}, {"in": "hello"})
        assert result == {"true": "hello", "false": None}

    def test_falsy_payload_still_selects_false_port(self) -> None:
        rt = _dummy_runtime()
        result = exec_if(rt, {}, {"in": 0})
        assert result == {"true": None, "false": 0}

    def test_custom_ports(self) -> None:
        rt = _dummy_runtime()
        result = exec_if(rt, {"ports": ["yes", "no"]}, {"in": 1})
        assert result == {"yes": 1, "no": None}

    def test_invalid_ports_fail_loud(self) -> None:
        rt = _dummy_runtime()
        with pytest.raises(WorkflowExecutionError):
            exec_if(rt, {"ports": ["only-one"]}, {"in": 1})


class TestIfRoutingOrder:
    """flow:if routing must not depend on the order of canvas edges."""

    @pytest.mark.asyncio
    async def test_false_edge_declared_first_does_not_steal_truthy_input(self) -> None:
        from deerflow.workflow.schema import PortType, WorkflowDefinition

        if_node = Node(
            id="check",
            type=NodeType.FLOW_IF,
            inputs=[Port(name="in", type=PortType.DATA)],
            outputs=[Port(name="true", type=PortType.DATA), Port(name="false", type=PortType.DATA)],
        )
        definition = WorkflowDefinition(
            id="if-order",
            name="if order",
            nodes=[
                _start_node(),
                if_node,
                _node("yes_node"),
                _node("no_node"),
                _end_node(),
            ],
            edges=[
                Edge(source="start", source_port="input", target="check", target_port="in"),
                # Deliberately declare the false default before the true branch.
                Edge(source="check", source_port="false", target="no_node", target_port="in"),
                Edge(source="check", source_port="true", target="yes_node", target_port="in", condition="true"),
                Edge(source="yes_node", source_port="out", target="end", target_port="in"),
                Edge(source="no_node", source_port="out", target="end", target_port="in"),
            ],
        )

        clear_compile_cache()
        graph = compile_definition(definition, context=build_default_registry().build_context())
        state = await graph.ainvoke({"wf:start:input": "hello"})

        assert state.get("wf:yes_node:out") == "hello"
        assert state.get("wf:no_node:out") is None


class TestExecLog:
    """tool:log — logging + passthrough."""

    def test_log_and_passthrough(self, caplog: pytest.LogCaptureFixture) -> None:
        rt = _dummy_runtime()
        with caplog.at_level(logging.INFO, logger="deerflow.workflow.executors.tool"):
            result = exec_log(rt, {"message": "step done"}, {"in": "payload"})
        assert result == {"out": "payload"}
        assert "step done" in caplog.text

    def test_log_fallback_to_input(self, caplog: pytest.LogCaptureFixture) -> None:
        rt = _dummy_runtime()
        with caplog.at_level(logging.INFO, logger="deerflow.workflow.executors.tool"):
            result = exec_log(rt, {}, {"in": "fallback msg"})
        assert result == {"out": "fallback msg"}
        assert "fallback msg" in caplog.text


# ═══════════════════════════════════════════════════════════════════════════════
# 2. Non-idempotent executors — crash_confirm gates
# ═══════════════════════════════════════════════════════════════════════════════


class TestCrashConfirm:
    """bash and http require crash_confirm=true; missing → WorkflowExecutionError."""

    def test_bash_missing_crash_confirm_raises(self) -> None:
        rt = _dummy_runtime()
        with pytest.raises(WorkflowExecutionError, match="crash_confirm"):
            exec_bash(rt, {}, {})

    def test_bash_missing_command_raises(self) -> None:
        rt = _dummy_runtime()
        with pytest.raises(WorkflowExecutionError, match="command"):
            exec_bash(rt, {"crash_confirm": True, "command": ""}, {})

    def test_bash_with_crash_confirm_executes(self) -> None:
        """bash with crash_confirm=True → calls sandbox.execute_command."""
        mock_sandbox = MagicMock()
        mock_sandbox.execute_command.return_value = "ok\n"

        with patch("deerflow.workflow.executors.tool.sandbox_tools.ensure_sandbox_initialized", return_value=mock_sandbox):
            with patch("deerflow.workflow.executors.tool.sandbox_tools.replace_virtual_paths_in_command", side_effect=lambda cmd, td: cmd):
                with patch("deerflow.workflow.executors.tool.sandbox_tools.get_thread_data", return_value={}):
                    rt = _dummy_runtime()
                    result = exec_bash(rt, {"crash_confirm": True, "command": "echo hi"}, {})

        assert result == {"out": "ok\n"}
        mock_sandbox.execute_command.assert_called_once()

    def test_http_missing_crash_confirm_raises(self) -> None:
        rt = _dummy_runtime()
        with pytest.raises(WorkflowExecutionError, match="crash_confirm"):
            asyncio.run(exec_http(rt, {}, {}))

    @pytest.mark.asyncio
    async def test_http_with_crash_confirm(self) -> None:
        """http with crash_confirm=True → mocked httpx request, returns structured result."""
        mock_response = MagicMock()
        mock_response.status_code = 200
        mock_response.headers = {"content-type": "application/json"}
        mock_response.json.return_value = {"ok": True}

        mock_client = AsyncMock()
        mock_client.__aenter__.return_value = mock_client
        mock_client.request.return_value = mock_response

        with patch("httpx.AsyncClient", return_value=mock_client):
            rt = _dummy_runtime()
            result = await exec_http(rt, {"crash_confirm": True, "url": "http://localhost/test", "method": "GET"}, {})

        assert result["out"]["status_code"] == 200
        assert result["out"]["json"] == {"ok": True}


# ═══════════════════════════════════════════════════════════════════════════════
# 3. Compiled-graph integrations
# ═══════════════════════════════════════════════════════════════════════════════


class TestLoopCompiled:
    """flow:loop — fixed 3 iterations via compiled graph."""

    @pytest.mark.asyncio
    async def test_loop_fixed_3_iterations(self) -> None:
        """Loop body node (counting executor) executed exactly 3 times."""
        counter: list[int] = []

        nodes = [
            _start_node(),
            Node(id="loop", type=NodeType.FLOW_LOOP, params={"iterations": 3}, inputs=[Port(name="in", type=PortType.DATA)], outputs=[Port(name="out", type=PortType.DATA)]),
            _node("body", NodeType.DATA_ASSIGN),
            _end_node(),
        ]
        edges = [
            Edge(source="start", source_port="input", target="loop", target_port="in"),
            # Conditional back-edge: when count ≤ iterations, go to body
            Edge(source="loop", source_port="out", target="body", target_port="in", condition="loop_body"),
            Edge(source="body", source_port="out", target="loop", target_port="in"),
            # Default edge: when count > iterations, go to end
            Edge(source="loop", source_port="out", target="end", target_port="in"),
        ]
        def_ = _make_def(nodes, edges)
        ctx = build_default_registry().build_context()
        # Override DATA_ASSIGN with counting executor
        ctx.executors[NodeType.DATA_ASSIGN] = _counting_executor(counter)

        graph = compile_definition(def_, context=ctx)
        state = await _run(graph, {"wf:start:input": "looping"})

        # counter should have been incremented 3 times (one per loop iteration)
        assert len(counter) == 3
        # Loop count state field should be 4 (started at 0, incremented 4 times: 1,2,3,4)
        assert state.get("wf:loop:__count") == 4


class TestParallelCompiled:
    """flow:parallel — two branches both execute."""

    @pytest.mark.asyncio
    async def test_parallel_two_branches(self) -> None:
        """Both parallel branch nodes execute (count=2)."""
        counter: list[int] = []

        nodes = [
            _start_node(),
            Node(id="par", type=NodeType.FLOW_PARALLEL, inputs=[Port(name="in", type=PortType.DATA)], outputs=[Port(name="a_port", type=PortType.DATA), Port(name="b_port", type=PortType.DATA)]),
            _node("branch_a", NodeType.DATA_ASSIGN),
            _node("branch_b", NodeType.DATA_ASSIGN),
            _end_node(),
        ]
        edges = [
            Edge(source="start", source_port="input", target="par", target_port="in"),
            Edge(source="par", source_port="a_port", target="branch_a", target_port="in"),
            Edge(source="par", source_port="b_port", target="branch_b", target_port="in"),
            Edge(source="branch_a", source_port="out", target="end", target_port="in"),
            Edge(source="branch_b", source_port="out", target="end", target_port="in"),
        ]
        def_ = _make_def(nodes, edges)
        ctx = build_default_registry().build_context()
        ctx.executors[NodeType.DATA_ASSIGN] = _counting_executor(counter)

        graph = compile_definition(def_, context=ctx)
        await _run(graph, {"wf:start:input": "go"})

        assert len(counter) == 2


class TestAINodeCompiled:
    """ai:llm_agent — missing instruction raises WorkflowExecutionError."""

    @pytest.mark.asyncio
    async def test_ai_node_requires_instruction(self) -> None:
        """Compiled graph with ai:llm_agent (no instruction) → ainvoke raises WorkflowExecutionError."""
        nodes = [
            _start_node(),
            _node("ai_step", NodeType.AI_LLM_AGENT),
            _end_node(),
        ]
        edges = [
            Edge(source="start", source_port="input", target="ai_step", target_port="in"),
            Edge(source="ai_step", source_port="out", target="end", target_port="in"),
        ]
        def_ = _make_def(nodes, edges)
        ctx = build_default_registry().build_context()
        graph = compile_definition(def_, context=ctx)

        with pytest.raises(WorkflowExecutionError, match="template_prompt"):
            await _run(graph, {"wf:start:input": "query"})


# ═══════════════════════════════════════════════════════════════════════════════
# 4. Registry completeness & idempotent coverage
# ═══════════════════════════════════════════════════════════════════════════════


class TestRegistry:
    """ExecutorRegistry: 25 types registered, duplicate rejects, build_context works."""

    # All 15 NodeType values that require runtime executors (excluding flow:start,
    # flow:end, flow:loop, flow:parallel — handled natively by compiler).
    _EXPECTED_EXECUTOR_TYPES: frozenset[NodeType] = frozenset(
        {
            NodeType.FLOW_IF,
            NodeType.FLOW_SWITCH,
            NodeType.FLOW_HANDOFF,
            NodeType.FLOW_WAIT,
            NodeType.DATA_ASSIGN,
            NodeType.DATA_CONVERT,
            NodeType.DATA_ASSET,
            NodeType.DATA_SHARED,
            NodeType.DATA_FILE,
            NodeType.DATA_JSON,
            NodeType.DATA_REGEX,
            NodeType.TOOL_BASH,
            NodeType.TOOL_HTTP,
            NodeType.TOOL_NOTIFY,
            NodeType.TOOL_LOG,
            NodeType.TOOL_INVOKE,
            NodeType.AI_LLM_AGENT,
            NodeType.AI_PROMPT_PREVIEW,
            NodeType.APP_LAUNCH,
            NodeType.APP_SCRIPT,
            NodeType.APP_WAIT,
            NodeType.APP_COLLECT,
            NodeType.HUMAN_TASK,
            NodeType.HUMAN_REVIEW,
            NodeType.NESTED_SUBWORKFLOW,
        }
    )

    def test_default_registry_has_all_types(self) -> None:
        """build_default_registry() registers every expected NodeType value."""
        reg = build_default_registry()
        registered = set(reg.keys())
        assert registered == self._EXPECTED_EXECUTOR_TYPES

    def test_registry_length_is_25(self) -> None:
        reg = build_default_registry()
        assert len(reg) == 25

    def test_duplicate_register_raises_valueerror(self) -> None:
        """Registering same NodeType twice → ValueError."""
        reg = ExecutorRegistry()
        reg.register(ExecutorRegistration(node_type=NodeType.DATA_ASSIGN, executor=lambda r, p, i: {"out": 1}, idempotent=True))
        with pytest.raises(ValueError, match="already registered"):
            reg.register(ExecutorRegistration(node_type=NodeType.DATA_ASSIGN, executor=lambda r, p, i: {"out": 2}, idempotent=True))

    def test_get_unknown_type_returns_none(self) -> None:
        reg = build_default_registry()
        assert reg.get(NodeType.FLOW_START) is None

    def test_contains_works(self) -> None:
        reg = build_default_registry()
        assert NodeType.DATA_ASSIGN in reg
        assert NodeType.FLOW_START not in reg

    def test_crash_confirm_required(self) -> None:
        """crash_confirm_required returns True for bash and http only."""
        assert crash_confirm_required(NodeType.TOOL_BASH) is True
        assert crash_confirm_required(NodeType.TOOL_HTTP) is True
        assert crash_confirm_required(NodeType.DATA_ASSIGN) is False
        assert crash_confirm_required(NodeType.FLOW_WAIT) is False

    def test_build_context_is_compilable(self) -> None:
        """Registry.build_context() produces a CompileContext that compiles a minimal graph."""
        nodes = [_start_node(), _node("a", NodeType.DATA_ASSIGN), _end_node()]
        edges = [
            Edge(source="start", source_port="input", target="a", target_port="in"),
            Edge(source="a", source_port="out", target="end", target_port="in"),
        ]
        def_ = _make_def(nodes, edges)
        reg = build_default_registry()
        ctx = reg.build_context()
        graph = compile_definition(def_, context=ctx)
        assert graph is not None

    def test_registration_metadata(self) -> None:
        """Non-idempotent types have requires_confirmation=True."""
        reg = build_default_registry()
        bash_reg = reg.get(NodeType.TOOL_BASH)
        assert bash_reg is not None
        assert bash_reg.idempotent is False
        assert bash_reg.requires_confirmation is True

        http_reg = reg.get(NodeType.TOOL_HTTP)
        assert http_reg is not None
        assert http_reg.idempotent is False
        assert http_reg.requires_confirmation is True

        assign_reg = reg.get(NodeType.DATA_ASSIGN)
        assert assign_reg is not None
        assert assign_reg.idempotent is True
        assert assign_reg.requires_confirmation is False


# ═══════════════════════════════════════════════════════════════════════════════
# 5. Placeholder executors — correct exception types
# ═══════════════════════════════════════════════════════════════════════════════


class TestPlaceholderExecutors:
    """notify delivers a record; nested without a spec raises its guidance error."""

    def test_exec_notify_returns_record(self) -> None:
        rt = _dummy_runtime()
        result = exec_notify(rt, {"message": "hello"}, {})
        assert result["out"]["message"] == "hello"
        assert result["out"]["delivered"] is False  # no notifier hook → log fallback

    def test_exec_notify_falls_back_to_input_and_notifier_hook(self) -> None:
        delivered: list[dict] = []
        rt = WorkflowRuntime(context={"notifier": delivered.append})
        result = exec_notify(rt, {"title": "T"}, {"in": "from-input"})
        assert result["out"]["delivered"] is True
        assert delivered == [{"title": "T", "message": "from-input", "level": "info"}]

    def test_exec_nested_not_implemented(self) -> None:
        rt = _dummy_runtime()
        with pytest.raises(WorkflowExecutionError, match="nested:subworkflow"):
            exec_nested_subworkflow(rt, {}, {})

    def test_exec_human_task_missing_repo_raises(self) -> None:
        """human:task without a repo in context degrades to WorkflowExecutionError."""
        rt = _dummy_runtime()
        with pytest.raises(WorkflowExecutionError, match="human_task_repo"):
            asyncio.run(exec_human_task(rt, {}, {}))


# ═══════════════════════════════════════════════════════════════════════════════
# 6. Direct executor call: dummy WorkflowRuntime
# ═══════════════════════════════════════════════════════════════════════════════


class TestDirectExecutorCall:
    """Every exported executor can be called directly with a dummy WorkflowRuntime."""

    def test_all_executors_accept_dummy_runtime(self) -> None:
        """All 15 real executors accept a dummy WorkflowRuntime without LangGraph context."""
        rt = _dummy_runtime()

        # Data executors — sync
        assert exec_assign(rt, {"value": "x"}, {}) == {"out": "x"}
        assert exec_convert(rt, {"to": "str"}, {"in": 5}) == {"out": "5"}
        # json, regex, file tested above in dedicated classes
        assert exec_json(rt, {"operation": "stringify"}, {"in": [1]}) == {"out": "[1]"}
        assert exec_regex(rt, {"pattern": r"\w+"}, {"in": "abc"}) == {"out": "abc"}

        # Flow executors — sync
        assert exec_if(rt, {}, {"in": "x"}) == {"true": "x", "false": None}
        assert exec_switch(rt, {"cases": [{"value": "y", "port": "p"}]}, {"in": "y"}) == {"p": True}
        # wait tested above (async)

        # Log
        assert exec_log(rt, {"message": "t"}, {"in": "v"}) == {"out": "v"}

        # Notify — delivers a record (log fallback without a notifier hook)
        assert exec_notify(rt, {"message": "t"}, {})["out"]["delivered"] is False
        with pytest.raises(WorkflowExecutionError):
            asyncio.run(exec_human_task(rt, {}, {}))
        with pytest.raises(WorkflowExecutionError):
            exec_nested_subworkflow(rt, {}, {})
        with pytest.raises(WorkflowExecutionError):
            asyncio.run(exec_llm_agent(rt, {}, {}))
