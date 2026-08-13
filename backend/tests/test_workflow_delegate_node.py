"""Tests for runtime-delegation ``nested:subworkflow`` nodes (T10-5).

Covers:
- ``parse_subworkflow_spec``: ``mode="delegate"`` requires a template reference,
  and unknown ``mode`` values are rejected.
- A ``mode="delegate"`` node compiles and runs end-to-end: the parent graph
  delegates to a (mocked) sub-agent whose ``invoke_workflow`` result is parsed
  and written back to the parent output port.
- Delegation-depth guard (``CompileContext.max_delegation_depth``) raises at runtime.
- A failed delegation propagates as ``WorkflowExecutionError`` with the node path.
- An unparseable sub-agent result falls back to the raw text on the first output port.
- ``mode`` absent / ``compile`` keeps the T9 compile-time expansion path.
"""

from __future__ import annotations

from types import SimpleNamespace
from typing import Any

import pytest
from langgraph.checkpoint.memory import InMemorySaver

from deerflow.workflow.compiler import (
    CompileContext,
    WorkflowCompileError,
    clear_compile_cache,
    compile_definition,
    parse_subworkflow_spec,
)
from deerflow.workflow.executors import WorkflowExecutionError, exec_assign
from deerflow.workflow.schema import (
    Edge,
    Node,
    NodeType,
    Port,
    PortType,
    WorkflowDefinition,
)

# ═══════════════════════════════════════════════════════════════════════════════
# Helpers (minimal copies from test_workflow_subgraph.py — test files do not
# share imports to avoid coupling)
# ═══════════════════════════════════════════════════════════════════════════════


def _make_def(nodes: list[Node] | None = None, edges: list[Edge] | None = None, **kwargs: Any) -> WorkflowDefinition:
    kwargs.setdefault("id", "test-wf")
    kwargs.setdefault("name", "Test Workflow")
    return WorkflowDefinition(nodes=nodes or [], edges=edges or [], **kwargs)


def _start_node(id_: str = "start") -> Node:
    return Node(id=id_, type=NodeType.FLOW_START, inputs=[], outputs=[Port(name="input", type=PortType.DATA)])


def _end_node(id_: str = "end") -> Node:
    return Node(id=id_, type=NodeType.FLOW_END, inputs=[Port(name="in", type=PortType.DATA)], outputs=[])


def _child_def(*, child_id: str = "child", assign_value: Any = None, prefix: str = "") -> WorkflowDefinition:
    """Build a minimal child subgraph ``cstart → cassign → cend``."""
    start_id = f"{prefix}cstart"
    assign_id = f"{prefix}cassign"
    end_id = f"{prefix}cend"
    params: dict[str, Any] = {} if assign_value is None else {"value": assign_value}
    return _make_def(
        nodes=[
            Node(id=start_id, type=NodeType.FLOW_START, inputs=[], outputs=[Port(name="in", type=PortType.DATA)]),
            Node(id=assign_id, type=NodeType.DATA_ASSIGN, params=params, inputs=[Port(name="in", type=PortType.DATA)], outputs=[Port(name="out", type=PortType.DATA)]),
            Node(id=end_id, type=NodeType.FLOW_END, inputs=[Port(name="in", type=PortType.DATA)], outputs=[Port(name="result", type=PortType.DATA)]),
        ],
        edges=[
            Edge(source=start_id, source_port="in", target=assign_id, target_port="in"),
            Edge(source=assign_id, source_port="out", target=end_id, target_port="in"),
        ],
        id=child_id,
        name=child_id,
    )


def _delegate_node(
    id_: str = "sub",
    *,
    template_id: str = "wf-child",
    mapping: dict[str, Any] | None = None,
    allow_recursion: bool = False,
) -> Node:
    """Build a ``nested:subworkflow`` node carrying a ``mode="delegate"`` template spec."""
    params: dict[str, Any] = {"subworkflow": {"type": "template", "template_id": template_id, "mode": "delegate"}}
    if mapping is not None:
        params["mapping"] = mapping
    if allow_recursion:
        params["allow_recursion"] = True
    return Node(
        id=id_,
        type=NodeType.NESTED_SUBWORKFLOW,
        params=params,
        inputs=[Port(name="in", type=PortType.DATA)],
        outputs=[Port(name="out", type=PortType.DATA)],
    )


