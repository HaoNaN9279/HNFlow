"""Tests for the N14 §24.7 reliability primitives.

Covers:
- pure parsing / decision logic (:mod:`deerflow.workflow.reliability`);
- compile-time gating of ``params.retry`` (idempotent nodes only);
- runtime bounded retry + the ``wf:<node>:__retry`` reservation;
- idempotency-key propagation into ``tool:http`` / ``tool:bash``.
"""

from __future__ import annotations

import types
from typing import Any

import pytest
from langgraph.errors import GraphBubbleUp

from deerflow.workflow.compiler import WorkflowCompileError, clear_compile_cache, compile_definition
from deerflow.workflow.executors import build_default_registry
from deerflow.workflow.reliability import (
    IDEMPOTENCY_ENV,
    IDEMPOTENCY_HEADER,
    IDEMPOTENCY_PARAM,
    RetryPolicy,
    RetryPolicyError,
    idempotency_key,
    is_retryable_exception,
    parse_retry_policy,
    resolve_idempotency_key,
    should_retry,
    validate_idempotency_param,
)
from deerflow.workflow.schema import Edge, Node, NodeType, Port, PortType, WorkflowDefinition


def _make_def(nodes: list[Node], edges: list[Edge]) -> WorkflowDefinition:
    return WorkflowDefinition(id="test-wf", name="Test Workflow", nodes=nodes, edges=edges)


def _start_node() -> Node:
    return Node(id="start", type=NodeType.FLOW_START, inputs=[], outputs=[Port(name="input", type=PortType.DATA)])


def _end_node() -> Node:
    return Node(id="end", type=NodeType.FLOW_END, inputs=[Port(name="in", type=PortType.DATA)], outputs=[])


def _assign_node(*, params: dict[str, Any] | None = None, node_id: str = "work") -> Node:
    return Node(
        id=node_id,
        type=NodeType.DATA_ASSIGN,
        params=params or {},
        inputs=[Port(name="in", type=PortType.DATA)],
        outputs=[Port(name="out", type=PortType.DATA)],
    )


@pytest.fixture(autouse=True)
def _isolate_cache() -> Any:
    clear_compile_cache()
    yield
    clear_compile_cache()


# ── pure: parse_retry_policy / validate_idempotency_param ────────────────────


class TestParseRetryPolicy:
    def test_absent_returns_none(self) -> None:
        assert parse_retry_policy({}) is None
        assert parse_retry_policy(None) is None

    def test_defaults(self) -> None:
        policy = parse_retry_policy({"retry": {}})
        assert policy == RetryPolicy(max_attempts=3, backoff_seconds=0.0, retry_on=None)

    def test_full_parse(self) -> None:
        policy = parse_retry_policy({"retry": {"max_attempts": 5, "backoff_seconds": 1.5, "retry_on": ["timeout", "tool"]}})
        assert policy is not None
        assert policy.max_attempts == 5
        assert policy.backoff_seconds == 1.5
        assert policy.retry_on == frozenset({"timeout", "tool"})

    @pytest.mark.parametrize("bad", [0, 11, -1, True, 2.5, "3"])
    def test_bad_max_attempts(self, bad: Any) -> None:
        with pytest.raises(RetryPolicyError):
            parse_retry_policy({"retry": {"max_attempts": bad}})

    @pytest.mark.parametrize("bad", [-1, 61, True, "1s"])
    def test_bad_backoff(self, bad: Any) -> None:
        with pytest.raises(RetryPolicyError):
            parse_retry_policy({"retry": {"backoff_seconds": bad}})

    def test_unknown_key(self) -> None:
        with pytest.raises(RetryPolicyError):
            parse_retry_policy({"retry": {"max_tries": 3}})

    def test_non_dict(self) -> None:
        with pytest.raises(RetryPolicyError):
            parse_retry_policy({"retry": [1, 2]})

    def test_retry_on_empty_and_unknown(self) -> None:
        with pytest.raises(RetryPolicyError):
            parse_retry_policy({"retry": {"retry_on": []}})
        with pytest.raises(RetryPolicyError):
            parse_retry_policy({"retry": {"retry_on": ["nope"]}})


