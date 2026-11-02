"""Tests for ``flow:loop`` with a **declared body** (``params.subworkflow``, N14ak).

An inline loop body is hand-drawn: the author wires ``loop --cond--> body`` and
``body --> loop`` themselves.  A params-declared body replaces those two edges
with an engine-generated child graph node, so a reusable body (typically a stored
template) can be looped over without redrawing it.

What the compiler owes the definition in that mode:

- the body edge and the back-edge are generated, so a drawn conditional out-edge
  is a compile error (two sources of routing truth) while exactly one unconditioned
  exit edge is required;
- each round's input (the *ring*: the seed on round 1, the previous round's result
  afterwards) is injected into the body's start port and the body's result port is
  written back to the reserved ``wf:<loop>:__ring`` channel — which is what keeps
  ``results`` / ``last`` / ``continue_on`` behaving exactly as they do for an
  inline body;
- the inline path is untouched (a loop without a ``subworkflow`` param compiles
  byte-identically to before).
"""

from __future__ import annotations

from typing import Any

import pytest

from deerflow.workflow.compiler import (
    LOOP_RING_CHANNEL,
    CompileContext,
    WorkflowCompileError,
    clear_compile_cache,
    compile_definition,
)
from deerflow.workflow.executors import build_default_registry
from deerflow.workflow.schema import (
    Edge,
    Node,
    NodeType,
    Port,
    PortType,
    WorkflowDefinition,
)
from deerflow.workflow.workflow_io import validate_definition

# ═══════════════════════════════════════════════════════════════════════════════
# Helpers
# ═══════════════════════════════════════════════════════════════════════════════


def _make_def(nodes: list[Node] | None = None, edges: list[Edge] | None = None, **kwargs: Any) -> WorkflowDefinition:
    kwargs.setdefault("id", "loop-body-wf")
    kwargs.setdefault("name", "Loop Body Workflow")
    return WorkflowDefinition(nodes=nodes or [], edges=edges or [], **kwargs)


def _start_node(id_: str = "start") -> Node:
    return Node(id=id_, type=NodeType.FLOW_START, inputs=[], outputs=[Port(name="input", type=PortType.DATA)])


def _end_node(id_: str = "end") -> Node:
    return Node(id=id_, type=NodeType.FLOW_END, inputs=[Port(name="in", type=PortType.DATA)], outputs=[])


def _loop_node(id_: str = "loop", *, spec: dict[str, Any] | None = None, iterations: int = 3, params: dict[str, Any] | None = None, outputs: list[Port] | None = None) -> Node:
    merged: dict[str, Any] = {"iterations": iterations}
    if spec is not None:
        merged["subworkflow"] = spec
    if params:
        merged.update(params)
    return Node(
        id=id_,
        type=NodeType.FLOW_LOOP,
        params=merged,
        inputs=[Port(name="in", type=PortType.DATA)],
        outputs=outputs or [Port(name="iteration", type=PortType.DATA), Port(name="out", type=PortType.DATA)],
    )


def _loop_node_agg(id_: str = "loop", *, spec: dict[str, Any] | None = None, iterations: int = 3, params: dict[str, Any] | None = None, extra_outputs: list[Port] | None = None) -> Node:
    outputs = [Port(name="iteration", type=PortType.DATA), Port(name="out", type=PortType.DATA), Port(name="results", type=PortType.ARRAY), Port(name="last", type=PortType.DATA)]
    if extra_outputs:
        outputs.extend(extra_outputs)
    return _loop_node(id_, spec=spec, iterations=iterations, params=params, outputs=outputs)


def _body_definition(*, end_outputs: list[Port] | None = None) -> WorkflowDefinition:
    """A one-node body: ``start(in) → work(in→out) → end(in→out)``."""
    return _make_def(
        id="body-wf",
        name="Loop Body",
        nodes=[
            Node(id="bstart", type=NodeType.FLOW_START, inputs=[], outputs=[Port(name="in", type=PortType.DATA)]),
            Node(id="bwork", type=NodeType.DATA_ASSIGN, inputs=[Port(name="in", type=PortType.DATA)], outputs=[Port(name="out", type=PortType.DATA)]),
            Node(id="bend", type=NodeType.FLOW_END, inputs=[Port(name="in", type=PortType.DATA)], outputs=end_outputs if end_outputs is not None else [Port(name="out", type=PortType.DATA)]),
        ],
        edges=[
            Edge(source="bstart", source_port="in", target="bwork", target_port="in"),
            Edge(source="bwork", source_port="out", target="bend", target_port="in"),
        ],
    )


