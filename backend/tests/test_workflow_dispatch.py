"""Harness-layer workflow dispatch tests (T18-2).

Covers ``deerflow.workflow.dispatch`` — the conversation-side workflow run
entry point — using a real ``RunManager`` (no store), a mocked ``StreamBridge``,
the real ``MemoryRunEventStore``, and in-memory workflow definitions.  The
``run_workflow`` worker itself is exercised only where the definition is
compilable; the resume test patches it to assert the forwarded arguments.

Boundary guarantee: ``deerflow.workflow.dispatch`` must never import from the
app layer (pinned separately by ``test_harness_boundary.py``).
"""

from __future__ import annotations

import asyncio
from typing import Any
from unittest.mock import AsyncMock, MagicMock, patch

import pytest
from langchain.tools import ToolRuntime
from langgraph.checkpoint.memory import InMemorySaver
from langgraph.types import Command

from deerflow.runtime.events.store.memory import MemoryRunEventStore
from deerflow.runtime.runs.manager import CancelOutcome, RunManager
from deerflow.runtime.runs.schemas import RunStatus
from deerflow.runtime.runs.worker import RunContext
from deerflow.workflow.dispatch import (
    WORKFLOW_RUNTIME_CONTEXT_KEY,
    WorkflowDispatchUnavailableError,
    cancel_workflow_run,
    get_workflow_run,
    list_run_events,
    resume_workflow_run,
    start_workflow_run,
)
from deerflow.workflow.schema import WorkflowDefinition

_VALID_DEFINITION_DICT = {
    "id": "wf-test-def",
    "name": "Test Workflow",
    "nodes": [
        {"id": "start", "type": "flow:start", "outputs": [{"name": "input", "type": "data"}]},
        {"id": "assign", "type": "data:assign", "inputs": [{"name": "in", "type": "data"}], "outputs": [{"name": "out", "type": "data"}]},
        {"id": "end", "type": "flow:end", "inputs": [{"name": "in", "type": "data"}]},
    ],
    "edges": [
        {"source": "start", "source_port": "input", "target": "assign", "target_port": "in"},
        {"source": "assign", "source_port": "out", "target": "end", "target_port": "in"},
    ],
}


def _make_definition() -> WorkflowDefinition:
    return WorkflowDefinition.model_validate(_VALID_DEFINITION_DICT)


def _make_mock_bridge() -> MagicMock:
    bridge = MagicMock()
    bridge.publish = AsyncMock()
    bridge.publish_end = AsyncMock()
    bridge.cleanup = AsyncMock()
    bridge.subscribe = AsyncMock(return_value=iter([]))
    bridge.supports_cross_process = False
    return bridge


def _make_runtime(bundle: dict) -> ToolRuntime:
    return ToolRuntime(
        state={},
        context={WORKFLOW_RUNTIME_CONTEXT_KEY: bundle},
        config={"configurable": {"thread_id": "thread-1"}},
        stream_writer=lambda _: None,
        tool_call_id="call-1",
        store=None,
        tools=[],
    )


async def _drain_workflow_task(record: Any) -> None:
    """Await an admitted run's background worker, then let fire-and-forget bridge tasks settle."""
    if record.task is not None:
        try:
            await record.task
        except Exception:
            pass
    await asyncio.sleep(0.05)


# ═══════════════════════════════════════════════════════════════════════════════
# 1. start_workflow_run — success path
# ═══════════════════════════════════════════════════════════════════════════════


class TestStartWorkflowRun:
    @pytest.mark.asyncio
    async def test_creates_admitted_record_with_default_thread(self) -> None:
        run_mgr = RunManager()
        event_store = MemoryRunEventStore()
        run_ctx = RunContext(checkpointer=InMemorySaver(), event_store=event_store)
        runtime = _make_runtime({"run_manager": run_mgr, "stream_bridge": _make_mock_bridge(), "run_ctx": run_ctx})
        definition = _make_definition()

        result = await start_workflow_run(
            "wf-test-def",
            definition,
            {"input": "hello"},
            runtime=runtime,
        )

        assert result["status"] == "pending"
        assert result["thread_id"].startswith("wf-run-")

        record = await run_mgr.get(result["run_id"])
        assert record is not None
        assert record.kwargs["definition_id"] == "wf-test-def"
        assert record.kwargs["params"] == {"input": "hello"}
        await _drain_workflow_task(record)

    @pytest.mark.asyncio
    async def test_honors_explicit_thread_and_on_disconnect(self) -> None:
        run_mgr = RunManager()
        run_ctx = RunContext(checkpointer=InMemorySaver())
        runtime = _make_runtime({"run_manager": run_mgr, "stream_bridge": _make_mock_bridge(), "run_ctx": run_ctx})

        result = await start_workflow_run(
            "wf-test-def",
            _make_definition(),
            {},
            runtime=runtime,
            thread_id="custom-thread",
            on_disconnect="continue",
            metadata={"kind": "tool"},
        )

        assert result["thread_id"] == "custom-thread"
        record = await run_mgr.get(result["run_id"])
        assert record is not None
        assert record.on_disconnect.value == "continue"
        assert record.metadata == {"kind": "tool"}
        await _drain_workflow_task(record)