class TestValidateIdempotencyParam:
    def test_ok(self) -> None:
        validate_idempotency_param({})
        validate_idempotency_param({"idempotency": True})
        validate_idempotency_param({"idempotency": False})
        validate_idempotency_param({"idempotency": "order-42"})

    def test_empty_string_rejected(self) -> None:
        with pytest.raises(RetryPolicyError):
            validate_idempotency_param({"idempotency": "  "})

    def test_int_rejected(self) -> None:
        with pytest.raises(RetryPolicyError):
            validate_idempotency_param({"idempotency": 1})


# ── pure: retry decision ─────────────────────────────────────────────────────


class _ControlFlow(GraphBubbleUp):
    pass


class TestRetryDecision:
    def test_retryable(self) -> None:
        assert is_retryable_exception(ValueError("boom"))
        assert not is_retryable_exception(_ControlFlow())
        assert not is_retryable_exception(KeyboardInterrupt())
        import asyncio

        assert not is_retryable_exception(asyncio.CancelledError())

    def test_attempt_bound(self) -> None:
        policy = RetryPolicy(max_attempts=3)
        assert should_retry(policy, attempt=1, exc=ValueError())
        assert should_retry(policy, attempt=2, exc=ValueError())
        assert not should_retry(policy, attempt=3, exc=ValueError())

    def test_control_flow_never_retried(self) -> None:
        assert not should_retry(RetryPolicy(max_attempts=5), attempt=1, exc=_ControlFlow())

    def test_retry_on_filters_by_failure_code(self) -> None:
        policy = RetryPolicy(max_attempts=5, retry_on=frozenset({"timeout"}))
        assert should_retry(policy, attempt=1, exc=TimeoutError())
        assert not should_retry(policy, attempt=1, exc=ValueError("boom"))


class TestIdempotencyKeys:
    def test_stable_key(self) -> None:
        assert idempotency_key("run-1", "node-a") == "run-1:node-a"
        # Same across calls — that is what lets a retry be deduped.
        assert idempotency_key("run-1", "node-a") == idempotency_key("run-1", "node-a")

    def test_resolve(self) -> None:
        assert resolve_idempotency_key({}, run_id="r", node_id="n") is None
        assert resolve_idempotency_key({"idempotency": False}, run_id="r", node_id="n") is None
        assert resolve_idempotency_key({"idempotency": True}, run_id="r", node_id="n") == "r:n"
        assert resolve_idempotency_key({"idempotency": "custom"}, run_id="r", node_id="n") == "custom"


# ── compile-time gating ──────────────────────────────────────────────────────


class TestCompileTimeRetryValidation:
    def test_non_idempotent_retry_rejected(self) -> None:
        http = Node(
            id="http",
            type=NodeType.TOOL_HTTP,
            params={"url": "https://example.com", "crash_confirm": True, "retry": {"max_attempts": 2}},
            inputs=[Port(name="in", type=PortType.DATA)],
            outputs=[Port(name="out", type=PortType.DATA)],
        )
        def_ = _make_def([_start_node(), http, _end_node()], [Edge(source="start", source_port="input", target="http", target_port="in"), Edge(source="http", source_port="out", target="end", target_port="in")])
        with pytest.raises(WorkflowCompileError, match="only allowed on idempotent"):
            compile_definition(def_, context=build_default_registry().build_context())

    def test_idempotent_retry_compiles_and_declares_channel(self) -> None:
        work = _assign_node(params={"retry": {"max_attempts": 2}})
        def_ = _make_def([_start_node(), work, _end_node()], [Edge(source="start", source_port="input", target="work", target_port="in"), Edge(source="work", source_port="out", target="end", target_port="in")])
        graph = compile_definition(def_, context=build_default_registry().build_context())
        assert graph is not None

    def test_bad_retry_shape_is_compile_error(self) -> None:
        work = _assign_node(params={"retry": {"max_attempts": 99}})
        def_ = _make_def([_start_node(), work, _end_node()], [Edge(source="start", source_port="input", target="work", target_port="in"), Edge(source="work", source_port="out", target="end", target_port="in")])
        with pytest.raises(WorkflowCompileError):
            compile_definition(def_, context=build_default_registry().build_context())

    def test_bad_idempotency_param_is_compile_error(self) -> None:
        work = _assign_node(params={"idempotency": ""})
        def_ = _make_def([_start_node(), work, _end_node()], [Edge(source="start", source_port="input", target="work", target_port="in"), Edge(source="work", source_port="out", target="end", target_port="in")])
        with pytest.raises(WorkflowCompileError):
            compile_definition(def_, context=build_default_registry().build_context())


# ── runtime retry ────────────────────────────────────────────────────────────