def _compile_sub_node(
    id_: str = "sub",
    *,
    template_id: str | None = None,
    definition: dict[str, Any] | None = None,
    mapping: dict[str, Any] | None = None,
) -> Node:
    """Build a ``nested:subworkflow`` node without an explicit ``mode`` (T9 compile path)."""
    params: dict[str, Any] = {}
    if definition is not None:
        params["subworkflow"] = {"type": "inline", "definition": definition}
    elif template_id is not None:
        params["subworkflow"] = {"type": "template", "template_id": template_id}
    if mapping is not None:
        params["mapping"] = mapping
    return Node(
        id=id_,
        type=NodeType.NESTED_SUBWORKFLOW,
        params=params,
        inputs=[Port(name="in", type=PortType.DATA)],
        outputs=[Port(name="out", type=PortType.DATA)],
    )


def _roundtrip_mapping() -> dict[str, Any]:
    """Standard input/output mapping: parent start → child start, child end → parent out."""
    return {"inputs": {"in": "wf:start:input"}, "outputs": {"result": "out"}}


def _parent_def_with_delegate(mapping: dict[str, Any], *, template_id: str = "wf-child") -> WorkflowDefinition:
    sub = _delegate_node("sub", template_id=template_id, mapping=mapping)
    nodes = [_start_node(), sub, _end_node()]
    edges = [
        Edge(source="start", source_port="input", target="sub", target_port="in"),
        Edge(source="sub", source_port="out", target="end", target_port="in"),
    ]
    return _make_def(nodes, edges)


def _resolver(child: WorkflowDefinition) -> Any:
    templates = {child.id: child}

    def resolver(template_id: str, _version: str | None) -> WorkflowDefinition | None:
        return templates.get(template_id)

    return resolver


def _completed_result(text: str) -> Any:
    return SimpleNamespace(status=SimpleNamespace(value="completed"), result=text, error=None)


def _failed_result(error: str) -> Any:
    return SimpleNamespace(status=SimpleNamespace(value="failed"), result=None, error=error)


# ═══════════════════════════════════════════════════════════════════════════════
# Fixtures
# ═══════════════════════════════════════════════════════════════════════════════


@pytest.fixture(autouse=True)
def _isolate_cache() -> Any:
    clear_compile_cache()
    yield


@pytest.fixture
def fake_executor(monkeypatch: pytest.MonkeyPatch) -> Any:
    """Replace ``SubagentExecutor`` with a fake that returns a scripted result.

    The delegate node fn lazily imports ``SubagentExecutor`` from
    ``deerflow.subagents``; patching the package attribute shadows that lazy
    export without importing the real (heavy) executor module.
    """
    captured: dict[str, Any] = {}

    class FakeExecutor:
        def __init__(self, **kwargs: Any) -> None:
            captured["kwargs"] = kwargs

        async def _aexecute(self, task: str, result_holder: Any = None) -> Any:
            captured["task"] = task
            return captured["result"]

    import deerflow.subagents as subagents_pkg

    monkeypatch.setattr(subagents_pkg, "SubagentExecutor", FakeExecutor)
    yield captured


# ═══════════════════════════════════════════════════════════════════════════════
# 1. Spec parsing: mode validation
# ═══════════════════════════════════════════════════════════════════════════════


class TestSpecModeValidation:
    def test_delegate_spec_requires_template(self) -> None:
        node = Node(
            id="n",
            type=NodeType.NESTED_SUBWORKFLOW,
            params={"subworkflow": {"type": "inline", "definition": _child_def().model_dump(mode="json"), "mode": "delegate"}},
        )
        with pytest.raises(WorkflowCompileError, match="delegate mode requires a template"):
            parse_subworkflow_spec(node)

    def test_delegate_mode_invalid_value(self) -> None:
        node = Node(
            id="n",
            type=NodeType.NESTED_SUBWORKFLOW,
            params={"subworkflow": {"type": "template", "template_id": "wf-x", "mode": "bogus"}},
        )
        with pytest.raises(WorkflowCompileError, match="mode"):
            parse_subworkflow_spec(node)

    def test_delegate_mode_is_returned(self) -> None:
        node = Node(
            id="n",
            type=NodeType.NESTED_SUBWORKFLOW,
            params={"subworkflow": {"type": "template", "template_id": "wf-x", "mode": "delegate"}},
        )
        spec = parse_subworkflow_spec(node)
        assert spec is not None
        assert spec["mode"] == "delegate"


