"""Tests for the N14 §24.8 evaluation core (:mod:`deerflow.workflow.evals`)."""

from __future__ import annotations

from typing import Any

import pytest

from deerflow.workflow.evals import (
    EvalCase,
    EvalError,
    EvalReport,
    NodeAssertion,
    evaluate_assertion,
    evaluate_case,
    extract_node_outputs,
    run_eval_suite,
)


class TestExtractNodeOutputs:
    def test_groups_by_node(self) -> None:
        state = {
            "wf:a:out": 1,
            "wf:a:extra": 2,
            "wf:b:out": "x",
            "wf:shared:board": [1],
            "wf:a:__token_usage": {"t": 1},
            "unrelated": "noise",
        }
        assert extract_node_outputs(state) == {"a": {"out": 1, "extra": 2}, "b": {"out": "x"}}

    def test_skips_non_wf_and_reserved(self) -> None:
        assert extract_node_outputs({"wf:x:__retry": 1, "wf:shared:s": 2, "plain": 3}) == {}


class TestAssertionValidation:
    @pytest.mark.parametrize("kind", ["equals", "contains", "matches", "exists", "truthy", "semantic"])
    def test_valid_kinds(self, kind: str) -> None:
        expected = "v" if kind in ("matches", "semantic") else None
        NodeAssertion("n", "p", kind, expected=expected)

    def test_unknown_kind(self) -> None:
        with pytest.raises(EvalError):
            NodeAssertion("n", "p", "whatever")

    def test_semantic_requires_str(self) -> None:
        with pytest.raises(EvalError):
            NodeAssertion("n", "p", "semantic", expected=1)

    def test_bad_regex(self) -> None:
        with pytest.raises(EvalError):
            NodeAssertion("n", "p", "matches", expected="(")


def _outputs() -> dict[str, dict[str, Any]]:
    return {"a": {"out": 42, "text": "Hello World", "empty": "", "items": [1, 2, 3]}}


class TestEvaluateAssertion:
    def test_equals(self) -> None:
        assert evaluate_assertion(NodeAssertion("a", "out", "equals", 42), _outputs()).passed
        assert not evaluate_assertion(NodeAssertion("a", "out", "equals", 41), _outputs()).passed

    def test_truthy(self) -> None:
        assert evaluate_assertion(NodeAssertion("a", "out", "truthy"), _outputs()).passed
        assert not evaluate_assertion(NodeAssertion("a", "empty", "truthy"), _outputs()).passed

    def test_exists(self) -> None:
        assert evaluate_assertion(NodeAssertion("a", "out", "exists"), _outputs()).passed
        assert not evaluate_assertion(NodeAssertion("a", "missing", "exists"), _outputs()).passed
        assert not evaluate_assertion(NodeAssertion("z", "out", "exists"), _outputs()).passed

    def test_contains_str(self) -> None:
        assert evaluate_assertion(NodeAssertion("a", "text", "contains", "World"), _outputs()).passed
        assert not evaluate_assertion(NodeAssertion("a", "text", "contains", "world"), _outputs()).passed
        assert evaluate_assertion(NodeAssertion("a", "text", "contains", "world", case_sensitive=False), _outputs()).passed

    def test_contains_list(self) -> None:
        assert evaluate_assertion(NodeAssertion("a", "items", "contains", 2), _outputs()).passed
        assert not evaluate_assertion(NodeAssertion("a", "items", "contains", 9), _outputs()).passed

    def test_contains_non_str_scalar(self) -> None:
        assert evaluate_assertion(NodeAssertion("a", "out", "contains", "4"), _outputs()).passed

    def test_matches(self) -> None:
        assert evaluate_assertion(NodeAssertion("a", "text", "matches", r"Hel+o"), _outputs()).passed
        assert not evaluate_assertion(NodeAssertion("a", "text", "matches", r"^World"), _outputs()).passed

    def test_missing_port_fails_for_non_exists(self) -> None:
        result = evaluate_assertion(NodeAssertion("a", "missing", "equals", 1), _outputs())
        assert not result.passed
        assert "not produced" in result.detail

    def test_semantic_with_judge(self) -> None:
        assertion = NodeAssertion("a", "text", "semantic", expected="a greeting")
        assert evaluate_assertion(assertion, _outputs(), judge=lambda _e, _a: True).passed
        assert not evaluate_assertion(assertion, _outputs(), judge=lambda _e, _a: False).passed

    def test_semantic_without_judge_fails(self) -> None:
        result = evaluate_assertion(NodeAssertion("a", "text", "semantic", expected="x"), _outputs())
        assert not result.passed
        assert "no semantic judge" in result.detail

    def test_semantic_judge_exception_is_a_failure(self) -> None:
        def _boom(_e: str, _a: str) -> bool:
            raise RuntimeError("judge down")

        result = evaluate_assertion(NodeAssertion("a", "text", "semantic", expected="x"), _outputs(), judge=_boom)
        assert not result.passed
        assert "judge raised RuntimeError" in result.detail


