"""Tests for the N14 section 24.9 failure taxonomy.

``classify_failure`` maps an exception to a stable code; the compiler's node
event carries it as ``error_class``.
"""

from __future__ import annotations

from typing import Any

import pytest

from deerflow.locks.file_lock import LockTimeoutError
from deerflow.workflow import compiler as compiler_mod
from deerflow.workflow.compiler import _with_node_events
from deerflow.workflow.conflict import WorkflowConflictError
from deerflow.workflow.executors import WorkflowExecutionError
from deerflow.workflow.failure_taxonomy import FAILURE_CODES, classify_failure
from deerflow.workflow.schema import NodeType
from deerflow.workflow.structured_output import StructuredOutputError


class TestClassifyFailure:
    def test_every_result_is_a_known_code(self) -> None:
        for exc in (ValueError("x"), WorkflowExecutionError("y"), TimeoutError()):
            assert classify_failure(exc) in FAILURE_CODES

    def test_timeout(self) -> None:
        assert classify_failure(TimeoutError()) == "timeout"

    def test_config(self) -> None:
        assert classify_failure(compiler_mod.WorkflowCompileError("bad")) == "config"

    def test_validation(self) -> None:
        assert classify_failure(StructuredOutputError("nope")) == "validation"

    def test_conflict(self) -> None:
        assert classify_failure(WorkflowConflictError("node x", ["/tmp/a"])) == "conflict"

    def test_resource_via_lock_error(self) -> None:
        assert classify_failure(LockTimeoutError("busy")) == "resource"

    def test_resource_via_message(self) -> None:
        assert classify_failure(WorkflowExecutionError("local resource unavailable: gpu")) == "resource"

    def test_rate_limit_via_message(self) -> None:
        assert classify_failure(RuntimeError("HTTP 429 Too Many Requests")) == "rate_limit"

    def test_tool_node_execution_error(self) -> None:
        assert classify_failure(WorkflowExecutionError("bash failed"), node_type=NodeType.TOOL_BASH) == "tool"

    def test_generic_execution_error_is_unknown(self) -> None:
        assert classify_failure(WorkflowExecutionError("boom")) == "unknown"

    def test_plain_exception_is_unknown(self) -> None:
        assert classify_failure(ValueError("boom")) == "unknown"


class TestNodeEventErrorClass:
    @pytest.mark.asyncio
    async def test_failed_event_carries_error_class(self, monkeypatch: pytest.MonkeyPatch) -> None:
        captured: list[tuple[str, str, dict[str, Any]]] = []
        monkeypatch.setattr(compiler_mod, "_emit_node_event", lambda event_type, node_id, depth, **extra: captured.append((event_type, node_id, extra)))

        async def _boom(_state: dict[str, Any]) -> dict[str, Any]:
            raise WorkflowExecutionError("bash blew up")

        wrapped = _with_node_events("n1", 0, _boom, NodeType.TOOL_BASH)
        with pytest.raises(WorkflowExecutionError):
            await wrapped({})

        event_type, node_id, extra = captured[-1]
        assert event_type == "failed"
        assert node_id == "n1"
        assert extra["error_type"] == "WorkflowExecutionError"
        assert extra["error_class"] == "tool"

    @pytest.mark.asyncio
    async def test_completed_event_has_no_error_class(self, monkeypatch: pytest.MonkeyPatch) -> None:
        captured: list[tuple[str, str, dict[str, Any]]] = []
        monkeypatch.setattr(compiler_mod, "_emit_node_event", lambda event_type, node_id, depth, **extra: captured.append((event_type, node_id, extra)))

        async def _ok(_state: dict[str, Any]) -> dict[str, Any]:
            return {"out": 1}

        wrapped = _with_node_events("n1", 0, _ok, NodeType.DATA_ASSIGN)
        await wrapped({})

        assert captured[-1][0] == "completed"
        assert "error_class" not in captured[-1][2]