def _body_with_report() -> WorkflowDefinition:
    """A body that produces two *distinct* values: the ring's ``out`` and a ``report``.

    The end node carries same-named input and output ports so each value travels
    independently — with a single input port it would forward that one value to
    every output, which would make the two indistinguishable.
    """
    return _make_def(
        id="report-body",
        name="Report body",
        nodes=[
            Node(id="bstart", type=NodeType.FLOW_START, inputs=[], outputs=[Port(name="in", type=PortType.DATA)]),
            Node(id="bwork", type=NodeType.DATA_ASSIGN, inputs=[Port(name="in", type=PortType.DATA)], outputs=[Port(name="out", type=PortType.DATA), Port(name="report", type=PortType.DATA)]),
            Node(
                id="bend",
                type=NodeType.FLOW_END,
                inputs=[Port(name="out", type=PortType.DATA), Port(name="report", type=PortType.DATA)],
                outputs=[Port(name="out", type=PortType.DATA), Port(name="report", type=PortType.DATA)],
            ),
        ],
        edges=[
            Edge(source="bstart", source_port="in", target="bwork", target_port="in"),
            Edge(source="bwork", source_port="out", target="bend", target_port="out"),
            Edge(source="bwork", source_port="report", target="bend", target_port="report"),
        ],
    )


def _inline_spec(**kwargs: Any) -> dict[str, Any]:
    return {"type": "inline", "definition": _body_definition(**kwargs).model_dump(mode="json")}


def _parent(nodes: list[Node], edges: list[Edge], ctx: CompileContext | None = None) -> Any:
    return compile_definition(_make_def(nodes, edges), context=ctx or build_default_registry().build_context())


def _assign_exec(fn: Any) -> Any:
    """Wrap a ``(inputs) -> outputs`` fn as a ``data:assign`` executor."""

    def _exec(_rt: Any, _p: dict, inputs: dict) -> dict[str, Any]:
        return fn(inputs)

    return _exec


async def _run(graph: Any, initial: dict[str, Any]) -> dict[str, Any]:
    return await graph.ainvoke(initial)


@pytest.fixture(autouse=True)
def _isolate_cache() -> Any:
    clear_compile_cache()
    yield


def _ctx(assign_fn: Any) -> CompileContext:
    return CompileContext(executors={NodeType.DATA_ASSIGN: _assign_exec(assign_fn)})


# ═══════════════════════════════════════════════════════════════════════════════
# 1. The ring: seed on round 1, previous result afterwards
# ═══════════════════════════════════════════════════════════════════════════════


