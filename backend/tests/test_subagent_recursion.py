"""Tests for task recursion gating and delegation-depth propagation (T10-2)."""

from __future__ import annotations

import importlib
from enum import Enum
from types import SimpleNamespace

import pytest

from deerflow.subagents.config import SubagentConfig

task_tool_module = importlib.import_module("deerflow.tools.builtins.task_tool")


class _SubagentStatus(Enum):
    COMPLETED = "completed"


def _runtime(context: dict | None = None) -> SimpleNamespace:
    return SimpleNamespace(
        state={},
        context=context if context is not None else {},
        config={"metadata": {}, "configurable": {}},
    )


def _app_config(max_delegation_depth: int = 3) -> SimpleNamespace:
    return SimpleNamespace(subagents=SimpleNamespace(max_delegation_depth=max_delegation_depth))


def _completed_result() -> SimpleNamespace:
    return SimpleNamespace(
        status=_SubagentStatus.COMPLETED,
        ai_messages=[],
        result="delegated result",
        error=None,
        stop_reason=None,
        token_usage_records=[],
        usage_reported=False,
    )


class _FakeExecutor:
    """Records constructor kwargs and returns a stable execution id."""

    def __init__(self, captured: dict):
        self._captured = captured

    def __call__(self, **kwargs):
        self._captured.update(kwargs)
        return self

    def execute_async(self, prompt, task_id=None):
        return "exec-1"


async def _noop_aemit(*_args, **_kwargs):
    return None


def _patch_common(monkeypatch: pytest.MonkeyPatch, *, config: SubagentConfig, captured_tools: dict):
    """Patch the task_tool dependencies needed to reach the executor construction."""

    def _capture_get_available_tools(**kwargs):
        captured_tools["kwargs"] = kwargs
        return []

    monkeypatch.setattr(task_tool_module, "get_available_subagent_names", lambda *a, **k: ["general-purpose"])
    monkeypatch.setattr(task_tool_module, "get_subagent_config", lambda name, *a, **k: config)
    monkeypatch.setattr(task_tool_module, "resolve_runtime_user_id", lambda runtime: "test-user")
    monkeypatch.setattr(task_tool_module, "resolve_run_extensions", lambda ctx: None)
    monkeypatch.setattr(task_tool_module, "get_current_trace_id", lambda: None)
    monkeypatch.setattr("deerflow.tools.get_available_tools", _capture_get_available_tools)
    monkeypatch.setattr(task_tool_module, "get_background_task_result", lambda _task_id: _completed_result())
    monkeypatch.setattr(task_tool_module, "cleanup_background_task", lambda _task_id: None)
    monkeypatch.setattr(task_tool_module, "get_stream_writer", lambda: [])
    monkeypatch.setattr(task_tool_module, "aemit_custom_event", _noop_aemit)
    monkeypatch.setattr(task_tool_module, "SubagentStatus", _SubagentStatus)


class TestAllowRecursion:
    @pytest.mark.anyio
    async def test_allow_recursion_false_excludes_task_tool(self, monkeypatch):
        config = SubagentConfig(
            name="general-purpose",
            description="d",
            system_prompt="p",
            model="test-model",
            allow_recursion=False,
        )
        captured_tools: dict = {}
        _patch_common(monkeypatch, config=config, captured_tools=captured_tools)
        monkeypatch.setattr(task_tool_module, "SubagentExecutor", _FakeExecutor({}))

        runtime = _runtime({"app_config": _app_config()})
        await task_tool_module.task_tool.coroutine(runtime, "desc", "prompt", "general-purpose", "call-1")

        assert captured_tools["kwargs"]["subagent_enabled"] is False

    @pytest.mark.anyio
    async def test_allow_recursion_true_includes_task_tool(self, monkeypatch):
        config = SubagentConfig(
            name="general-purpose",
            description="d",
            system_prompt="p",
            model="test-model",
            allow_recursion=True,
        )
        captured_tools: dict = {}
        _patch_common(monkeypatch, config=config, captured_tools=captured_tools)
        monkeypatch.setattr(task_tool_module, "SubagentExecutor", _FakeExecutor({}))

        runtime = _runtime({"app_config": _app_config()})
        await task_tool_module.task_tool.coroutine(runtime, "desc", "prompt", "general-purpose", "call-1")

        assert captured_tools["kwargs"]["subagent_enabled"] is True


class TestDelegationDepth:
    @pytest.mark.anyio
    async def test_depth_exceeded_rejected(self, monkeypatch):
        config = SubagentConfig(
            name="general-purpose",
            description="d",
            system_prompt="p",
            model="test-model",
            allow_recursion=True,
        )
        captured_tools: dict = {}
        _patch_common(monkeypatch, config=config, captured_tools=captured_tools)
        executor_factory = _FakeExecutor({})
        monkeypatch.setattr(task_tool_module, "SubagentExecutor", executor_factory)
        # The depth check short-circuits before get_available_tools, so drop it
        # to prove no tool assembly happened on the rejected path.
        monkeypatch.setattr("deerflow.tools.get_available_tools", lambda **kwargs: pytest.fail("tools must not be assembled when depth is exceeded"))

        runtime = _runtime({"app_config": _app_config(max_delegation_depth=3), "delegation_depth": 3})
        result = await task_tool_module.task_tool.coroutine(runtime, "desc", "prompt", "general-purpose", "call-1")

        message = result.update["messages"][0]
        assert message.tool_call_id == "call-1"
        assert "subagent delegation depth exceeded: max 3" in message.content
        assert executor_factory._captured == {}  # executor never constructed

    @pytest.mark.anyio
    async def test_depth_propagated(self, monkeypatch):
        config = SubagentConfig(
            name="general-purpose",
            description="d",
            system_prompt="p",
            model="test-model",
            allow_recursion=True,
        )
        captured_tools: dict = {}
        _patch_common(monkeypatch, config=config, captured_tools=captured_tools)
        captured_executor: dict = {}
        monkeypatch.setattr(task_tool_module, "SubagentExecutor", _FakeExecutor(captured_executor))

        runtime = _runtime({"app_config": _app_config(max_delegation_depth=3), "delegation_depth": 1})
        await task_tool_module.task_tool.coroutine(runtime, "desc", "prompt", "general-purpose", "call-1")

        assert captured_executor["delegation_depth"] == 2
