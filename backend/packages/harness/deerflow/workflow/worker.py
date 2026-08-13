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
    resume: Any | None = None,
    human_task_repo: Any | None = None,
    origin_run_id: str | None = None,
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
    resume:
        Optional ``langgraph.types.Command`` instance.  When set, the graph is
        resumed from its interrupted checkpoint (``Command(resume=...)``) instead
        of starting from a fresh ``params`` mapping — the ``_build_graph_input``
        step is skipped.
    human_task_repo:
        Optional human-task repository injected into ``config["context"]`` so the
        ``human:task`` executor can persist pending tasks.  ``None`` on memory
        backends (or when the T13 executor is not wired).
    origin_run_id:
        Optional original run id used to seed ``config["context"]["run_id"]``
        instead of the new run's id.  On a resume run the record carries a fresh
        ``run_id`` (``record.run_id``), but the ``human:task`` executor keys its
        idempotency on ``(run_id, node_id)``; LangGraph re-executes the node from
        head on ``Command(resume=...)``, so injecting the *original* (hung) run id
        makes ``find_by_run_and_node`` hit the existing pending task instead of
        minting a duplicate.  ``None`` (default) keeps ``record.run_id``.  The
        ``run_id`` local variable is left unchanged — ``event_store.put``,
        ``bridge.publish``, and ``run_manager.set_status`` all still use the new
        run id.
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
    if resume is not None:
        # Resume run: the caller supplies a langgraph ``Command(resume=...)`` that
        # re-enters the graph from the interrupted ``human:task`` checkpoint.
        graph_input: Any = resume
    else:
        graph_input = _build_graph_input(definition, params)

    # ── 5. Compile the workflow definition ─────────────────────────────
    registry = build_default_registry()
    compile_ctx = CompileContext(
        executors=registry.build_context().executors,
        checkpointer=checkpointer,
        definition_resolver=definition_resolver,
        max_delegation_depth=ctx.app_config.subagents.max_delegation_depth if ctx.app_config is not None else 3,
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
            config["context"]["run_id"] = origin_run_id or run_id
            config["context"]["delegation_depth"] = 0
    if human_task_repo is not None:
        # Injected independently of app_config so the human:task executor and the
        # hangup backfill (T13-2) both see the repo even when app_config is absent.
        config.setdefault("context", {})
        if isinstance(config["context"], dict):
            config["context"]["human_task_repo"] = human_task_repo

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

        # ── 9. Read final state snapshot ───────────────────────────────
        # ``aget_state`` serves two purposes: hangup detection (``snapshot.next``
        # is non-empty when the graph suspended on an ``interrupt()``) and
        # ``run.end`` content (``snapshot.values``).  It raises without a
        # checkpointer, which is fine — both consumers degrade gracefully.
        snapshot = None
        need_state = (not record.abort_event.is_set()) or (event_store is not None)
        if need_state:
            try:
                snapshot = await graph.aget_state(config)
            except Exception:
                logger.warning("Failed to read final state for run %s (non-fatal)", run_id, exc_info=True)

        # A graph interrupted on a ``human:task`` (or any ``interrupt()``) leaves
        # pending tasks in ``snapshot.next``; treat that as ``interrupted`` rather
        # than the old unconditional ``success``.
        has_pending = snapshot is not None and not record.abort_event.is_set() and bool(getattr(snapshot, "next", None))

        # ── 10. Determine terminal status ──────────────────────────────
        if record.abort_event.is_set():
            await run_manager.set_status(
                run_id,
                RunStatus.interrupted,
                **terminal_status_kwargs,
            )
        elif has_pending:
            await run_manager.set_status(
                run_id,
                RunStatus.interrupted,
                **terminal_status_kwargs,
            )
            # Backfill checkpoint_ref on this run's pending human tasks so the
            # recovery path (T13-3) can resume from the exact checkpoint.
            repo = (config.get("context") or {}).get("human_task_repo")
            if repo is not None:
                try:
                    await _backfill_checkpoint_ref(repo, run_id, thread_id, snapshot)
                except Exception:
                    logger.warning("Failed to backfill checkpoint_ref for run %s (non-fatal)", run_id, exc_info=True)
        else:
            await run_manager.set_status(
                run_id,
                RunStatus.success,
                **terminal_status_kwargs,
            )

        # ── 11. Persist run.end with final state ───────────────────────
        if event_store is not None:
            final_output: dict[str, Any] = {}
            if snapshot is not None:
                final_output = getattr(snapshot, "values", {}) or {}
            if not final_output:
                final_output = accumulated_output

            try:
                await event_store.put(
                    thread_id=thread_id,
                    run_id=run_id,
                    event_type="run.end",
                    category="outputs",
                    content=final_output,
                    metadata={"status": "interrupted" if has_pending else "success"},
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

        # ── Compensation (T13-4) ────────────────────────────────────────
        # interrupt()/checkpoint-write failure: the human:task executor may have
        # already created a pending row that never hung (checkpoint_ref=None), so
        # it can never be resumed.  Clean it up before marking the run errored —
        # no half-state.  Aborts (CancelledError) are handled separately and must
        # NOT compensate: a user cancellation should not delete the task.
        repo = (config.get("context") or {}).get("human_task_repo")
        if repo is not None:
            try:
                await repo.delete_pending_by_run(run_id=run_id)
            except Exception:
                logger.warning("Compensation cleanup failed for run %s (non-fatal)", run_id, exc_info=True)

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


async def _backfill_checkpoint_ref(repo: Any, run_id: str, thread_id: str, snapshot: Any) -> None:
    """Backfill ``checkpoint_ref`` on a hung run's pending human tasks.

    The ``human:task`` executor creates its pending rows *before* the graph
    suspends, so the checkpoint id is not yet known at creation time.  Once the
    graph has interrupted, the suspended checkpoint is readable from
    ``snapshot.config`` — write that coordinate back so the recovery path
    (T13-3) can resume the run with ``Command(resume=...)``.
    """
    checkpoint_id = ((snapshot.config or {}).get("configurable") or {}).get("checkpoint_id")
    ref = {"thread_id": thread_id, "checkpoint_id": checkpoint_id}
    await repo.update_checkpoint_ref_by_run(run_id=run_id, checkpoint_ref=ref)


__all__ = ["run_workflow"]
