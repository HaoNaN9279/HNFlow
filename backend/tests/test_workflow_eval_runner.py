"""Tests for the N14 §24.8 eval runner (:mod:`deerflow.workflow.eval_runner`)."""

from __future__ import annotations

from typing import Any

import pytest

from deerflow.workflow.eval_runner import evaluate_replayed_run
from deerflow.workflow.evals import EvalCase, NodeAssertion
from deerflow.workflow.replay import MODE_RECORD, REPLAY_CONTEXT_KEY, ReplayFixture, ReplayMissError, ReplaySession
from deerflow.workflow.schema import Edge, Node, NodeType, Port, PortType, WorkflowDefinition


def _definition() -> WorkflowDefinition:
    return WorkflowDefinition(
        id="wf",
        name="WF",
        nodes=[
            Node(id="start", type=NodeType.FLOW_START, inputs=[], outputs=[Port(name="input", type=PortType.DATA)]),
            Node(id="work", type=NodeType.DATA_ASSIGN, inputs=[Port(name="in", type=PortType.DATA)], outputs=[Port(name="out", type=PortType.DATA)]),
            Node(id="end", type=NodeType.FLOW_END, inputs=[Port(name="in", type=PortType.DATA)], outputs=[]),
        ],
        edges=[
            Edge(source="start", source_port="input", target="work", target_port="in"),
            Edge(source="work", source_port="out", target="end", target_port="in"),
        ],
    )


async def _record(*, value: str) -> ReplayFixture:
    from deerflow.workflow.compiler import compile_definition
    from deerflow.workflow.executors import build_default_registry

    ctx = build_default_registry().build_context()
    ctx.executors[NodeType.DATA_ASSIGN] = lambda _rt, _p, _i: {"out": value}
    graph = compile_definition(_definition(), context=ctx)
    session = ReplaySession(mode=MODE_RECORD, fixture=ReplayFixture(run_id="r"), redact=False)
    await graph.ainvoke({"wf:start:input": "seed"}, {"configurable": {"thread_id": "t"}, "context": {REPLAY_CONTEXT_KEY: session}})
    return session.fixture


@pytest.fixture(autouse=True)
def _isolate_cache() -> Any:
    from deerflow.workflow.compiler import clear_compile_cache

    clear_compile_cache()
    yield
    clear_compile_cache()


class TestEvaluateReplayedRun:
    @pytest.mark.asyncio
    async def test_pass(self) -> None:
        fixture = await _record(value="golden")
        report = await evaluate_replayed_run(_definition(), fixture=fixture, initial_state={"wf:start:input": "seed"}, cases=[EvalCase("c", [NodeAssertion("work", "out", "equals", "golden")])])
        assert report.total == 1
        assert report.passed == 1

    @pytest.mark.asyncio
    async def test_fail(self) -> None:
        fixture = await _record(value="golden")
        report = await evaluate_replayed_run(_definition(), fixture=fixture, initial_state={"wf:start:input": "seed"}, cases=[EvalCase("c", [NodeAssertion("work", "out", "equals", "other")])])
        assert report.failed == 1
        assert report.failures[0].case_name == "c"

    @pytest.mark.asyncio
    async def test_replay_skips_real_executor(self) -> None:
        fixture = await _record(value="golden")
        # evaluate_replayed_run compiles with the DEFAULT registry; the replay hit
        # means the real data:assign executor is never invoked and returns golden.
        report = await evaluate_replayed_run(_definition(), fixture=fixture, initial_state={"wf:start:input": "seed"}, cases=[EvalCase("c", [NodeAssertion("work", "out", "equals", "golden")])])
        assert report.passed == 1

    @pytest.mark.asyncio
    async def test_miss_errors(self) -> None:
        with pytest.raises(ReplayMissError):
            await evaluate_replayed_run(_definition(), fixture=ReplayFixture(run_id="r"), initial_state={"wf:start:input": "seed"}, cases=[EvalCase("c", [NodeAssertion("work", "out", "exists")])])

    @pytest.mark.asyncio
    async def test_miss_live_falls_back(self) -> None:
        report = await evaluate_replayed_run(_definition(), fixture=ReplayFixture(run_id="r"), initial_state={"wf:start:input": "seed"}, cases=[EvalCase("c", [NodeAssertion("work", "out", "exists")])], on_miss="live")
        # default data:assign passes the input through → port exists.
        assert report.passed == 1

    @pytest.mark.asyncio
    async def test_semantic_judge(self) -> None:
        fixture = await _record(value="a friendly greeting")
        case = EvalCase("c", [NodeAssertion("work", "out", "semantic", expected="greeting")])
        report = await evaluate_replayed_run(_definition(), fixture=fixture, initial_state={"wf:start:input": "seed"}, cases=[case], judge=lambda _e, actual: "greeting" in actual)
        assert report.passed == 1
