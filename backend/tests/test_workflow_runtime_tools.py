"""Tests for the conversation-side workflow runtime tools (T18-3).

The tools are thin synchronous shells over the ``deerflow.workflow.dispatch``
layer (T18-2).  The dispatch module now exists in the harness tree, so the
tests patch its real functions directly with ``AsyncMock`` (the tools resolve
those functions lazily on every call, so patching the source module's
attributes is enough).

The workflow-definition read (``get_workflow_definition``), pending-review
collection (``danger.collect_pending_review_nodes``), and the
non-idempotent-type set (``registry._NON_IDEMPOTENT_TYPES``) are real modules
and used with their real values.

Note on concurrency: the sibling T18-4 task also writes this file (HumanTask
tools ``list_human_tasks`` / ``submit_human_task`` / ``skip_human_task``).
This suite only covers the T18-3 scheduling tools; T18-4 has its own suite
(``test_workflow_human_task_tools.py``).
"""

from __future__ import annotations

import json
from types import SimpleNamespace
from unittest.mock import AsyncMock, patch

from deerflow.tools.builtins import (
    cancel_workflow,
    get_workflow_run,
    pause_workflow,
    run_workflow,
)
from deerflow.workflow.schema import Edge, Node, NodeType, Port, PortType, WorkflowDefinition

# ── Helpers ─────────────────────────────────────────────────────────────────


def _runtime(user_id: str = "user-1") -> SimpleNamespace:
    return SimpleNamespace(
        state={},
        context={"thread_id": "thread-1", "user_id": user_id},
        config={"configurable": {"thread_id": "thread-1", "user_id": user_id}},
        tool_call_id="tool-1",
    )


def _port(name: str, port_type: PortType = PortType.DATA) -> Port:
    return Port(name=name, type=port_type)


