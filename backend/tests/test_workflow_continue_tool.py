"""Tests for the ``continue_node`` conversation-side tool (W2B).

``continue_node`` lets the lead agent continue a previously completed /
interrupted workflow run's target ``ai:llm_agent`` node *in the same session*:
a fresh workflow run is admitted and the AI node's executor is routed through
the W1A continue mode against the *original* run's session checkpoint
(``f"{origin_thread_id}:wfai:{node_id}"``) instead of the new run's thread.

Covers:
- tool shell: forwards ``run_id`` / ``node_id`` / ``prompt`` and inherited
  ``definition_id`` / ``params`` to ``dispatch.continue_workflow_node``.
- dispatch: creates a new run with ``continue_nodes`` + ``origin_thread_id``
  forwarded to ``run_workflow``; definition/params inherited from the original
  run record's ``kwargs`` unless supplied explicitly.
- run not found → structured ``run_not_found`` error (tool) /
  ``WorkflowRunNotFoundError`` (dispatch).
- missing runtime bundle → ``WorkflowDispatchUnavailableError`` / fail-closed
  error Command.
- executor: ``runtime.context["__ai_continue"]`` selects continue mode when
  ``continue_prompt`` is absent; ``ai_origin_thread_id`` overrides the
  checkpoint-thread prefix.
- worker: ``run_workflow`` injects ``__ai_continue`` / ``ai_origin_thread_id``
  into ``config["context"]`` only when provided.
"""

from __future__ import annotations

import asyncio
import json
from types import SimpleNamespace
from typing import Any
from unittest.mock import AsyncMock, MagicMock, patch

import pytest
from langgraph.checkpoint.memory import InMemorySaver

from deerflow.runtime.events.store.memory import MemoryRunEventStore
from deerflow.runtime.runs.manager import RunManager
from deerflow.runtime.runs.schemas import RunStatus
from deerflow.runtime.runs.worker import RunContext
from deerflow.tools.builtins import continue_node
from deerflow.workflow.compiler import WorkflowRuntime, clear_compile_cache
from deerflow.workflow.dispatch import (
    WORKFLOW_RUNTIME_CONTEXT_KEY,
    WorkflowDispatchUnavailableError,
    WorkflowRunNotFoundError,
    continue_workflow_node,
    start_workflow_run,
)
from deerflow.workflow.executors import exec_llm_agent
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


def _make_def(nodes: list[Node] | None = None, edges: list[Edge] | None = None, **kwargs: Any) -> WorkflowDefinition:
    kwargs.setdefault("id", "test-wf")
    kwargs.setdefault("name", "Test Workflow")
    return WorkflowDefinition(nodes=nodes or [], edges=edges or [], **kwargs)


def _start_node(id_: str = "start") -> Node:
    return Node(id=id_, type=NodeType.FLOW_START, inputs=[], outputs=[Port(name="input", type=PortType.DATA)])


def _end_node(id_: str = "end") -> Node:
    return Node(id=id_, type=NodeType.FLOW_END, inputs=[Port(name="in", type=PortType.DATA)], outputs=[])


def _ai_definition(*, wf_id: str = "wf-ai", node_id: str = "ai_step") -> WorkflowDefinition:
    ai = Node(
        id=node_id,
        type=NodeType.AI_LLM_AGENT,
        params={"instruction": "首轮 {{in}}"},
        inputs=[Port(name="in", type=PortType.DATA)],
        outputs=[Port(name="out", type=PortType.DATA)],
    )
    assign = Node(
        id="assign",
        type=NodeType.DATA_ASSIGN,
        params={"value": "x"},
        inputs=[Port(name="in", type=PortType.DATA)],
        outputs=[Port(name="out", type=PortType.DATA)],
    )
    return _make_def(
        [_start_node(), assign, ai, _end_node()],
        [
            Edge(source="start", source_port="input", target="assign", target_port="in"),
            Edge(source="assign", source_port="out", target=node_id, target_port="in"),
            Edge(source=node_id, source_port="out", target="end", target_port="in"),
        ],
        id=wf_id,
    )