# ═══════════════════════════════════════════════════════════════════════════════
# 2. Missing injected runtime singleton → WorkflowDispatchUnavailableError
# ═══════════════════════════════════════════════════════════════════════════════


class TestWorkflowDispatchUnavailable:
    @pytest.mark.asyncio
    async def test_raises_when_context_key_missing(self) -> None:
        runtime = _make_runtime({})  # bundle exists but empty / no key
        with pytest.raises(WorkflowDispatchUnavailableError):
            await start_workflow_run("wf-test-def", _make_definition(), {}, runtime=runtime)

    @pytest.mark.asyncio
    async def test_raises_when_context_is_not_a_mapping(self) -> None:
        bare = MagicMock()
        bare.context = None
        with pytest.raises(WorkflowDispatchUnavailableError):
            await start_workflow_run("wf-test-def", _make_definition(), {}, runtime=bare)

    @pytest.mark.asyncio
    async def test_raises_when_bundle_missing_run_manager(self) -> None:
        runtime = _make_runtime({"stream_bridge": _make_mock_bridge()})
        with pytest.raises(WorkflowDispatchUnavailableError):
            await start_workflow_run("wf-test-def", _make_definition(), {}, runtime=runtime)


# ═══════════════════════════════════════════════════════════════════════════════
# 3. cancel_workflow_run — CancelOutcome mapping
# ═══════════════════════════════════════════════════════════════════════════════


class TestCancelWorkflowRun:
    @pytest.mark.asyncio
    @pytest.mark.parametrize(
        "outcome",
        [CancelOutcome.cancelled, CancelOutcome.requested, CancelOutcome.taken_over],
    )
    async def test_ok_outcomes(self, outcome: CancelOutcome) -> None:
        run_mgr = MagicMock()
        run_mgr.cancel = AsyncMock(return_value=outcome)
        runtime = _make_runtime({"run_manager": run_mgr})

        result = await cancel_workflow_run("run-1", runtime=runtime)

        assert result["ok"] is True
        assert result["outcome"] == outcome.value
        run_mgr.cancel.assert_awaited_once_with("run-1", action="interrupt")

    @pytest.mark.asyncio
    @pytest.mark.parametrize(
        "outcome",
        [
            CancelOutcome.lease_valid_elsewhere,
            CancelOutcome.not_cancellable,
            CancelOutcome.not_active_locally,
            CancelOutcome.unknown,
        ],
    )
    async def test_failure_outcomes(self, outcome: CancelOutcome) -> None:
        run_mgr = MagicMock()
        run_mgr.cancel = AsyncMock(return_value=outcome)
        runtime = _make_runtime({"run_manager": run_mgr})

        result = await cancel_workflow_run("run-1", runtime=runtime)

        assert result["ok"] is False
        assert result["reason"] == outcome.value


# ═══════════════════════════════════════════════════════════════════════════════
# 4. get_workflow_run — summary + missing
# ═══════════════════════════════════════════════════════════════════════════════


class TestGetWorkflowRun:
    @pytest.mark.asyncio
    async def test_returns_summary(self) -> None:
        run_mgr = RunManager()
        runtime = _make_runtime({"run_manager": run_mgr})
        record = await run_mgr.create_or_reject(
            "thread-1",
            "wf-test-def",
            kwargs={"params": {}, "definition_id": "wf-test-def"},
        )

        summary = await get_workflow_run(record.run_id, runtime=runtime)

        assert summary == {
            "run_id": record.run_id,
            "thread_id": "thread-1",
            "status": "pending",
            "error": None,
            "created_at": record.created_at,
        }

    @pytest.mark.asyncio
    async def test_returns_none_for_missing_run(self) -> None:
        run_mgr = RunManager()
        runtime = _make_runtime({"run_manager": run_mgr})
        assert await get_workflow_run("missing-run", runtime=runtime) is None


# ═══════════════════════════════════════════════════════════════════════════════
# 5. list_run_events — wf:node:* aggregation
# ═══════════════════════════════════════════════════════════════════════════════