class TestDeclaredBodyRing:
    @pytest.mark.asyncio
    async def test_body_runs_iterations_times_with_a_ring(self) -> None:
        """The body sees the seed first and its own previous result afterwards."""
        seen: list[Any] = []

        def _work(inputs: dict) -> dict:
            seen.append(inputs.get("in"))
            return {"out": (inputs.get("in") or 0) * 2}

        nodes = [_start_node(), _loop_node_agg("loop", spec=_inline_spec(), iterations=3), _end_node()]
        edges = [
            Edge(source="start", source_port="input", target="loop", target_port="in"),
            Edge(source="loop", source_port="out", target="end", target_port="in"),
        ]
        state = await _run(_parent(nodes, edges, _ctx(_work)), {"wf:start:input": 1})

        assert seen == [1, 2, 4]
        assert state.get("wf:loop:results") == [2, 4, 8]
        assert state.get("wf:loop:last") == 8
        assert state.get("wf:loop:__count") == 4
        # The final visit writes the last result to ``out`` and exits; the body
        # does not run a fourth time (``iterations`` bounds body runs, not visits).
        assert state.get("wf:loop:out") == 8
        assert state.get(f"wf:loop:{LOOP_RING_CHANNEL}") == 8

    @pytest.mark.asyncio
    async def test_iterations_is_a_hard_ceiling(self) -> None:
        """``iterations`` bounds the rounds even when nothing asks the loop to stop."""
        calls: list[int] = []

        def _work(inputs: dict) -> dict:
            calls.append(1)
            return {"out": len(calls)}

        nodes = [_start_node(), _loop_node("loop", spec=_inline_spec(), iterations=2), _end_node()]
        edges = [
            Edge(source="start", source_port="input", target="loop", target_port="in"),
            Edge(source="loop", source_port="out", target="end", target_port="in"),
        ]
        state = await _run(_parent(nodes, edges, _ctx(_work)), {"wf:start:input": "seed"})

        assert len(calls) == 2
        assert state.get("wf:loop:__count") == 3

    @pytest.mark.asyncio
    async def test_zero_iterations_never_runs_the_body(self) -> None:
        calls: list[int] = []

        def _work(inputs: dict) -> dict:
            calls.append(1)
            return {"out": 1}

        nodes = [_start_node(), _loop_node_agg("loop", spec=_inline_spec(), iterations=0), _end_node()]
        edges = [
            Edge(source="start", source_port="input", target="loop", target_port="in"),
            Edge(source="loop", source_port="out", target="end", target_port="in"),
        ]
        state = await _run(_parent(nodes, edges, _ctx(_work)), {"wf:start:input": "seed"})

        assert calls == []
        assert state.get("wf:loop:results") == []
        assert state.get("wf:loop:last") is None

    @pytest.mark.asyncio
    async def test_body_without_a_ring_port_is_a_count_only_loop(self) -> None:
        """A body declaring no result port has no ring: nothing is aggregated.

        The seed must not be mistaken for a body output — collecting it would
        report the same value once per round as if the body had produced it.
        """
        calls: list[int] = []

        def _work(inputs: dict) -> dict:
            calls.append(1)
            return {"out": "ignored"}

        body = _make_def(
            id="ringless",
            name="Ringless Body",
            nodes=[
                # No port named ``in`` on the start and no port at all on the end:
                # the two defaults resolve to "no ring".
                Node(id="bstart", type=NodeType.FLOW_START, inputs=[], outputs=[Port(name="seed", type=PortType.DATA)]),
                Node(id="bwork", type=NodeType.DATA_ASSIGN, inputs=[Port(name="in", type=PortType.DATA)], outputs=[Port(name="out", type=PortType.DATA)]),
                Node(id="bend", type=NodeType.FLOW_END, inputs=[Port(name="in", type=PortType.DATA)], outputs=[]),
            ],
            edges=[Edge(source="bstart", source_port="seed", target="bwork", target_port="in"), Edge(source="bwork", source_port="out", target="bend", target_port="in")],
        )
        spec = {"type": "inline", "definition": body.model_dump(mode="json")}
        nodes = [_start_node(), _loop_node_agg("loop", spec=spec, iterations=2), _end_node()]
        edges = [
            Edge(source="start", source_port="input", target="loop", target_port="in"),
            Edge(source="loop", source_port="out", target="end", target_port="in"),
        ]
        state = await _run(_parent(nodes, edges, _ctx(_work)), {"wf:start:input": "seed"})

        assert len(calls) == 2
        assert state.get("wf:loop:results") == []
        assert state.get(f"wf:loop:{LOOP_RING_CHANNEL}") is None

    @pytest.mark.asyncio
    async def test_mapping_outputs_report_extra_body_values_onto_loop_ports(self) -> None:
        """``mapping.outputs`` carries more than the ring: the body can report.

        The body's ``report`` end port is a value of its own (not a copy of the
        ring), and it lands on the loop's declared ``report`` port.
        """
        spec = {"type": "inline", "definition": _body_with_report().model_dump(mode="json")}
        loop = _loop_node_agg("loop", spec=spec, iterations=2, params={"mapping": {"outputs": {"report": "report"}}}, extra_outputs=[Port(name="report", type=PortType.DATA)])
        nodes = [_start_node(), loop, _end_node()]
        edges = [
            Edge(source="start", source_port="input", target="loop", target_port="in"),
            Edge(source="loop", source_port="out", target="end", target_port="in"),
        ]

        def _work(inputs: dict) -> dict:
            return {"out": f"r{inputs.get('in')}", "report": f"rep{inputs.get('in')}"}

        state = await _run(_parent(nodes, edges, _ctx(_work)), {"wf:start:input": 0})

        assert state.get("wf:loop:results") == ["r0", "rr0"]
        assert state.get("wf:loop:last") == "rr0"
        assert state.get("wf:loop:report") == "repr0"

    @pytest.mark.asyncio
    async def test_body_failure_fails_the_loop(self) -> None:
        """A declared body is not a ``flow:try``: its failure propagates."""
        from deerflow.workflow.registry import WorkflowExecutionError

        nodes = [_start_node(), _loop_node("loop", spec=_inline_spec(), iterations=2), _end_node()]
        edges = [
            Edge(source="start", source_port="input", target="loop", target_port="in"),
            Edge(source="loop", source_port="out", target="end", target_port="in"),
        ]

        def _exec_boom(_rt: Any, _p: dict, _i: dict) -> dict:
            raise RuntimeError("body exploded")

        with pytest.raises(WorkflowExecutionError, match=r"loop > body > body exploded"):
            await _run(_parent(nodes, edges, CompileContext(executors={NodeType.DATA_ASSIGN: _exec_boom})), {"wf:start:input": 1})


