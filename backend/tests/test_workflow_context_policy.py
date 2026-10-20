"""Tests for N14 section 24.3 node-level context policy on ``ai:llm_agent``.

``params.context_policy = {examples, include, budget}`` mounts declarative
few-shot examples and named input ports into a deterministic ``<examples>`` /
``<context>`` block and applies a per-node token budget over the augmentation
buckets.  Usage is surfaced on the reserved ``wf:<node_id>:__context_usage``
channel.  All judgements are pure (``workflow/context_policy.py``).
"""

from __future__ import annotations

from types import SimpleNamespace
from typing import Any

import pytest

from deerflow.workflow.compiler import (
    WorkflowCompileError,
    WorkflowRuntime,
    clear_compile_cache,
    compile_definition,
)
from deerflow.workflow.context_policy import (
    BUCKET_ORDER,
    ContextPolicy,
    ContextPolicyError,
    apply_context_budget,
    estimate_tokens,
    parse_context_policy,
)
from deerflow.workflow.executors import WorkflowExecutionError, build_default_registry, exec_llm_agent
from deerflow.workflow.prompts import (
    assemble_ai_node_prompt,
    build_ai_node_buckets,
    build_context_layer,
    build_examples_layer,
)
from deerflow.workflow.schema import Edge, Node, NodeType, Port, PortType, WorkflowDefinition

# ═══════════════════════════════════════════════════════════════════════════════
# Helpers
# ═══════════════════════════════════════════════════════════════════════════════


def _start_node(id_: str = "start") -> Node:
    return Node(id=id_, type=NodeType.FLOW_START, inputs=[], outputs=[Port(name="input", type=PortType.DATA)])


def _end_node(id_: str = "end") -> Node:
    return Node(id=id_, type=NodeType.FLOW_END, inputs=[Port(name="in", type=PortType.DATA)], outputs=[])


def _ai_node(id_: str = "ai_step", *, params: dict[str, Any] | None = None, inputs: list[Port] | None = None) -> Node:
    merged: dict[str, Any] = {"instruction": "处理 {{in}}"}
    merged.update(params or {})
    return Node(
        id=id_,
        type=NodeType.AI_LLM_AGENT,
        params=merged,
        inputs=inputs if inputs is not None else [Port(name="in", type=PortType.DATA)],
        outputs=[Port(name="out", type=PortType.DATA)],
    )


def _make_def(nodes: list[Node], edges: list[Edge]) -> WorkflowDefinition:
    return WorkflowDefinition(id="test-wf", name="Test Workflow", nodes=nodes, edges=edges)


def _completed_result(text: str = "ok") -> Any:
    return SimpleNamespace(status=SimpleNamespace(value="completed"), result=text, error=None)


def _runtime(*, thread_id: str | None = "t1", checkpointer: Any = None) -> WorkflowRuntime:
    context: dict[str, Any] = {"user_id": "u1"}
    if thread_id is not None:
        context["thread_id"] = thread_id
    if checkpointer is not None:
        context["checkpointer"] = checkpointer
    return WorkflowRuntime(context=context)


@pytest.fixture(autouse=True)
def _isolate_cache() -> Any:
    clear_compile_cache()
    yield


@pytest.fixture
def fake_executor(monkeypatch: pytest.MonkeyPatch) -> dict[str, Any]:
    captured: dict[str, Any] = {}

    class FakeExecutor:
        def __init__(self, **kwargs: Any) -> None:
            captured["kwargs"] = kwargs

        async def _aexecute(self, task: str, result_holder: Any = None) -> Any:
            captured["task"] = task
            return captured["result"]

    import deerflow.subagents as subagents_pkg

    monkeypatch.setattr(subagents_pkg, "SubagentExecutor", FakeExecutor)
    monkeypatch.setattr("deerflow.workflow.executors.ai._resolve_node_tools", lambda *args, **kwargs: [])
    monkeypatch.setattr("deerflow.workflow.prompts.load_agent_soul", lambda agent_name, user_id=None: None)
    yield captured