class TestListRunEvents:
    @pytest.mark.asyncio
    async def test_aggregates_node_progress_sequence(self) -> None:
        run_mgr = RunManager()
        event_store = MemoryRunEventStore()
        run_ctx = RunContext(checkpointer=InMemorySaver(), event_store=event_store)
        runtime = _make_runtime({"run_manager": run_mgr, "run_ctx": run_ctx})
        record = await run_mgr.create_or_reject(
            "thread-1",
            "wf-test-def",
            kwargs={"params": {}, "definition_id": "wf-test-def"},
        )
        run_id, thread_id = record.run_id, record.thread_id

        await event_store.put(
            thread_id=thread_id,
            run_id=run_id,
            event_type="wf:node:started",
            category="workflow",
            content={"node_id": "a", "step": 1},
        )
        await event_store.put(
            thread_id=thread_id,
            run_id=run_id,
            event_type="wf:node:completed",
            category="workflow",
            content={"node_id": "a", "step": 1, "output": {"x": 1}},
        )
        await event_store.put(
            thread_id=thread_id,
            run_id=run_id,
            event_type="wf:node:started",
            category="workflow",
            content={"node_id": "b", "step": 2},
        )
        await event_store.put(
            thread_id=thread_id,
            run_id=run_id,
            event_type="wf:node:failed",
            category="workflow",
            content={"node_id": "b", "step": 2, "error": "boom"},
        )
        # A non-workflow event must be filtered out.
        await event_store.put(
            thread_id=thread_id,
            run_id=run_id,
            event_type="run.start",
            category="trace",
            content={"chain": None},
        )

        progress = await list_run_events(run_id, runtime=runtime)

        assert progress == [
            {"node_id": "a", "step": 1, "status": "started"},
            {"node_id": "a", "step": 1, "status": "completed", "output": {"x": 1}},
            {"node_id": "b", "step": 2, "status": "started"},
            {"node_id": "b", "step": 2, "status": "failed", "error": "boom"},
        ]

    @pytest.mark.asyncio
    async def test_empty_for_missing_run(self) -> None:
        run_mgr = RunManager()
        run_ctx = RunContext(checkpointer=InMemorySaver(), event_store=MemoryRunEventStore())
        runtime = _make_runtime({"run_manager": run_mgr, "run_ctx": run_ctx})
        assert await list_run_events("missing-run", runtime=runtime) == []


# ═══════════════════════════════════════════════════════════════════════════════
# 6. resume_workflow_run — reuses the original run
# ═══════════════════════════════════════════════════════════════════════════════


class TestResumeWorkflowRun:
    @pytest.mark.asyncio
    async def test_resumes_submitted_task_on_original_thread(self) -> None:
        run_mgr = RunManager()
        event_store = MemoryRunEventStore()
        run_ctx = RunContext(checkpointer=InMemorySaver(), event_store=event_store)
        runtime = _make_runtime({"run_manager": run_mgr, "stream_bridge": _make_mock_bridge(), "run_ctx": run_ctx})
        orig = await run_mgr.create_or_reject(
            "wf-orig",
            "wf-test-def",
            kwargs={"params": {}, "definition_id": "wf-test-def"},
        )
        # A resume is only legal once the original run has suspended
        # (human:task interrupt) — mark it terminal so admission is not rejected.
        await run_mgr.set_status(orig.run_id, RunStatus.interrupted)
        task = {
            "id": "ht-1",
            "workflow_run_id": orig.run_id,
            "status": "submitted",
            "submission": {"answer": "yes"},
            "checkpoint_ref": {"thread_id": "wf-orig", "checkpoint_id": "ck-1"},
        }

        with (
            patch(
                "deerflow.persistence.workflow_definitions.service.get_workflow_definition",
                AsyncMock(return_value={"definition": _VALID_DEFINITION_DICT}),
            ),
            patch("deerflow.workflow.worker.run_workflow", AsyncMock()) as mock_run_workflow,
        ):
            await resume_workflow_run(task, runtime=runtime)

        # Let the fire-and-forget worker run against the patched run_workflow.
        await asyncio.sleep(0.05)

        mock_run_workflow.assert_awaited_once()
        call_kwargs = mock_run_workflow.await_args.kwargs
        assert call_kwargs["origin_run_id"] == orig.run_id
        assert call_kwargs["resume"] == Command(resume={"answer": "yes"})
        assert call_kwargs["definition"].id == "wf-test-def"
        assert call_kwargs["params"] == {}
        assert call_kwargs["human_task_repo"] is None

        # A new run was admitted on the original thread, distinct from the original.
        runs = await run_mgr.list_by_thread("wf-orig")
        assert len(runs) == 2
        resumed = next(r for r in runs if r.run_id != orig.run_id)
        assert resumed.kwargs["definition_id"] == "wf-test-def"

    @pytest.mark.asyncio
    async def test_skipped_task_resumes_with_skip_sentinel(self) -> None:
        run_mgr = RunManager()
        run_ctx = RunContext(checkpointer=InMemorySaver())
        runtime = _make_runtime({"run_manager": run_mgr, "stream_bridge": _make_mock_bridge(), "run_ctx": run_ctx})
        orig = await run_mgr.create_or_reject(
            "wf-orig",
            "wf-test-def",
            kwargs={"params": {}, "definition_id": "wf-test-def"},
        )
        await run_mgr.set_status(orig.run_id, RunStatus.interrupted)
        task = {
            "id": "ht-2",
            "workflow_run_id": orig.run_id,
            "status": "skipped",
            "submission": None,
            "checkpoint_ref": {"thread_id": "wf-orig", "checkpoint_id": "ck-2"},
        }

        with (
            patch(
                "deerflow.persistence.workflow_definitions.service.get_workflow_definition",
                AsyncMock(return_value={"definition": _VALID_DEFINITION_DICT}),
            ),
            patch("deerflow.workflow.worker.run_workflow", AsyncMock()) as mock_run_workflow,
        ):
            await resume_workflow_run(task, runtime=runtime)

        await asyncio.sleep(0.05)
        assert mock_run_workflow.await_args.kwargs["resume"] == Command(resume={"__skip": True})

    @pytest.mark.asyncio
    async def test_missing_checkpoint_ref_is_silent(self) -> None:
        run_mgr = RunManager()
        run_ctx = RunContext(checkpointer=InMemorySaver())
        runtime = _make_runtime({"run_manager": run_mgr, "run_ctx": run_ctx})

        await resume_workflow_run(
            {"id": "ht-3", "workflow_run_id": "run-x", "checkpoint_ref": None},
            runtime=runtime,
        )

        # No run was created, no exception raised.
        assert await run_mgr.get("run-x") is None


