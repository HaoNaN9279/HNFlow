"""Tests for subagent checkpoint-resume wiring (T10-1).

Covers:
- Default path leaves the child run_config free of checkpoint coordinates.
- ``checkpointer=True`` without a saver instance raises ``ValueError``.
- Checkpoint coordinates (``thread_id`` / ``checkpoint_ns`` / ``checkpoint_id``)
  are written into the child config only when checkpointing is enabled AND a
  saver is supplied.
- ``_create_agent`` threads the saver through to ``create_agent``.
- An InMemorySaver-backed subagent actually writes a checkpoint and a resumed
  execution continues on the same checkpoint thread.
"""

from __future__ import annotations

import sys
from types import ModuleType, SimpleNamespace

import pytest
from langchain_core.language_models import BaseChatModel
from langchain_core.messages import AIMessage, HumanMessage
from langchain_core.outputs import ChatGeneration, ChatResult
from langgraph.checkpoint.memory import InMemorySaver


@pytest.fixture
def env():
    """Import the real executor behind conftest's cycle-breaking mock.

    Unlike ``test_extension_subagent_lifecycle``, no module mocks are injected
    here: importing ``deerflow.subagents.executor`` directly resolves the real
    ``deerflow.agents.thread_state`` schema (needed to compile a real graph in
    the write/resume test) without tripping the circular-import path conftest
    guards against.
    """
    original_executor = sys.modules.get("deerflow.subagents.executor")
    subagents_pkg = sys.modules.get("deerflow.subagents")
    missing = object()
    original_executor_attr = getattr(subagents_pkg, "executor", missing) if subagents_pkg is not None else missing

    sys.modules.pop("deerflow.subagents.executor", None)
    if subagents_pkg is not None and hasattr(subagents_pkg, "executor"):
        delattr(subagents_pkg, "executor")

    try:
        from deerflow.subagents.config import SubagentConfig
        from deerflow.subagents.executor import SubagentExecutor, SubagentResult, SubagentStatus

        executor_module = sys.modules["deerflow.subagents.executor"]
        executor_module.get_app_config = lambda: SimpleNamespace(
            tool_search=SimpleNamespace(enabled=False),
            authorization=SimpleNamespace(enabled=False),
            skills=SimpleNamespace(deferred_discovery=True, container_path="/mnt/skills"),
        )
        yield SimpleNamespace(
            SubagentConfig=SubagentConfig,
            SubagentExecutor=SubagentExecutor,
            SubagentResult=SubagentResult,
            SubagentStatus=SubagentStatus,
            executor_module=executor_module,
        )
    finally:
        if original_executor is None:
            sys.modules.pop("deerflow.subagents.executor", None)
        else:
            sys.modules["deerflow.subagents.executor"] = original_executor
        subagents_pkg = sys.modules.get("deerflow.subagents")
        if subagents_pkg is not None:
            if original_executor_attr is missing:
                if hasattr(subagents_pkg, "executor"):
                    delattr(subagents_pkg, "executor")
            else:
                setattr(subagents_pkg, "executor", original_executor_attr)


def _config(**overrides) -> dict:
    kwargs: dict = {
        "name": "test-agent",
        "description": "Test agent",
        "system_prompt": "You are a test agent.",
        "max_turns": 10,
        "timeout_seconds": 60,
    }
    kwargs.update(overrides)
    return kwargs


async def _noop_initial_state(self, task):
    return ({"messages": [HumanMessage(content=task)]}, [], None)


class _CapturingAgent:
    """Records the config passed to ``astream`` and yields a terminal answer."""

    def __init__(self, seen: dict):
        self.seen = seen

    async def astream(self, state, config=None, context=None, stream_mode=None):
        self.seen["config"] = config
        self.seen["context"] = context
        yield {"messages": [HumanMessage(content="do it"), AIMessage(content="done")]}


def _patch_middleware_builder(monkeypatch: pytest.MonkeyPatch) -> None:
    """Short-circuit the heavy middleware builder used by ``_create_agent``."""
    mw_pkg = ModuleType("deerflow.agents.middlewares")
    monkeypatch.setitem(sys.modules, "deerflow.agents.middlewares", mw_pkg)
    fake = ModuleType("deerflow.agents.middlewares.tool_error_handling_middleware")
    fake.build_subagent_runtime_middlewares = lambda **kwargs: []
    monkeypatch.setitem(sys.modules, "deerflow.agents.middlewares.tool_error_handling_middleware", fake)


