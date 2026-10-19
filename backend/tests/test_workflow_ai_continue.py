"""Tests for ``ai:llm_agent`` continue-mode session continuation (W1A).

``exec_llm_agent`` gains a second mode: when ``inputs["continue_prompt"]`` is
non-empty the node appends a new task layer to an existing sub-agent session
instead of starting a fresh one-shot run.  The session is persisted under a
checkpoint thread derived from ``{thread_id}:wfai:{node_id}``, so repeated
``continue`` dispatches in a loop keep accumulating history.

Covers:
- continue_prompt non-empty → checkpoint-enabled SubagentExecutor bound to
  ``checkpoint_thread_id == f"{thread_id}:wfai:{node_id}"``; the executed task
  is only the new task layer (identity/capability stay in the session's first
  turn), and ``system_prompt`` is not re-assembled.
- continue_prompt empty → the legacy template branch (one-shot,
  ``checkpointer=False``, full three-layer prompt).
- continue without a checkpointer in runtime context → ``WorkflowExecutionError``
  (memory backend fail-closed).
- continue without thread_id / node_id → readable ``WorkflowExecutionError``.
- checkpoint thread stability: two continues of the same node_id reuse the same
  checkpoint thread id.
- Integration: a compiled workflow whose AI node carries a ``continue_prompt``
  input port executes successfully with a runtime-context checkpointer.
"""

from __future__ import annotations

from types import SimpleNamespace
from typing import Any

import pytest
from langgraph.checkpoint.memory import InMemorySaver

from deerflow.workflow.compiler import (
    WorkflowRuntime,
    clear_compile_cache,
    compile_definition,
)
from deerflow.workflow.executors import WorkflowExecutionError, build_default_registry, exec_llm_agent
from deerflow.workflow.prompts import build_task_layer
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
    inputs: list[Port] | None = None,
) -> Node:
    return Node(
        id=id_,
        type=NodeType.AI_LLM_AGENT,
        params={"instruction": instruction},
        inputs=inputs if inputs is not None else [Port(name="in", type=PortType.DATA)],
        outputs=[Port(name="out", type=PortType.DATA)],
    )


def _completed_result(text: str = "ok") -> Any:
    return SimpleNamespace(status=SimpleNamespace(value="completed"), result=text, error=None)


def _runtime(
    *,
    thread_id: str | None = "t1",
    checkpointer: Any = None,
    app_config: Any = None,
) -> WorkflowRuntime:
    context: dict[str, Any] = {}
    if thread_id is not None:
        context["thread_id"] = thread_id
    context["user_id"] = "u1"
    if app_config is not None:
        context["app_config"] = app_config
    if checkpointer is not None:
        context["checkpointer"] = checkpointer
    return WorkflowRuntime(context=context)


# ═══════════════════════════════════════════════════════════════════════════════
# Fixtures
# ═══════════════════════════════════════════════════════════════════════════════


@pytest.fixture(autouse=True)
def _isolate_cache() -> Any:
    clear_compile_cache()
    yield


@pytest.fixture
def fake_executor(monkeypatch: pytest.MonkeyPatch) -> list[dict[str, Any]]:
    """Replace ``SubagentExecutor`` and record every construction + task.

    ``exec_llm_agent`` lazily imports ``SubagentExecutor`` from
    ``deerflow.subagents``; patching the package attribute shadows that lazy
    export without importing the real (heavy) executor module.
    """
    instances: list[dict[str, Any]] = []

    class FakeExecutor:
        def __init__(self, **kwargs: Any) -> None:
            self._index = len(instances)
            instances.append({"kwargs": kwargs})

        async def _aexecute(self, task: str, result_holder: Any = None) -> Any:
            instances[self._index]["task"] = task
            return _completed_result()

    import deerflow.subagents as subagents_pkg

    monkeypatch.setattr(subagents_pkg, "SubagentExecutor", FakeExecutor)
    return instances


# ═══════════════════════════════════════════════════════════════════════════════
# 1. Continue mode
# ═══════════════════════════════════════════════════════════════════════════════