class TestCaseAndReport:
    def test_case_requires_name(self) -> None:
        with pytest.raises(EvalError):
            EvalCase(name="")

    def test_evaluate_case_all_pass(self) -> None:
        case = EvalCase("c", [NodeAssertion("a", "out", "equals", 42), NodeAssertion("a", "text", "contains", "Hello")])
        result = evaluate_case(case, _outputs())
        assert result.passed
        assert result.failures == []

    def test_evaluate_case_reports_failures(self) -> None:
        case = EvalCase("c", [NodeAssertion("a", "out", "equals", 41)])
        result = evaluate_case(case, _outputs())
        assert not result.passed
        assert len(result.failures) == 1

    def test_report_aggregation(self) -> None:
        report = EvalReport()
        report.add(evaluate_case(EvalCase("pass", [NodeAssertion("a", "out", "equals", 42)]), _outputs()))
        report.add(evaluate_case(EvalCase("fail", [NodeAssertion("a", "out", "equals", 0)]), _outputs()))
        assert report.total == 2
        assert report.passed == 1
        assert report.failed == 1
        assert report.pass_rate == 0.5
        assert [c.case_name for c in report.failures] == ["fail"]

    def test_empty_report_rate_is_one(self) -> None:
        assert EvalReport().pass_rate == 1.0

    def test_report_json_roundtrip(self) -> None:
        import json

        report = EvalReport()
        report.add(evaluate_case(EvalCase("c", [NodeAssertion("a", "out", "equals", 42)]), _outputs()))
        data = json.loads(report.to_json())
        assert data["total"] == 1
        assert data["cases"][0]["assertions"][0]["passed"] is True

    def test_run_eval_suite(self) -> None:
        cases = [EvalCase("one", [NodeAssertion("a", "out", "equals", 42)]), EvalCase("two", [NodeAssertion("a", "out", "equals", 0)])]
        report = run_eval_suite(cases, {"one": _outputs(), "two": _outputs()})
        assert report.total == 2
        assert report.passed == 1


class TestReplayIntegration:
    """The eval core consumes an N14 §24.11 replayed run's final state."""

    @pytest.mark.asyncio
    async def test_evaluate_replayed_run(self) -> None:
        from deerflow.workflow.compiler import clear_compile_cache, compile_definition
        from deerflow.workflow.executors import build_default_registry
        from deerflow.workflow.replay import MODE_RECORD, REPLAY_CONTEXT_KEY, ReplayFixture, ReplaySession
        from deerflow.workflow.schema import Edge, Node, NodeType, Port, PortType, WorkflowDefinition

        clear_compile_cache()
        definition = WorkflowDefinition(
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
        ctx = build_default_registry().build_context()
        ctx.executors[NodeType.DATA_ASSIGN] = lambda _rt, _p, _i: {"out": "golden"}
        graph = compile_definition(definition, context=ctx)
        session = ReplaySession(mode=MODE_RECORD, fixture=ReplayFixture(run_id="r"), redact=False)
        state = await graph.ainvoke({"wf:start:input": "seed"}, {"configurable": {"thread_id": "t"}, "context": {REPLAY_CONTEXT_KEY: session}})

        case = EvalCase("golden", [NodeAssertion("work", "out", "equals", "golden")])
        result = evaluate_case(case, extract_node_outputs(state))
        clear_compile_cache()
        assert result.passed