# ═══════════════════════════════════════════════════════════════════════════════
# estimate_tokens (pure)
# ═══════════════════════════════════════════════════════════════════════════════


class TestEstimateTokens:
    def test_empty_is_zero(self) -> None:
        assert estimate_tokens("") == 0

    def test_non_empty_is_at_least_one(self) -> None:
        assert estimate_tokens("a") == 1

    def test_ascii_scales_with_length(self) -> None:
        assert estimate_tokens("a" * 40) == 10

    def test_cjk_is_denser_than_ascii(self) -> None:
        # 12 CJK chars ~ 6 tokens; 12 ASCII chars ~ 3 tokens.
        assert estimate_tokens("你好世界这是一个测试") > estimate_tokens("abcdefghijkl")

    def test_monotone_in_length(self) -> None:
        text = "hello 世界 again and again"
        assert estimate_tokens(text[:10]) <= estimate_tokens(text)


# ═══════════════════════════════════════════════════════════════════════════════
# parse_context_policy (pure)
# ═══════════════════════════════════════════════════════════════════════════════


class TestParseContextPolicy:
    def test_absent_is_none(self) -> None:
        assert parse_context_policy({}) is None

    def test_empty_object_declares_an_empty_policy(self) -> None:
        policy = parse_context_policy({"context_policy": {}})
        assert policy is not None
        assert policy.is_empty

    def test_full_policy(self) -> None:
        policy = parse_context_policy({"context_policy": {"examples": ["a", "b"], "include": ["x"], "budget": {"total_tokens": 100}}})
        assert policy == ContextPolicy(examples=("a", "b"), include=("x",), budget=100)

    def test_example_object_is_rendered_deterministically(self) -> None:
        policy = parse_context_policy({"context_policy": {"examples": [{"input": "q", "output": "a"}]}})
        assert policy is not None
        assert policy.examples == ("input: q\noutput: a",)

    @pytest.mark.parametrize(
        "policy",
        [
            "nope",
            {"unknown": 1},
            {"examples": "a"},
            {"examples": [1]},
            {"include": "x"},
            {"include": [""]},
            {"include": [1]},
            {"budget": 5},
            {"budget": {"unknown": 1}},
            {"budget": {"total_tokens": 0}},
            {"budget": {"total_tokens": -3}},
            {"budget": {"total_tokens": True}},
            {"budget": {"total_tokens": "10"}},
        ],
    )
    def test_bad_shapes_raise(self, policy: Any) -> None:
        with pytest.raises(ContextPolicyError):
            parse_context_policy({"context_policy": policy})


# ═══════════════════════════════════════════════════════════════════════════════
# Layer builders (pure)
# ═══════════════════════════════════════════════════════════════════════════════


class TestLayerBuilders:
    def test_examples_empty(self) -> None:
        assert build_examples_layer(()) == ""

    def test_examples_rendered(self) -> None:
        assert build_examples_layer(("one", "two")) == "<examples>\none\n\ntwo\n</examples>"

    def test_context_empty(self) -> None:
        assert build_context_layer(("missing",), {}) == ""

    def test_context_mounts_named_ports_in_order(self) -> None:
        layer = build_context_layer(("b", "a", "absent"), {"a": "AAA", "b": "BBB", "absent": None})
        assert layer == "<context>\n--- b ---\nBBB\n\n--- a ---\nAAA\n</context>"

    def test_bucket_order_and_keys(self) -> None:
        node = _ai_node()
        buckets = build_ai_node_buckets(
            agent_name=None,
            capability_groups=[],
            instruction=node.params["instruction"],
            inputs={"in": "hi"},
            policy=ContextPolicy(examples=("e",), include=("in",)),
        )
        assert set(buckets) == {
            "identity",
            "capability",
            "capability_rules",
            "capability_skills",
            "task",
            "examples",
            "context",
        }
        assert list(buckets) == [name for name in BUCKET_ORDER if name in buckets]

    def test_assemble_without_policy_unchanged(self) -> None:
        node = _ai_node()
        prompt = assemble_ai_node_prompt(node, {"in": "hi"})
        assert "hi" in prompt
        assert "<examples>" not in prompt
        assert "<context>" not in prompt

    def test_assemble_with_policy_appends_layers_after_task(self) -> None:
        node = _ai_node()
        prompt = assemble_ai_node_prompt(node, {"in": "hi"}, policy=ContextPolicy(examples=("ex",), include=("in",)))
        assert prompt.index("hi") < prompt.index("<examples>")
        assert prompt.index("<examples>") < prompt.index("<context>")