def _definition_row(def_: WorkflowDefinition) -> dict:
    return {
        "id": def_.id,
        "user_id": "user-1",
        "name": def_.name,
        "schema_version": 1,
        "definition": def_.model_dump(mode="json"),
        "metadata": {},
        "version": def_.version,
    }


def _tool_runtime(user_id: str = "user-1") -> SimpleNamespace:
    return SimpleNamespace(
        state={},
        context={"thread_id": "thread-1", "user_id": user_id},
        config={"configurable": {"thread_id": "thread-1", "user_id": user_id}},
        tool_call_id="tool-1",
    )


def _make_mock_bridge() -> MagicMock:
    bridge = MagicMock()
    bridge.publish = AsyncMock()
    bridge.publish_end = AsyncMock()
    bridge.cleanup = AsyncMock()
    bridge.subscribe = AsyncMock(return_value=iter([]))
    bridge.supports_cross_process = False
    return bridge


def _make_dispatch_runtime(bundle: dict) -> SimpleNamespace:
    return SimpleNamespace(
        state={},
        context={WORKFLOW_RUNTIME_CONTEXT_KEY: bundle},
        config={"configurable": {"thread_id": "thread-1"}},
        tool_call_id="call-1",
    )


def _command_payload(command) -> dict:
    return json.loads(command.update["messages"][0].content)


def _completed_result(text: str = "ok") -> Any:
    return SimpleNamespace(status=SimpleNamespace(value="completed"), result=text, error=None)


# ═══════════════════════════════════════════════════════════════════════════════
# 1. Tool shell
# ═══════════════════════════════════════════════════════════════════════════════


class TestContinueNodeTool:
    def test_continue_node_forwards_args_and_returns_summary(self) -> None:
        import deerflow.workflow.dispatch as dispatch_mod

        with patch.object(
            dispatch_mod,
            "continue_workflow_node",
            new=AsyncMock(
                return_value={
                    "run_id": "run-new",
                    "thread_id": "wf-run-new",
                    "status": "pending",
                    "continue_node_id": "ai_step",
                    "origin_run_id": "run-orig",
                }
            ),
        ) as mock_continue:
            command = continue_node.func(run_id="run-orig", node_id="ai_step", prompt="继续干活", runtime=_tool_runtime())

        payload = _command_payload(command)
        assert payload["ok"] is True
        assert payload["run_id"] == "run-new"
        assert payload["status"] == "pending"
        assert payload["continue_node_id"] == "ai_step"
        assert payload["origin_run_id"] == "run-orig"

        mock_continue.assert_awaited_once()
        args, kwargs = mock_continue.await_args
        assert args[0] == "run-orig"
        assert args[1] == "ai_step"
        assert args[2] == "继续干活"
        assert kwargs["runtime"] is not None

    def test_continue_node_explicit_definition_and_params(self) -> None:
        import deerflow.workflow.dispatch as dispatch_mod

        with patch.object(
            dispatch_mod,
            "continue_workflow_node",
            new=AsyncMock(return_value={"run_id": "run-new", "thread_id": "t", "status": "pending", "continue_node_id": "ai_step", "origin_run_id": "run-orig"}),
        ) as mock_continue:
            continue_node.func(
                run_id="run-orig",
                node_id="ai_step",
                prompt="p",
                runtime=_tool_runtime(),
                definition_id="wf-explicit",
                params={"input": "y"},
            )

        kwargs = mock_continue.await_args.kwargs
        assert kwargs["definition_id"] == "wf-explicit"
        assert kwargs["params"] == {"input": "y"}

    def test_continue_node_missing_run_fails_closed(self) -> None:
        import deerflow.workflow.dispatch as dispatch_mod

        with patch.object(
            dispatch_mod,
            "continue_workflow_node",
            new=AsyncMock(side_effect=WorkflowRunNotFoundError("run-nope")),
        ):
            command = continue_node.func(run_id="run-nope", node_id="ai_step", prompt="p", runtime=_tool_runtime())

        message = command.update["messages"][0]
        assert message.status == "error"
        payload = _command_payload(command)
        assert payload["ok"] is False
        assert payload["errors"][0]["code"] == "run_not_found"

    def test_continue_node_unavailable_bundle_fails_closed(self) -> None:
        # No WORKFLOW_RUNTIME_CONTEXT_KEY in runtime.context → dispatch raises
        # WorkflowDispatchUnavailableError → tool returns an error Command.
        import deerflow.workflow.dispatch as dispatch_mod

        with patch.object(dispatch_mod, "continue_workflow_node", new=AsyncMock(side_effect=WorkflowDispatchUnavailableError("no bundle"))):
            command = continue_node.func(run_id="run-orig", node_id="ai_step", prompt="p", runtime=_tool_runtime())

        message = command.update["messages"][0]
        assert message.status == "error"
        payload = _command_payload(command)
        assert payload["ok"] is False
        assert payload["errors"][0]["code"] == "workflow_operation_failed"

    def test_continue_node_exception_fails_closed(self) -> None:
        import deerflow.workflow.dispatch as dispatch_mod

        with patch.object(dispatch_mod, "continue_workflow_node", new=AsyncMock(side_effect=RuntimeError("boom"))):
            command = continue_node.func(run_id="run-orig", node_id="ai_step", prompt="p", runtime=_tool_runtime())

        message = command.update["messages"][0]
        assert message.status == "error"
        payload = _command_payload(command)
        assert payload["ok"] is False
        assert "boom" in payload["errors"][0]["message"]


