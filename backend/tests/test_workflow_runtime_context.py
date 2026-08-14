"""T18: harness runtime injects the workflow run singletons into runtime context.

The Gateway run lifecycle (``RunManager`` / ``StreamBridge`` / ``RunContext``)
lives on ``app.state`` where the harness cannot reach it. The worker therefore
packages those singletons under ``WORKFLOW_RUNTIME_CONTEXT_KEY`` so T18
dialogue-side dispatch tools reading ``ToolRuntime.context`` can start workflow
runs through the same lifecycle instead of building their own engine.

The key is host-internal and caller-mergeable: a caller-supplied
``__workflow_runtime`` must never win over the worker's own injection.
"""

from __future__ import annotations

from types import SimpleNamespace
from unittest.mock import AsyncMock

import pytest
from langgraph.checkpoint.memory import InMemorySaver

from deerflow.extensions import reset_loaded_extensions
from deerflow.runtime.context_keys import WORKFLOW_RUNTIME_CONTEXT_KEY
from deerflow.runtime.runs.worker import RunContext, _build_runtime_context, run_agent


def test_build_runtime_context_installs_workflow_runtime_singletons():
    workflow_runtime = {"run_manager": object(), "stream_bridge": object(), "run_ctx": object()}

    context = _build_runtime_context(
        "thread-1",
        "run-1",
        None,
        workflow_runtime=workflow_runtime,
    )

    assert context[WORKFLOW_RUNTIME_CONTEXT_KEY] is workflow_runtime


def test_build_runtime_context_omits_workflow_runtime_by_default():
    context = _build_runtime_context("thread-1", "run-1", None)

    assert WORKFLOW_RUNTIME_CONTEXT_KEY not in context


def test_build_runtime_context_caller_supplied_workflow_runtime_never_wins():
    """``runtime.context`` is caller-mergeable, so the worker's own injection must
    win and a caller value must never survive when the worker has none."""
    forged = {"run_manager": "caller-forged"}
    authoritative = {"run_manager": object(), "stream_bridge": object(), "run_ctx": object()}

    overridden = _build_runtime_context(
        "thread-1",
        "run-1",
        {WORKFLOW_RUNTIME_CONTEXT_KEY: forged},
        workflow_runtime=authoritative,
    )
    dropped = _build_runtime_context("thread-1", "run-1", {WORKFLOW_RUNTIME_CONTEXT_KEY: forged})

    assert overridden[WORKFLOW_RUNTIME_CONTEXT_KEY] is authoritative
    assert WORKFLOW_RUNTIME_CONTEXT_KEY not in dropped


def _bridge():
    return SimpleNamespace(publish=AsyncMock(), publish_end=AsyncMock(), cleanup=AsyncMock())


@pytest.fixture
def _isolated_extensions():
    reset_loaded_extensions()
    yield
    reset_loaded_extensions()


class _Agent:
    async def astream(self, *args, **kwargs):
        yield {"messages": []}


@pytest.mark.anyio
async def test_run_agent_passes_workflow_runtime_singletons(monkeypatch, _isolated_extensions):
    """The worker's construction site packages the actual run singletons under
    the workflow runtime key — the run manager, the stream bridge, and the
    ``RunContext`` infrastructure object (not fresh copies)."""
    import deerflow.runtime.runs.worker as worker_mod

    seen: dict = {}
    original = worker_mod._build_runtime_context

    def capturing(*args, **kwargs):
        seen["kwargs"] = dict(kwargs)
        return original(*args, **kwargs)

    monkeypatch.setattr(worker_mod, "_build_runtime_context", capturing)

    from deerflow.runtime.runs.manager import RunManager

    bridge = _bridge()
    run_manager = RunManager()
    record = await run_manager.create("thread-workflow-runtime")
    ctx = RunContext(checkpointer=InMemorySaver())

    await run_agent(
        bridge,
        run_manager,
        record,
        ctx=ctx,
        agent_factory=lambda *, config: _Agent(),
        graph_input={},
        config={},
    )

    workflow_runtime = seen["kwargs"]["workflow_runtime"]
    assert workflow_runtime["run_manager"] is run_manager
    assert workflow_runtime["stream_bridge"] is bridge
    assert workflow_runtime["run_ctx"] is ctx