class TestContinueMode:
    @pytest.mark.asyncio
    async def test_continue_builds_checkpoint_executor(self, fake_executor: list[dict[str, Any]]) -> None:
        """A non-empty ``continue_prompt`` selects the checkpoint-enabled branch."""
        saver = InMemorySaver()
        rt = _runtime(thread_id="t1", checkpointer=saver)
        inputs = {"in": "x", "continue_prompt": "请继续处理 {{in}}"}

        result = await exec_llm_agent(rt, {"instruction": "首轮 {{in}}", "node_id": "ai_step"}, inputs)

        assert result == {"out": "ok"}
        assert len(fake_executor) == 1
        record = fake_executor[0]
        cfg = record["kwargs"]["config"]

        # Checkpoint-enabled sub-agent bound to the derived session thread.
        assert cfg.checkpointer is True
        assert record["kwargs"]["checkpointer"] is saver
        assert record["kwargs"]["checkpoint_thread_id"] == "t1:wfai:ai_step"
        assert record["kwargs"]["resume_checkpoint_id"] is None

        # Identity/capability layers are NOT re-assembled — the session's first
        # turn already carries them. Only the new task layer is executed.
        assert cfg.system_prompt is None
        assert record["task"] == build_task_layer("请继续处理 {{in}}", inputs)
        assert record["task"] == "请继续处理 x"
        assert "首轮" not in record["task"]

    @pytest.mark.asyncio
    async def test_continue_keeps_identity_kwargs(self, fake_executor: list[dict[str, Any]]) -> None:
        """Continue mode still forwards user/app/thread identity kwargs."""
        saver = InMemorySaver()
        rt = _runtime(thread_id="t1", checkpointer=saver)
        await exec_llm_agent(rt, {"instruction": "首轮", "node_id": "ai_step"}, {"in": "x", "continue_prompt": "继续"})

        kwargs = fake_executor[0]["kwargs"]
        assert kwargs["user_id"] == "u1"
        assert kwargs["thread_id"] == "t1"
        assert kwargs["delegation_depth"] == 0


# ═══════════════════════════════════════════════════════════════════════════════
# 2. Template mode regression (current one-shot behavior)
# ═══════════════════════════════════════════════════════════════════════════════


class TestTemplateMode:
    @pytest.mark.asyncio
    async def test_empty_continue_prompt_uses_template_branch(self, fake_executor: list[dict[str, Any]]) -> None:
        """Missing/empty ``continue_prompt`` keeps the one-shot template path."""
        rt = _runtime(thread_id="t1", checkpointer=InMemorySaver())
        inputs = {"in": "x"}

        result = await exec_llm_agent(rt, {"instruction": "请总结 {{in}}", "node_id": "ai_step"}, inputs)

        assert result == {"out": "ok"}
        record = fake_executor[0]
        cfg = record["kwargs"]["config"]

        # One-shot: checkpointer disabled, no session coordinates.
        assert cfg.checkpointer is False
        assert "checkpointer" not in record["kwargs"]
        assert "checkpoint_thread_id" not in record["kwargs"]

        # Full three-layer prompt assembled as before.
        assert cfg.system_prompt is not None
        assert "通用 AI 助手" in cfg.system_prompt  # identity layer
        assert "请总结 x" not in cfg.system_prompt  # task layer is the user turn
        assert record["task"] == "请总结 x"  # task layer interpolated

    @pytest.mark.asyncio
    async def test_blank_string_continue_prompt_uses_template_branch(self, fake_executor: list[dict[str, Any]]) -> None:
        """An empty-string ``continue_prompt`` input is falsy → template branch."""
        rt = _runtime(thread_id="t1", checkpointer=InMemorySaver())
        await exec_llm_agent(rt, {"instruction": "首轮", "node_id": "ai_step"}, {"in": "x", "continue_prompt": ""})

        assert fake_executor[0]["kwargs"]["config"].checkpointer is False


# ═══════════════════════════════════════════════════════════════════════════════
# 3. Fail-closed: continue without a checkpointer
# ═══════════════════════════════════════════════════════════════════════════════


class TestContinueFailClosed:
    @pytest.mark.asyncio
    async def test_continue_without_checkpointer_raises(self) -> None:
        """continue on a memory backend (no checkpointer) is a readable error."""
        rt = _runtime(thread_id="t1", checkpointer=None)  # context has no checkpointer

        with pytest.raises(WorkflowExecutionError, match="continue") as exc_info:
            await exec_llm_agent(rt, {"instruction": "首轮", "node_id": "ai_step"}, {"in": "x", "continue_prompt": "继续"})
        assert "checkpointer" in str(exc_info.value)

    @pytest.mark.asyncio
    async def test_continue_without_thread_id_raises(self) -> None:
        """continue without a thread_id cannot derive a stable session key."""
        rt = _runtime(thread_id=None, checkpointer=InMemorySaver())

        with pytest.raises(WorkflowExecutionError, match="thread_id") as exc_info:
            await exec_llm_agent(rt, {"instruction": "首轮", "node_id": "ai_step"}, {"in": "x", "continue_prompt": "继续"})
        assert "continue" in str(exc_info.value)

    @pytest.mark.asyncio
    async def test_continue_without_node_id_raises(self) -> None:
        """continue without a node_id cannot derive a stable session key."""
        rt = _runtime(thread_id="t1", checkpointer=InMemorySaver())

        with pytest.raises(WorkflowExecutionError, match="node_id") as exc_info:
            await exec_llm_agent(rt, {"instruction": "首轮"}, {"in": "x", "continue_prompt": "继续"})
        assert "continue" in str(exc_info.value)