# ═══════════════════════════════════════════════════════════════════════════════
# 2. dispatch.continue_workflow_node
# ═══════════════════════════════════════════════════════════════════════════════


class TestDispatchContinueWorkflowNode:
    @pytest.mark.asyncio
    async def test_creates_continue_run_with_origin_thread(self) -> None:
        run_mgr = RunManager()
        event_store = MemoryRunEventStore()
        run_ctx = RunContext(checkpointer=InMemorySaver(), event_store=event_store)
        runtime = _make_dispatch_runtime({"run_manager": run_mgr, "stream_bridge": _make_mock_bridge(), "run_ctx": run_ctx})
        definition = _ai_definition()
        orig = await run_mgr.create_or_reject(
            "wf-orig",
            definition.id,
            kwargs={"params": {"input": "hello"}, "definition_id": definition.id},
        )
        await run_mgr.set_status(orig.run_id, RunStatus.success)

        with (
            patch(
                "deerflow.persistence.workflow_definitions.service.get_workflow_definition",
                AsyncMock(return_value=_definition_row(definition)),
            ),
            patch("deerflow.workflow.worker.run_workflow", AsyncMock()) as mock_run_workflow,
        ):
            result = await continue_workflow_node(orig.run_id, "ai_step", "继续", runtime=runtime)

        assert result["status"] == "pending"
        assert result["continue_node_id"] == "ai_step"
        assert result["origin_run_id"] == orig.run_id
        assert result["run_id"] != orig.run_id
        # A fresh workflow thread, distinct from the original run's thread.
        assert result["thread_id"].startswith("wf-run-")

        # Let the fire-and-forget worker run against the patched run_workflow.
        await asyncio.sleep(0.05)
        mock_run_workflow.assert_awaited_once()
        call_kwargs = mock_run_workflow.await_args.kwargs
        assert call_kwargs["continue_nodes"] == {"ai_step": "继续"}
        assert call_kwargs["origin_thread_id"] == "wf-orig"
        assert call_kwargs["definition"].id == definition.id
        assert call_kwargs["params"] == {"input": "hello"}  # inherited from the original run

        # The new record remembers the continue coordinates for a chained continue.
        new_record = await run_mgr.get(result["run_id"])
        assert new_record is not None
        assert new_record.kwargs["continue_nodes"] == {"ai_step": "继续"}
        assert new_record.kwargs["origin_thread_id"] == "wf-orig"
        assert new_record.metadata["continue_from_run_id"] == orig.run_id

    @pytest.mark.asyncio
    async def test_explicit_definition_and_params_override_inheritance(self) -> None:
        run_mgr = RunManager()
        run_ctx = RunContext(checkpointer=InMemorySaver())
        runtime = _make_dispatch_runtime({"run_manager": run_mgr, "stream_bridge": _make_mock_bridge(), "run_ctx": run_ctx})
        definition = _ai_definition()
        orig = await run_mgr.create_or_reject(
            "wf-orig-2",
            definition.id,
            kwargs={"params": {"input": "hello"}, "definition_id": definition.id},
        )
        await run_mgr.set_status(orig.run_id, RunStatus.success)

        other = _ai_definition(wf_id="wf-other", node_id="ai_step")
        with (
            patch(
                "deerflow.persistence.workflow_definitions.service.get_workflow_definition",
                AsyncMock(side_effect=lambda user_id, definition_id: _definition_row(other) if definition_id == "wf-other" else None),
            ),
            patch("deerflow.workflow.worker.run_workflow", AsyncMock()) as mock_run_workflow,
        ):
            await continue_workflow_node(
                orig.run_id,
                "ai_step",
                "继续",
                runtime=runtime,
                definition_id="wf-other",
                params={"input": "fresh"},
            )

        await asyncio.sleep(0.05)
        call_kwargs = mock_run_workflow.await_args.kwargs
        assert call_kwargs["definition"].id == "wf-other"
        assert call_kwargs["params"] == {"input": "fresh"}
        assert call_kwargs["origin_thread_id"] == "wf-orig-2"

    @pytest.mark.asyncio
    async def test_missing_run_raises_not_found(self) -> None:
        run_mgr = RunManager()
        run_ctx = RunContext(checkpointer=InMemorySaver())
        runtime = _make_dispatch_runtime({"run_manager": run_mgr, "run_ctx": run_ctx})

        with pytest.raises(WorkflowRunNotFoundError, match="run-nope"):
            await continue_workflow_node("run-nope", "ai_step", "p", runtime=runtime)

    @pytest.mark.asyncio
    async def test_missing_runtime_bundle_raises(self) -> None:
        runtime = _make_dispatch_runtime({})
        with pytest.raises(WorkflowDispatchUnavailableError):
            await continue_workflow_node("run-orig", "ai_step", "p", runtime=runtime)

    @pytest.mark.asyncio
    async def test_definition_not_found_raises_value_error(self) -> None:
        run_mgr = RunManager()
        run_ctx = RunContext(checkpointer=InMemorySaver())
        runtime = _make_dispatch_runtime({"run_manager": run_mgr, "run_ctx": run_ctx})
        orig = await run_mgr.create_or_reject("wf-orig-3", "wf-missing", kwargs={"params": {}, "definition_id": "wf-missing"})
        await run_mgr.set_status(orig.run_id, RunStatus.success)

        with patch("deerflow.persistence.workflow_definitions.service.get_workflow_definition", AsyncMock(return_value=None)):
            with pytest.raises(ValueError, match="wf-missing"):
                await continue_workflow_node(orig.run_id, "ai_step", "p", runtime=runtime)

    @pytest.mark.asyncio
    async def test_run_without_definition_reference_requires_explicit(self) -> None:
        run_mgr = RunManager()
        run_ctx = RunContext(checkpointer=InMemorySaver())
        runtime = _make_dispatch_runtime({"run_manager": run_mgr, "run_ctx": run_ctx})
        # assistant_id / kwargs carry no definition reference.
        orig = await run_mgr.create("wf-bare", assistant_id=None)
        await run_mgr.set_status(orig.run_id, RunStatus.success)

        with pytest.raises(ValueError, match="definition_id"):
            await continue_workflow_node(orig.run_id, "ai_step", "p", runtime=runtime)


