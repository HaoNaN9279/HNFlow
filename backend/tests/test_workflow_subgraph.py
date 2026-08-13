"""Tests for compile-time ``nested:subworkflow`` subgraph expansion (T9-2).

Covers:
- Inline 2-level nesting with port-mapping round-trip
- 3-level inline nesting success (params flow parent → child → leaf and back)
- Failure path carries the full node path (``parent > child: msg``)
- Nesting-depth limit rejection with the chain path
- Template reference cycle A↔B rejected before compilation (cycle beats not-found)
- Parent-side output-port declaration check (missing port → compile error)
- Subgraph compiles with ``checkpointer=None``
- Template reference compile + execute via resolver injection
- Parent config forwarded into the subgraph (runtime.context visible)
- ``nested:subworkflow`` without a spec falls back to the legacy executor path
"""

from __future__ import annotations

from typing import Any

import pytest

from deerflow.workflow.compiler import (
    CompileContext,
    WorkflowCompileError,
    _expand_subworkflow,
    clear_compile_cache,
    compile_definition,
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
# Helpers
# ═══════════════════════════════════════════════════════════════════════════════


def _make_def(nodes: list[Node] | None = None, edges: list[Edge] | None = None, **kwargs: Any) -> WorkflowDefinition:
    kwargs.setdefault("id", "test-wf")
    kwargs.setdefault("name", "Test Workflow")
    return WorkflowDefinition(nodes=nodes or [], edges=edges or [], **kwargs)


def _start_node(id_: str = "start") -> Node:
    return Node(id=id_, type=NodeType.FLOW_START, inputs=[], outputs=[Port(name="input", type=PortType.DATA)])


def _end_node(id_: str = "end") -> Node:
    return Node(id=id_, type=NodeType.FLOW_END, inputs=[Port(name="in", type=PortType.DATA)], outputs=[])


def _sub_node(
    id_: str = "sub",
    *,
    definition: dict[str, Any] | None = None,
    template_id: str | None = None,
    version: str | None = None,
    mapping: dict[str, Any] | None = None,
    inputs: list[Port] | None = None,
    outputs: list[Port] | None = None,
) -> Node:
    """Build a ``nested:subworkflow`` node carrying an inline/template spec."""
    params: dict[str, Any] = {}
    if definition is not None:
        params["subworkflow"] = {"type": "inline", "definition": definition}
    elif template_id is not None:
        spec: dict[str, Any] = {"type": "template", "template_id": template_id}
        if version is not None:
            spec["version"] = version
        params["subworkflow"] = spec
    if mapping is not None:
        params["mapping"] = mapping
    return Node(
        id=id_,
        type=NodeType.NESTED_SUBWORKFLOW,
        params=params,
        inputs=inputs if inputs is not None else [Port(name="in", type=PortType.DATA)],
        outputs=outputs if outputs is not None else [Port(name="out", type=PortType.DATA)],
    )


def _child_def(*, child_id: str = "child", assign_value: Any = None, prefix: str = "") -> WorkflowDefinition:
    """Build a minimal child subgraph ``cstart → cassign → cend``.

    ``assign_value`` sets the ``cassign`` static value (otherwise passthrough).
    ``prefix`` scopes node ids so sibling graphs don't collide.
    """
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


async def _run(graph: Any, initial: dict[str, Any], config: dict[str, Any] | None = None) -> dict[str, Any]:
    return await graph.ainvoke(initial, config) if config is not None else await graph.ainvoke(initial)


def _roundtrip_mapping() -> dict[str, Any]:
    """Standard input/output mapping: parent start → child start, child end → parent out."""
    return {"inputs": {"in": "wf:start:input"}, "outputs": {"result": "out"}}


# ═══════════════════════════════════════════════════════════════════════════════
# Fixture: isolate cache per test
# ═══════════════════════════════════════════════════════════════════════════════


@pytest.fixture(autouse=True)
def _isolate_cache() -> Any:
    clear_compile_cache()
    yield


# ═══════════════════════════════════════════════════════════════════════════════
# 1. Inline 2-level nesting round-trip
# ═══════════════════════════════════════════════════════════════════════════════


class TestInlineTwoLevel:
    @pytest.mark.asyncio
    async def test_port_mapping_roundtrip(self) -> None:
        """Parent start value feeds the child, child result feeds back to parent output."""
        child = _child_def(assign_value="computed")
        sub = _sub_node("sub", definition=child.model_dump(mode="json"), mapping=_roundtrip_mapping())
        nodes = [_start_node(), sub, _end_node()]
        edges = [
            Edge(source="start", source_port="input", target="sub", target_port="in"),
            Edge(source="sub", source_port="out", target="end", target_port="in"),
        ]
        def_ = _make_def(nodes, edges)
        ctx = CompileContext(executors={NodeType.DATA_ASSIGN: exec_assign})
        graph = compile_definition(def_, context=ctx)
        state = await _run(graph, {"wf:start:input": "ignored"})
        assert state.get("wf:sub:out") == "computed"

    @pytest.mark.asyncio
    async def test_passthrough_roundtrip(self) -> None:
        """Child passthrough forwards the parent-provided value back unchanged."""
        child = _child_def()  # passthrough
        sub = _sub_node("sub", definition=child.model_dump(mode="json"), mapping=_roundtrip_mapping())
        nodes = [_start_node(), sub, _end_node()]
        edges = [
            Edge(source="start", source_port="input", target="sub", target_port="in"),
            Edge(source="sub", source_port="out", target="end", target_port="in"),
        ]
        def_ = _make_def(nodes, edges)
        ctx = CompileContext(executors={NodeType.DATA_ASSIGN: exec_assign})
        graph = compile_definition(def_, context=ctx)
        state = await _run(graph, {"wf:start:input": "hello"})
        assert state.get("wf:sub:out") == "hello"


# ═══════════════════════════════════════════════════════════════════════════════
# 2. 3-level nesting success
# ═══════════════════════════════════════════════════════════════════════════════


class TestThreeLevelNesting:
    @pytest.mark.asyncio
    async def test_params_flow_three_levels(self) -> None:
        """parent > mid > leaf, all inline; the value flows down and back up."""
        leaf = _child_def(child_id="leaf", prefix="l")  # passthrough
        mid_def = _make_def(
            nodes=[
                Node(id="mstart", type=NodeType.FLOW_START, inputs=[], outputs=[Port(name="in", type=PortType.DATA)]),
                _sub_node("m_sub", definition=leaf.model_dump(mode="json"), mapping={"inputs": {"in": "wf:mstart:in"}, "outputs": {"result": "out"}}),
                Node(id="mend", type=NodeType.FLOW_END, inputs=[Port(name="in", type=PortType.DATA)], outputs=[Port(name="result", type=PortType.DATA)]),
            ],
            edges=[
                Edge(source="mstart", source_port="in", target="m_sub", target_port="in"),
                Edge(source="m_sub", source_port="out", target="mend", target_port="in"),
            ],
            id="mid",
            name="mid",
        )
        parent_nodes = [
            _start_node(),
            _sub_node("p_sub", definition=mid_def.model_dump(mode="json"), mapping=_roundtrip_mapping()),
            _end_node(),
        ]
        parent_edges = [
            Edge(source="start", source_port="input", target="p_sub", target_port="in"),
            Edge(source="p_sub", source_port="out", target="end", target_port="in"),
        ]
        def_ = _make_def(parent_nodes, parent_edges)
        ctx = CompileContext(executors={NodeType.DATA_ASSIGN: exec_assign})
        graph = compile_definition(def_, context=ctx)
        state = await _run(graph, {"wf:start:input": "three-level-value"})
        assert state.get("wf:p_sub:out") == "three-level-value"


# ═══════════════════════════════════════════════════════════════════════════════
# 3. Failure path carries the full node path
# ═══════════════════════════════════════════════════════════════════════════════


class TestFailurePath:
    @pytest.mark.asyncio
    async def test_error_contains_parent_child_chain(self) -> None:
        """Leaf node failure surfaces as WorkflowExecutionError with the node chain."""

        def _explode(_rt: Any, _p: dict, _i: dict) -> dict[str, Any]:
            raise ValueError("boom")

        leaf = _child_def(child_id="leaf", prefix="l")  # lassign is DATA_ASSIGN
        mid_def = _make_def(
            nodes=[
                Node(id="mstart", type=NodeType.FLOW_START, inputs=[], outputs=[Port(name="in", type=PortType.DATA)]),
                _sub_node("m_sub", definition=leaf.model_dump(mode="json"), mapping={"inputs": {"in": "wf:mstart:in"}, "outputs": {"result": "out"}}),
                Node(id="mend", type=NodeType.FLOW_END, inputs=[Port(name="in", type=PortType.DATA)], outputs=[Port(name="result", type=PortType.DATA)]),
            ],
            edges=[
                Edge(source="mstart", source_port="in", target="m_sub", target_port="in"),
                Edge(source="m_sub", source_port="out", target="mend", target_port="in"),
            ],
            id="mid",
            name="mid",
        )
        parent_nodes = [
            _start_node(),
            _sub_node("p_sub", definition=mid_def.model_dump(mode="json"), mapping=_roundtrip_mapping()),
            _end_node(),
        ]
        parent_edges = [
            Edge(source="start", source_port="input", target="p_sub", target_port="in"),
            Edge(source="p_sub", source_port="out", target="end", target_port="in"),
        ]
        def_ = _make_def(parent_nodes, parent_edges)
        ctx = CompileContext(executors={NodeType.DATA_ASSIGN: _explode})
        graph = compile_definition(def_, context=ctx)

        with pytest.raises(WorkflowExecutionError, match=r"p_sub > m_sub"):
            await _run(graph, {"wf:start:input": "x"})


# ═══════════════════════════════════════════════════════════════════════════════
# 4. Nesting-depth limit
# ═══════════════════════════════════════════════════════════════════════════════


class TestDepthLimit:
    def test_three_level_nesting_exceeds_max_depth_two(self) -> None:
        """parent > mid > leaf with max_nesting_depth=2 → WorkflowCompileError."""
        leaf = _child_def(child_id="leaf", prefix="l")
        mid_def = _make_def(
            nodes=[
                Node(id="mstart", type=NodeType.FLOW_START, inputs=[], outputs=[Port(name="in", type=PortType.DATA)]),
                _sub_node("m_sub", definition=leaf.model_dump(mode="json"), mapping={"inputs": {"in": "wf:mstart:in"}, "outputs": {"result": "out"}}),
                Node(id="mend", type=NodeType.FLOW_END, inputs=[Port(name="in", type=PortType.DATA)], outputs=[Port(name="result", type=PortType.DATA)]),
            ],
            edges=[
                Edge(source="mstart", source_port="in", target="m_sub", target_port="in"),
                Edge(source="m_sub", source_port="out", target="mend", target_port="in"),
            ],
            id="mid",
            name="mid",
        )
        parent_nodes = [
            _start_node(),
            _sub_node("p_sub", definition=mid_def.model_dump(mode="json"), mapping=_roundtrip_mapping()),
            _end_node(),
        ]
        parent_edges = [
            Edge(source="start", source_port="input", target="p_sub", target_port="in"),
            Edge(source="p_sub", source_port="out", target="end", target_port="in"),
        ]
        def_ = _make_def(parent_nodes, parent_edges)
        ctx = CompileContext(executors={NodeType.DATA_ASSIGN: exec_assign}, max_nesting_depth=2)
        with pytest.raises(WorkflowCompileError, match="nesting depth exceeded"):
            compile_definition(def_, context=ctx)


# ═══════════════════════════════════════════════════════════════════════════════
# 5. Template reference cycle
# ═══════════════════════════════════════════════════════════════════════════════


def _template_def(tid: str, ref_template_id: str) -> WorkflowDefinition:
    """A template whose sub node references *ref_template_id*."""
    return _make_def(
        nodes=[
            Node(id=f"{tid}_start", type=NodeType.FLOW_START, inputs=[], outputs=[Port(name="in", type=PortType.DATA)]),
            _sub_node(f"{tid}_sub", template_id=ref_template_id),
            Node(id=f"{tid}_end", type=NodeType.FLOW_END, inputs=[Port(name="in", type=PortType.DATA)], outputs=[Port(name="result", type=PortType.DATA)]),
        ],
        edges=[
            Edge(source=f"{tid}_start", source_port="in", target=f"{tid}_sub", target_port="in"),
            Edge(source=f"{tid}_sub", source_port="out", target=f"{tid}_end", target_port="in"),
        ],
        id=tid,
        name=tid,
    )


class TestTemplateCycle:
    def test_cycle_rejected_before_not_found(self) -> None:
        """A→B→A reference cycle is reported with the full chain before any not-found error."""
        templates: dict[str, WorkflowDefinition] = {
            "A": _template_def("A", "B"),
            "B": _template_def("B", "A"),
        }

        def resolver(template_id: str, _version: str | None) -> WorkflowDefinition | None:
            return templates.get(template_id)

        nodes = [
            _start_node(),
            _sub_node("sub", template_id="A", mapping=_roundtrip_mapping()),
            _end_node(),
        ]
        edges = [
            Edge(source="start", source_port="input", target="sub", target_port="in"),
            Edge(source="sub", source_port="out", target="end", target_port="in"),
        ]
        def_ = _make_def(nodes, edges)
        ctx = CompileContext(executors={NodeType.DATA_ASSIGN: exec_assign}, definition_resolver=resolver)
        with pytest.raises(WorkflowCompileError, match="cycle detected") as exc_info:
            compile_definition(def_, context=ctx)
        assert "A → B → A" in str(exc_info.value)


# ═══════════════════════════════════════════════════════════════════════════════
# 6. Parent-side output-port declaration check
# ═══════════════════════════════════════════════════════════════════════════════


class TestMappingValidation:
    def test_parent_output_port_not_declared_raises(self) -> None:
        """mapping.outputs referencing an undeclared parent port → compile error."""
        child = _child_def(assign_value="x")
        sub = _sub_node(
            "sub",
            definition=child.model_dump(mode="json"),
            mapping={"outputs": {"result": "undeclared"}},
            outputs=[Port(name="out", type=PortType.DATA)],
        )
        nodes = [_start_node(), sub, _end_node()]
        edges = [
            Edge(source="start", source_port="input", target="sub", target_port="in"),
            Edge(source="sub", source_port="out", target="end", target_port="in"),
        ]
        def_ = _make_def(nodes, edges)
        ctx = CompileContext(executors={NodeType.DATA_ASSIGN: exec_assign})
        with pytest.raises(WorkflowCompileError, match="not declared in node outputs"):
            compile_definition(def_, context=ctx)

    def test_child_input_port_not_found_raises(self) -> None:
        """mapping.inputs referencing an unknown child start port → compile error."""
        child = _child_def(assign_value="x")
        sub = _sub_node("sub", definition=child.model_dump(mode="json"), mapping={"inputs": {"nope": "wf:start:input"}})
        nodes = [_start_node(), sub, _end_node()]
        edges = [
            Edge(source="start", source_port="input", target="sub", target_port="in"),
            Edge(source="sub", source_port="out", target="end", target_port="in"),
        ]
        def_ = _make_def(nodes, edges)
        ctx = CompileContext(executors={NodeType.DATA_ASSIGN: exec_assign})
        with pytest.raises(WorkflowCompileError, match="not found in subworkflow start node"):
            compile_definition(def_, context=ctx)

    def test_child_output_port_not_found_raises(self) -> None:
        """mapping.outputs referencing an unknown child end port → compile error."""
        child = _child_def(assign_value="x")
        sub = _sub_node("sub", definition=child.model_dump(mode="json"), mapping={"outputs": {"nope": "out"}})
        nodes = [_start_node(), sub, _end_node()]
        edges = [
            Edge(source="start", source_port="input", target="sub", target_port="in"),
            Edge(source="sub", source_port="out", target="end", target_port="in"),
        ]
        def_ = _make_def(nodes, edges)
        ctx = CompileContext(executors={NodeType.DATA_ASSIGN: exec_assign})
        with pytest.raises(WorkflowCompileError, match="not found in subworkflow end node"):
            compile_definition(def_, context=ctx)

    def test_missing_mapping_is_legal(self) -> None:
        """A subworkflow node with no mapping at all compiles (empty mapping)."""
        child = _child_def(assign_value="x")
        sub = _sub_node("sub", definition=child.model_dump(mode="json"), mapping=None)
        nodes = [_start_node(), sub, _end_node()]
        edges = [
            Edge(source="start", source_port="input", target="sub", target_port="in"),
            Edge(source="sub", source_port="out", target="end", target_port="in"),
        ]
        def_ = _make_def(nodes, edges)
        ctx = CompileContext(executors={NodeType.DATA_ASSIGN: exec_assign})
        graph = compile_definition(def_, context=ctx)
        assert graph is not None


# ═══════════════════════════════════════════════════════════════════════════════
# 7. Subgraph compiles with checkpointer=None
# ═══════════════════════════════════════════════════════════════════════════════


class TestSubgraphCheckpointer:
    def test_child_graph_checkpointer_is_none(self) -> None:
        """The expanded child graph must not inherit the parent checkpointer."""
        child = _child_def(assign_value="x")
        sub = _sub_node("sub", definition=child.model_dump(mode="json"), mapping=_roundtrip_mapping())
        ctx = CompileContext(executors={NodeType.DATA_ASSIGN: exec_assign})
        child_graph, _ = _expand_subworkflow(sub, ctx, depth=1, visiting=set(), chain_path=[])
        assert child_graph.checkpointer is None


# ═══════════════════════════════════════════════════════════════════════════════
# 8. Template reference compile + execute
# ═══════════════════════════════════════════════════════════════════════════════


class TestTemplateReference:
    @pytest.mark.asyncio
    async def test_template_compiles_and_runs(self) -> None:
        templates: dict[str, WorkflowDefinition] = {"wf-tpl": _child_def(child_id="wf-tpl", assign_value="from-template")}

        def resolver(template_id: str, _version: str | None) -> WorkflowDefinition | None:
            return templates.get(template_id)

        sub = _sub_node("sub", template_id="wf-tpl", mapping=_roundtrip_mapping())
        nodes = [_start_node(), sub, _end_node()]
        edges = [
            Edge(source="start", source_port="input", target="sub", target_port="in"),
            Edge(source="sub", source_port="out", target="end", target_port="in"),
        ]
        def_ = _make_def(nodes, edges)
        ctx = CompileContext(executors={NodeType.DATA_ASSIGN: exec_assign}, definition_resolver=resolver)
        graph = compile_definition(def_, context=ctx)
        state = await _run(graph, {"wf:start:input": "ignored"})
        assert state.get("wf:sub:out") == "from-template"

    def test_template_not_found_raises(self) -> None:
        """resolver returning None → compile error naming the template id."""

        def resolver(_template_id: str, _version: str | None) -> WorkflowDefinition | None:
            return None

        sub = _sub_node("sub", template_id="wf-missing", mapping=_roundtrip_mapping())
        nodes = [_start_node(), sub, _end_node()]
        edges = [
            Edge(source="start", source_port="input", target="sub", target_port="in"),
            Edge(source="sub", source_port="out", target="end", target_port="in"),
        ]
        def_ = _make_def(nodes, edges)
        ctx = CompileContext(executors={NodeType.DATA_ASSIGN: exec_assign}, definition_resolver=resolver)
        with pytest.raises(WorkflowCompileError, match="wf-missing"):
            compile_definition(def_, context=ctx)


# ═══════════════════════════════════════════════════════════════════════════════
# 9. Config forwarding into the subgraph
# ═══════════════════════════════════════════════════════════════════════════════


class TestConfigForwarding:
    @pytest.mark.asyncio
    async def test_subgraph_node_sees_parent_context(self) -> None:
        """A probe executor inside the child observes the parent's runtime context."""
        captured: dict[str, Any] = {}

        def probe_exec(runtime: Any, _p: dict, inputs: dict) -> dict[str, Any]:
            captured["context"] = runtime.context
            return {"out": inputs.get("in")}

        child = _child_def()  # passthrough cassign
        sub = _sub_node("sub", definition=child.model_dump(mode="json"), mapping=_roundtrip_mapping())
        nodes = [_start_node(), sub, _end_node()]
        edges = [
            Edge(source="start", source_port="input", target="sub", target_port="in"),
            Edge(source="sub", source_port="out", target="end", target_port="in"),
        ]
        def_ = _make_def(nodes, edges)
        ctx = CompileContext(executors={NodeType.DATA_ASSIGN: probe_exec})
        graph = compile_definition(def_, context=ctx)
        config = {"configurable": {"thread_id": "t-config"}, "context": {"marker": "present"}}
        await _run(graph, {"wf:start:input": "hello"}, config)
        assert captured["context"].get("marker") == "present"


# ═══════════════════════════════════════════════════════════════════════════════
# 10. Legacy executor fallback (no subworkflow spec)
# ═══════════════════════════════════════════════════════════════════════════════


class TestLegacyFallback:
    def test_nested_without_spec_compiles_via_executor(self) -> None:
        """A nested node without params['subworkflow'] falls back to the executor path."""
        sub = Node(
            id="sub",
            type=NodeType.NESTED_SUBWORKFLOW,
            params={},
            inputs=[Port(name="in", type=PortType.DATA)],
            outputs=[Port(name="out", type=PortType.DATA)],
        )
        nodes = [_start_node(), sub, _end_node()]
        edges = [
            Edge(source="start", source_port="input", target="sub", target_port="in"),
            Edge(source="sub", source_port="out", target="end", target_port="in"),
        ]
        def_ = _make_def(nodes, edges)
        ctx = CompileContext(executors={NodeType.NESTED_SUBWORKFLOW: lambda _r, _p, _i: {"out": "legacy"}})
        graph = compile_definition(def_, context=ctx)
        assert graph is not None


# ═══════════════════════════════════════════════════════════════════════════════
# 11. SSE node-event filter: subgraph-internal nodes never leak (T9-4)
# ═══════════════════════════════════════════════════════════════════════════════


class TestSseNoSubgraphLeak:
    @pytest.mark.asyncio
    async def test_three_level_nesting_child_events_not_leaked(self) -> None:
        """Subgraph-internal node events never leak into the parent node namespace.

        ``run_workflow`` streams ``wf:node:started``/``wf:node:completed`` via
        ``astream_events(version="v2", include_names=parent_node_ids)`` — the parent's
        non-``flow:start``/``flow:end`` node ids.  A child subgraph's nodes
        (``mstart``/``m_sub``/``mend``/``lcstart``/``lcassign``/``lcend``) are internal
        details of the parent ``nested:subworkflow`` node and must stay invisible to
        that filter.
        """
        leaf = _child_def(child_id="leaf", prefix="l")  # lcstart → lcassign → lcend
        mid_def = _make_def(
            nodes=[
                Node(id="mstart", type=NodeType.FLOW_START, inputs=[], outputs=[Port(name="in", type=PortType.DATA)]),
                _sub_node("m_sub", definition=leaf.model_dump(mode="json"), mapping={"inputs": {"in": "wf:mstart:in"}, "outputs": {"result": "out"}}),
                Node(id="mend", type=NodeType.FLOW_END, inputs=[Port(name="in", type=PortType.DATA)], outputs=[Port(name="result", type=PortType.DATA)]),
            ],
            edges=[
                Edge(source="mstart", source_port="in", target="m_sub", target_port="in"),
                Edge(source="m_sub", source_port="out", target="mend", target_port="in"),
            ],
            id="mid",
            name="mid",
        )
        parent_nodes = [
            _start_node(),
            _sub_node("p_sub", definition=mid_def.model_dump(mode="json"), mapping=_roundtrip_mapping()),
            _end_node(),
        ]
        parent_edges = [
            Edge(source="start", source_port="input", target="p_sub", target_port="in"),
            Edge(source="p_sub", source_port="out", target="end", target_port="in"),
        ]
        def_ = _make_def(parent_nodes, parent_edges)
        ctx = CompileContext(executors={NodeType.DATA_ASSIGN: exec_assign})
        graph = compile_definition(def_, context=ctx)

        # The parent's non-start/end node ids — the include_names filter run_workflow uses.
        node_ids = [n.id for n in def_.nodes if n.type not in (NodeType.FLOW_START, NodeType.FLOW_END)]
        assert node_ids == ["p_sub"]

        child_node_ids = {"mstart", "m_sub", "mend", "lcstart", "lcassign", "lcend"}

        names: set[str] = set()
        starts: set[str] = set()
        ends: set[str] = set()
        async for event in graph.astream_events({"wf:start:input": "three-level-value"}, version="v2", include_names=node_ids):
            name = event.get("name", "")
            names.add(name)
            if event.get("event") == "on_chain_start":
                starts.add(name)
            elif event.get("event") == "on_chain_end":
                ends.add(name)

        # No subgraph-internal node id may surface in the filtered event stream.
        assert not (names & child_node_ids), f"subgraph node ids leaked: {sorted(names & child_node_ids)}"
        # Only parent node ids may surface (not the bare graph root, not any child).
        assert names <= set(node_ids), f"unexpected names: {sorted(names - set(node_ids))}"
        # Positive assertion: the parent subworkflow node did emit start/end events,
        # so the pass cannot be a false green from an over-filtered (empty) stream.
        assert "p_sub" in starts
        assert "p_sub" in ends