# ═══════════════════════════════════════════════════════════════════════════════
# 4. Session-key stability
# ═══════════════════════════════════════════════════════════════════════════════


class TestSessionKeyStability:
    @pytest.mark.asyncio
    async def test_same_node_id_two_continues_same_checkpoint_thread(self, fake_executor: list[dict[str, Any]]) -> None:
        """A loop that continues the same node twice keeps one session thread."""
        rt = _runtime(thread_id="t1", checkpointer=InMemorySaver())
        params = {"instruction": "首轮", "node_id": "ai_step"}

        await exec_llm_agent(rt, params, {"in": "x", "continue_prompt": "继续"})
        await exec_llm_agent(rt, params, {"in": "y", "continue_prompt": "再继续"})

        assert len(fake_executor) == 2
        first = fake_executor[0]["kwargs"]["checkpoint_thread_id"]
        second = fake_executor[1]["kwargs"]["checkpoint_thread_id"]
        assert first == "t1:wfai:ai_step"
        assert second == first

    @pytest.mark.asyncio
    async def test_different_node_ids_get_different_session_threads(self, fake_executor: list[dict[str, Any]]) -> None:
        """Different nodes never share a session checkpoint thread."""
        rt = _runtime(thread_id="t1", checkpointer=InMemorySaver())

        await exec_llm_agent(rt, {"instruction": "首轮", "node_id": "ai_a"}, {"in": "x", "continue_prompt": "继续"})
        await exec_llm_agent(rt, {"instruction": "首轮", "node_id": "ai_b"}, {"in": "x", "continue_prompt": "继续"})

        assert fake_executor[0]["kwargs"]["checkpoint_thread_id"] == "t1:wfai:ai_a"
        assert fake_executor[1]["kwargs"]["checkpoint_thread_id"] == "t1:wfai:ai_b"
        assert fake_executor[0]["kwargs"]["checkpoint_thread_id"] != fake_executor[1]["kwargs"]["checkpoint_thread_id"]


# ═══════════════════════════════════════════════════════════════════════════════
# 5. Integration: compiled workflow with a continue_prompt input port
# ═══════════════════════════════════════════════════════════════════════════════


class TestContinueIntegration:
    @pytest.mark.asyncio
    async def test_ai_node_with_continue_port_executes(self, fake_executor: list[dict[str, Any]]) -> None:
        """A compiled workflow whose AI node receives ``continue_prompt`` from
        an upstream node runs with the runtime-context checkpointer wired in."""
        saver = InMemorySaver()
        ai = _ai_node(
            "ai_step",
            instruction="首轮 {{in}}",
            inputs=[Port(name="continue_prompt", type=PortType.DATA)],
        )
        # continue_prompt arrives through a real edge (its value lives on an
        # output-port state key the compiler declares — bare graph inputs for
        # undeclared keys are silently dropped by LangGraph, and a node with no
        # incoming edge never executes).  The AI node has a single incoming
        # edge: multiple incoming edges would re-execute it once per fan-in
        # (LangGraph semantics), which is the template-then-continue loop shape
        # rather than this single-continue integration check.
        prompt_src = Node(
            id="prompt_src",
            type=NodeType.DATA_ASSIGN,
            params={"value": "请继续处理"},
            inputs=[Port(name="in", type=PortType.DATA)],
            outputs=[Port(name="out", type=PortType.DATA)],
        )
        nodes = [_start_node(), prompt_src, ai, _end_node()]
        edges = [
            Edge(source="start", source_port="input", target="prompt_src", target_port="in"),
            Edge(source="prompt_src", source_port="out", target="ai_step", target_port="continue_prompt"),
            Edge(source="ai_step", source_port="out", target="end", target_port="in"),
        ]
        def_ = _make_def(nodes, edges)
        ctx = build_default_registry().build_context()
        graph = compile_definition(def_, context=ctx)

        state = await graph.ainvoke(
            {"wf:start:input": "hello"},
            {
                "configurable": {"thread_id": "t-cont"},
                "context": {"thread_id": "t-cont", "user_id": "u1", "checkpointer": saver},
            },
        )

        assert state.get("wf:ai_step:out") == "ok"

        # The compiler injected node_id; the executor derived the session key
        # from runtime context and executed only the new task layer.
        record = fake_executor[0]
        assert record["kwargs"]["checkpoint_thread_id"] == "t-cont:wfai:ai_step"
        assert record["kwargs"]["config"].checkpointer is True
        assert record["task"] == "请继续处理"