# ═══════════════════════════════════════════════════════════════════════════════
# 3. start_workflow_run forwards the continue context
# ═══════════════════════════════════════════════════════════════════════════════


class TestStartWorkflowRunForwardsContinue:
    @pytest.mark.asyncio
    async def test_forwards_continue_nodes_and_origin_thread(self) -> None:
        run_mgr = RunManager()
        run_ctx = RunContext(checkpointer=InMemorySaver())
        runtime = _make_dispatch_runtime({"run_manager": run_mgr, "stream_bridge": _make_mock_bridge(), "run_ctx": run_ctx})
        definition = _ai_definition()

        with patch("deerflow.workflow.worker.run_workflow", AsyncMock()) as mock_run_workflow:
            result = await start_workflow_run(
                definition.id,
                definition,
                {"input": "x"},
                runtime=runtime,
                continue_nodes={"ai_step": "继续"},
                origin_thread_id="wf-orig",
                metadata={"continue_from_run_id": "run-orig"},
            )

        assert result["status"] == "pending"
        record = await run_mgr.get(result["run_id"])
        assert record is not None
        assert record.kwargs["continue_nodes"] == {"ai_step": "继续"}
        assert record.kwargs["origin_thread_id"] == "wf-orig"

        await asyncio.sleep(0.05)
        call_kwargs = mock_run_workflow.await_args.kwargs
        assert call_kwargs["continue_nodes"] == {"ai_step": "继续"}
        assert call_kwargs["origin_thread_id"] == "wf-orig"

    @pytest.mark.asyncio
    async def test_no_continue_context_stays_absent(self) -> None:
        run_mgr = RunManager()
        run_ctx = RunContext(checkpointer=InMemorySaver())
        runtime = _make_dispatch_runtime({"run_manager": run_mgr, "stream_bridge": _make_mock_bridge(), "run_ctx": run_ctx})
        definition = _ai_definition()

        with patch("deerflow.workflow.worker.run_workflow", AsyncMock()) as mock_run_workflow:
            result = await start_workflow_run(definition.id, definition, {"input": "x"}, runtime=runtime)

        record = await run_mgr.get(result["run_id"])
        assert record is not None
        assert "continue_nodes" not in record.kwargs
        assert "origin_thread_id" not in record.kwargs
        await asyncio.sleep(0.05)
        call_kwargs = mock_run_workflow.await_args.kwargs
        assert call_kwargs["continue_nodes"] is None
        assert call_kwargs["origin_thread_id"] is None


