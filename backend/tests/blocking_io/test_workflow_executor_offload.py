"""Workflow sync executors must run in a worker thread, never on the loop."""

from __future__ import annotations

from pathlib import Path

import pytest

pytestmark = pytest.mark.asyncio


async def test_sync_workflow_executor_is_offloaded(tmp_path: Path) -> None:
    from deerflow.workflow.compiler import WorkflowRuntime, _resolve_executor

    target = tmp_path / "payload.txt"
    target.write_text("x", encoding="utf-8")

    def blocking_executor(_rt: WorkflowRuntime, _params: dict, _inputs: dict) -> dict:
        # Real file IO would trip the strict Blockbuster gate if this ran on
        # the event loop.
        return {"out": target.read_text(encoding="utf-8")}

    result = await _resolve_executor(blocking_executor, WorkflowRuntime(), {}, {})

    assert result == {"out": "x"}
