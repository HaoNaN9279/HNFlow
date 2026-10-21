"""Tests for N14 §24.10 run-level budget enforcement (:mod:`deerflow.workflow.budgets`)."""

from __future__ import annotations

from typing import Any

import pytest

from deerflow.workflow.budgets import (
    ON_EXCEED_ABORT,
    ON_EXCEED_WARN,
    BudgetError,
    RunBudget,
    aggregate_token_usage,
    evaluate_budget,
    parse_run_budget,
    usage_total,
)
from deerflow.workflow.compiler import WorkflowCompileError, clear_compile_cache, compile_definition
from deerflow.workflow.executors import build_default_registry
from deerflow.workflow.schema import Edge, Node, NodeType, Port, PortType, WorkflowDefinition, WorkflowMetadata


class TestParseRunBudget:
    def test_absent(self) -> None:
        assert parse_run_budget({}) is None
        assert parse_run_budget(None) is None

    def test_valid_defaults_warn(self) -> None:
        assert parse_run_budget({"budget": {"max_total_tokens": 100}}) == RunBudget(100, ON_EXCEED_WARN)

    def test_valid_abort(self) -> None:
        assert parse_run_budget({"budget": {"max_total_tokens": 5, "on_exceed": "abort"}}) == RunBudget(5, ON_EXCEED_ABORT)

    @pytest.mark.parametrize(
        "bad",
        [
            "nope",
            {},
            {"max_total_tokens": 0},
            {"max_total_tokens": -1},
            {"max_total_tokens": True},
            {"max_total_tokens": "100"},
            {"max_total_tokens": 10, "on_exceed": "degrade"},
            {"max_total_tokens": 10, "nope": 1},
        ],
    )
    def test_bad(self, bad: Any) -> None:
        with pytest.raises(BudgetError):
            parse_run_budget({"budget": bad})


class TestUsageTotal:
    def test_total_tokens(self) -> None:
        assert usage_total({"total_tokens": 42}) == 42

    def test_input_plus_output(self) -> None:
        assert usage_total({"input_tokens": 10, "output_tokens": 5}) == 15

    def test_none_and_bad(self) -> None:
        assert usage_total(None) == 0
        assert usage_total({"total_tokens": "x", "input_tokens": 3}) == 3


class TestAggregate:
    def test_sums_channels(self) -> None:
        state = {
            "wf:a:__token_usage": {"input_tokens": 10, "output_tokens": 5, "total_tokens": 15, "cache_read_tokens": 1},
            "wf:b:__token_usage": {"total_tokens": 20},
            "wf:a:out": "noise",
        }
        totals = aggregate_token_usage(state)
        assert totals["total_tokens"] == 35
        assert totals["input_tokens"] == 10
        assert totals["cache_read_tokens"] == 1

    def test_ignores_non_usage(self) -> None:
        assert aggregate_token_usage({"wf:a:__duration_ms": 2, "plain": 1})["total_tokens"] == 0


class TestEvaluate:
    def test_not_exceeded(self) -> None:
        decision = evaluate_budget(10, RunBudget(100))
        assert not decision.exceeded

    def test_exceeded(self) -> None:
        decision = evaluate_budget(101, RunBudget(100, ON_EXCEED_ABORT))
        assert decision.exceeded
        assert decision.action == ON_EXCEED_ABORT
        assert decision.observed == 101 and decision.limit == 100


# ── compiler integration ─────────────────────────────────────────────────────


def _ai_node() -> Node:
    return Node(id="ai", type=NodeType.AI_LLM_AGENT, params={}, inputs=[Port(name="in", type=PortType.DATA), Port(name="template_prompt", type=PortType.DATA)], outputs=[Port(name="out", type=PortType.DATA)])


def _def(metadata: WorkflowMetadata | None) -> WorkflowDefinition:
    return WorkflowDefinition(
        id="wf",
        name="WF",
        nodes=[
            Node(id="start", type=NodeType.FLOW_START, inputs=[], outputs=[Port(name="input", type=PortType.DATA)]),
            _ai_node(),
            Node(id="end", type=NodeType.FLOW_END, inputs=[Port(name="in", type=PortType.DATA)], outputs=[]),
        ],
        edges=[
            Edge(source="start", source_port="input", target="ai", target_port="in"),
            Edge(source="start", source_port="input", target="ai", target_port="template_prompt"),
            Edge(source="ai", source_port="out", target="end", target_port="in"),
        ],
        metadata=metadata or WorkflowMetadata(),
    )


@pytest.fixture(autouse=True)
def _isolate_cache() -> Any:
    clear_compile_cache()
    yield
    clear_compile_cache()


def _stub_ai(total_tokens: int) -> Any:
    def _run(rt: Any, params: dict, _inputs: dict) -> dict[str, Any]:
        return {"out": "x", "__workflow_token_usage": {"input_tokens": total_tokens, "output_tokens": 0, "total_tokens": total_tokens, "cache_read_tokens": 0}}

    return _run


class TestCompilerBudget:
    def test_bad_budget_is_compile_error(self) -> None:
        with pytest.raises(WorkflowCompileError):
            compile_definition(_def(WorkflowMetadata(budget={"max_total_tokens": 0})), context=build_default_registry().build_context())

    @pytest.mark.asyncio
    async def test_abort_fails_run(self) -> None:
        ctx = build_default_registry().build_context()
        ctx.executors[NodeType.AI_LLM_AGENT] = _stub_ai(100)
        graph = compile_definition(_def(WorkflowMetadata(budget={"max_total_tokens": 50, "on_exceed": "abort"})), context=ctx)
        with pytest.raises(Exception, match="run budget exceeded"):
            await graph.ainvoke({"wf:start:input": "seed"})

    @pytest.mark.asyncio
    async def test_warn_continues(self) -> None:
        ctx = build_default_registry().build_context()
        ctx.executors[NodeType.AI_LLM_AGENT] = _stub_ai(100)
        graph = compile_definition(_def(WorkflowMetadata(budget={"max_total_tokens": 50, "on_exceed": "warn"})), context=ctx)
        state = await graph.ainvoke({"wf:start:input": "seed"})
        assert state.get("wf:ai:out") == "x"
        assert state.get("wf:ai:__token_usage", {}).get("total_tokens") == 100

    @pytest.mark.asyncio
    async def test_no_budget_unaffected(self) -> None:
        ctx = build_default_registry().build_context()
        ctx.executors[NodeType.AI_LLM_AGENT] = _stub_ai(999999)
        graph = compile_definition(_def(None), context=ctx)
        state = await graph.ainvoke({"wf:start:input": "seed"})
        assert state.get("wf:ai:out") == "x"

    @pytest.mark.asyncio
    async def test_within_budget_ok(self) -> None:
        ctx = build_default_registry().build_context()
        ctx.executors[NodeType.AI_LLM_AGENT] = _stub_ai(10)
        graph = compile_definition(_def(WorkflowMetadata(budget={"max_total_tokens": 50, "on_exceed": "abort"})), context=ctx)
        state = await graph.ainvoke({"wf:start:input": "seed"})
        assert state.get("wf:ai:out") == "x"