class _OneShotModel(BaseChatModel):
    """Returns a single terminal answer and logs every generation."""

    answer: str = "done"

    @property
    def _llm_type(self) -> str:
        return "fake-checkpoint-model"

    def bind_tools(self, tools, **kwargs):
        return self

    def _generate(self, messages, stop=None, run_manager=None, **kwargs):
        _model_calls.append(self.answer)
        return ChatResult(generations=[ChatGeneration(message=AIMessage(content=self.answer))])

    async def _agenerate(self, messages, stop=None, run_manager=None, **kwargs):
        return self._generate(messages, stop=stop, run_manager=run_manager, **kwargs)


_model_calls: list[str] = []


@pytest.fixture(autouse=True)
def _clear_model_calls():
    _model_calls.clear()
    yield


class TestCheckpointCoordinates:
    @pytest.mark.anyio
    async def test_default_no_checkpoint_no_coords(self, env, monkeypatch):
        SubagentExecutor = env.SubagentExecutor
        SubagentStatus = env.SubagentStatus
        seen: dict = {}
        monkeypatch.setattr(env.SubagentExecutor, "_build_initial_state", _noop_initial_state)
        monkeypatch.setattr(env.SubagentExecutor, "_create_agent", lambda self, tools, **kwargs: _CapturingAgent(seen))

        executor = SubagentExecutor(config=env.SubagentConfig(**_config()), tools=[], thread_id="thread-1")
        result = await executor._aexecute("do the thing")

        assert result.status is SubagentStatus.COMPLETED
        config = seen["config"]
        assert "configurable" not in config
        assert "thread_id" not in config

    @pytest.mark.anyio
    async def test_checkpoint_coords_written_when_enabled(self, env, monkeypatch):
        SubagentExecutor = env.SubagentExecutor
        saver = InMemorySaver()
        seen: dict = {}
        monkeypatch.setattr(env.SubagentExecutor, "_build_initial_state", _noop_initial_state)
        monkeypatch.setattr(env.SubagentExecutor, "_create_agent", lambda self, tools, **kwargs: _CapturingAgent(seen))

        cfg = env.SubagentConfig(**_config(checkpointer=True))
        executor = SubagentExecutor(
            config=cfg,
            tools=[],
            thread_id="thread-1",
            checkpointer=saver,
            checkpoint_thread_id="cp-thread-1",
        )
        await executor._aexecute("do the thing")

        configurable = seen["config"]["configurable"]
        assert configurable["thread_id"] == "cp-thread-1"
        assert configurable["checkpoint_ns"] == "subagent"
        assert "checkpoint_id" not in configurable

    @pytest.mark.anyio
    async def test_resume_checkpoint_id_written_when_set(self, env, monkeypatch):
        SubagentExecutor = env.SubagentExecutor
        saver = InMemorySaver()
        seen: dict = {}
        monkeypatch.setattr(env.SubagentExecutor, "_build_initial_state", _noop_initial_state)
        monkeypatch.setattr(env.SubagentExecutor, "_create_agent", lambda self, tools, **kwargs: _CapturingAgent(seen))

        cfg = env.SubagentConfig(**_config(checkpointer=True))
        executor = SubagentExecutor(
            config=cfg,
            tools=[],
            thread_id="thread-1",
            checkpointer=saver,
            checkpoint_thread_id="cp-thread-1",
            resume_checkpoint_id="resume-cp-id",
        )
        await executor._aexecute("do the thing")

        configurable = seen["config"]["configurable"]
        assert configurable["thread_id"] == "cp-thread-1"
        assert configurable["checkpoint_ns"] == "subagent"
        assert configurable["checkpoint_id"] == "resume-cp-id"

    @pytest.mark.anyio
    async def test_checkpoint_thread_id_defaults_from_thread_and_task(self, env, monkeypatch):
        SubagentExecutor = env.SubagentExecutor
        saver = InMemorySaver()
        seen: dict = {}
        monkeypatch.setattr(env.SubagentExecutor, "_build_initial_state", _noop_initial_state)
        monkeypatch.setattr(env.SubagentExecutor, "_create_agent", lambda self, tools, **kwargs: _CapturingAgent(seen))

        cfg = env.SubagentConfig(**_config(checkpointer=True))
        executor = SubagentExecutor(config=cfg, tools=[], thread_id="parent-thread", checkpointer=saver)
        await executor._aexecute("do the thing")

        configurable = seen["config"]["configurable"]
        assert configurable["thread_id"].startswith("parent-thread:wfsub:")
        assert configurable["checkpoint_ns"] == "subagent"