# ═══════════════════════════════════════════════════════════════════════════════
# 2. Delegate node runtime behavior
# ═══════════════════════════════════════════════════════════════════════════════


class TestDelegateNodeRuntime:
    @pytest.mark.asyncio
    async def test_delegate_node_compiles_and_runs(self, fake_executor: dict[str, Any]) -> None:
        child = _child_def(child_id="wf-child")
        fake_executor["result"] = _completed_result('{"result": "hello"}')
        def_ = _parent_def_with_delegate(_roundtrip_mapping())
        ctx = CompileContext(
            executors={NodeType.DATA_ASSIGN: exec_assign},
            checkpointer=InMemorySaver(),
            definition_resolver=_resolver(child),
        )
        graph = compile_definition(def_, context=ctx)

        state = await graph.ainvoke(
            {"wf:start:input": "ignored"},
            {"configurable": {"thread_id": "t-parent"}, "context": {"thread_id": "t-parent", "delegation_depth": 0}},
        )

        assert state.get("wf:sub:out") == "hello"
        # The delegate node must construct a checkpoint-enabled sub-agent bound
        # to the invoke_workflow tool, with an independent checkpoint thread and
        # the parent delegation depth incremented by one.
        kwargs = fake_executor["kwargs"]
        assert kwargs["config"].checkpointer is True
        assert kwargs["checkpointer"] is not None
        assert kwargs["checkpoint_thread_id"] == "t-parent:wfsub:sub"
        assert kwargs["delegation_depth"] == 1
        assert len(kwargs["tools"]) == 1
        assert kwargs["tools"][0].name == "invoke_workflow"

    @pytest.mark.asyncio
    async def test_delegate_depth_exceeded(self, fake_executor: dict[str, Any]) -> None:
        child = _child_def(child_id="wf-child")
        fake_executor["result"] = _completed_result('{"result": "hello"}')
        def_ = _parent_def_with_delegate(_roundtrip_mapping())
        ctx = CompileContext(
            executors={NodeType.DATA_ASSIGN: exec_assign},
            checkpointer=InMemorySaver(),
            definition_resolver=_resolver(child),
            max_delegation_depth=0,
        )
        graph = compile_definition(def_, context=ctx)

        with pytest.raises(WorkflowExecutionError, match="delegation depth"):
            await graph.ainvoke(
                {"wf:start:input": "x"},
                {"configurable": {"thread_id": "t"}, "context": {"delegation_depth": 0}},
            )

    @pytest.mark.asyncio
    async def test_delegate_failure_propagates(self, fake_executor: dict[str, Any]) -> None:
        child = _child_def(child_id="wf-child")
        fake_executor["result"] = _failed_result("boom")
        def_ = _parent_def_with_delegate(_roundtrip_mapping())
        ctx = CompileContext(
            executors={NodeType.DATA_ASSIGN: exec_assign},
            checkpointer=InMemorySaver(),
            definition_resolver=_resolver(child),
        )
        graph = compile_definition(def_, context=ctx)

        with pytest.raises(WorkflowExecutionError, match="subagent delegation failed") as exc_info:
            await graph.ainvoke(
                {"wf:start:input": "x"},
                {"configurable": {"thread_id": "t"}, "context": {"delegation_depth": 0}},
            )
        assert "node 'sub'" in str(exc_info.value)
        assert "boom" in str(exc_info.value)

    @pytest.mark.asyncio
    async def test_delegate_unparseable_result_fallback(self, fake_executor: dict[str, Any]) -> None:
        child = _child_def(child_id="wf-child")
        fake_executor["result"] = _completed_result("just some prose, not JSON")
        def_ = _parent_def_with_delegate(_roundtrip_mapping())
        ctx = CompileContext(
            executors={NodeType.DATA_ASSIGN: exec_assign},
            checkpointer=InMemorySaver(),
            definition_resolver=_resolver(child),
        )
        graph = compile_definition(def_, context=ctx)

        state = await graph.ainvoke(
            {"wf:start:input": "x"},
            {"configurable": {"thread_id": "t"}, "context": {"delegation_depth": 0}},
        )

        assert state.get("wf:sub:out") == "just some prose, not JSON"


