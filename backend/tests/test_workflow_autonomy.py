"""Tests for N14 section 24.5 autonomy budgets on ``ai:llm_agent``.

``params.autonomy = {mode, budgets}`` selects ``template`` (default, unchanged)
or ``bounded`` (explicit per-node hard limits: ``max_turns`` -> recursion_limit,
``max_tokens`` -> a per-node token budget).  ``stop_reason`` is surfaced on the
reserved ``wf:<node_id>:__stop_reason`` channel.
"""

from __future__ import annotations

from typing import Any

import pytest

from deerflow.config.token_budget_config import TokenBudgetConfig
from deerflow.subagents.config import SubagentConfig
from deerflow.workflow.compiler import (
    WorkflowCompileError,
    clear_compile_cache,
    compile_definition,
)
from deerflow.workflow.executors import build_default_registry
from deerflow.workflow.executors.ai import STOP_REASON_RESULT_KEY, _autonomy_settings
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


def _start() -> Node:
    return Node(id="start", type=NodeType.FLOW_START, inputs=[], outputs=[Port(name="input", type=PortType.DATA)])


def _end() -> Node:
    return Node(id="end", type=NodeType.FLOW_END, inputs=[Port(name="in", type=PortType.DATA)], outputs=[])


def _ai(id_: str = "ai", params: dict[str, Any] | None = None) -> Node:
    merged = {"instruction": "do a thing"}
    merged.update(params or {})
    return Node(
        id=id_,
        type=NodeType.AI_LLM_AGENT,
        params=merged,
        inputs=[Port(name="in", type=PortType.DATA)],
        outputs=[Port(name="out", type=PortType.DATA)],
    )


def _def(nodes: list[Node]) -> WorkflowDefinition:
    edges = [
        Edge(source="start", source_port="input", target=nodes[1].id, target_port="in"),
        Edge(source=nodes[1].id, source_port="out", target="end", target_port="in"),
    ]
    return WorkflowDefinition(id="test-wf", name="Test Workflow", nodes=nodes, edges=edges)


@pytest.fixture(autouse=True)
def _isolate() -> Any:
    clear_compile_cache()
    yield


# ═══════════════════════════════════════════════════════════════════════════════
# _autonomy_settings (pure)
# ═══════════════════════════════════════════════════════════════════════════════


class TestAutonomySettings:
    def test_absent_autonomy_keeps_defaults(self) -> None:
        max_turns, token_budget = _autonomy_settings({})
        assert max_turns == 50
        assert token_budget is None

    def test_template_mode_keeps_defaults(self) -> None:
        max_turns, token_budget = _autonomy_settings({"autonomy": {"mode": "template"}})
        assert (max_turns, token_budget) == (50, None)

    def test_bounded_max_turns_only(self) -> None:
        max_turns, token_budget = _autonomy_settings({"autonomy": {"mode": "bounded", "budgets": {"max_turns": 7}}})
        assert max_turns == 7
        assert token_budget is None

    def test_bounded_max_tokens_builds_budget(self) -> None:
        max_turns, token_budget = _autonomy_settings({"autonomy": {"mode": "bounded", "budgets": {"max_turns": 3, "max_tokens": 12345}}})
        assert max_turns == 3
        assert isinstance(token_budget, TokenBudgetConfig)
        assert token_budget.enabled is True
        assert token_budget.max_tokens == 12345


# ═══════════════════════════════════════════════════════════════════════════════
# stop_reason surfacing
# ═══════════════════════════════════════════════════════════════════════════════


class TestStopReasonSurfacing:
    @pytest.mark.asyncio
    async def test_stop_reason_lands_on_reserved_channel(self) -> None:
        def _fake(_rt: Any, _p: dict, _i: dict) -> dict[str, Any]:
            return {"out": "answer", STOP_REASON_RESULT_KEY: "token_capped"}

        ctx = build_default_registry().build_context()
        ctx.executors[NodeType.AI_LLM_AGENT] = _fake
        graph = compile_definition(_def([_start(), _ai(), _end()]), context=ctx)
        state = await graph.ainvoke({"wf:start:input": "seed"})

        assert state.get("wf:ai:__stop_reason") == "token_capped"

    @pytest.mark.asyncio
    async def test_absent_stop_reason_leaves_channel_unset(self) -> None:
        def _fake(_rt: Any, _p: dict, _i: dict) -> dict[str, Any]:
            return {"out": "answer"}

        ctx = build_default_registry().build_context()
        ctx.executors[NodeType.AI_LLM_AGENT] = _fake
        graph = compile_definition(_def([_start(), _ai(), _end()]), context=ctx)
        state = await graph.ainvoke({"wf:start:input": "seed"})

        assert state.get("wf:ai:__stop_reason") is None


# ═══════════════════════════════════════════════════════════════════════════════
# Validation
# ═══════════════════════════════════════════════════════════════════════════════


class TestAutonomyValidation:
    def _compile(self, params: dict[str, Any]) -> Any:
        return compile_definition(_def([_start(), _ai(params=params), _end()]), context=build_default_registry().build_context())

    def test_invalid_mode_is_compile_error(self) -> None:
        with pytest.raises(WorkflowCompileError):
            self._compile({"autonomy": {"mode": "yolo"}})

    def test_max_tool_calls_not_supported(self) -> None:
        with pytest.raises(WorkflowCompileError):
            self._compile({"autonomy": {"mode": "bounded", "budgets": {"max_tool_calls": 5}}})

    def test_non_positive_budget_is_compile_error(self) -> None:
        with pytest.raises(WorkflowCompileError):
            self._compile({"autonomy": {"mode": "bounded", "budgets": {"max_turns": 0}}})

    def test_unknown_budget_key_is_compile_error(self) -> None:
        with pytest.raises(WorkflowCompileError):
            self._compile({"autonomy": {"mode": "bounded", "budgets": {"max_steps": 5}}})

    def test_bounded_budgets_compile_ok(self) -> None:
        self._compile({"autonomy": {"mode": "bounded", "budgets": {"max_turns": 4, "max_tokens": 9000}}})


# ═══════════════════════════════════════════════════════════════════════════════
# SubagentConfig carries the per-node budget
# ═══════════════════════════════════════════════════════════════════════════════


class TestSubagentConfigBudget:
    def test_token_budget_defaults_to_none(self) -> None:
        cfg = SubagentConfig(name="x", description="y")
        assert cfg.token_budget is None

    def test_token_budget_round_trips(self) -> None:
        budget = TokenBudgetConfig(enabled=True, max_tokens=5000)
        cfg = SubagentConfig(name="x", description="y", max_turns=9, token_budget=budget)
        assert cfg.max_turns == 9
        assert cfg.token_budget is budget