async def _run_assign(*, params: dict[str, Any], exec_fn: Any, context: dict[str, Any] | None = None) -> dict[str, Any]:
    ctx = build_default_registry().build_context()
    ctx.executors[NodeType.DATA_ASSIGN] = exec_fn
    nodes = [_start_node(), _assign_node(params=params), _end_node()]
    edges = [
        Edge(source="start", source_port="input", target="work", target_port="in"),
        Edge(source="work", source_port="out", target="end", target_port="in"),
    ]
    graph = compile_definition(_make_def(nodes, edges), context=ctx)
    return await graph.ainvoke({"wf:start:input": "seed"}, {"configurable": {"thread_id": "t"}, "context": context or {"run_id": "r1"}})


class TestRuntimeRetry:
    @pytest.mark.asyncio
    async def test_retries_then_succeeds(self) -> None:
        calls: list[int] = []

        def _flaky(rt: Any, _p: dict, _i: dict) -> dict[str, Any]:
            calls.append(1)
            if len(calls) < 3:
                raise ValueError("transient")
            return {"out": "ok"}

        state = await _run_assign(params={"retry": {"max_attempts": 5}}, exec_fn=_flaky)

        assert len(calls) == 3
        assert state.get("wf:work:out") == "ok"
        assert state.get("wf:work:__retry") == 2

    @pytest.mark.asyncio
    async def test_exhausted_budget_raises(self) -> None:
        calls: list[int] = []

        def _always_fail(rt: Any, _p: dict, _i: dict) -> dict[str, Any]:
            calls.append(1)
            raise ValueError("nope")

        with pytest.raises(Exception):
            await _run_assign(params={"retry": {"max_attempts": 3}}, exec_fn=_always_fail)
        assert len(calls) == 3

    @pytest.mark.asyncio
    async def test_no_retry_without_policy(self) -> None:
        calls: list[int] = []

        def _fail(rt: Any, _p: dict, _i: dict) -> dict[str, Any]:
            calls.append(1)
            raise ValueError("nope")

        with pytest.raises(Exception):
            await _run_assign(params={}, exec_fn=_fail)
        assert len(calls) == 1

    @pytest.mark.asyncio
    async def test_successful_first_attempt_writes_no_retry_channel(self) -> None:
        def _ok(rt: Any, _p: dict, _i: dict) -> dict[str, Any]:
            return {"out": "ok"}

        state = await _run_assign(params={"retry": {"max_attempts": 3}}, exec_fn=_ok)
        assert state.get("wf:work:__retry") is None

    @pytest.mark.asyncio
    async def test_control_flow_signal_is_not_retried(self) -> None:
        calls: list[int] = []

        def _control(rt: Any, _p: dict, _i: dict) -> dict[str, Any]:
            calls.append(1)
            raise _ControlFlow()

        with pytest.raises(Exception):
            await _run_assign(params={"retry": {"max_attempts": 5}}, exec_fn=_control)
        assert len(calls) == 1

    @pytest.mark.asyncio
    async def test_retry_on_skips_unlisted_failure(self) -> None:
        calls: list[int] = []

        def _fail(rt: Any, _p: dict, _i: dict) -> dict[str, Any]:
            calls.append(1)
            raise ValueError("unknown code, not timeout")

        with pytest.raises(Exception):
            await _run_assign(params={"retry": {"max_attempts": 5, "retry_on": ["timeout"]}}, exec_fn=_fail)
        assert len(calls) == 1

    @pytest.mark.asyncio
    async def test_idempotency_key_injected_into_params(self) -> None:
        seen: list[Any] = []

        def _capture(rt: Any, p: dict, _i: dict) -> dict[str, Any]:
            seen.append(p.get(IDEMPOTENCY_PARAM))
            return {"out": "ok"}

        await _run_assign(params={"idempotency": True}, exec_fn=_capture, context={"run_id": "run-x"})
        assert seen == ["run-x:work"]

    @pytest.mark.asyncio
    async def test_no_idempotency_key_when_not_requested(self) -> None:
        seen: list[Any] = []

        def _capture(rt: Any, p: dict, _i: dict) -> dict[str, Any]:
            seen.append(p.get(IDEMPOTENCY_PARAM))
            return {"out": "ok"}

        await _run_assign(params={}, exec_fn=_capture)
        assert seen == [None]


# ── executor idempotency propagation ─────────────────────────────────────────