# ═══════════════════════════════════════════════════════════════════════════════
# 4. executor: __ai_continue + ai_origin_thread_id
# ═══════════════════════════════════════════════════════════════════════════════


@pytest.fixture(autouse=True)
def _isolate_cache() -> Any:
    clear_compile_cache()
    yield


@pytest.fixture
def fake_executor(monkeypatch: pytest.MonkeyPatch) -> list[dict[str, Any]]:
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


def _ai_runtime(*, thread_id: str = "t1", origin_thread_id: str | None = None, continue_nodes: dict[str, str] | None = None) -> WorkflowRuntime:
    context: dict[str, Any] = {"thread_id": thread_id, "user_id": "u1", "checkpointer": InMemorySaver()}
    if origin_thread_id is not None:
        context["ai_origin_thread_id"] = origin_thread_id
    if continue_nodes is not None:
        context["__ai_continue"] = continue_nodes
    return WorkflowRuntime(context=context)


class TestExecutorContinueContext:
    @pytest.mark.asyncio
    async def test_continue_nodes_select_continue_mode_without_input(self, fake_executor: list[dict[str, Any]]) -> None:
        """A per-node prompt in ``__ai_continue`` routes the node through continue
        mode even when ``inputs["continue_prompt"]`` is absent."""
        rt = _ai_runtime(origin_thread_id="orig-thread", continue_nodes={"ai_step": "请继续处理"})

        result = await exec_llm_agent(rt, {"instruction": "首轮", "node_id": "ai_step"}, {"in": "x"})

        assert result == {"out": "ok"}
        record = fake_executor[0]
        assert record["kwargs"]["config"].checkpointer is True
        # Cross-run continue: the checkpoint thread is derived from the ORIGINAL
        # run's thread, not the new run's.
        assert record["kwargs"]["checkpoint_thread_id"] == "orig-thread:wfai:ai_step"
        assert record["task"] == "请继续处理"

    @pytest.mark.asyncio
    async def test_origin_thread_id_overrides_thread_prefix(self, fake_executor: list[dict[str, Any]]) -> None:
        rt = _ai_runtime(thread_id="new-thread", origin_thread_id="orig-thread", continue_nodes={"ai_step": "继续"})

        await exec_llm_agent(rt, {"instruction": "首轮", "node_id": "ai_step"}, {"in": "x"})

        assert fake_executor[0]["kwargs"]["checkpoint_thread_id"] == "orig-thread:wfai:ai_step"

    @pytest.mark.asyncio
    async def test_without_origin_thread_uses_current_thread(self, fake_executor: list[dict[str, Any]]) -> None:
        """No ``ai_origin_thread_id`` → the W1A behavior (current thread prefix)."""
        rt = _ai_runtime(thread_id="t1", continue_nodes={"ai_step": "继续"})

        await exec_llm_agent(rt, {"instruction": "首轮", "node_id": "ai_step"}, {"in": "x"})

        assert fake_executor[0]["kwargs"]["checkpoint_thread_id"] == "t1:wfai:ai_step"

    @pytest.mark.asyncio
    async def test_other_nodes_prompt_does_not_apply(self, fake_executor: list[dict[str, Any]]) -> None:
        """``__ai_continue`` targeting a different node_id leaves this node in
        template (one-shot) mode."""
        rt = _ai_runtime(thread_id="t1", continue_nodes={"other_node": "继续"})

        await exec_llm_agent(rt, {"instruction": "首轮", "node_id": "ai_step"}, {"in": "x"})

        record = fake_executor[0]
        assert record["kwargs"]["config"].checkpointer is False
        assert "checkpoint_thread_id" not in record["kwargs"]

    @pytest.mark.asyncio
    async def test_explicit_continue_prompt_wins_over_context(self, fake_executor: list[dict[str, Any]]) -> None:
        """A non-empty ``continue_prompt`` input still wins over ``__ai_continue``."""
        rt = _ai_runtime(thread_id="t1", origin_thread_id="orig-thread", continue_nodes={"ai_step": "context prompt"})

        await exec_llm_agent(rt, {"instruction": "首轮", "node_id": "ai_step"}, {"in": "x", "continue_prompt": "input prompt"})

        assert fake_executor[0]["task"] == "input prompt"


