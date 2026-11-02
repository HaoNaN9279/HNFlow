"""T18-5 integration tests — full T18 chain (real sqlite + real RunManager + real event store).

Exercises the conversation-side workflow dispatch + worker chain end to end:

- real SQLite engine (workflow-definition rows, human-task rows, run events)
- real :class:`RunManager` (no store) and real :class:`MemoryStreamBridge`
- real compiled workflow graph (``build_default_registry`` executors) — no LLM
  or sandbox call happens; the ``tool:bash`` executor's sandbox acquisition is
  patched to raise ``WorkflowExecutionError`` where a failure scenario needs one
- every scenario runs inside one ``asyncio.run`` so the ``RunManager`` lock and
  the SQLAlchemy engine never cross event loops

Scenarios:
1. 对话发起运行收到进度: dispatch → poll → success + node events + summary
2. 人为节点失败 → agent 可分析: bash (sandbox mocked off) → error + failed node/error
3. 危险节点启动被拒: pending-review gate blocks before admission (no run record)
4. list → submit → resume 生效: real human-task repo + real definition row +
   resume dispatch reuses the original run (worker mocked)
5. skip 路径: repo ``skipped`` + resume ``{"__skip": True}``
6. 双入口一致: dialogue dispatch writes the same shared storage (RunManager +
   sqlite event store) the canvas-side read path uses
7. 无 ``__workflow_runtime`` → ``WorkflowDispatchUnavailableError`` (fail-closed)
"""

from __future__ import annotations

import asyncio
from typing import Any
from unittest.mock import AsyncMock, patch

import pytest
from langchain.tools import ToolRuntime
from langgraph.checkpoint.memory import InMemorySaver
from langgraph.types import Command

from deerflow.config.database_config import DatabaseConfig
from deerflow.persistence.engine import close_engine, get_session_factory, init_engine_from_config
from deerflow.persistence.human_tasks import HumanTaskRepository
from deerflow.persistence.workflow_definitions import WorkflowDefinitionRepository
from deerflow.runtime.events.store.db import DbRunEventStore
from deerflow.runtime.runs.manager import RunManager
from deerflow.runtime.runs.schemas import RunStatus
from deerflow.runtime.runs.worker import RunContext
from deerflow.runtime.stream_bridge.memory import MemoryStreamBridge
from deerflow.tools.builtins import workflow_runtime_tools as wrt
from deerflow.workflow.compiler import clear_compile_cache
from deerflow.workflow.dispatch import (
    WORKFLOW_RUNTIME_CONTEXT_KEY,
    WorkflowDispatchUnavailableError,
    get_workflow_run,
    list_run_events,
    resume_workflow_run,
    start_workflow_run,
)
from deerflow.workflow.executors import WorkflowExecutionError
from deerflow.workflow.schema import Edge, Node, NodeType, Port, PortType, WorkflowDefinition

USER_ID = "user-1"
_TERMINAL_STATUSES = frozenset({"success", "error", "interrupted"})
_OUTPUT_SPEC = {"ports": [{"name": "answer", "type": "data", "required": True, "description": "结论"}]}


@pytest.fixture(autouse=True)
def _isolate_compile_cache() -> Any:
    clear_compile_cache()
    yield


# ── Helpers ─────────────────────────────────────────────────────────────────


def _linear_definition(
    node_id: str = "node_a",
    node_type: NodeType = NodeType.DATA_ASSIGN,
    params: dict[str, Any] | None = None,
    def_id: str = "wf-integration",
) -> WorkflowDefinition:
    """Build a 3-node linear definition: start → node → end."""
    return WorkflowDefinition(
        id=def_id,
        name="Integration WF",
        version="0.1.0",
        nodes=[
            Node(id="start", type=NodeType.FLOW_START, outputs=[Port(name="input", type=PortType.DATA)]),
            Node(
                id=node_id,
                type=node_type,
                inputs=[Port(name="in", type=PortType.DATA)],
                outputs=[Port(name="out", type=PortType.DATA)],
                params=params or {},
            ),
            Node(id="end", type=NodeType.FLOW_END, inputs=[Port(name="in", type=PortType.DATA)]),
        ],
        edges=[
            Edge(source="start", source_port="input", target=node_id, target_port="in"),
            Edge(source=node_id, source_port="out", target="end", target_port="in"),
        ],
    )