class TestHttpIdempotencyHeader:
    @pytest.mark.asyncio
    async def test_header_added(self, monkeypatch: pytest.MonkeyPatch) -> None:
        from deerflow.workflow.executors import tool as tool_mod

        captured: dict[str, Any] = {}

        class _Response:
            status_code = 200
            headers: dict[str, str] = {}

            def json(self) -> Any:
                return {"ok": True}

        class _Client:
            def __init__(self, **_kwargs: Any) -> None:
                pass

            async def __aenter__(self) -> _Client:
                return self

            async def __aexit__(self, *_exc: Any) -> None:
                return None

            async def request(self, **kwargs: Any) -> _Response:
                captured.update(kwargs)
                return _Response()

        fake_httpx = types.SimpleNamespace(Timeout=lambda *a, **k: None, AsyncClient=_Client)
        monkeypatch.setattr(tool_mod, "httpx", fake_httpx)

        await tool_mod.exec_http(None, {"url": "https://example.com", "crash_confirm": True, IDEMPOTENCY_PARAM: "run-1:http"}, {})
        assert captured["headers"][IDEMPOTENCY_HEADER] == "run-1:http"

    @pytest.mark.asyncio
    async def test_explicit_header_wins(self, monkeypatch: pytest.MonkeyPatch) -> None:
        from deerflow.workflow.executors import tool as tool_mod

        captured: dict[str, Any] = {}

        class _Response:
            status_code = 200
            headers: dict[str, str] = {}

            def json(self) -> Any:
                return {}

        class _Client:
            def __init__(self, **_kwargs: Any) -> None:
                pass

            async def __aenter__(self) -> _Client:
                return self

            async def __aexit__(self, *_exc: Any) -> None:
                return None

            async def request(self, **kwargs: Any) -> _Response:
                captured.update(kwargs)
                return _Response()

        monkeypatch.setattr(tool_mod, "httpx", types.SimpleNamespace(Timeout=lambda *a, **k: None, AsyncClient=_Client))
        await tool_mod.exec_http(None, {"url": "https://example.com", "crash_confirm": True, "headers": {"Idempotency-Key": "mine"}, IDEMPOTENCY_PARAM: "run-1:http"}, {})
        assert captured["headers"][IDEMPOTENCY_HEADER] == "mine"


class TestBashIdempotencyEnv:
    def test_env_injected(self, monkeypatch: pytest.MonkeyPatch) -> None:
        from deerflow.workflow.executors import tool as tool_mod

        seen: dict[str, Any] = {}

        class _Sandbox:
            def execute_command(self, command: str, env: dict[str, str] | None = None, timeout: float | None = None) -> str:
                seen["env"] = env
                return "done"

        fake_sandbox_tools = types.SimpleNamespace(
            ensure_sandbox_initialized=lambda _rt: _Sandbox(),
            get_thread_data=lambda _rt: {},
            replace_virtual_paths_in_command=lambda cmd, _td: cmd,
            mask_secret_values=lambda out, _secrets: out,
        )
        monkeypatch.setattr(tool_mod, "sandbox_tools", fake_sandbox_tools)

        class _Runtime:
            state: dict[str, Any] = {}

        result = tool_mod.exec_bash(_Runtime(), {"command": "echo hi", "crash_confirm": True, IDEMPOTENCY_PARAM: "run-2:bash"}, {})
        assert result == {"out": "done"}
        assert seen["env"][IDEMPOTENCY_ENV] == "run-2:bash"

    def test_no_env_without_key(self, monkeypatch: pytest.MonkeyPatch) -> None:
        from deerflow.workflow.executors import tool as tool_mod

        seen: dict[str, Any] = {}

        class _Sandbox:
            def execute_command(self, command: str, env: dict[str, str] | None = None, timeout: float | None = None) -> str:
                seen["env"] = env
                return "done"

        monkeypatch.setattr(
            tool_mod,
            "sandbox_tools",
            types.SimpleNamespace(
                ensure_sandbox_initialized=lambda _rt: _Sandbox(),
                get_thread_data=lambda _rt: {},
                replace_virtual_paths_in_command=lambda cmd, _td: cmd,
                mask_secret_values=lambda out, _secrets: out,
            ),
        )

        class _Runtime:
            state: dict[str, Any] = {}

        tool_mod.exec_bash(_Runtime(), {"command": "echo hi", "crash_confirm": True}, {})
        assert seen["env"] is None