class TestCheckpointValidation:
    def test_checkpointer_true_without_instance_raises(self, env):
        SubagentConfig = env.SubagentConfig
        SubagentExecutor = env.SubagentExecutor
        cfg = SubagentConfig(**_config(checkpointer=True))

        with pytest.raises(ValueError, match="checkpointer=True"):
            SubagentExecutor(config=cfg, tools=[])

    def test_checkpointer_false_without_instance_is_fine(self, env):
        SubagentConfig = env.SubagentConfig
        SubagentExecutor = env.SubagentExecutor
        cfg = SubagentConfig(**_config())

        executor = SubagentExecutor(config=cfg, tools=[])
        assert executor.checkpointer is None


class TestCreateAgentCheckpointerWiring:
    def test_create_agent_passes_checkpointer(self, env, monkeypatch):
        SubagentConfig = env.SubagentConfig
        SubagentExecutor = env.SubagentExecutor
        executor_module = env.executor_module
        saver = InMemorySaver()
        captured: dict = {}

        def fake_create_agent(**kwargs):
            captured["checkpointer"] = kwargs.get("checkpointer")
            return object()

        monkeypatch.setattr(executor_module, "create_agent", fake_create_agent)
        monkeypatch.setattr(executor_module, "create_chat_model", lambda **kwargs: object())
        _patch_middleware_builder(monkeypatch)

        cfg = SubagentConfig(**_config(checkpointer=True, model="test-model"))
        SubagentExecutor(config=cfg, tools=[], checkpointer=saver)._create_agent()
        assert captured["checkpointer"] is saver

        captured.clear()
        cfg2 = SubagentConfig(**_config(model="test-model"))
        SubagentExecutor(config=cfg2, tools=[])._create_agent()
        assert captured["checkpointer"] is False


class TestCheckpointWriteAndResume:
    @pytest.mark.anyio
    async def test_checkpoint_write_and_resume_with_in_memory_saver(self, env, monkeypatch):
        SubagentConfig = env.SubagentConfig
        SubagentExecutor = env.SubagentExecutor
        SubagentStatus = env.SubagentStatus
        executor_module = env.executor_module

        saver = InMemorySaver()
        model = _OneShotModel(answer="done")

        monkeypatch.setattr(executor_module, "create_chat_model", lambda **kwargs: model)
        _patch_middleware_builder(monkeypatch)
        monkeypatch.setattr(env.SubagentExecutor, "_build_initial_state", _noop_initial_state)

        cfg = SubagentConfig(**_config(checkpointer=True, system_prompt=None))
        executor1 = SubagentExecutor(
            config=cfg,
            tools=[],
            parent_model="test-model",
            thread_id="cp-thread",
            checkpointer=saver,
            checkpoint_thread_id="cp-thread",
        )
        result1 = await executor1._aexecute("do the thing")

        assert result1.status is SubagentStatus.COMPLETED
        assert result1.result == "done"

        checkpoints = list(saver.list({"configurable": {"thread_id": "cp-thread"}}))
        assert checkpoints, "a checkpoint-enabled subagent must persist a checkpoint"
        checkpoint_id = checkpoints[-1].config["configurable"]["checkpoint_id"]

        # Resume: a new executor resumes from the persisted checkpoint on the
        # same thread. The model is re-invoked as a continuation (not a fresh
        # run from a clean slate) and the checkpoint thread accumulates.
        model.answer = "resumed"
        executor2 = SubagentExecutor(
            config=cfg,
            tools=[],
            parent_model="test-model",
            thread_id="cp-thread",
            checkpointer=saver,
            checkpoint_thread_id="cp-thread",
            resume_checkpoint_id=checkpoint_id,
        )
        result2 = await executor2._aexecute("do the thing")

        assert result2.status is SubagentStatus.COMPLETED
        assert result2.result == "resumed"
        checkpoints_after_resume = list(saver.list({"configurable": {"thread_id": "cp-thread"}}))
        assert len(checkpoints_after_resume) > len(checkpoints)


class TestDelegationDepthContext:
    @pytest.mark.anyio
    async def test_delegation_depth_written_to_context(self, env, monkeypatch):
        SubagentExecutor = env.SubagentExecutor
        seen: dict = {}
        monkeypatch.setattr(env.SubagentExecutor, "_build_initial_state", _noop_initial_state)
        monkeypatch.setattr(env.SubagentExecutor, "_create_agent", lambda self, tools, **kwargs: _CapturingAgent(seen))

        cfg = env.SubagentConfig(**_config())
        executor = SubagentExecutor(config=cfg, tools=[], thread_id="thread-1", delegation_depth=2)
        await executor._aexecute("do the thing")

        assert seen["context"]["delegation_depth"] == 2