# ═══════════════════════════════════════════════════════════════════════════════
# 5. worker: context injection
# ═══════════════════════════════════════════════════════════════════════════════


class _ConfigCaptureGraph:
    def __init__(self) -> None:
        self.captured_config: dict[str, Any] | None = None

    async def astream(self, graph_input: dict[str, Any], config: dict[str, Any] | None = None, **kwargs: Any) -> Any:
        self.captured_config = config
        if False:
            yield

    async def aget_state(self, config: dict[str, Any]) -> Any:
        return SimpleNamespace(next=[], values={})


class TestWorkerContextInjection:
    async def _run(self, *, continue_nodes: dict[str, str] | None, origin_thread_id: str | None) -> dict[str, Any]:
        from deerflow.config.app_config import AppConfig
        from deerflow.config.sandbox_config import SandboxConfig
        from deerflow.workflow.worker import run_workflow

        definition = _ai_definition()
        manager = RunManager()
        record = await manager.create("thread-ctx", definition.id)
        bridge = MagicMock()
        bridge.publish = AsyncMock()
        bridge.publish_end = AsyncMock()
        bridge.cleanup = AsyncMock()
        fake_graph = _ConfigCaptureGraph()
        ctx = RunContext(checkpointer=None, event_store=None, app_config=AppConfig(sandbox=SandboxConfig(use="test")))

        with patch("deerflow.workflow.worker.compile_definition", return_value=fake_graph):
            await run_workflow(
                bridge,
                manager,
                record,
                ctx=ctx,
                definition=definition,
                params={},
                continue_nodes=continue_nodes,
                origin_thread_id=origin_thread_id,
            )
        assert fake_graph.captured_config is not None
        return fake_graph.captured_config["context"]

    @pytest.mark.asyncio
    async def test_injects_continue_context_when_provided(self) -> None:
        context = await self._run(continue_nodes={"ai_step": "继续"}, origin_thread_id="wf-orig")
        assert context["__ai_continue"] == {"ai_step": "继续"}
        assert context["ai_origin_thread_id"] == "wf-orig"

    @pytest.mark.asyncio
    async def test_omits_continue_context_when_none(self) -> None:
        context = await self._run(continue_nodes=None, origin_thread_id=None)
        assert "__ai_continue" not in context
        assert "ai_origin_thread_id" not in context