def _make_runtime(bundle: dict[str, Any]) -> ToolRuntime:
    return ToolRuntime(
        state={},
        context={"user_id": USER_ID, WORKFLOW_RUNTIME_CONTEXT_KEY: bundle},
        config={"configurable": {"thread_id": "thread-1", "user_id": USER_ID}},
        stream_writer=lambda _: None,
        tool_call_id="call-1",
        store=None,
        tools=[],
    )


def _make_ctx(run_mgr: RunManager, bridge: MemoryStreamBridge, event_store: Any) -> dict[str, Any]:
    return {
        "run_manager": run_mgr,
        "stream_bridge": bridge,
        "run_ctx": RunContext(checkpointer=InMemorySaver(), event_store=event_store),
    }


async def _init_sqlite(tmp_path) -> Any:
    await init_engine_from_config(DatabaseConfig(backend="sqlite", sqlite_dir=str(tmp_path)))
    session_factory = get_session_factory()
    assert session_factory is not None
    return session_factory


async def _close_sqlite() -> None:
    await close_engine()
    await asyncio.sleep(0.05)


async def _persist_definition(session_factory, definition: WorkflowDefinition) -> None:
    repo = WorkflowDefinitionRepository(session_factory)
    await repo.create(
        definition_id=definition.id,
        user_id=USER_ID,
        name=definition.name,
        schema_version=1,
        definition=definition.model_dump(mode="json"),
    )


async def _poll_until_terminal(runtime: ToolRuntime, run_id: str, timeout: float = 10.0) -> str:
    loop = asyncio.get_running_loop()
    deadline = loop.time() + timeout
    while True:
        record = await get_workflow_run(run_id, runtime=runtime)
        status = str(record.get("status") or "unknown") if record is not None else "unknown"
        if status in _TERMINAL_STATUSES:
            return status
        if loop.time() >= deadline:
            raise AssertionError(f"workflow run {run_id} not terminal within {timeout}s (last status: {status})")
        await asyncio.sleep(0.02)


async def _run_to_terminal(started: dict[str, Any], runtime: ToolRuntime) -> tuple[str, Any]:
    run_mgr = runtime.context[WORKFLOW_RUNTIME_CONTEXT_KEY]["run_manager"]
    run_id = started["run_id"]
    status = await _poll_until_terminal(runtime, run_id)
    record = await run_mgr.get(run_id)
    if record is not None and record.task is not None:
        try:
            await record.task
        except Exception:  # noqa: BLE001 - the worker already recorded the outcome
            pass
    return status, record


# ── Scenario 1: dialogue dispatch → progress ────────────────────────────────


def test_scenario1_dispatch_run_receives_progress(tmp_path) -> None:
    async def _scenario() -> None:
        try:
            sf = await _init_sqlite(tmp_path)
            definition = _linear_definition()
            await _persist_definition(sf, definition)
            run_mgr = RunManager()
            bridge = MemoryStreamBridge()
            event_store = DbRunEventStore(sf)
            runtime = _make_runtime(_make_ctx(run_mgr, bridge, event_store))

            started = await start_workflow_run(definition.id, definition, {"input": "hello"}, runtime=runtime)
            status, record = await _run_to_terminal(started, runtime)
            assert status == "success"
            assert record.status.value == "success"

            progress = await list_run_events(record.run_id, runtime=runtime)
            node_events = [p for p in progress if p["node_id"] == "node_a"]
            assert [p["status"] for p in node_events] == ["started", "completed"]
            # The compiler writes state under ``wf:<node_id>:<port>`` keys.
            assert node_events[1]["output"] == {"wf:node_a:out": "hello"}

            summary = await wrt._rt_aggregate_summary(wrt._rt_deps(), record.run_id, runtime, "success", definition)
            assert summary["completed_nodes"] == 1
            assert summary["total_nodes"] == 1
            assert summary["current_node"] is None
            assert summary["failed_node"] is None

            await bridge.cleanup(record.run_id, delay=0)
        finally:
            await _close_sqlite()

    asyncio.run(_scenario())


# ── Scenario 2: node failure → agent can analyse ────────────────────────────