# ═══════════════════════════════════════════════════════════════════════════════
# 2. continue_on against a declared body
# ═══════════════════════════════════════════════════════════════════════════════


class TestDeclaredBodyContinueOn:
    @pytest.mark.asyncio
    async def test_continue_on_a_mapped_report_port_exits_early(self) -> None:
        """A body that reports "no more" through a mapped port stops the loop."""
        body = _body_with_report()
        spec = {"type": "inline", "definition": body.model_dump(mode="json")}
        loop = _loop_node_agg(
            "loop",
            spec=spec,
            iterations=5,
            # The body's ``report`` end port is exposed on the loop's own
            # ``needs_more`` output port, which is what ``continue_on`` then reads.
            params={"continue_on": "needs_more", "mapping": {"outputs": {"report": "needs_more"}}},
            extra_outputs=[Port(name="needs_more", type=PortType.DATA)],
        )
        nodes = [_start_node(), loop, _end_node()]
        edges = [
            Edge(source="start", source_port="input", target="loop", target_port="in"),
            Edge(source="loop", source_port="out", target="end", target_port="in"),
        ]
        rounds: list[Any] = []

        def _work(inputs: dict) -> dict:
            rounds.append(inputs.get("in"))
            # First round asks for another round, second round is done.
            return {"out": len(rounds), "report": len(rounds) < 2}

        state = await _run(_parent(nodes, edges, _ctx(_work)), {"wf:start:input": "seed"})

        # Round 3's visit reads the falsy report and exits: two body runs, not five.
        assert len(rounds) == 2
        assert state.get("wf:loop:results") == [1, 2]
        assert state.get("wf:loop:iteration") == 3

    @pytest.mark.asyncio
    async def test_continue_on_the_ring_port_reads_the_last_result(self) -> None:
        """``continue_on`` may name the body's ring port (the newest result)."""
        loop = _loop_node_agg("loop", spec=_inline_spec(), iterations=5, params={"continue_on": "out"})
        nodes = [_start_node(), loop, _end_node()]
        edges = [
            Edge(source="start", source_port="input", target="loop", target_port="in"),
            Edge(source="loop", source_port="out", target="end", target_port="in"),
        ]
        rounds: list[int] = []

        def _work(inputs: dict) -> dict:
            rounds.append(1)
            # 1 (keep going) then 0 (stop): the 0 is read on the third visit.
            return {"out": 0 if len(rounds) == 2 else 1}

        state = await _run(_parent(nodes, edges, _ctx(_work)), {"wf:start:input": 1})

        assert len(rounds) == 2
        assert state.get("wf:loop:last") == 0

    def test_continue_on_an_unknown_name_is_a_compile_error(self) -> None:
        """With a declared body the legal names are known, so a typo cannot be a no-op."""
        loop = _loop_node("loop", spec=_inline_spec(), params={"continue_on": "nope"})
        nodes = [_start_node(), loop, _end_node()]
        edges = [
            Edge(source="start", source_port="input", target="loop", target_port="in"),
            Edge(source="loop", source_port="out", target="end", target_port="in"),
        ]
        with pytest.raises(WorkflowCompileError, match=r"continue_on.*names 'nope'"):
            _parent(nodes, edges)

    @pytest.mark.asyncio
    async def test_continue_on_an_incoming_source_port_still_resolves(self) -> None:
        """The classic spelling (an incoming edge's source port) keeps working.

        ``pre`` reports "stop" from the start, so a route that genuinely reads that
        channel exits before running the body at all — which is what distinguishes
        a resolved key from a compile error or a silent no-op.
        """
        loop = _loop_node("loop", spec=_inline_spec(), iterations=5, params={"continue_on": "keep"})
        nodes = [
            Node(id="pre", type=NodeType.DATA_ASSIGN, inputs=[Port(name="input", type=PortType.DATA)], outputs=[Port(name="input", type=PortType.DATA), Port(name="keep", type=PortType.DATA)]),
            _start_node(),
            loop,
            _end_node(),
        ]
        edges = [
            Edge(source="start", source_port="input", target="pre", target_port="input"),
            Edge(source="pre", source_port="input", target="loop", target_port="in"),
            Edge(source="pre", source_port="keep", target="loop", target_port="in"),
            Edge(source="loop", source_port="out", target="end", target_port="in"),
        ]
        rounds: list[int] = []

        def _exec(_rt: Any, _p: dict, inputs: dict) -> dict:
            # ``pre`` receives only ``input`` → answers "stop" on ``keep``;
            # the body's work node receives ``in`` and is the one counted.
            if "in" not in inputs:
                return {"input": "seed", "keep": False}
            rounds.append(1)
            return {"out": 1}

        state = await _run(_parent(nodes, edges, CompileContext(executors={NodeType.DATA_ASSIGN: _exec})), {"wf:start:input": "seed"})

        assert rounds == []
        assert state.get("wf:loop:__count") == 1  # the loop never entered its body
        assert state.get("wf:loop:iteration") == 1