# ═══════════════════════════════════════════════════════════════════════════════
# 3. Regression: mode absent / compile keeps the T9 expansion path
# ═══════════════════════════════════════════════════════════════════════════════


class TestCompileModeUnchanged:
    @pytest.mark.asyncio
    async def test_compile_mode_unchanged(self) -> None:
        """A subworkflow node without ``mode`` still expands in-graph (T9 path)."""
        child = _child_def(child_id="wf-child", assign_value="computed")
        sub = _compile_sub_node("sub", template_id="wf-child", mapping=_roundtrip_mapping())
        nodes = [_start_node(), sub, _end_node()]
        edges = [
            Edge(source="start", source_port="input", target="sub", target_port="in"),
            Edge(source="sub", source_port="out", target="end", target_port="in"),
        ]
        def_ = _make_def(nodes, edges)
        ctx = CompileContext(executors={NodeType.DATA_ASSIGN: exec_assign}, definition_resolver=_resolver(child))
        graph = compile_definition(def_, context=ctx)

        state = await graph.ainvoke({"wf:start:input": "ignored"})

        assert state.get("wf:sub:out") == "computed"


# ═══════════════════════════════════════════════════════════════════════════════
# 4. Regression pin: full delegation-depth propagation chain (T10-6)
# ═══════════════════════════════════════════════════════════════════════════════


class TestDelegationDepthChain:
    @pytest.mark.asyncio
    async def test_delegate_node_depth_propagates_to_executor_context(self, fake_executor: dict[str, Any]) -> None:
        """A nested parent (depth 1) must pass ``depth + 1`` to its sub-agent executor.

        Pins the delegate node's ``+1``: without it a sub-agent re-runs at the
        parent's depth and unbounded recursive delegation is not bounded by
        ``CompileContext.max_delegation_depth``.
        """
        child = _child_def(child_id="wf-child")
        fake_executor["result"] = _completed_result('{"result": "hello"}')
        def_ = _parent_def_with_delegate(_roundtrip_mapping())
        ctx = CompileContext(
            executors={NodeType.DATA_ASSIGN: exec_assign},
            checkpointer=InMemorySaver(),
            definition_resolver=_resolver(child),
            max_delegation_depth=3,
        )
        graph = compile_definition(def_, context=ctx)

        await graph.ainvoke(
            {"wf:start:input": "ignored"},
            {"configurable": {"thread_id": "t-parent"}, "context": {"thread_id": "t-parent", "delegation_depth": 1}},
        )

        assert fake_executor["kwargs"]["delegation_depth"] == 2

    @pytest.mark.asyncio
    async def test_delegate_node_depth_limit_at_boundary(self, fake_executor: dict[str, Any]) -> None:
        """Reaching ``max_delegation_depth`` at the delegate node raises, not delegates.

        Pins the boundary check (``depth >= max``): a parent already at the
        ceiling must be refused before it constructs a sub-agent executor.
        """
        child = _child_def(child_id="wf-child")
        fake_executor["result"] = _completed_result('{"result": "hello"}')
        def_ = _parent_def_with_delegate(_roundtrip_mapping())
        ctx = CompileContext(
            executors={NodeType.DATA_ASSIGN: exec_assign},
            checkpointer=InMemorySaver(),
            definition_resolver=_resolver(child),
            max_delegation_depth=3,
        )
        graph = compile_definition(def_, context=ctx)

        with pytest.raises(WorkflowExecutionError, match="delegation depth exceeded"):
            await graph.ainvoke(
                {"wf:start:input": "x"},
                {"configurable": {"thread_id": "t"}, "context": {"delegation_depth": 3}},
            )