def test_scenario2_bash_failure(tmp_path) -> None:
    """Real ``tool:bash`` executor with the sandbox acquisition mocked off."""

    async def _scenario() -> None:
        try:
            sf = await _init_sqlite(tmp_path)
            definition = _linear_definition("bash_step", NodeType.TOOL_BASH, {"command": "echo hi", "crash_confirm": True}, "wf-bash-fail")
            await _persist_definition(sf, definition)
            run_mgr = RunManager()
            bridge = MemoryStreamBridge()
            event_store = DbRunEventStore(sf)
            runtime = _make_runtime(_make_ctx(run_mgr, bridge, event_store))

            with patch("deerflow.sandbox.tools.ensure_sandbox_initialized", side_effect=WorkflowExecutionError("sandbox unavailable")):
                started = await start_workflow_run(definition.id, definition, {"input": "x"}, runtime=runtime)
                status, record = await _run_to_terminal(started, runtime)

            assert status == "error"
            assert record.error is not None

            progress = await list_run_events(record.run_id, runtime=runtime)
            failed = [p for p in progress if p["status"] == "failed"]
            assert len(failed) == 1
            assert failed[0]["node_id"] == "bash_step"
            assert "sandbox unavailable" in failed[0]["error"]

            summary = await wrt._rt_aggregate_summary(wrt._rt_deps(), record.run_id, runtime, "error", definition)
            assert summary["failed_node"] == "bash_step"
            assert "sandbox unavailable" in summary["failed_error"]

            await bridge.cleanup(record.run_id, delay=0)
        finally:
            await _close_sqlite()

    asyncio.run(_scenario())


# ── Scenario 3: dangerous node rejected before admission ────────────────────


def test_scenario3_dangerous_node_rejected_before_start(tmp_path) -> None:
    async def _scenario() -> None:
        try:
            sf = await _init_sqlite(tmp_path)
            definition = _linear_definition("bash_step", NodeType.TOOL_BASH, {"command": "echo hi"}, "wf-danger")
            await _persist_definition(sf, definition)
            run_mgr = RunManager()
            bridge = MemoryStreamBridge()
            event_store = DbRunEventStore(sf)
            runtime = _make_runtime(_make_ctx(run_mgr, bridge, event_store))

            mock_start = AsyncMock()
            # The real row lives in sqlite; only the config-driven service wrapper
            # is replaced (it would otherwise require a repo-root config.yaml).
            real_row = await WorkflowDefinitionRepository(sf).get(definition.id, user_id=USER_ID)
            assert real_row is not None
            with (
                patch("deerflow.persistence.workflow_definitions.service.get_workflow_definition", new=AsyncMock(return_value=real_row)),
                patch("deerflow.workflow.dispatch.start_workflow_run", new=mock_start),
            ):
                result = await wrt._run_workflow_async(
                    definition_id=definition.id,
                    params={},
                    runtime=runtime,
                    wait=False,
                    wait_timeout=None,
                )

            assert result["ok"] is False
            assert result["errors"][0]["code"] == "pending_review"
            assert result["errors"][0]["nodes"] == ["bash_step"]
            mock_start.assert_not_awaited()
            # No run was admitted into the run manager.
            assert run_mgr._runs == {}  # noqa: SLF001
        finally:
            await _close_sqlite()

    asyncio.run(_scenario())


# ── Scenarios 4/5: human task list → submit / skip → resume ────────────────