# ═══════════════════════════════════════════════════════════════════════════════
# 7. Template resolver — fail-open
# ═══════════════════════════════════════════════════════════════════════════════


class TestTemplateResolverFailOpen:
    @pytest.mark.asyncio
    async def test_no_template_refs_resolves_without_repo_access(self) -> None:
        # The definition has no nested:subworkflow nodes, so prefetch never
        # touches the definition service — admission succeeds normally.
        run_mgr = RunManager()
        run_ctx = RunContext(checkpointer=InMemorySaver())
        runtime = _make_runtime({"run_manager": run_mgr, "stream_bridge": _make_mock_bridge(), "run_ctx": run_ctx})

        result = await start_workflow_run(
            "wf-test-def",
            _make_definition(),
            {"input": "hello"},
            runtime=runtime,
        )

        assert result["status"] == "pending"
        record = await run_mgr.get(result["run_id"])
        assert record is not None
        await _drain_workflow_task(record)

    @pytest.mark.asyncio
    async def test_template_ref_repo_failure_does_not_block_admission(self) -> None:
        # A definition with a template reference whose repo lookup fails must
        # still admit the run (fail-open); the compile step reports the
        # unresolved template later. run_workflow is patched so we only pin the
        # admission behavior.
        template_definition_dict = dict(_VALID_DEFINITION_DICT)
        template_definition_dict["id"] = "wf-with-template"
        template_definition_dict["nodes"] = [
            {"id": "start", "type": "flow:start", "outputs": [{"name": "input", "type": "data"}]},
            {
                "id": "sub",
                "type": "nested:subworkflow",
                "params": {"subworkflow": {"type": "template", "template_id": "wf-tmpl"}},
            },
            {"id": "end", "type": "flow:end", "inputs": [{"name": "in", "type": "data"}]},
        ]
        template_definition_dict["edges"] = [
            {"source": "start", "source_port": "input", "target": "sub", "target_port": "in"},
            {"source": "sub", "source_port": "out", "target": "end", "target_port": "in"},
        ]
        definition = WorkflowDefinition.model_validate(template_definition_dict)

        run_mgr = RunManager()
        run_ctx = RunContext(checkpointer=InMemorySaver())
        runtime = _make_runtime({"run_manager": run_mgr, "stream_bridge": _make_mock_bridge(), "run_ctx": run_ctx})

        with (
            patch(
                "deerflow.persistence.workflow_definitions.service.get_workflow_definition",
                AsyncMock(side_effect=RuntimeError("repo down")),
            ),
            patch("deerflow.workflow.worker.run_workflow", AsyncMock()) as mock_run_workflow,
        ):
            result = await start_workflow_run(
                "wf-with-template",
                definition,
                {},
                runtime=runtime,
            )

        assert result["status"] == "pending"
        record = await run_mgr.get(result["run_id"])
        assert record is not None
        await asyncio.sleep(0.05)
        assert mock_run_workflow.await_args.kwargs["definition_resolver"] is None
