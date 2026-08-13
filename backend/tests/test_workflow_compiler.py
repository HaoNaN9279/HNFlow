"""Tests for ``deerflow.workflow.compiler`` — compile_definition, CompileContext, cache, errors.

Covers:
- Serial pipeline with sync / async executors
- ``flow:if`` conditional branching (true, false, default fallback, to-end)
- Compile cache identity, key separation, clear
- Graph topology via ``get_graph()`` (nodes, edges, conditional edges)
- Boundary error conditions (missing executor, unsupported types, missing default, etc.)
"""

from __future__ import annotations

import asyncio
from typing import Any

import pytest

from deerflow.workflow.compiler import (
    CompileContext,
    WorkflowCompileError,
    clear_compile_cache,
    compile_definition,
    parse_subworkflow_spec,
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
# Helpers
# ═══════════════════════════════════════════════════════════════════════════════


def _make_def(nodes: list[Node] | None = None, edges: list[Edge] | None = None, **kwargs: Any) -> WorkflowDefinition:
    kwargs.setdefault("id", "test-wf")
    kwargs.setdefault("name", "Test Workflow")
    return WorkflowDefinition(
        nodes=nodes or [],
        edges=edges or [],
        **kwargs,
    )


def _start_node(id_: str = "start") -> Node:
    return Node(id=id_, type=NodeType.FLOW_START, inputs=[], outputs=[Port(name="input", type=PortType.DATA)])


def _end_node(id_: str = "end") -> Node:
    return Node(id=id_, type=NodeType.FLOW_END, inputs=[Port(name="in", type=PortType.DATA)], outputs=[])


def _node(
    id_: str,
    node_type: NodeType = NodeType.DATA_ASSIGN,
    inputs: list[Port] | None = None,
    outputs: list[Port] | None = None,
) -> Node:
    return Node(
        id=id_,
        type=node_type,
        inputs=inputs or [Port(name="in", type=PortType.DATA)],
        outputs=outputs or [Port(name="out", type=PortType.DATA)],
    )


def _if_node(id_: str = "check") -> Node:
    return Node(
        id=id_,
        type=NodeType.FLOW_IF,
        inputs=[Port(name="in", type=PortType.DATA)],
        outputs=[Port(name="true", type=PortType.DATA), Port(name="false", type=PortType.DATA)],
    )


def _exec_identity() -> Any:
    """Executor that returns input as-is under 'out'."""
    return lambda _rt, _p, _i: {"out": _i.get("in")}


def _exec_prefix(prefix: str) -> Any:
    """Executor that prepends *prefix* to input."""
    return lambda _rt, _p, _i: {"out": f"{prefix}{_i.get('in', '')}"}


async def _run(graph: Any, initial: dict[str, Any]) -> dict[str, Any]:
    return await graph.ainvoke(initial)


# ═══════════════════════════════════════════════════════════════════════════════
# Fixture: isolate cache per test
# ═══════════════════════════════════════════════════════════════════════════════


@pytest.fixture(autouse=True)
def _isolate_cache() -> Any:
    clear_compile_cache()
    yield


# ═══════════════════════════════════════════════════════════════════════════════
# 1. Serial flow
# ═══════════════════════════════════════════════════════════════════════════════


class TestSerialFlow:
    """3-node pipeline: start → a → b → end."""

    @pytest.mark.asyncio
    async def test_sync_executor_data_flow(self) -> None:
        """Sync executors — data flows start→a→b→end."""
        nodes = [_start_node(), _node("a"), _node("b", NodeType.DATA_CONVERT), _end_node()]
        edges = [
            Edge(source="start", source_port="input", target="a", target_port="in"),
            Edge(source="a", source_port="out", target="b", target_port="in"),
            Edge(source="b", source_port="out", target="end", target_port="in"),
        ]
        def_ = _make_def(nodes, edges)
        ctx = CompileContext(
            executors={
                NodeType.DATA_ASSIGN: _exec_prefix("x!"),
                NodeType.DATA_CONVERT: _exec_prefix("y?"),
            }
        )
        graph = compile_definition(def_, context=ctx)
        state = await _run(graph, {"wf:start:input": "hi"})
        assert state.get("wf:a:out") == "x!hi"
        assert state.get("wf:b:out") == "y?x!hi"

    @pytest.mark.asyncio
    async def test_async_executor_data_flow(self) -> None:
        """Async executors — identical data flow as sync."""

        async def _a_exec(_rt: dict, _p: dict, _i: dict) -> dict:
            await asyncio.sleep(0)
            return {"out": f"a:{_i.get('in', '')}"}

        async def _b_exec(_rt: dict, _p: dict, _i: dict) -> dict:
            await asyncio.sleep(0)
            return {"out": f"b:{_i.get('in', '')}"}

        nodes = [_start_node(), _node("a", NodeType.DATA_ASSIGN), _node("b", NodeType.DATA_CONVERT), _end_node()]
        edges = [
            Edge(source="start", source_port="input", target="a", target_port="in"),
            Edge(source="a", source_port="out", target="b", target_port="in"),
            Edge(source="b", source_port="out", target="end", target_port="in"),
        ]
        def_ = _make_def(nodes, edges)
        ctx = CompileContext(
            executors={
                NodeType.DATA_ASSIGN: _a_exec,
                NodeType.DATA_CONVERT: _b_exec,
            }
        )
        graph = compile_definition(def_, context=ctx)
        state = await _run(graph, {"wf:start:input": "hi"})
        assert state.get("wf:a:out") == "a:hi"
        assert state.get("wf:b:out") == "b:a:hi"


# ═══════════════════════════════════════════════════════════════════════════════
# 2. if conditional branching
# ═══════════════════════════════════════════════════════════════════════════════


def _if_exec_route(_rt: dict, _p: dict, _i: dict) -> dict:
    """Route value to 'true' port if input contains 'yes', else to 'false'."""
    val = str(_i.get("in", ""))
    if "yes" in val.lower():
        return {"true": val, "false": None}
    return {"true": None, "false": val}


class TestIfBranch:
    """Conditional branching via flow:if nodes."""

    @pytest.mark.asyncio
    async def test_true_branch(self) -> None:
        """Input 'yes' → true branch → yes_node executed."""
        nodes = [_start_node(), _if_node("check"), _node("yes_node"), _node("no_node"), _end_node()]
        edges = [
            Edge(source="start", source_port="input", target="check", target_port="in"),
            Edge(source="check", source_port="true", target="yes_node", target_port="in", condition="true"),
            Edge(source="check", source_port="false", target="no_node", target_port="in", condition="false"),
            Edge(source="check", source_port="true", target="end", target_port="in"),  # default
            Edge(source="yes_node", source_port="out", target="end", target_port="in"),
            Edge(source="no_node", source_port="out", target="end", target_port="in"),
        ]
        def_ = _make_def(nodes, edges)
        ctx = CompileContext(
            executors={
                NodeType.FLOW_IF: _if_exec_route,
                NodeType.DATA_ASSIGN: _exec_prefix("YES:"),
            }
        )
        graph = compile_definition(def_, context=ctx)
        state = await _run(graph, {"wf:start:input": "yes please"})
        assert state.get("wf:yes_node:out") == "YES:yes please"

    @pytest.mark.asyncio
    async def test_false_branch(self) -> None:
        """Input 'nope' → false branch → no_node executed."""
        nodes = [_start_node(), _if_node("check"), _node("yes_node"), _node("no_node"), _end_node()]
        edges = [
            Edge(source="start", source_port="input", target="check", target_port="in"),
            Edge(source="check", source_port="true", target="yes_node", target_port="in", condition="true"),
            Edge(source="check", source_port="false", target="no_node", target_port="in", condition="false"),
            Edge(source="check", source_port="true", target="end", target_port="in"),  # default
            Edge(source="yes_node", source_port="out", target="end", target_port="in"),
            Edge(source="no_node", source_port="out", target="end", target_port="in"),
        ]
        def_ = _make_def(nodes, edges)
        ctx = CompileContext(
            executors={
                NodeType.FLOW_IF: _if_exec_route,
                NodeType.DATA_ASSIGN: _exec_prefix("NO:"),
            }
        )
        graph = compile_definition(def_, context=ctx)
        state = await _run(graph, {"wf:start:input": "nope"})
        assert state.get("wf:no_node:out") == "NO:nope"

    @pytest.mark.asyncio
    async def test_default_fallback(self) -> None:
        """Executor returns all-None → default edge taken."""

        def _all_none(_rt: dict, _p: dict, _i: dict) -> dict:
            return {"true": None, "false": None}

        nodes = [_start_node(), _if_node("check"), _node("fallback"), _end_node()]
        edges = [
            Edge(source="start", source_port="input", target="check", target_port="in"),
            Edge(source="check", source_port="true", target="end", target_port="in", condition="true"),
            Edge(source="check", source_port="false", target="fallback", target_port="in"),  # default
            Edge(source="fallback", source_port="out", target="end", target_port="in"),
        ]
        def_ = _make_def(nodes, edges)
        ctx = CompileContext(
            executors={
                NodeType.FLOW_IF: _all_none,
                NodeType.DATA_ASSIGN: _exec_prefix("FB:"),
            }
        )
        graph = compile_definition(def_, context=ctx)
        state = await _run(graph, {"wf:start:input": "anything"})
        # fallback reads wf:check:false (edge source_port), which is None → "FB:None"
        assert "wf:fallback:out" in state

    @pytest.mark.asyncio
    async def test_conditional_edge_to_end(self) -> None:
        """Conditional edge targeting end node works."""
        nodes = [_start_node(), _if_node("check"), _node("yes_node"), _end_node()]
        edges = [
            Edge(source="start", source_port="input", target="check", target_port="in"),
            Edge(source="check", source_port="true", target="end", target_port="in", condition="true"),
            Edge(source="check", source_port="false", target="yes_node", target_port="in"),  # default
            Edge(source="yes_node", source_port="out", target="end", target_port="in"),
        ]
        def_ = _make_def(nodes, edges)
        ctx = CompileContext(
            executors={
                NodeType.FLOW_IF: _if_exec_route,
                NodeType.DATA_ASSIGN: _exec_identity(),
            }
        )
        graph = compile_definition(def_, context=ctx)

        # "yes" → condition "true" is truthy → route to end directly
        state = await _run(graph, {"wf:start:input": "yes please"})
        # yes_node should NOT have been reached
        assert state.get("wf:yes_node:out") is None

        # "nope" → condition "true" is None (falsy), condition "false" has value → route to yes_node via default
        # Wait: the default edge is source_port="false" which is the default (no condition).
        # Route: check "true" value → None → falsy. Then default → yes_node.
        # But yes_node reads wf:check:false → "nope" → output "nope"
        state2 = await _run(graph, {"wf:start:input": "nope"})
        assert state2.get("wf:yes_node:out") == "nope"


# ═══════════════════════════════════════════════════════════════════════════════
# 2b. Conditional default-edge isolation (T5 bugfix)
# ═══════════════════════════════════════════════════════════════════════════════


class TestConditionalDefaultIsolation:
    """Default edge of if / switch must NOT fire when a conditional branch matches."""

    @pytest.mark.asyncio
    async def test_if_default_edge_not_executed_on_branch_match(self) -> None:
        """When if true-branch matches, the default-edge target stays idle."""
        nodes = [
            _start_node(),
            _if_node("check"),
            _node("yes_node"),
            _node("default_node"),  # must NOT execute on true match
            _end_node(),
        ]
        edges = [
            Edge(source="start", source_port="input", target="check", target_port="in"),
            Edge(source="check", source_port="true", target="yes_node", target_port="in", condition="true"),
            Edge(source="check", source_port="false", target="default_node", target_port="in"),  # default
            Edge(source="yes_node", source_port="out", target="end", target_port="in"),
            Edge(source="default_node", source_port="out", target="end", target_port="in"),
        ]
        def_ = _make_def(nodes, edges)
        ctx = CompileContext(
            executors={
                NodeType.FLOW_IF: _if_exec_route,
                NodeType.DATA_ASSIGN: _exec_identity(),
            }
        )
        graph = compile_definition(def_, context=ctx)
        state = await _run(graph, {"wf:start:input": "yes please"})
        # True branch matched → yes_node executed
        assert state.get("wf:yes_node:out") == "yes please"
        # Default-edge target must NOT have executed
        assert state.get("wf:default_node:out") is None

    @pytest.mark.asyncio
    async def test_switch_default_edge_not_executed_on_branch_match(self) -> None:
        """When switch case-a matches, the default-edge target stays idle."""

        def _sw_exec_case_a(_rt: dict, _p: dict, _i: dict) -> dict:
            """SWITCH executor — always routes to case_a."""
            val = _i.get("in")
            return {"case_a": val, "case_b": None}

        nodes = [
            _start_node(),
            Node(
                id="sw",
                type=NodeType.FLOW_SWITCH,
                inputs=[Port(name="in", type=PortType.DATA)],
                outputs=[Port(name="case_a", type=PortType.DATA), Port(name="case_b", type=PortType.DATA)],
            ),
            _node("na"),
            _node("nd"),  # must NOT execute on case_a match
            _end_node(),
        ]
        edges = [
            Edge(source="start", source_port="input", target="sw", target_port="in"),
            Edge(source="sw", source_port="case_a", target="na", target_port="in", condition="case_a"),
            Edge(source="sw", source_port="case_b", target="nd", target_port="in"),  # default
            Edge(source="na", source_port="out", target="end", target_port="in"),
            Edge(source="nd", source_port="out", target="end", target_port="in"),
        ]
        def_ = _make_def(nodes, edges)
        ctx = CompileContext(
            executors={
                NodeType.FLOW_SWITCH: _sw_exec_case_a,
                NodeType.DATA_ASSIGN: _exec_identity(),
            }
        )
        graph = compile_definition(def_, context=ctx)
        state = await _run(graph, {"wf:start:input": "hello"})
        # case_a matched → na executed
        assert state.get("wf:na:out") == "hello"
        # Default-edge target must NOT have executed
        assert state.get("wf:nd:out") is None


# ═══════════════════════════════════════════════════════════════════════════════
# 3. Compile cache
# ═══════════════════════════════════════════════════════════════════════════════


def _minimal_def() -> WorkflowDefinition:
    nodes = [_start_node(), _node("a"), _end_node()]
    edges = [
        Edge(source="start", source_port="input", target="a", target_port="in"),
        Edge(source="a", source_port="out", target="end", target_port="in"),
    ]
    return _make_def(nodes, edges)


def _minimal_ctx() -> CompileContext:
    return CompileContext(executors={NodeType.DATA_ASSIGN: _exec_identity()})


class TestCompileCache:
    """Cache identity, separation, and clear."""

    def test_same_def_same_ctx_returns_same_instance(self) -> None:
        """Same definition + same context → is same instance."""
        d = _minimal_def()
        ctx = _minimal_ctx()
        g1 = compile_definition(d, context=ctx)
        g2 = compile_definition(d, context=ctx)
        assert g1 is g2

    def test_different_def_returns_new_instance(self) -> None:
        """Changed definition (new name) → different instance."""
        nodes = [_start_node(), _node("a"), _end_node()]
        edges = [
            Edge(source="start", source_port="input", target="a", target_port="in"),
            Edge(source="a", source_port="out", target="end", target_port="in"),
        ]
        d1 = _make_def(nodes, edges)
        d2 = _make_def(nodes, edges, name="Changed")
        ctx = _minimal_ctx()
        g1 = compile_definition(d1, context=ctx)
        g2 = compile_definition(d2, context=ctx)
        assert g1 is not g2

    def test_different_nodetype_set_returns_new_instance(self) -> None:
        """Same definition but context has extra NodeType → different cache key → new instance."""
        d = _minimal_def()
        ctx_a = CompileContext(executors={NodeType.DATA_ASSIGN: _exec_identity()})
        ctx_b = CompileContext(
            executors={
                NodeType.DATA_ASSIGN: _exec_identity(),
                NodeType.DATA_CONVERT: _exec_identity(),  # extra type
            }
        )
        g1 = compile_definition(d, context=ctx_a)
        g2 = compile_definition(d, context=ctx_b)
        assert g1 is not g2

    def test_same_nodetype_set_different_impl_returns_same_instance(self) -> None:
        """Same NodeType set with different callables → same cache key → is (granularity convention)."""
        d = _minimal_def()
        ctx_a = CompileContext(executors={NodeType.DATA_ASSIGN: _exec_prefix("v1:")})
        ctx_b = CompileContext(executors={NodeType.DATA_ASSIGN: _exec_prefix("v2:")})
        g1 = compile_definition(d, context=ctx_a)
        g2 = compile_definition(d, context=ctx_b)
        assert g1 is g2

    def test_clear_cache_returns_new_instance(self) -> None:
        """After clear_compile_cache(), new compilation returns different instance."""
        d = _minimal_def()
        ctx = _minimal_ctx()
        g1 = compile_definition(d, context=ctx)
        clear_compile_cache()
        g2 = compile_definition(d, context=ctx)
        assert g1 is not g2


# ═══════════════════════════════════════════════════════════════════════════════
# 4. Graph topology assertions
# ═══════════════════════════════════════════════════════════════════════════════


class TestTopology:
    """Verify compiled graph structure via get_graph()."""

    def test_nodes_includes_start_end_and_real_nodes(self) -> None:
        """get_graph().nodes contains __start__, __end__, and all real node ids."""
        nodes = [_start_node(), _node("a"), _end_node()]
        edges = [
            Edge(source="start", source_port="input", target="a", target_port="in"),
            Edge(source="a", source_port="out", target="end", target_port="in"),
        ]
        def_ = _make_def(nodes, edges)
        ctx = _minimal_ctx()
        graph = compile_definition(def_, context=ctx)
        draw = graph.get_graph()
        assert set(draw.nodes) == {"__start__", "a", "__end__"}

    def test_edges_include_start_and_end_sentinels(self) -> None:
        """Regular edges include __start__→a and a→__end__."""
        nodes = [_start_node(), _node("a"), _node("b"), _end_node()]
        edges = [
            Edge(source="start", source_port="input", target="a", target_port="in"),
            Edge(source="a", source_port="out", target="b", target_port="in"),
            Edge(source="b", source_port="out", target="end", target_port="in"),
        ]
        def_ = _make_def(nodes, edges)
        ctx = CompileContext(executors={NodeType.DATA_ASSIGN: _exec_identity()})
        graph = compile_definition(def_, context=ctx)
        draw = graph.get_graph()
        edge_pairs = {(e.source, e.target) for e in draw.edges}
        assert ("__start__", "a") in edge_pairs
        assert ("a", "b") in edge_pairs
        assert ("b", "__end__") in edge_pairs

    def test_conditional_edges_are_marked_conditional(self) -> None:
        """if-node conditional edges appear with conditional=True in get_graph()."""
        nodes = [_start_node(), _if_node("check"), _node("yes_node"), _node("no_node"), _end_node()]
        edges = [
            Edge(source="start", source_port="input", target="check", target_port="in"),
            Edge(source="check", source_port="true", target="yes_node", target_port="in", condition="true"),
            Edge(source="check", source_port="false", target="no_node", target_port="in", condition="false"),
            Edge(source="check", source_port="true", target="end", target_port="in"),  # default
            Edge(source="yes_node", source_port="out", target="end", target_port="in"),
            Edge(source="no_node", source_port="out", target="end", target_port="in"),
        ]
        def_ = _make_def(nodes, edges)
        ctx = CompileContext(
            executors={
                NodeType.FLOW_IF: _if_exec_route,
                NodeType.DATA_ASSIGN: _exec_identity(),
            }
        )
        graph = compile_definition(def_, context=ctx)
        draw = graph.get_graph()

        cond_edges = [e for e in draw.edges if e.conditional]
        # Both yes_node and no_node are conditional targets from check
        assert len(cond_edges) >= 2
        cond_pairs = {(e.source, e.target) for e in cond_edges}
        assert ("check", "yes_node") in cond_pairs or ("check", "no_node") in cond_pairs


# ═══════════════════════════════════════════════════════════════════════════════
# 5. Boundary & error conditions
# ═══════════════════════════════════════════════════════════════════════════════


class TestBoundaryErrors:
    """Compile-time error conditions raise WorkflowCompileError."""

    def test_missing_executor(self) -> None:
        """Node type not in CompileContext.executors → WorkflowCompileError."""
        nodes = [_start_node(), _node("a"), _end_node()]
        edges = [
            Edge(source="start", source_port="input", target="a", target_port="in"),
            Edge(source="a", source_port="out", target="end", target_port="in"),
        ]
        def_ = _make_def(nodes, edges)
        with pytest.raises(WorkflowCompileError, match="no registered executor"):
            compile_definition(def_, context=CompileContext())

    def test_loop_node_compiles(self) -> None:
        """flow:loop → now compiles (T5); no longer rejected."""
        nodes = [
            _start_node(),
            Node(id="loop", type=NodeType.FLOW_LOOP, inputs=[Port(name="in", type=PortType.DATA)], outputs=[Port(name="out", type=PortType.DATA)]),
            _end_node(),
        ]
        edges = [
            Edge(source="start", source_port="input", target="loop", target_port="in"),
            Edge(source="loop", source_port="out", target="end", target_port="in"),
        ]
        def_ = _make_def(nodes, edges)
        ctx = CompileContext(executors={NodeType.FLOW_LOOP: _exec_identity()})
        # Should compile without error (loop executor is registered inline by compiler)
        graph = compile_definition(def_, context=ctx)
        assert graph is not None

    def test_parallel_node_compiles(self) -> None:
        """flow:parallel → now compiles (T5); no longer rejected."""
        nodes = [
            _start_node(),
            Node(id="par", type=NodeType.FLOW_PARALLEL, inputs=[Port(name="in", type=PortType.DATA)], outputs=[Port(name="out", type=PortType.DATA)]),
            _end_node(),
        ]
        edges = [
            Edge(source="start", source_port="input", target="par", target_port="in"),
            Edge(source="par", source_port="out", target="end", target_port="in"),
        ]
        def_ = _make_def(nodes, edges)
        ctx = CompileContext(executors={NodeType.FLOW_PARALLEL: _exec_identity()})
        # Should compile without error (parallel executor is registered inline by compiler)
        graph = compile_definition(def_, context=ctx)
        assert graph is not None

    def test_if_missing_default_edge(self) -> None:
        """if node with conditional edges but no default edge → WorkflowCompileError."""
        nodes = [_start_node(), _if_node("check"), _node("yes_node"), _end_node()]
        edges = [
            Edge(source="start", source_port="input", target="check", target_port="in"),
            Edge(source="check", source_port="true", target="yes_node", target_port="in", condition="true"),
            Edge(source="yes_node", source_port="out", target="end", target_port="in"),
        ]
        def_ = _make_def(nodes, edges)
        ctx = CompileContext(
            executors={
                NodeType.FLOW_IF: _exec_identity(),
                NodeType.DATA_ASSIGN: _exec_identity(),
            }
        )
        with pytest.raises(WorkflowCompileError, match="default edge"):
            compile_definition(def_, context=ctx)

    def test_if_multiple_default_edges(self) -> None:
        """if node with two unconditional outgoing edges → WorkflowCompileError."""
        nodes = [_start_node(), _if_node("check"), _node("yes_node"), _node("no_node"), _end_node()]
        edges = [
            Edge(source="start", source_port="input", target="check", target_port="in"),
            Edge(source="check", source_port="true", target="yes_node", target_port="in"),  # default 1
            Edge(source="check", source_port="false", target="no_node", target_port="in"),  # default 2
            Edge(source="yes_node", source_port="out", target="end", target_port="in"),
            Edge(source="no_node", source_port="out", target="end", target_port="in"),
        ]
        def_ = _make_def(nodes, edges)
        ctx = CompileContext(
            executors={
                NodeType.FLOW_IF: _exec_identity(),
                NodeType.DATA_ASSIGN: _exec_identity(),
            }
        )
        with pytest.raises(WorkflowCompileError, match="multiple default edges"):
            compile_definition(def_, context=ctx)

    def test_non_if_conditional_edge(self) -> None:
        """Conditional edge from non-if/switch/loop node → WorkflowCompileError."""
        nodes = [_start_node(), _node("a"), _node("b"), _end_node()]
        edges = [
            Edge(source="start", source_port="input", target="a", target_port="in"),
            Edge(source="a", source_port="out", target="b", target_port="in", condition="some_cond"),
            Edge(source="b", source_port="out", target="end", target_port="in"),
        ]
        def_ = _make_def(nodes, edges)
        ctx = CompileContext(executors={NodeType.DATA_ASSIGN: _exec_identity()})
        with pytest.raises(WorkflowCompileError, match="only 'flow:if'"):
            compile_definition(def_, context=ctx)

    def test_cycle_definition_rejected(self) -> None:
        """Cyclic graph → WorkflowCompileError wrapping validation failure."""
        nodes = [
            _start_node(),
            Node(id="a", type=NodeType.DATA_ASSIGN, inputs=[Port(name="in", type=PortType.DATA)], outputs=[Port(name="out", type=PortType.DATA)]),
            Node(id="b", type=NodeType.DATA_ASSIGN, inputs=[Port(name="in", type=PortType.DATA)], outputs=[Port(name="out", type=PortType.DATA)]),
            _end_node(),
        ]
        edges = [
            Edge(source="start", source_port="input", target="a", target_port="in"),
            Edge(source="a", source_port="out", target="b", target_port="in"),
            Edge(source="b", source_port="out", target="a", target_port="in"),  # back edge → cycle
        ]
        def_ = _make_def(nodes, edges)
        ctx = CompileContext(executors={NodeType.DATA_ASSIGN: _exec_identity()})
        with pytest.raises(WorkflowCompileError, match="validation failed"):
            compile_definition(def_, context=ctx)

    def test_missing_start_rejected(self) -> None:
        """No flow:start node → WorkflowCompileError via validation."""
        nodes = [_node("a"), _end_node()]
        edges = [
            Edge(source="a", source_port="out", target="end", target_port="in"),
        ]
        def_ = _make_def(nodes, edges)
        ctx = CompileContext(executors={NodeType.DATA_ASSIGN: _exec_identity()})
        with pytest.raises(WorkflowCompileError, match="validation failed"):
            compile_definition(def_, context=ctx)

    @pytest.mark.parametrize(
        "pattern",
        ["my_node_42", "data:convert"],
    )
    def test_error_message_contains_node_id_and_type(self, pattern: str) -> None:
        """Missing executor error includes the node id and type value."""
        nodes = [_start_node(), _node("my_node_42", NodeType.DATA_CONVERT), _end_node()]
        edges = [
            Edge(source="start", source_port="input", target="my_node_42", target_port="in"),
            Edge(source="my_node_42", source_port="out", target="end", target_port="in"),
        ]
        def_ = _make_def(nodes, edges)
        ctx = CompileContext(executors={NodeType.DATA_ASSIGN: _exec_identity()})
        with pytest.raises(WorkflowCompileError, match=pattern):
            compile_definition(def_, context=ctx)


# ═══════════════════════════════════════════════════════════════════════════════
# 6. parse_subworkflow_spec (T9-1)
# ═══════════════════════════════════════════════════════════════════════════════


def _sub_node(params: dict[str, Any] | None = None) -> Node:
    return Node(id="sub", type=NodeType.NESTED_SUBWORKFLOW, params=params or {})


class TestParseSubworkflowSpec:
    """parse_subworkflow_spec: None for legacy path, normalized dict otherwise, WorkflowCompileError on malformed."""

    def test_no_subworkflow_key_returns_none(self) -> None:
        """Node without params['subworkflow'] → None (legacy executor path)."""
        assert parse_subworkflow_spec(_sub_node()) is None

    def test_inline_valid_returns_dict(self) -> None:
        """Valid inline spec returns a dict whose definition is model-validatable."""
        definition: dict[str, Any] = {"id": "sub-wf", "name": "Sub"}
        node = _sub_node({"subworkflow": {"type": "inline", "definition": definition}})
        spec = parse_subworkflow_spec(node)
        assert spec == {"type": "inline", "definition": definition}
        WorkflowDefinition.model_validate(spec["definition"])

    def test_template_valid_returns_dict(self) -> None:
        """Valid template spec returns a dict with template_id + version."""
        node = _sub_node({"subworkflow": {"type": "template", "template_id": "wf-abc", "version": "0.1.0"}})
        spec = parse_subworkflow_spec(node)
        assert spec == {"type": "template", "template_id": "wf-abc", "version": "0.1.0"}

    def test_template_version_optional(self) -> None:
        """Template without 'version' omits it from the result."""
        node = _sub_node({"subworkflow": {"type": "template", "template_id": "wf-abc"}})
        spec = parse_subworkflow_spec(node)
        assert spec == {"type": "template", "template_id": "wf-abc"}

    def test_non_dict_spec_raises(self) -> None:
        """A non-dict subworkflow value raises WorkflowCompileError."""
        node = _sub_node({"subworkflow": "inline"})
        with pytest.raises(WorkflowCompileError, match="sub"):
            parse_subworkflow_spec(node)

    def test_missing_type_raises(self) -> None:
        """Spec without 'type' raises WorkflowCompileError."""
        node = _sub_node({"subworkflow": {"definition": {"id": "sub-wf", "name": "Sub"}}})
        with pytest.raises(WorkflowCompileError, match="'type'"):
            parse_subworkflow_spec(node)

    def test_invalid_type_raises(self) -> None:
        """Unknown 'type' value raises WorkflowCompileError."""
        node = _sub_node({"subworkflow": {"type": "bogus"}})
        with pytest.raises(WorkflowCompileError, match="'type'"):
            parse_subworkflow_spec(node)

    def test_inline_missing_definition_raises(self) -> None:
        """Inline spec without 'definition' raises WorkflowCompileError."""
        node = _sub_node({"subworkflow": {"type": "inline"}})
        with pytest.raises(WorkflowCompileError, match="definition"):
            parse_subworkflow_spec(node)

    def test_inline_invalid_definition_raises(self) -> None:
        """Inline spec whose definition fails model_validate raises WorkflowCompileError."""
        node = _sub_node({"subworkflow": {"type": "inline", "definition": {"id": "sub-wf"}}})  # missing name
        with pytest.raises(WorkflowCompileError, match="sub"):
            parse_subworkflow_spec(node)

    def test_template_missing_template_id_raises(self) -> None:
        """Template spec without 'template_id' raises WorkflowCompileError."""
        node = _sub_node({"subworkflow": {"type": "template"}})
        with pytest.raises(WorkflowCompileError, match="template_id"):
            parse_subworkflow_spec(node)

    def test_template_empty_template_id_raises(self) -> None:
        """Empty 'template_id' raises WorkflowCompileError."""
        node = _sub_node({"subworkflow": {"type": "template", "template_id": ""}})
        with pytest.raises(WorkflowCompileError, match="template_id"):
            parse_subworkflow_spec(node)

    def test_template_non_string_version_raises(self) -> None:
        """Non-string 'version' raises WorkflowCompileError."""
        node = _sub_node({"subworkflow": {"type": "template", "template_id": "wf-abc", "version": 1}})
        with pytest.raises(WorkflowCompileError, match="version"):
            parse_subworkflow_spec(node)

    def test_inline_and_template_together_raises(self) -> None:
        """Spec carrying both 'definition' and 'template_id' raises WorkflowCompileError."""
        node = _sub_node({"subworkflow": {"type": "inline", "definition": {"id": "sub-wf", "name": "Sub"}, "template_id": "wf-abc"}})
        with pytest.raises(WorkflowCompileError, match="sub"):
            parse_subworkflow_spec(node)
