"""Tests for N14 §24.6b collaboration templates (:mod:`deerflow.workflow.patterns`)."""

from __future__ import annotations

from typing import Any

import pytest

from deerflow.workflow.compiler import clear_compile_cache, compile_definition
from deerflow.workflow.executors import build_default_registry
from deerflow.workflow.patterns import (
    TEMPLATES,
    critic_review_loop,
    supervisor_topology,
)
from deerflow.workflow.schema import NodeType
from deerflow.workflow.workflow_io import validate_definition


@pytest.fixture(autouse=True)
def _isolate_cache() -> Any:
    clear_compile_cache()
    yield
    clear_compile_cache()


class TestCriticReviewLoop:
    def test_definition_is_valid_and_compiles(self) -> None:
        definition = critic_review_loop(producer_template_prompt="draft", critic_template_prompt="review", max_iterations=3)
        assert validate_definition(definition) == []
        graph = compile_definition(definition, context=build_default_registry().build_context())
        assert graph is not None

    def test_invalid_iterations(self) -> None:
        with pytest.raises(ValueError):
            critic_review_loop(producer_template_prompt="d", critic_template_prompt="c", max_iterations=0)

    @pytest.mark.asyncio
    async def test_loop_runs_until_critic_approves(self) -> None:
        definition = critic_review_loop(producer_template_prompt="draft", critic_template_prompt="review", max_iterations=5)
        ctx = build_default_registry().build_context()
        producer_calls: list[int] = []
        critic_calls: list[int] = []

        def _stub_ai(runtime: Any, params: dict, _inputs: dict) -> dict[str, Any]:
            node_id = params.get("node_id")
            if node_id == "producer":
                producer_calls.append(1)
                return {"out": f"draft-{len(producer_calls)}"}
            if node_id == "critic":
                critic_calls.append(1)
                # Reject the first draft, accept the second.
                return {"out": "verdict", "needs_revision": len(critic_calls) < 2}
            return {"out": "x"}

        ctx.executors[NodeType.AI_LLM_AGENT] = _stub_ai
        graph = compile_definition(definition, context=ctx)
        await graph.ainvoke({"wf:start:input": "seed"})

        assert len(producer_calls) == 2
        assert len(critic_calls) == 2

    @pytest.mark.asyncio
    async def test_loop_hits_iteration_cap(self) -> None:
        definition = critic_review_loop(producer_template_prompt="draft", critic_template_prompt="review", max_iterations=2)
        ctx = build_default_registry().build_context()
        producer_calls: list[int] = []

        def _stub_ai(runtime: Any, params: dict, _inputs: dict) -> dict[str, Any]:
            if params.get("node_id") == "producer":
                producer_calls.append(1)
                return {"out": "draft"}
            return {"out": "verdict", "needs_revision": True}  # never approves

        ctx.executors[NodeType.AI_LLM_AGENT] = _stub_ai
        graph = compile_definition(definition, context=ctx)
        await graph.ainvoke({"wf:start:input": "seed"})
        assert len(producer_calls) == 2  # hard cap


class TestSupervisorTopology:
    def test_definition_is_valid_and_compiles(self) -> None:
        definition = supervisor_topology(supervisor_template_prompt="route", experts=[("writer", "write"), ("critic", "critique")])
        assert validate_definition(definition) == []
        graph = compile_definition(definition, context=build_default_registry().build_context())
        assert graph is not None

    def test_no_experts(self) -> None:
        with pytest.raises(ValueError):
            supervisor_topology(supervisor_template_prompt="route", experts=[])

    def test_duplicate_expert_ids(self) -> None:
        with pytest.raises(ValueError):
            supervisor_topology(supervisor_template_prompt="route", experts=[("a", "x"), ("a", "y")])

    def test_reserved_expert_id(self) -> None:
        with pytest.raises(ValueError):
            supervisor_topology(supervisor_template_prompt="route", experts=[("supervisor", "x")])

    @pytest.mark.asyncio
    async def test_supervisor_dispatches_to_expert(self) -> None:
        definition = supervisor_topology(supervisor_template_prompt="route", experts=[("writer", "write"), ("critic", "critique")])
        ctx = build_default_registry().build_context()
        seen: list[str] = []

        def _stub_ai(runtime: Any, params: dict, _inputs: dict) -> dict[str, Any]:
            node_id = params.get("node_id")
            seen.append(node_id)
            if node_id == "supervisor":
                return {"out": "routed", "decision": "critic"}
            return {"out": f"{node_id}-result"}

        ctx.executors[NodeType.AI_LLM_AGENT] = _stub_ai
        graph = compile_definition(definition, context=ctx)
        state = await graph.ainvoke({"wf:start:input": "seed"})

        assert "supervisor" in seen
        assert "critic" in seen
        assert "writer" not in seen  # switch routed to the critic only
        assert state.get("wf:critic:out") == "critic-result"


class TestTemplatesRegistry:
    def test_named_templates(self) -> None:
        assert set(TEMPLATES) == {"critic_review_loop", "supervisor_topology"}