# ═══════════════════════════════════════════════════════════════════════════════
# 3. Compile-time validation
# ═══════════════════════════════════════════════════════════════════════════════


class TestDeclaredBodyValidation:
    def test_drawn_conditional_edge_is_rejected(self) -> None:
        body_node = Node(id="body", type=NodeType.DATA_ASSIGN, inputs=[Port(name="in", type=PortType.DATA)], outputs=[Port(name="out", type=PortType.DATA)])
        loop = _loop_node("loop", spec=_inline_spec())
        nodes = [_start_node(), loop, body_node, _end_node()]
        edges = [
            Edge(source="start", source_port="input", target="loop", target_port="in"),
            Edge(source="loop", source_port="out", target="body", target_port="in", condition="body"),
            Edge(source="loop", source_port="out", target="end", target_port="in"),
        ]
        with pytest.raises(WorkflowCompileError, match=r"must not draw conditional out-edges"):
            _parent(nodes, edges)

    def test_missing_exit_edge_is_rejected(self) -> None:
        loop = _loop_node("loop", spec=_inline_spec())
        nodes = [_start_node(), loop, _end_node()]
        edges = [Edge(source="start", source_port="input", target="loop", target_port="in")]
        with pytest.raises(WorkflowCompileError, match=r"requires exactly one unconditioned exit edge"):
            _parent(nodes, edges)

    def test_multiple_exit_edges_are_rejected(self) -> None:
        loop = _loop_node("loop", spec=_inline_spec())
        mid = Node(id="mid", type=NodeType.DATA_ASSIGN, inputs=[Port(name="in", type=PortType.DATA)], outputs=[Port(name="out", type=PortType.DATA)])
        nodes = [_start_node(), loop, mid, _end_node()]
        edges = [
            Edge(source="start", source_port="input", target="loop", target_port="in"),
            Edge(source="loop", source_port="out", target="end", target_port="in"),
            Edge(source="loop", source_port="out", target="mid", target_port="in"),
            Edge(source="mid", source_port="out", target="end", target_port="in"),
        ]
        with pytest.raises(WorkflowCompileError, match=r"multiple exit edges"):
            _parent(nodes, edges)

    def test_explicit_ring_port_that_does_not_exist_is_rejected(self) -> None:
        loop = _loop_node("loop", spec=_inline_spec(), params={"ring_port": "nope"})
        nodes = [_start_node(), loop, _end_node()]
        edges = [
            Edge(source="start", source_port="input", target="loop", target_port="in"),
            Edge(source="loop", source_port="out", target="end", target_port="in"),
        ]
        with pytest.raises(WorkflowCompileError, match=r"'ring_port' port 'nope' not found"):
            _parent(nodes, edges)

    def test_explicit_seed_input_that_does_not_exist_is_rejected(self) -> None:
        loop = _loop_node("loop", spec=_inline_spec(), params={"seed_input": "nope"})
        nodes = [_start_node(), loop, _end_node()]
        edges = [
            Edge(source="start", source_port="input", target="loop", target_port="in"),
            Edge(source="loop", source_port="out", target="end", target_port="in"),
        ]
        with pytest.raises(WorkflowCompileError, match=r"'seed_input' port 'nope' not found"):
            _parent(nodes, edges)

    def test_delegate_mode_is_rejected(self) -> None:
        """A loop body runs in-graph every round; it cannot be a delegated task."""
        loop = _loop_node("loop", spec={"type": "template", "template_id": "t", "mode": "delegate"})
        nodes = [_start_node(), loop, _end_node()]
        edges = [
            Edge(source="start", source_port="input", target="loop", target_port="in"),
            Edge(source="loop", source_port="out", target="end", target_port="in"),
        ]
        with pytest.raises(WorkflowCompileError, match=r"body spec 'mode' must be 'compile'"):
            _parent(nodes, edges)

    def test_pure_validator_shape_checks_loop_and_try_bodies(self) -> None:
        """``validate_definition`` (pure, canvas-shared) reports malformed specs early."""
        loop = _loop_node("loop", spec={"type": "bogus"})
        try_node = Node(id="try", type=NodeType.FLOW_TRY, params={"subworkflow": {"type": "inline"}, "finally_subworkflow": {"type": "inline"}}, inputs=[Port(name="in", type=PortType.DATA)], outputs=[Port(name="error", type=PortType.BOOL)])
        nodes = [_start_node(), loop, _end_node()]
        edges = [
            Edge(source="start", source_port="input", target="loop", target_port="in"),
            Edge(source="loop", source_port="out", target="end", target_port="in"),
        ]
        errors = validate_definition(_make_def(nodes, edges))
        assert any("loop" in error and "'type' must be 'inline' or 'template'" in error for error in errors)

        try_def = _make_def([_start_node(), try_node, _end_node()], [Edge(source="start", source_port="input", target="try", target_port="in"), Edge(source="try", source_port="error", target="end", target_port="in")])
        try_errors = validate_definition(try_def)
        assert any("(finally)" in error for error in try_errors)
        assert any("requires a 'definition' dict" in error for error in try_errors)


