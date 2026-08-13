"""Workflow execution worker — compiled graph → run lifecycle + SSE + run events.

This module connects a compiled workflow graph to the existing run lifecycle
infrastructure.  It is the workflow counterpart of ``runtime/runs/worker.py:run_agent``.
"""

from __future__ import annotations

import asyncio
import logging
from collections.abc import Callable
from typing import Any

from deerflow.runtime.runs.manager import RunManager, RunRecord, RunStartOutcome
from deerflow.runtime.runs.schemas import RunStatus
from deerflow.runtime.runs.worker import RunContext
from deerflow.runtime.stream_bridge.base import StreamBridge
from deerflow.workflow.compiler import CompileContext, compile_definition
from deerflow.workflow.executors import build_default_registry
from deerflow.workflow.schema import NodeType, WorkflowDefinition

logger = logging.getLogger(__name__)


async def run_workflow(
    bridge: StreamBridge,
    run_manager: RunManager,
    record: RunRecord,
    *,
    ctx: RunContext,
    definition: WorkflowDefinition,
    params: dict[str, Any],
    definition_resolver: Callable[[str, str | None], WorkflowDefinition | None] | None = None,
) -> None:
    """Execute a compiled workflow graph in the background.

    Lifecycle skeleton (aligned with ``run_agent``):

    1. Wait for prior finalizing runs.
    2. Try to start this run; if cancelled, return.
    3. Publish metadata (frontend depends on ``metadata`` event).
    4. Compile the workflow definition → graph.
    5. Stream node-level events via ``astream_events(version="v2")``.
    6. In ``finally``: persist terminal status, publish end, cleanup bridge.

    Parameters
    ----------
    bridge:
        SSE stream bridge for publishing real-time events.
    run_manager:
        Run registry for status transitions and cancellation.
    record:
        Mutable run record carrying ``abort_event``, ``run_id``, etc.
    ctx:
        Infrastructure dependencies (checkpointer, event_store, etc.).
    definition:
        The workflow definition to compile and execute.
    params:
        Port-name → value mapping that seeds the ``flow:start`` node inputs.
    definition_resolver:
        Optional synchronous resolver ``(template_id, version) -> WorkflowDefinition | None``
        used to expand ``nested:subworkflow`` template references.  Must be a
        pure in-memory lookup (no IO) — the compile path must stay loop-safe.
    """

    run_id = record.run_id
    thread_id = record.thread_id
    event_store = ctx.event_store
    checkpointer = ctx.checkpointer
    terminal_status_kwargs: dict[str, Any] = {"persist": False} if event_store is not None else {}

    # ── 1. Wait for prior finalizing runs ───────────────────────────────
    await run_manager.wait_for_prior_finalizing(
        thread_id,
        run_id,
        abort_event=record.abort_event,
    )

    # ── 2. Try to start ─────────────────────────────────────────────────
    start_outcome = await run_manager.try_start(run_id)
    if start_outcome is not RunStartOutcome.started:
        if record.abort_event.is_set():
            # Cancelled before start — finish cancellation and return.
            await run_manager.set_status(
                run_id,
                RunStatus.interrupted,
                **terminal_status_kwargs,
            )
        return

    # ── 3. Publish metadata (frontend requires this) ───────────────────
    await bridge.publish(
        run_id,
        "metadata",
        {"run_id": run_id, "thread_id": thread_id},
    )

    # ── 4. Build graph input from params → start node ──────────────────
    graph_input: dict[str, Any] = _build_graph_input(definition, params)

    # ── 5. Compile the workflow definition ─────────────────────────────
    registry = build_default_registry()
    compile_ctx = CompileContext(
        executors=registry.build_context().executors,
        checkpointer=checkpointer,
        definition_resolver=definition_resolver,
    )
    graph = compile_definition(definition, context=compile_ctx)

    # ── 6. Build config ────────────────────────────────────────────────
    config: dict[str, Any] = {
        "configurable": {
            "thread_id": thread_id,
        }
    }
    if ctx.app_config is not None:
        config.setdefault("context", {})
        if isinstance(config["context"], dict):
            config["context"]["app_config"] = ctx.app_config
            config["context"]["thread_id"] = thread_id
            config["context"]["run_id"] = run_id

    # Collect non-start/end node ids for astream_events filtering.
    node_ids: list[str] = [n.id for n in definition.nodes if n.type not in (NodeType.FLOW_START, NodeType.FLOW_END)]

    # ── 7. Persist run.start event ─────────────────────────────────────
    if event_store is not None:
        try:
            await event_store.put(
                thread_id=thread_id,
                run_id=run_id,
                event_type="run.start",
                category="trace",
                content={"chain": None},
                metadata={"caller": "workflow"},
            )
        except Exception:
            logger.warning("Failed to persist run.start for run %s (non-fatal)", run_id, exc_info=True)

    # Track the most recent node so the outer exception handler can
    # emit wf:node:failed when the exception bubbles out of astream_events
    # before on_chain_error reaches the loop body.
    recent_node_id: str | None = None
    recent_step: int = 0

    # Accumulate per-node output dicts from on_chain_end events so the
    # run.end content has a fallback when no checkpointer is configured
    # (aget_state raises ValueError without one).
    accumulated_output: dict[str, Any] = {}

    try:
        # ── 8. Stream node-level events ────────────────────────────────
        abort_task: asyncio.Task[None] | None = None

        async def _wait_for_abort() -> None:
            await record.abort_event.wait()

        abort_task = asyncio.create_task(_wait_for_abort())

        # Use astream_events v2 for node-level visibility.
        # include_names filters to workflow nodes only (no LLM chains).
        stream_kwargs: dict[str, Any] = {"version": "v2"}
        if node_ids:
            stream_kwargs["include_names"] = node_ids

        try:
            stream_done_coro = graph.astream_events(graph_input, config, **stream_kwargs)
            async for event in stream_done_coro:
                _event_type = event.get("event", "")
                _name = event.get("name", "")
                _metadata = event.get("metadata", {}) or {}
                _data = event.get("data", {}) or {}
                _step = _metadata.get("langgraph_step", 0)

                if _event_type == "on_chain_start":
                    # Remember the last-started node so the outer except
                    # block can emit wf:node:failed for it.
                    recent_node_id = _name
                    recent_step = _step

                    content: dict[str, Any] = {
                        "node_id": _name,
                        "step": _step,
                    }
                    await bridge.publish(run_id, "wf:node:started", content)
                    if event_store is not None:
                        try:
                            await event_store.put(
                                thread_id=thread_id,
                                run_id=run_id,
                                event_type="wf:node:started",
                                category="workflow",
                                content=content,
                                metadata={"node_id": _name},
                            )
                        except Exception:
                            logger.warning(
                                "Failed to persist wf:node:started for run %s node %s (non-fatal)",
                                run_id,
                                _name,
                                exc_info=True,
                            )

                elif _event_type == "on_chain_end":
                    # Node completed successfully — clear the recent-node
                    # tracker so a later exception does not attribute
                    # failure to this node.
                    recent_node_id = None

                    _output = _data.get("output") if isinstance(_data, dict) else None
                    content = {
                        "node_id": _name,
                        "step": _step,
                        "output": _output if _output is not None else {},
                    }
                    # Accumulate for the run.end fallback (no-checkpointer path).
                    if isinstance(_output, dict):
                        accumulated_output.update(_output)

                    await bridge.publish(run_id, "wf:node:completed", content)
                    if event_store is not None:
                        try:
                            await event_store.put(
                                thread_id=thread_id,
                                run_id=run_id,
                                event_type="wf:node:completed",
                                category="workflow",
                                content=content,
                                metadata={"node_id": _name},
                            )
                        except Exception:
                            logger.warning(
                                "Failed to persist wf:node:completed for run %s node %s (non-fatal)",
                                run_id,
                                _name,
                                exc_info=True,
                            )

                elif _event_type == "on_chain_error":
                    # In LangGraph 1.2.x astream_events v2 the exception
                    # usually bubbles out before this branch is reached;
                    # keep it as defence-in-depth for future versions.
                    recent_node_id = None

                    _error = _data.get("error") if isinstance(_data, dict) else None
                    error_str = str(_error) if _error is not None else ""
                    error_type_name = type(_error).__name__ if _error is not None else "Exception"
                    content = {
                        "node_id": _name,
                        "step": _step,
                        "error": error_str,
                    }
                    await bridge.publish(run_id, "wf:node:failed", content)
                    if event_store is not None:
                        try:
                            await event_store.put(
                                thread_id=thread_id,
                                run_id=run_id,
                                event_type="wf:node:failed",
                                category="workflow",
                                content=content,
                                metadata={"node_id": _name, "error_type": error_type_name},
                            )
                        except Exception:
                            logger.warning(
                                "Failed to persist wf:node:failed for run %s node %s (non-fatal)",
                                run_id,
                                _name,
                                exc_info=True,
                            )

                # Check for cancellation after each event
                if record.abort_event.is_set():
                    logger.info("Run %s abort requested — stopping", run_id)
                    break

            # Abort wasn't set during streaming — cancel the wait task.
            if not record.abort_event.is_set():
                abort_task.cancel()
                try:
                    await abort_task
                except asyncio.CancelledError:
                    pass
            else:
                # Abort was set — wait for abort_task to complete (already done).
                try:
                    await abort_task
                except Exception:
                    pass

        except asyncio.CancelledError:
            logger.info("Run %s was cancelled", run_id)
            if abort_task is not None and not abort_task.done():
                abort_task.cancel()
                try:
                    await abort_task
                except asyncio.CancelledError:
                    pass

        # ── 9. Determine terminal status ───────────────────────────────
        if record.abort_event.is_set():
            await run_manager.set_status(
                run_id,
                RunStatus.interrupted,
                **terminal_status_kwargs,
            )
        else:
            await run_manager.set_status(
                run_id,
                RunStatus.success,
                **terminal_status_kwargs,
            )

        # ── 10. Persist run.end with final state ───────────────────────
        if event_store is not None:
            final_output: dict[str, Any] = {}
            try:
                state_snapshot = await graph.aget_state(config)
                final_output = getattr(state_snapshot, "values", {}) or {}
            except Exception:
                logger.warning("Failed to read final state for run.end (non-fatal)", exc_info=True)
            if not final_output:
                final_output = accumulated_output

            try:
                await event_store.put(
                    thread_id=thread_id,
                    run_id=run_id,
                    event_type="run.end",
                    category="outputs",
                    content=final_output,
                    metadata={"status": "success"},
                )
            except Exception:
                logger.warning("Failed to persist run.end for run %s (non-fatal)", run_id, exc_info=True)

    except asyncio.CancelledError:
        logger.info("Run %s was cancelled", run_id)
        await run_manager.set_status(
            run_id,
            RunStatus.interrupted,
            **terminal_status_kwargs,
        )

    except Exception as exc:
        error_msg = f"{exc}"
        logger.exception("Run %s failed: %s", run_id, error_msg)

        # ── Emit wf:node:failed for the node that was executing ────────
        if recent_node_id is not None:
            failed_content = {
                "node_id": recent_node_id,
                "step": recent_step,
                "error": error_msg,
            }
            await bridge.publish(run_id, "wf:node:failed", failed_content)
            if event_store is not None:
                try:
                    await event_store.put(
                        thread_id=thread_id,
                        run_id=run_id,
                        event_type="wf:node:failed",
                        category="workflow",
                        content=failed_content,
                        metadata={"node_id": recent_node_id, "error_type": type(exc).__name__},
                    )
                except Exception:
                    logger.warning(
                        "Failed to persist wf:node:failed for run %s node %s (non-fatal)",
                        run_id,
                        recent_node_id,
                        exc_info=True,
                    )

        await run_manager.set_status(
            run_id,
            RunStatus.error,
            error=error_msg,
            **terminal_status_kwargs,
        )
        await bridge.publish(
            run_id,
            "error",
            {"message": error_msg, "name": type(exc).__name__},
        )

        if event_store is not None:
            try:
                await event_store.put(
                    thread_id=thread_id,
                    run_id=run_id,
                    event_type="run.error",
                    category="error",
                    content=error_msg,
                    metadata={"error_type": type(exc).__name__},
                )
            except Exception:
                logger.warning("Failed to persist run.error for run %s (non-fatal)", run_id, exc_info=True)

    finally:
        await bridge.publish_end(run_id)
        asyncio.create_task(bridge.cleanup(run_id, delay=60))


# ── Internal helpers ───────────────────────────────────────────────────────


def _build_graph_input(definition: WorkflowDefinition, params: dict[str, Any]) -> dict[str, Any]:
    """Map caller-supplied ``params`` to graph state keys.

    1.  Find the node whose ``type == NodeType.FLOW_START``.
    2.  For each ``(port_name, value)`` in *params*, construct a graph key
        ``wf:{start_node.id}:{port_name}``.
    3.  If no start node or *params* is empty, return ``{}``.

    Returns
    -------
    dict
        Keys are ``wf:<node_id>:<port_name>``; values are the caller-supplied
        parameter values.
    """
    if not params:
        return {}

    start_node = next((n for n in definition.nodes if n.type == NodeType.FLOW_START), None)
    if start_node is None:
        logger.warning("No flow:start node found in workflow definition; ignoring params")
        return {}

    return {f"wf:{start_node.id}:{port_name}": value for port_name, value in params.items()}


__all__ = ["run_workflow"]