def _definition(*, dangerous: str | None = None, dangerous_count: int = 1) -> WorkflowDefinition:
    """Build a 5-node definition (start + n1 + n2 + n3 + end).

    With *dangerous* set, the first ordinary node (``n1``) gets that type;
    ``dangerous_count=2`` makes ``n2`` dangerous too.  Without it the
    definition has no pending-review nodes.
    """
    nodes: list[Node] = [
        Node(id="start", type=NodeType.FLOW_START, outputs=[_port("out")]),
        Node(id="n1", type=NodeType.DATA_ASSIGN, inputs=[_port("in")], outputs=[_port("out")], params={"value": "x"}),
        Node(id="n2", type=NodeType.DATA_ASSIGN, inputs=[_port("in")], outputs=[_port("out")], params={"value": "x"}),
        Node(id="n3", type=NodeType.DATA_ASSIGN, inputs=[_port("in")], outputs=[_port("out")], params={"value": "x"}),
        Node(id="end", type=NodeType.FLOW_END, inputs=[_port("in")]),
    ]
    if dangerous is not None:
        nodes[1] = Node(id="n1", type=NodeType(dangerous), inputs=[_port("in")], outputs=[_port("out")], params={"command": "echo hi"})
        if dangerous_count >= 2:
            nodes[2] = Node(id="n2", type=NodeType(dangerous), inputs=[_port("in")], outputs=[_port("out")], params={"command": "echo hi"})
    return WorkflowDefinition(
        id="wf-1",
        name="Test Workflow",
        version="0.1.0",
        nodes=nodes,
        edges=[
            Edge(source="start", source_port="out", target="n1", target_port="in"),
            Edge(source="n1", source_port="out", target="n2", target_port="in"),
            Edge(source="n2", source_port="out", target="n3", target_port="in"),
            Edge(source="n3", source_port="out", target="end", target_port="in"),
        ],
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


def _progress_entry(status: str, node_id: str, error: str | None = None) -> dict:
    """One entry in the dispatch ``list_run_events`` result."""
    entry: dict = {"node_id": node_id, "step": 1, "status": status}
    if status == "completed":
        entry["output"] = {"value": "x"}
    if error is not None:
        entry["error"] = error
    return entry


def _command_payload(command) -> dict:
    return json.loads(command.update["messages"][0].content)


# ── run_workflow: no dangerous nodes, wait=False ────────────────────────────


def test_run_workflow_ok_without_wait():
    definition = _definition()
    import deerflow.workflow.dispatch as dispatch_mod

    with (
        patch("deerflow.persistence.workflow_definitions.service.get_workflow_definition", new=AsyncMock(return_value=_definition_row(definition))),
        patch.object(
            dispatch_mod,
            "start_workflow_run",
            new=AsyncMock(return_value={"run_id": "run-1", "thread_id": "t-1", "status": "pending"}),
        ) as mock_start,
    ):
        command = run_workflow.func(definition_id="wf-1", params={"out": "x"}, runtime=_runtime())

    payload = _command_payload(command)
    assert payload["ok"] is True
    assert payload["run_id"] == "run-1"
    assert payload["status"] == "pending"

    mock_start.assert_awaited_once()
    kwargs = mock_start.await_args.kwargs
    assert kwargs["definition_id"] == "wf-1"
    assert kwargs["params"] == {"out": "x"}
    assert kwargs["definition"].id == "wf-1"


# ── run_workflow: pending-review gate ───────────────────────────────────────


def test_run_workflow_rejects_pending_review_nodes():
    definition = _definition(dangerous=NodeType.TOOL_BASH.value)
    import deerflow.workflow.dispatch as dispatch_mod

    mock_start = AsyncMock()
    with (
        patch("deerflow.persistence.workflow_definitions.service.get_workflow_definition", new=AsyncMock(return_value=_definition_row(definition))),
        patch.object(dispatch_mod, "start_workflow_run", new=mock_start),
    ):
        command = run_workflow.func(definition_id="wf-1", params={}, runtime=_runtime())

    message = command.update["messages"][0]
    assert message.status == "error"
    payload = _command_payload(command)
    assert payload["ok"] is False
    assert payload["errors"][0]["code"] == "pending_review"
    assert payload["errors"][0]["nodes"] == ["n1"]
    assert "crash_confirm" in payload["errors"][0]["message"]
    mock_start.assert_not_awaited()


# ── run_workflow: wait=True success aggregation ─────────────────────────────


def test_run_workflow_wait_success_aggregates_progress():
    definition = _definition()
    import deerflow.workflow.dispatch as dispatch_mod

    with (
        patch("deerflow.persistence.workflow_definitions.service.get_workflow_definition", new=AsyncMock(return_value=_definition_row(definition))),
        patch.object(dispatch_mod, "start_workflow_run", new=AsyncMock(return_value={"run_id": "run-1", "thread_id": "t-1", "status": "running"})),
        patch.object(dispatch_mod, "get_workflow_run", new=AsyncMock(return_value={"run_id": "run-1", "thread_id": "t-1", "status": "success"})),
        patch.object(
            dispatch_mod,
            "list_run_events",
            new=AsyncMock(
                return_value=[
                    _progress_entry("started", "n1"),
                    _progress_entry("completed", "n1"),
                    _progress_entry("started", "n2"),
                    _progress_entry("completed", "n2"),
                ]
            ),
        ),
    ):
        command = run_workflow.func(definition_id="wf-1", params={}, runtime=_runtime(), wait=True)

    payload = _command_payload(command)
    assert payload["ok"] is True
    assert payload["run_id"] == "run-1"
    assert payload["status"] == "success"
    assert payload["completed_nodes"] == 2
    assert payload["total_nodes"] == 3  # n1 + n2 + n3 (start/end excluded)
    assert payload["failed_node"] is None
    assert payload["idempotent_retryable"] is None


# ── run_workflow: wait=True failure aggregation ─────────────────────────────


def test_run_workflow_wait_failure_bash_not_retryable():
    definition = _definition(dangerous=NodeType.TOOL_BASH.value)
    # n1 is tool:bash but carries crash_confirm=false → not pending, start allowed.
    definition.nodes[1] = definition.nodes[1].model_copy(update={"params": {"command": "echo hi", "crash_confirm": False}})
    import deerflow.workflow.dispatch as dispatch_mod

    with (
        patch("deerflow.persistence.workflow_definitions.service.get_workflow_definition", new=AsyncMock(return_value=_definition_row(definition))),
        patch.object(dispatch_mod, "start_workflow_run", new=AsyncMock(return_value={"run_id": "run-1", "thread_id": "t-1", "status": "running"})),
        patch.object(dispatch_mod, "get_workflow_run", new=AsyncMock(return_value={"run_id": "run-1", "thread_id": "t-1", "status": "error"})),
        patch.object(
            dispatch_mod,
            "list_run_events",
            new=AsyncMock(
                return_value=[
                    _progress_entry("started", "n1"),
                    _progress_entry("failed", "n1", error="boom"),
                ]
            ),
        ),
    ):
        command = run_workflow.func(definition_id="wf-1", params={}, runtime=_runtime(), wait=True)

    payload = _command_payload(command)
    assert payload["ok"] is True
    assert payload["status"] == "error"
    assert payload["failed_node"] == "n1"
    assert payload["failed_error"] == "boom"
    assert payload["idempotent_retryable"] is False  # tool:bash is non-idempotent
    assert payload["completed_nodes"] == 0


def test_run_workflow_wait_failure_idempotent_node_retryable():
    definition = _definition()
    import deerflow.workflow.dispatch as dispatch_mod

    with (
        patch("deerflow.persistence.workflow_definitions.service.get_workflow_definition", new=AsyncMock(return_value=_definition_row(definition))),
        patch.object(dispatch_mod, "start_workflow_run", new=AsyncMock(return_value={"run_id": "run-1", "thread_id": "t-1", "status": "running"})),
        patch.object(dispatch_mod, "get_workflow_run", new=AsyncMock(return_value={"run_id": "run-1", "thread_id": "t-1", "status": "error"})),
        patch.object(
            dispatch_mod,
            "list_run_events",
            new=AsyncMock(
                return_value=[
                    _progress_entry("started", "n1"),
                    _progress_entry("failed", "n1", error="boom"),
                ]
            ),
        ),
    ):
        command = run_workflow.func(definition_id="wf-1", params={}, runtime=_runtime(), wait=True)

    payload = _command_payload(command)
    assert payload["ok"] is True
    assert payload["status"] == "error"
    assert payload["failed_node"] == "n1"
    assert payload["idempotent_retryable"] is True  # data:assign is idempotent


# ── run_workflow: wait timeout ──────────────────────────────────────────────


def test_run_workflow_wait_timeout():
    definition = _definition()
    import deerflow.workflow.dispatch as dispatch_mod

    with (
        patch("deerflow.persistence.workflow_definitions.service.get_workflow_definition", new=AsyncMock(return_value=_definition_row(definition))),
        patch.object(dispatch_mod, "start_workflow_run", new=AsyncMock(return_value={"run_id": "run-1", "thread_id": "t-1", "status": "running"})),
        patch.object(dispatch_mod, "get_workflow_run", new=AsyncMock(return_value={"run_id": "run-1", "thread_id": "t-1", "status": "running"})),
    ):
        command = run_workflow.func(definition_id="wf-1", params={}, runtime=_runtime(), wait=True, wait_timeout=0)

    message = command.update["messages"][0]
    assert message.status == "error"
    payload = _command_payload(command)
    assert payload["ok"] is False
    assert payload["errors"][0]["code"] == "timeout"


# ── pause / cancel → CancelOutcome mapping ──────────────────────────────────


def test_pause_workflow_maps_cancel_outcome():
    import deerflow.workflow.dispatch as dispatch_mod

    with patch.object(dispatch_mod, "cancel_workflow_run", new=AsyncMock(return_value={"ok": True, "outcome": "cancelled"})) as mock_cancel:
        command = pause_workflow.func(run_id="run-1", runtime=_runtime())

    payload = _command_payload(command)
    assert payload["ok"] is True
    assert payload["run_id"] == "run-1"
    assert payload["action"] == "interrupt"
    assert payload["outcome"] == "cancelled"

    mock_cancel.assert_awaited_once()
    args, kwargs = mock_cancel.await_args
    assert args[0] == "run-1"
    assert kwargs.get("runtime") is not None


def test_cancel_workflow_maps_requested_outcome():
    import deerflow.workflow.dispatch as dispatch_mod

    with patch.object(dispatch_mod, "cancel_workflow_run", new=AsyncMock(return_value={"ok": True, "outcome": "requested"})):
        command = cancel_workflow.func(run_id="run-1", runtime=_runtime())

    payload = _command_payload(command)
    assert payload["ok"] is True
    assert payload["run_id"] == "run-1"
    assert payload["outcome"] == "requested"


def test_cancel_workflow_rejected_outcome_fails_closed():
    import deerflow.workflow.dispatch as dispatch_mod

    with patch.object(dispatch_mod, "cancel_workflow_run", new=AsyncMock(return_value={"ok": False, "reason": "not_cancellable"})):
        command = cancel_workflow.func(run_id="run-1", runtime=_runtime())

    message = command.update["messages"][0]
    assert message.status == "error"
    payload = _command_payload(command)
    assert payload["ok"] is False
    assert payload["errors"][0]["code"] == "cancel_failed"


# ── get_workflow_run: summary + recent events ───────────────────────────────


def test_get_workflow_run_summary_and_events():
    import deerflow.workflow.dispatch as dispatch_mod

    events = [
        _progress_entry("started", "n1"),
        _progress_entry("completed", "n1"),
        _progress_entry("started", "n2"),
    ]
    with (
        patch.object(dispatch_mod, "get_workflow_run", new=AsyncMock(return_value={"run_id": "run-1", "thread_id": "t-1", "status": "running"})),
        patch.object(dispatch_mod, "list_run_events", new=AsyncMock(return_value=events)),
    ):
        command = get_workflow_run.func(run_id="run-1", runtime=_runtime())

    payload = _command_payload(command)
    assert payload["ok"] is True
    assert payload["run_id"] == "run-1"
    assert payload["status"] == "running"
    assert [e["node_id"] for e in payload["events"]] == ["n1", "n1", "n2"]


def test_get_workflow_run_caps_recent_events():
    import deerflow.workflow.dispatch as dispatch_mod

    events = [_progress_entry("started", f"n{i}") for i in range(30)]
    with (
        patch.object(dispatch_mod, "get_workflow_run", new=AsyncMock(return_value={"run_id": "run-1", "thread_id": "t-1", "status": "running"})),
        patch.object(dispatch_mod, "list_run_events", new=AsyncMock(return_value=events)),
    ):
        command = get_workflow_run.func(run_id="run-1", runtime=_runtime())

    payload = _command_payload(command)
    assert len(payload["events"]) == 20


def test_get_workflow_run_not_found_fails_closed():
    import deerflow.workflow.dispatch as dispatch_mod

    with patch.object(dispatch_mod, "get_workflow_run", new=AsyncMock(return_value=None)):
        command = get_workflow_run.func(run_id="run-nope", runtime=_runtime())

    message = command.update["messages"][0]
    assert message.status == "error"
    payload = _command_payload(command)
    assert payload["ok"] is False
    assert payload["errors"][0]["code"] == "not_found"


# ── Fail-closed error paths ─────────────────────────────────────────────────


def test_run_workflow_definition_not_found_fails_closed():
    import deerflow.workflow.dispatch as dispatch_mod

    with (
        patch("deerflow.persistence.workflow_definitions.service.get_workflow_definition", new=AsyncMock(return_value=None)),
        patch.object(dispatch_mod, "start_workflow_run", new=AsyncMock()) as mock_start,
    ):
        command = run_workflow.func(definition_id="wf-nope", params={}, runtime=_runtime())

    message = command.update["messages"][0]
    assert message.status == "error"
    payload = _command_payload(command)
    assert payload["ok"] is False
    assert payload["errors"][0]["code"] == "not_found"
    mock_start.assert_not_awaited()


def test_runtime_tool_exception_fails_closed():
    import deerflow.workflow.dispatch as dispatch_mod

    with (
        patch("deerflow.persistence.workflow_definitions.service.get_workflow_definition", new=AsyncMock(side_effect=RuntimeError("boom"))),
        patch.object(dispatch_mod, "start_workflow_run", new=AsyncMock()),
    ):
        command = run_workflow.func(definition_id="wf-1", params={}, runtime=_runtime())

    message = command.update["messages"][0]
    assert message.status == "error"
    payload = _command_payload(command)
    assert payload["ok"] is False
    assert payload["errors"]
    assert "boom" in payload["errors"][0]["message"]


def test_pause_workflow_exception_fails_closed():
    import deerflow.workflow.dispatch as dispatch_mod

    with patch.object(dispatch_mod, "cancel_workflow_run", new=AsyncMock(side_effect=RuntimeError("boom"))):
        command = pause_workflow.func(run_id="run-1", runtime=_runtime())

    message = command.update["messages"][0]
    assert message.status == "error"
    payload = _command_payload(command)
    assert payload["ok"] is False
    assert "boom" in payload["errors"][0]["message"]