# ═══════════════════════════════════════════════════════════════════════════════
# apply_context_budget (pure)
# ═══════════════════════════════════════════════════════════════════════════════


class TestApplyContextBudget:
    def test_no_budget_keeps_everything(self) -> None:
        result = apply_context_budget({"identity": "i", "examples": "e", "context": "c"}, None)
        assert result.buckets == {"identity": "i", "examples": "e", "context": "c"}
        assert result.dropped == ()
        assert result.over_budget is False

    def test_generous_budget_keeps_everything(self) -> None:
        result = apply_context_budget({"identity": "i", "examples": "e" * 40, "context": "c" * 40}, 10_000)
        assert result.dropped == ()
        assert result.truncated == ()

    def test_tight_budget_drops_context_before_examples(self) -> None:
        # A budget that fits the scaffold + examples but not context.
        sections = {"identity": "i" * 4, "task": "t" * 4, "examples": "e" * 20, "context": "c" * 20}
        result = apply_context_budget(sections, 7)
        assert "examples" in result.buckets
        assert "context" not in result.buckets
        assert result.dropped == ("context",)

    def test_examples_have_priority_over_context(self) -> None:
        # Enough for context alone but not for both: examples claim the budget.
        sections = {"identity": "i" * 4, "examples": "e" * 20, "context": "c" * 20}
        result = apply_context_budget(sections, 6)
        assert "examples" in result.buckets
        assert "context" not in result.buckets

    def test_oversized_bucket_is_truncated_and_flagged(self) -> None:
        sections = {"identity": "i" * 4, "context": "c" * 400}
        result = apply_context_budget(sections, 12)
        assert "context" in result.buckets
        assert result.truncated == ("context",)
        assert result.buckets["context"].endswith("[truncated]")

    def test_scaffold_over_budget_is_reported_not_truncated(self) -> None:
        sections = {"identity": "i", "task": "t" * 400}
        result = apply_context_budget(sections, 3)
        assert result.over_budget is True
        assert result.buckets["task"] == "t" * 400
        assert result.dropped == ()

    def test_payload_is_json_safe(self) -> None:
        result = apply_context_budget({"identity": "i", "context": "c" * 400}, 12)
        payload = result.to_payload()
        assert payload["budget"] == 12
        assert payload["truncated"] == ["context"]
        assert payload["over_budget"] is False
        assert isinstance(payload["estimated_tokens"], dict)
        assert payload["total_estimated"] == sum(payload["estimated_tokens"].values())


# ═══════════════════════════════════════════════════════════════════════════════
# Executor integration
# ═══════════════════════════════════════════════════════════════════════════════