# ═══════════════════════════════════════════════════════════════════════════════
# 4. Templates
# ═══════════════════════════════════════════════════════════════════════════════


class TestDeclaredBodyTemplates:
    @pytest.mark.asyncio
    async def test_template_body_content_decides_the_compiled_graph(self) -> None:
        """Editing a template body must recompile the parent (cache-key fix).

        Both compiles share one definition (one definition hash) and differ only in
        the resolver's *content* — a one-hop body versus a two-hop one — so the
        second compile must not return the first graph.  (The executor callable is
        identical in both, and the cache key deliberately fingerprints only the
        ``NodeType`` set, so definition content is the only thing that can tell
        these two apart.)
        """

        def _body(hops: int) -> WorkflowDefinition:
            nodes = [Node(id="bstart", type=NodeType.FLOW_START, inputs=[], outputs=[Port(name="in", type=PortType.DATA)])]
            edges: list[Edge] = []
            previous = "bstart"
            for index in range(hops):
                node_id = f"bwork{index}"
                nodes.append(Node(id=node_id, type=NodeType.DATA_ASSIGN, inputs=[Port(name="in", type=PortType.DATA)], outputs=[Port(name="out", type=PortType.DATA)]))
                edges.append(Edge(source=previous, source_port="in" if previous == "bstart" else "out", target=node_id, target_port="in"))
                previous = node_id
            nodes.append(Node(id="bend", type=NodeType.FLOW_END, inputs=[Port(name="in", type=PortType.DATA)], outputs=[Port(name="out", type=PortType.DATA)]))
            edges.append(Edge(source=previous, source_port="out", target="bend", target_port="in"))
            return _make_def(id=f"tpl-{hops}", name=f"Hops {hops}", nodes=nodes, edges=edges)

        def _resolver(hops: int) -> Any:
            def resolve(template_id: str, _version: str | None) -> WorkflowDefinition | None:
                return _body(hops) if template_id == "tpl" else None

            return resolve

        def _double(_rt: Any, _p: dict, inputs: dict) -> dict:
            return {"out": (inputs.get("in") or 0) * 2}

        spec = {"type": "template", "template_id": "tpl"}
        loop = _loop_node_agg("loop", spec=spec, iterations=2)
        nodes = [_start_node(), loop, _end_node()]
        edges = [
            Edge(source="start", source_port="input", target="loop", target_port="in"),
            Edge(source="loop", source_port="out", target="end", target_port="in"),
        ]

        ctx_one = CompileContext(executors={NodeType.DATA_ASSIGN: _double}, definition_resolver=_resolver(1))
        state_one = await _run(compile_definition(_make_def(nodes, edges), context=ctx_one), {"wf:start:input": 1})
        assert state_one.get("wf:loop:results") == [2, 4]

        ctx_two = CompileContext(executors={NodeType.DATA_ASSIGN: _double}, definition_resolver=_resolver(2))
        state_two = await _run(compile_definition(_make_def(nodes, edges), context=ctx_two), {"wf:start:input": 1})
        assert state_two.get("wf:loop:results") == [4, 16]

    def test_cache_key_folds_every_subworkflow_reference(self) -> None:
        """The key covers loop bodies, ``flow:try`` bodies and finally blocks.

        Only ``nested:subworkflow`` used to be folded in, so editing a try's
        template (or its finally block) silently reused the parent's cached graph.
        """
        from deerflow.workflow.compiler import _cache_key

        def _tpl(tag: str) -> WorkflowDefinition:
            return _make_def(
                id=tag,
                name=tag,
                nodes=[
                    Node(id="bstart", type=NodeType.FLOW_START, inputs=[], outputs=[Port(name="in", type=PortType.DATA)]),
                    Node(id="bwork", type=NodeType.DATA_ASSIGN, inputs=[Port(name="in", type=PortType.DATA)], outputs=[Port(name="out", type=PortType.DATA)]),
                    Node(id="bend", type=NodeType.FLOW_END, inputs=[Port(name="in", type=PortType.DATA)], outputs=[Port(name="out", type=PortType.DATA)]),
                ],
                edges=[Edge(source="bstart", source_port="in", target="bwork", target_port="in"), Edge(source="bwork", source_port="out", target="bend", target_port="in")],
            )

        loop = _loop_node("loop", spec={"type": "template", "template_id": "tpl"})
        try_node = Node(
            id="try",
            type=NodeType.FLOW_TRY,
            params={"subworkflow": {"type": "template", "template_id": "try-tpl"}, "finally_subworkflow": {"type": "template", "template_id": "fin-tpl"}},
            inputs=[Port(name="in", type=PortType.DATA)],
            outputs=[Port(name="error", type=PortType.BOOL)],
        )
        nodes = [_start_node(), loop, _end_node()]
        edges = [
            Edge(source="start", source_port="input", target="loop", target_port="in"),
            Edge(source="loop", source_port="out", target="end", target_port="in"),
        ]
        def_ = _make_def(nodes, edges)
        try_def = _make_def([_start_node(), try_node, _end_node()], [Edge(source="start", source_port="input", target="try", target_port="in"), Edge(source="try", source_port="error", target="end", target_port="in")])

        def _resolver(tag: str) -> Any:
            return lambda template_id, _version: _tpl(f"{template_id}-{tag}")

        executors = {NodeType.DATA_ASSIGN: _assign_exec(lambda _i: {})}
        base_loop = _cache_key(def_, CompileContext(executors=executors, definition_resolver=_resolver("v1")))
        changed_loop = _cache_key(def_, CompileContext(executors=executors, definition_resolver=_resolver("v2")))
        assert base_loop != changed_loop

        base_try = _cache_key(try_def, CompileContext(executors=executors, definition_resolver=_resolver("v1")))
        changed_try = _cache_key(try_def, CompileContext(executors=executors, definition_resolver=_resolver("v2")))
        assert base_try != changed_try

    def test_missing_template_is_a_compile_error(self) -> None:
        loop = _loop_node("loop", spec={"type": "template", "template_id": "missing"})
        nodes = [_start_node(), loop, _end_node()]
        edges = [
            Edge(source="start", source_port="input", target="loop", target_port="in"),
            Edge(source="loop", source_port="out", target="end", target_port="in"),
        ]
        ctx = CompileContext(executors={NodeType.DATA_ASSIGN: _assign_exec(lambda _i: {})}, definition_resolver=lambda _tid, _v: None)
        with pytest.raises(WorkflowCompileError, match=r"template 'missing' not found"):
            compile_definition(_make_def(nodes, edges), context=ctx)