def _human_task_scenario(tmp_path, *, skip: bool) -> None:
    async def _scenario() -> None:
        try:
            sf = await _init_sqlite(tmp_path)
            definition = _linear_definition(def_id="wf-resume")
            await _persist_definition(sf, definition)
            repo = HumanTaskRepository(sf)
            run_mgr = RunManager()
            bridge = MemoryStreamBridge()
            event_store = DbRunEventStore(sf)
            bundle = {**_make_ctx(run_mgr, bridge, event_store), "human_task_repo": repo}
            runtime = _make_runtime(bundle)

            orig = await run_mgr.create_or_reject("wf-orig", definition.id, kwargs={"params": {}, "definition_id": definition.id}, user_id=USER_ID)
            await run_mgr.set_status(orig.run_id, RunStatus.interrupted)

            task = await repo.create(
                user_id=USER_ID,
                workflow_run_id=orig.run_id,
                node_id="ht-node",
                description="请确认",
                output_spec=_OUTPUT_SPEC,
                validation_rules={},
                checkpoint_ref={"thread_id": "wf-orig", "checkpoint_id": "ck-1"},
            )
            listed = await repo.list_by_user(USER_ID)
            assert any(t["id"] == task["id"] for t in listed)

            if skip:
                transitioned = await repo.skip(task["id"], user_id=USER_ID)
                expected_resume = {"__skip": True}
            else:
                transitioned = await repo.submit(task["id"], user_id=USER_ID, values={"answer": "yes"}, to_status="submitted")
                expected_resume = {"answer": "yes"}
            assert transitioned is not None
            assert transitioned["status"] == ("skipped" if skip else "submitted")

            # The real definition row is what the resume path resolves.
            real_row = await WorkflowDefinitionRepository(sf).get(definition.id, user_id=USER_ID)
            assert real_row is not None
            with (
                patch("deerflow.persistence.workflow_definitions.service.get_workflow_definition", new=AsyncMock(return_value=real_row)),
                patch("deerflow.workflow.worker.run_workflow", AsyncMock()) as mock_worker,
            ):
                await resume_workflow_run(transitioned, runtime=runtime)
                await asyncio.sleep(0.05)

            mock_worker.assert_awaited_once()
            worker_kwargs = mock_worker.await_args.kwargs
            assert worker_kwargs["origin_run_id"] == orig.run_id
            assert worker_kwargs["resume"] == Command(resume=expected_resume)
            assert worker_kwargs["definition"].id == definition.id
            assert worker_kwargs["human_task_repo"] is repo

            # A new resume run was admitted on the original thread.
            runs = await run_mgr.list_by_thread("wf-orig")
            assert len(runs) == 2
            resumed = next(r for r in runs if r.run_id != orig.run_id)
            assert resumed.kwargs["definition_id"] == definition.id
        finally:
            await _close_sqlite()

    asyncio.run(_scenario())


def test_scenario4_submit_resumes_with_values(tmp_path) -> None:
    _human_task_scenario(tmp_path, skip=False)


def test_scenario5_skip_resumes_with_sentinel(tmp_path) -> None:
    _human_task_scenario(tmp_path, skip=True)


# ── Scenario 6: dialogue and canvas read paths share storage ────────────────


def test_scenario6_dialogue_and_canvas_share_storage(tmp_path) -> None:
    async def _scenario() -> None:
        try:
            sf = await _init_sqlite(tmp_path)
            definition = _linear_definition()
            await _persist_definition(sf, definition)
            run_mgr = RunManager()
            bridge = MemoryStreamBridge()
            event_store = DbRunEventStore(sf)
            runtime = _make_runtime(_make_ctx(run_mgr, bridge, event_store))

            started = await start_workflow_run(definition.id, definition, {"input": "hi"}, runtime=runtime)
            status, record = await _run_to_terminal(started, runtime)
            assert status == "success"

            # Canvas-side read path = the same shared RunManager + sqlite event store.
            canvas_record = await run_mgr.get(record.run_id)
            assert canvas_record is not None and canvas_record.status.value == "success"

            events = await event_store.list_events(
                record.thread_id,
                record.run_id,
                event_types=["wf:node:started", "wf:node:completed", "wf:node:failed"],
            )
            assert [e["event_type"] for e in events] == ["wf:node:started", "wf:node:completed"]
            assert all(e["content"]["node_id"] == "node_a" for e in events)

            # The dispatch aggregation is exactly the shared event store's view.
            progress = await list_run_events(record.run_id, runtime=runtime)
            assert [(p["node_id"], p["status"]) for p in progress] == [("node_a", "started"), ("node_a", "completed")]

            await bridge.cleanup(record.run_id, delay=0)
        finally:
            await _close_sqlite()

    asyncio.run(_scenario())


# ── Scenario 7: missing workflow runtime → fail-closed ──────────────────────


def test_scenario7_missing_bundle_fails_closed() -> None:
    runtime = _make_runtime({})  # bundle exists but empty — no singletons
    with pytest.raises(WorkflowDispatchUnavailableError):
        asyncio.run(start_workflow_run("wf-x", _linear_definition(), {}, runtime=runtime))
    with pytest.raises(WorkflowDispatchUnavailableError):
        asyncio.run(get_workflow_run("run-x", runtime=runtime))
    with pytest.raises(WorkflowDispatchUnavailableError):
        asyncio.run(list_run_events("run-x", runtime=runtime))