class TestExecutorIntegration:
    @pytest.mark.asyncio
    async def test_policy_mounts_layers_and_reports_usage(self, fake_executor: dict[str, Any]) -> None:
        fake_executor["result"] = _completed_result("done")
        params = {
            "instruction": "处理 {{in}}",
            "node_id": "ai_step",
            "context_policy": {"examples": ["示例一"], "include": ["in"], "budget": {"total_tokens": 5000}},
        }
        result = await exec_llm_agent(_runtime(), params, {"in": "hello"})

        prompt = result["out"]
        assert result["out"] == "done"
        cfg_prompt = fake_executor["kwargs"]["config"].system_prompt
        assert "<examples>" in cfg_prompt
        assert "示例一" in cfg_prompt
        assert "<context>" in cfg_prompt
        assert "hello" in cfg_prompt
        assert prompt == "done"

        usage = result["__context_usage"]
        assert usage["budget"] == 5000
        assert set(usage["estimated_tokens"]) <= set(BUCKET_ORDER)
        assert usage["dropped"] == []

    @pytest.mark.asyncio
    async def test_absent_policy_emits_no_usage_key(self, fake_executor: dict[str, Any]) -> None:
        fake_executor["result"] = _completed_result("done")
        result = await exec_llm_agent(_runtime(), {"instruction": "go", "node_id": "ai_step"}, {"in": "x"})
        assert "__context_usage" not in result

    @pytest.mark.asyncio
    async def test_invalid_policy_fails_the_node(self, fake_executor: dict[str, Any]) -> None:
        fake_executor["result"] = _completed_result("done")
        with pytest.raises(WorkflowExecutionError, match="invalid context_policy"):
            await exec_llm_agent(_runtime(), {"instruction": "go", "node_id": "ai_step", "context_policy": {"budget": 5}}, {})

    @pytest.mark.asyncio
    async def test_policy_rejected_with_session_continuation(self, fake_executor: dict[str, Any]) -> None:
        fake_executor["result"] = _completed_result("done")
        with pytest.raises(WorkflowExecutionError, match="context_policy is not supported with session continuation"):
            await exec_llm_agent(
                _runtime(checkpointer=object()),
                {"instruction": "go", "node_id": "ai_step", "context_policy": {"examples": ["e"]}},
                {"in": "x", "continue_prompt": "MORE"},
            )

    @pytest.mark.asyncio
    async def test_channel_lifted_onto_state(self, fake_executor: dict[str, Any]) -> None:
        fake_executor["result"] = _completed_result("done")
        node = _ai_node(params={"context_policy": {"examples": ["e"]}})
        edges = [
            Edge(source="start", source_port="input", target="ai_step", target_port="in"),
            Edge(source="ai_step", source_port="out", target="end", target_port="in"),
        ]
        graph = compile_definition(_make_def([_start_node(), node, _end_node()], edges), context=build_default_registry().build_context())
        state = await graph.ainvoke({"wf:start:input": "hi"}, {"configurable": {"thread_id": "t"}, "context": {"thread_id": "t", "user_id": "u1"}})
        assert state.get("wf:ai_step:out") == "done"
        assert state.get("wf:ai_step:__context_usage", {}).get("budget") is None


# ═══════════════════════════════════════════════════════════════════════════════
# Compile-time validation
# ═══════════════════════════════════════════════════════════════════════════════


class TestCompileValidation:
    def _compile(self, node: Node) -> None:
        edges = [
            Edge(source="start", source_port="input", target="ai_step", target_port="in"),
            Edge(source="ai_step", source_port="out", target="end", target_port="in"),
        ]
        compile_definition(_make_def([_start_node(), node, _end_node()], edges), context=build_default_registry().build_context())

    def test_undeclared_include_port_is_rejected(self) -> None:
        node = _ai_node(params={"context_policy": {"include": ["missing"]}})
        with pytest.raises(WorkflowCompileError, match="undeclared input port 'missing'"):
            self._compile(node)

    def test_declared_include_port_is_accepted(self) -> None:
        self._compile(_ai_node(params={"context_policy": {"include": ["in"]}}))

    def test_bad_policy_shape_is_rejected(self) -> None:
        with pytest.raises(WorkflowCompileError, match="invalid context_policy"):
            self._compile(_ai_node(params={"context_policy": {"budget": {"total_tokens": 0}}}))

    def test_policy_on_non_ai_node_is_rejected(self) -> None:
        node = Node(
            id="ai_step",
            type=NodeType.DATA_ASSIGN,
            params={"value": 1, "context_policy": {"examples": ["e"]}},
            inputs=[Port(name="in", type=PortType.DATA)],
            outputs=[Port(name="out", type=PortType.DATA)],
        )
        with pytest.raises(WorkflowCompileError, match="only supported on 'ai:llm_agent'"):
            self._compile(node)