# ═══════════════════════════════════════════════════════════════════════════════
# 5. Structural properties
# ═══════════════════════════════════════════════════════════════════════════════


class TestDeclaredBodyStructure:
    @pytest.mark.asyncio
    async def test_generated_body_node_is_an_engine_artifact(self) -> None:
        """The body node exists in the compiled graph but is not a definition node.

        Its id (``<loop>::body``) is deliberately unreachable through the
        definition, which is what keeps it out of node events and the canvas.
        """
        loop = _loop_node("loop", spec=_inline_spec(), iterations=1)
        nodes = [_start_node(), loop, _end_node()]
        edges = [
            Edge(source="start", source_port="input", target="loop", target_port="in"),
            Edge(source="loop", source_port="out", target="end", target_port="in"),
        ]
        graph = _parent(nodes, edges, _ctx(lambda _i: {"out": 1}))

        assert "loop.body" in graph.nodes
        assert "loop" in graph.nodes
        assert not any(node.id == "loop.body" for node in nodes)

    @pytest.mark.asyncio
    async def test_loop_without_a_body_spec_is_unchanged(self) -> None:
        """No ``subworkflow`` param → the inline path, and no ring channel declared."""
        calls: list[Any] = []

        def _work(inputs: dict) -> dict:
            calls.append(inputs.get("in"))
            return {"out": "body"}

        body_node = Node(id="body", type=NodeType.DATA_ASSIGN, inputs=[Port(name="in", type=PortType.DATA)], outputs=[Port(name="out", type=PortType.DATA)])
        loop = _loop_node_agg("loop", iterations=2)
        nodes = [_start_node(), loop, body_node, _end_node()]
        edges = [
            Edge(source="start", source_port="input", target="loop", target_port="in"),
            Edge(source="loop", source_port="out", target="body", target_port="in", condition="body"),
            Edge(source="body", source_port="out", target="loop", target_port="in"),
            Edge(source="loop", source_port="out", target="end", target_port="in"),
        ]
        state = await _run(_parent(nodes, edges, _ctx(_work)), {"wf:start:input": "seed"})

        # Round 1 has no body output yet: the back-edge is the last matching in-edge,
        # so the classic inline ring starts at None (see test_workflow_loop_ports.py).
        assert calls == [None, "body"]
        assert state.get("wf:loop:results") == ["body", "body"]  # one entry per round after the first
        assert state.get(f"wf:loop:{LOOP_RING_CHANNEL}") is None
        assert "loop.body" not in _parent(nodes, edges, _ctx(_work)).nodes
