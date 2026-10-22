"""Tests for the current ``ai:llm_agent`` node contract.

The AI node has no instruction/autonomy/context-policy/memory/retrieval/model-
policy parameters.  Its task comes from ``template_prompt`` (or
``continue_prompt``), its schema comes from a ``data:schema`` input node, and
context compression is automatic.
"""

from __future__ import annotations

from types import SimpleNamespace
from typing import Any

import pytest

from deerflow.config.agents_config import AgentConfig
from deerflow.workflow.compiler import WorkflowRuntime, clear_compile_cache, compile_definition
from deerflow.workflow.executors import WorkflowExecutionError, build_default_registry, exec_llm_agent
from deerflow.workflow.schema import Edge, Node, NodeType, Port, PortType, WorkflowDefinition
from deerflow.workflow.structured_output import parse_schema


def _start_node() -> Node:
    return Node(id="start", type=NodeType.FLOW_START, outputs=[Port(name="input", type=PortType.DATA)])


def _end_node() -> Node:
    return Node(id="end", type=NodeType.FLOW_END, inputs=[Port(name="in", type=PortType.DATA)])


def _ai_node(*, agent_name: str | None = None, capability_groups: list[str] | None = None) -> Node:
    return Node(
        id="ai_step",
        type=NodeType.AI_LLM_AGENT,
        params={},
        agent_name=agent_name,
        capability_groups=capability_groups or [],
        inputs=[
            Port(name="in", type=PortType.DATA),
            Port(name="template_prompt", type=PortType.DATA),
        ],
        outputs=[Port(name="out", type=PortType.DATA)],
    )


def _task_node(value: str = "请总结：{{in}}") -> Node:
    return Node(
        id="task",
        type=NodeType.DATA_ASSIGN,
        inputs=[Port(name="in", type=PortType.DATA)],
        outputs=[Port(name="out", type=PortType.DATA)],
        params={"value": value},
    )


def _graph_def() -> WorkflowDefinition:
    nodes = [_start_node(), _ai_node(agent_name="publisher", capability_groups=["publish"]), _end_node()]
    edges = [
        Edge(source="start", source_port="input", target="ai_step", target_port="in"),
        Edge(source="start", source_port="input", target="ai_step", target_port="template_prompt"),
        Edge(source="ai_step", source_port="out", target="end", target_port="in"),
    ]
    return WorkflowDefinition(id="test-wf", name="Test Workflow", nodes=nodes, edges=edges)


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
    monkeypatch.setattr("deerflow.workflow.executors.ai.load_capability_rules", lambda *args, **kwargs: [])
    monkeypatch.setattr("deerflow.workflow.executors.ai.load_capability_skills", lambda *args, **kwargs: [])
    monkeypatch.setattr("deerflow.workflow.prompts.load_agent_soul", lambda agent_name, user_id=None: None)
    yield captured


def _completed(text: str) -> Any:
    return SimpleNamespace(status=SimpleNamespace(value="completed"), result=text, error=None)


@pytest.mark.asyncio
async def test_template_prompt_is_the_only_task_source(fake_executor: dict[str, Any]) -> None:
    fake_executor["result"] = _completed("ok")
    result = await exec_llm_agent(
        WorkflowRuntime(context={"user_id": "u1", "thread_id": "t"}),
        {"node_id": "ai_step"},
        {"in": "value", "template_prompt": "Task {{in}}"},
    )

    assert fake_executor["task"] == "Task value"
    assert "Task value" not in (fake_executor["kwargs"]["config"].system_prompt or "")
    assert result["out"]["content"] == "ok"


@pytest.mark.asyncio
async def test_missing_template_prompt_raises(fake_executor: dict[str, Any]) -> None:
    fake_executor["result"] = _completed("ok")
    with pytest.raises(WorkflowExecutionError, match="template_prompt"):
        await exec_llm_agent(
            WorkflowRuntime(context={"user_id": "u1", "thread_id": "t"}),
            {"node_id": "ai_step"},
            {"in": "value"},
        )


@pytest.mark.asyncio
async def test_compiled_graph_runs_and_exposes_prompt(fake_executor: dict[str, Any], monkeypatch: pytest.MonkeyPatch) -> None:
    fake_executor["result"] = _completed("AI 完成")
    monkeypatch.setattr(
        "deerflow.workflow.executors.ai.load_agent_config",
        lambda name, user_id=None: AgentConfig(name=name, skills=["publish-skill"]),
    )

    graph = compile_definition(_graph_def(), context=build_default_registry().build_context())
    state = await graph.ainvoke(
        {"wf:start:input": "hello"},
        {"configurable": {"thread_id": "t"}, "context": {"thread_id": "t", "user_id": "u1"}},
    )

    assert state.get("wf:ai_step:out")["content"] == "AI 完成"
    assert "hello" in state.get("wf:ai_step:__prompt", "")
    cfg = fake_executor["kwargs"]["config"]
    assert "publisher" in (cfg.system_prompt or "")
    assert "publish-skill" in (cfg.system_prompt or "")
    assert "task" in cfg.disallowed_tools
    assert cfg.allow_recursion is False
    assert cfg.max_turns == 50
    assert getattr(cfg.token_budget, "enabled", None) is False
    assert fake_executor["task"] == "hello"


@pytest.mark.asyncio
async def test_failed_subagent_propagates(fake_executor: dict[str, Any]) -> None:
    fake_executor["result"] = SimpleNamespace(status=SimpleNamespace(value="failed"), result=None, error="boom")
    with pytest.raises(WorkflowExecutionError, match="boom"):
        await exec_llm_agent(
            WorkflowRuntime(context={"user_id": "u1", "thread_id": "t"}),
            {"node_id": "ai_step"},
            {"template_prompt": "Task"},
        )


_SCHEMA_RAW = {
    "version": 1,
    "max_repairs": 0,
    "custom_fields": [{"name": "score", "type": "number", "required": True}],
}


@pytest.mark.asyncio
async def test_schema_references_are_rendered_from_input_envelope(fake_executor: dict[str, Any]) -> None:
    fake_executor["result"] = _completed('{"summary":"done","status":"ok","content":"ok","custom":{"score":9}}')
    schema = parse_schema(_SCHEMA_RAW)
    assert schema is not None
    result = await exec_llm_agent(
        WorkflowRuntime(context={"user_id": "u1", "thread_id": "t"}),
        {"node_id": "ai_step", "__input_schema": schema, "__output_schema": schema},
        {
            "in": {"summary": "upstream", "status": "ok", "content": "body", "custom": {"score": 7}},
            "template_prompt": "summary=[schema.summary] score=[schema.custom.score]",
        },
    )

    assert fake_executor["task"] == "summary=upstream score=7"
    assert result["out"]["custom"] == {"score": 9}
    assert result["out"]["source_node"] == "ai_step"


@pytest.mark.asyncio
async def test_invalid_input_envelope_fails_before_model_call(fake_executor: dict[str, Any]) -> None:
    fake_executor["result"] = _completed('{"summary":"done","status":"ok","content":"ok","custom":{"score":9}}')
    schema = parse_schema(_SCHEMA_RAW)
    assert schema is not None
    with pytest.raises(WorkflowExecutionError, match="input envelope"):
        await exec_llm_agent(
            WorkflowRuntime(context={"user_id": "u1", "thread_id": "t"}),
            {"node_id": "ai_step", "__input_schema": schema, "__output_schema": schema},
            {"in": {"summary": "missing score"}, "template_prompt": "Task"},
        )
    assert "task" not in fake_executor
