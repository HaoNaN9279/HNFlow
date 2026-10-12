"""Tests for ``ai:llm_agent`` node execution (T21).

Covers:
- End-to-end: an ``ai:llm_agent`` node compiles and runs through a (mocked)
  ``SubagentExecutor._aexecute``; the assembled prompt carries all three layers
  (identity agent name / capability-group name / task-layer interpolation) and
  the sub-agent's final text is written back to the node output port.
- ``instruction`` missing/empty raises ``WorkflowExecutionError``.
- ``agent_name=None`` yields the default lead identity (no custom-agent marker).
- Compiler injection: non-AI node ``params`` are never polluted; an AI node's
  injected ``params`` reach the executor without mutating the original
  ``Node.params`` definition (``model_dump()`` shows no extra keys).
"""

from __future__ import annotations

from types import SimpleNamespace
from typing import Any

import pytest

from deerflow.config.agents_config import AgentConfig
from deerflow.workflow.compiler import (
    CompileContext,
    WorkflowRuntime,
    clear_compile_cache,
    compile_definition,
)
from deerflow.workflow.executors import WorkflowExecutionError, build_default_registry, exec_llm_agent
from deerflow.workflow.schema import (
    Edge,
    Node,
    NodeType,
    Port,
    PortType,
    WorkflowDefinition,
)

# ═══════════════════════════════════════════════════════════════════════════════
# Helpers (minimal copies from sibling test files — test files do not share
# imports to avoid coupling)
# ═══════════════════════════════════════════════════════════════════════════════


def _make_def(nodes: list[Node] | None = None, edges: list[Edge] | None = None, **kwargs: Any) -> WorkflowDefinition:
    kwargs.setdefault("id", "test-wf")
    kwargs.setdefault("name", "Test Workflow")
    return WorkflowDefinition(nodes=nodes or [], edges=edges or [], **kwargs)


def _start_node(id_: str = "start") -> Node:
    return Node(id=id_, type=NodeType.FLOW_START, inputs=[], outputs=[Port(name="input", type=PortType.DATA)])


def _end_node(id_: str = "end") -> Node:
    return Node(id=id_, type=NodeType.FLOW_END, inputs=[Port(name="in", type=PortType.DATA)], outputs=[])


def _ai_node(
    id_: str = "ai_step",
    *,
    instruction: str = "请处理 {{in}}",
    agent_name: str | None = None,
    capability_groups: list[str] | None = None,
) -> Node:
    return Node(
        id=id_,
        type=NodeType.AI_LLM_AGENT,
        params={"instruction": instruction},
        agent_name=agent_name,
        capability_groups=capability_groups or [],
        inputs=[Port(name="in", type=PortType.DATA)],
        outputs=[Port(name="out", type=PortType.DATA)],
    )


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
    """Replace ``SubagentExecutor`` with a fake returning a scripted result.

    ``exec_llm_agent`` lazily imports ``SubagentExecutor`` from
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
    # Keep these prompt/wiring tests hermetic: capability-group tool resolution
    # (C1) is covered separately in test_workflow_tool_gateway.py.
    monkeypatch.setattr("deerflow.workflow.executors.ai._resolve_node_tools", lambda *args, **kwargs: [])
    yield captured


# ═══════════════════════════════════════════════════════════════════════════════
# 1. End-to-end: compile + run through a mocked sub-agent
# ═══════════════════════════════════════════════════════════════════════════════


class TestAINodeE2E:
    @pytest.mark.asyncio
    async def test_ai_node_compiles_and_runs(self, fake_executor: dict[str, Any], monkeypatch: pytest.MonkeyPatch) -> None:
        fake_executor["result"] = _completed_result("AI 完成")

        # Avoid disk IO: the custom-agent config/SOUL loaders would hit the file
        # store. Patch the seams ``exec_llm_agent`` and ``prompts`` use directly.
        monkeypatch.setattr(
            "deerflow.workflow.executors.ai.load_agent_config",
            lambda name, user_id=None: AgentConfig(name=name, skills=["publish-skill"]),
        )
        monkeypatch.setattr("deerflow.workflow.prompts.load_agent_soul", lambda agent_name, user_id=None: None)

        nodes = [
            _start_node(),
            _ai_node("ai_step", instruction="请总结：{{in}}", agent_name="publisher", capability_groups=["publish"]),
            _end_node(),
        ]
        edges = [
            Edge(source="start", source_port="input", target="ai_step", target_port="in"),
            Edge(source="ai_step", source_port="out", target="end", target_port="in"),
        ]
        def_ = _make_def(nodes, edges)
        ctx = build_default_registry().build_context()
        graph = compile_definition(def_, context=ctx)

        state = await graph.ainvoke(
            {"wf:start:input": "hello"},
            {"configurable": {"thread_id": "t"}, "context": {"thread_id": "t", "user_id": "u1"}},
        )

        # Result written back to the node's output port.
        assert state.get("wf:ai_step:out") == "AI 完成"

        # The assembled prompt carries all three layers.
        prompt = fake_executor["task"]
        assert "publisher" in prompt  # identity layer: agent name
        assert "publish" in prompt  # capability layer: group name
        assert "hello" in prompt  # task layer: {{in}} interpolation
        assert "publish-skill" in prompt  # capability layer: agent skills whitelist

        # The sub-agent was bound with the assembled prompt and the expected
        # safety/checkpoint/recursion flags.
        cfg = fake_executor["kwargs"]["config"]
        assert cfg.system_prompt == prompt
        assert cfg.disallowed_tools == ["ask_clarification", "present_files"]
        assert cfg.checkpointer is False
        assert cfg.allow_recursion is False
        assert cfg.name == "ai:ai_step"

    @pytest.mark.asyncio
    async def test_ai_node_failure_propagates(self, fake_executor: dict[str, Any]) -> None:
        fake_executor["result"] = _failed_result("boom")
        nodes = [_start_node(), _ai_node("ai_step"), _end_node()]
        edges = [
            Edge(source="start", source_port="input", target="ai_step", target_port="in"),
            Edge(source="ai_step", source_port="out", target="end", target_port="in"),
        ]
        def_ = _make_def(nodes, edges)
        ctx = build_default_registry().build_context()
        graph = compile_definition(def_, context=ctx)

        with pytest.raises(WorkflowExecutionError, match="ai:llm_agent execution failed") as exc_info:
            await graph.ainvoke({"wf:start:input": "x"})
        assert "boom" in str(exc_info.value)


# ═══════════════════════════════════════════════════════════════════════════════
# 2. Error semantics
# ═══════════════════════════════════════════════════════════════════════════════


class TestAINodeErrors:
    @pytest.mark.asyncio
    async def test_instruction_missing_raises(self) -> None:
        rt = WorkflowRuntime()
        with pytest.raises(WorkflowExecutionError, match="instruction"):
            await exec_llm_agent(rt, {}, {"in": "x"})

    @pytest.mark.asyncio
    async def test_instruction_empty_raises(self) -> None:
        rt = WorkflowRuntime()
        with pytest.raises(WorkflowExecutionError, match="instruction"):
            await exec_llm_agent(rt, {"instruction": ""}, {"in": "x"})


# ═══════════════════════════════════════════════════════════════════════════════
# 3. Identity layer
# ═══════════════════════════════════════════════════════════════════════════════


class TestIdentityLayer:
    @pytest.mark.asyncio
    async def test_agent_name_none_uses_default_lead_identity(self, fake_executor: dict[str, Any]) -> None:
        fake_executor["result"] = _completed_result("ok")
        rt = WorkflowRuntime()

        result = await exec_llm_agent(rt, {"instruction": "执行 {{in}}"}, {"in": "value"})

        assert result == {"out": "ok"}
        prompt = fake_executor["task"]
        assert "通用 AI 助手" in prompt
        assert "自定义 agent" not in prompt


# ═══════════════════════════════════════════════════════════════════════════════
# 4. Compiler injection
# ═══════════════════════════════════════════════════════════════════════════════


class TestCompilerInjection:
    @pytest.mark.asyncio
    async def test_non_ai_node_params_not_polluted(self) -> None:
        captured: dict[str, Any] = {}

        def recording(_rt: Any, params: dict[str, Any], _inputs: dict[str, Any]) -> dict[str, Any]:
            captured["params"] = params
            return {"out": params.get("value")}

        assign = Node(
            id="a",
            type=NodeType.DATA_ASSIGN,
            params={"value": 7},
            inputs=[Port(name="in", type=PortType.DATA)],
            outputs=[Port(name="out", type=PortType.DATA)],
        )
        nodes = [_start_node(), assign, _end_node()]
        edges = [
            Edge(source="start", source_port="input", target="a", target_port="in"),
            Edge(source="a", source_port="out", target="end", target_port="in"),
        ]
        def_ = _make_def(nodes, edges)
        ctx = CompileContext(executors={NodeType.DATA_ASSIGN: recording})
        graph = compile_definition(def_, context=ctx)

        await graph.ainvoke({"wf:start:input": "x"})

        # Executor received the untouched params and the definition is unchanged.
        assert captured["params"] == {"value": 7}
        assert assign.params == {"value": 7}
        assert "agent_name" not in assign.params
        assert "capability_groups" not in assign.params
        assert "node_id" not in assign.params

    @pytest.mark.asyncio
    async def test_ai_node_params_injected_without_mutating_definition(self) -> None:
        captured: dict[str, Any] = {}

        def recording(_rt: Any, params: dict[str, Any], _inputs: dict[str, Any]) -> dict[str, Any]:
            captured["params"] = params
            return {"out": "done"}

        ai = Node(
            id="ai_step",
            type=NodeType.AI_LLM_AGENT,
            params={"instruction": "do {{in}}"},
            agent_name="publisher",
            capability_groups=["publish"],
            inputs=[Port(name="in", type=PortType.DATA)],
            outputs=[Port(name="out", type=PortType.DATA)],
        )
        nodes = [_start_node(), ai, _end_node()]
        edges = [
            Edge(source="start", source_port="input", target="ai_step", target_port="in"),
            Edge(source="ai_step", source_port="out", target="end", target_port="in"),
        ]
        def_ = _make_def(nodes, edges)
        ctx = CompileContext(executors={NodeType.AI_LLM_AGENT: recording})
        graph = compile_definition(def_, context=ctx)

        await graph.ainvoke({"wf:start:input": "x"})

        # The executor received the injected params...
        assert captured["params"]["agent_name"] == "publisher"
        assert captured["params"]["capability_groups"] == ["publish"]
        assert captured["params"]["node_id"] == "ai_step"
        assert captured["params"]["instruction"] == "do {{in}}"
        # ...without mutating the original node definition.
        assert ai.params == {"instruction": "do {{in}}"}
        assert "agent_name" not in ai.params
        assert "capability_groups" not in ai.params
        assert "node_id" not in ai.params
        assert ai.model_dump()["params"] == {"instruction": "do {{in}}"}
