"""Workflow execution worker — compiled graph → run lifecycle + SSE + run events.

This module connects a compiled workflow graph to the existing run lifecycle
infrastructure.  It is the workflow counterpart of ``runtime/runs/worker.py:run_agent``.
"""

from __future__ import annotations

import asyncio
import json
import logging
from collections.abc import Callable
from typing import Any

from deerflow.runtime.runs.manager import RunManager, RunRecord, RunStartOutcome
from deerflow.runtime.runs.schemas import RunStatus
from deerflow.runtime.runs.worker import RunContext
from deerflow.runtime.stream_bridge.base import StreamBridge
from deerflow.workflow.compiler import compile_definition
from deerflow.workflow.executors import build_default_registry
from deerflow.workflow.failure_taxonomy import classify_failure
from deerflow.workflow.runtime_context import build_workflow_compile_context, build_workflow_runtime_context
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
    workflow_undo_repo: Any | None = None,
    origin_run_id: str | None = None,
    continue_nodes: dict[str, str] | None = None,
    origin_thread_id: str | None = None,
    debug_step: bool = False,
    checkpoint_id: str | None = None,
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
    continue_nodes:
        Optional ``{node_id: prompt}`` mapping for W2B cross-run AI-node
        continuation.  When provided, it is injected into
        ``config["context"]["__ai_continue"]``; the ``ai:llm_agent`` executor
        falls back to this per-node prompt when ``inputs["continue_prompt"]`` is
        empty, so a fresh run can continue the target node's session instead of
        starting a new one-shot turn.  ``None`` (default) leaves the key absent.
    origin_thread_id:
        Optional original run's thread id used as the checkpoint-thread prefix
        (``f"{origin_thread_id}:wfai:{node_id}"``) for a cross-run continue.
        The new run's own ``thread_id`` differs from the original run's, so the
        executor must locate the original session checkpoint via this prefix.
        Injected as ``config["context"]["ai_origin_thread_id"]`` only when not
        ``None``; absent, the executor falls back to the current
        ``thread_id`` (W1A behavior).
    checkpoint_id:
        Optional checkpoint to resume the run from (§25 rewind & re-run).  When
        set, the caller-supplied ``params`` are ignored and the graph continues
        from that checkpoint's scheduled tasks, so the nodes before it are not
        re-executed (their outputs are already in state — the whole point of a
        rewind).  Resolved by ``workflow/rewind.py::locate_rewind_point``.
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
    elif checkpoint_id is not None:
        # §25 rewind: continue from a chosen checkpoint's scheduled tasks, so the
        # nodes before it are not re-executed (``params`` would seed a *fresh*
        # start and discard the checkpointed progress).
        graph_input = None
    else:
        graph_input = _build_graph_input(definition, params)

    # ── 5. Compile the workflow definition ─────────────────────────────
    # The compile context is assembled in one place so previewers (approval
    # gates) and idempotency metadata (retry gates) always travel with the
    # executors.  Reaching into ``build_context().executors`` here silently
    # disabled both features in production.
    registry = build_default_registry()
    compile_ctx = build_workflow_compile_context(
        registry,
        checkpointer=checkpointer,
        definition_resolver=definition_resolver,
        max_delegation_depth=ctx.app_config.subagents.max_delegation_depth if ctx.app_config is not None else 3,
    )
    graph = compile_definition(definition, context=compile_ctx)

    # ── 6. Build config ────────────────────────────────────────────────
    # W2B cross-run AI-node continuation.  ``__ai_continue`` carries the
    # per-node continue prompts for this run; ``ai_origin_thread_id`` lets the
    # executor locate the ORIGINAL run's session checkpoint thread (the new
    # run's thread_id differs from the original run's).  Both keys stay absent
    # for ordinary runs so existing behavior is untouched.
    runtime_extra: dict[str, Any] = {}
    if continue_nodes is not None:
        runtime_extra["__ai_continue"] = continue_nodes
    if origin_thread_id is not None:
        runtime_extra["ai_origin_thread_id"] = origin_thread_id

    config: dict[str, Any] = {
        "configurable": {
            "thread_id": thread_id,
        },
        "context": build_workflow_runtime_context(
            record=record,
            run_ctx=ctx,
            human_task_repo=human_task_repo,
            workflow_undo_repo=workflow_undo_repo,
            origin_run_id=origin_run_id,
            debug_step=debug_step,
            extra=runtime_extra,
        ),
    }
    if checkpoint_id is not None:
        # LangGraph resumes from a checkpoint through ``configurable``; the
        # checkpoint must belong to this thread (LangGraph validates that).
        config["configurable"]["checkpoint_id"] = checkpoint_id

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

        # C2: node-level visibility via ``astream(stream_mode=["updates","custom"])``.
        # The compiler wraps every node fn to emit ``wf:node:started|completed|failed``
        # custom events tagged with their subgraph depth; we republish top-level
        # (depth 0) ones to the SSE bridge + run-event store.  ``updates`` chunks
        # supply the accumulated-output fallback for the no-checkpointer path.
        node_id_set = set(node_ids)
        step_counter = 0
        pending_steps: dict[str, int] = {}

        async def _persist_node_event(event_type: str, content: dict[str, Any], metadata: dict[str, Any]) -> None:
            await bridge.publish(run_id, event_type, content)
            if event_store is None:
                return
            try:
                await event_store.put(
                    thread_id=thread_id,
                    run_id=run_id,
                    event_type=event_type,
                    category="workflow",
                    content=content,
                    metadata=metadata,
                )
            except Exception:
                logger.warning(
                    "Failed to persist %s for run %s node %s (non-fatal)",
                    event_type,
                    run_id,
                    content.get("node_id"),
                    exc_info=True,
                )

        try:
            stream_done_coro = graph.astream(graph_input, config, stream_mode=["updates", "custom"])
            async for chunk in stream_done_coro:
                if not (isinstance(chunk, tuple) and len(chunk) == 2):
                    continue
                mode, data = chunk

                if mode == "custom":
                    if not isinstance(data, dict):
                        continue
                    _name = data.get("node_id")
                    # Filter child-subgraph events (depth > 0) and unknown nodes.
                    if data.get("depth", 0) != 0 or _name not in node_id_set:
                        continue
                    _event_type = data.get("type")
                    if _event_type == "wf:node:started":
                        # Remember the last-started node so the outer except
                        # block can emit wf:node:failed if the custom failed
                        # event itself never made it out.
                        step_counter += 1
                        pending_steps[_name] = step_counter
                        recent_node_id = _name
                        recent_step = step_counter
                        await _persist_node_event(
                            "wf:node:started",
                            {"node_id": _name, "step": step_counter},
                            {"node_id": _name},
                        )
                    elif _event_type == "wf:node:completed":
                        recent_node_id = None
                        _step = pending_steps.pop(_name, step_counter)
                        _output = data.get("output")
                        await _persist_node_event(
                            "wf:node:completed",
                            {"node_id": _name, "step": _step, "output": _output if _output is not None else {}},
                            {"node_id": _name},
                        )
                    elif _event_type == "wf:node:failed":
                        recent_node_id = None
                        _step = pending_steps.pop(_name, step_counter)
                        await _persist_node_event(
                            "wf:node:failed",
                            {"node_id": _name, "step": _step, "error": data.get("error", "")},
                            {"node_id": _name, "error_type": data.get("error_type", "Exception"), "error_class": data.get("error_class", "unknown")},
                        )

                elif mode == "updates":
                    if isinstance(data, dict):
                        for _name, _output in data.items():
                            if _name in node_id_set and isinstance(_output, dict):
                                accumulated_output.update(_output)

                # Check for cancellation after each chunk.
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
            terminal_status = "interrupted"
            await run_manager.set_status(
                run_id,
                RunStatus.interrupted,
                **terminal_status_kwargs,
            )
        elif has_pending:
            terminal_status = "interrupted"
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
            terminal_status = "success"
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

            run_end_content = _build_run_end_content(final_output, status=terminal_status)
            await _persist_run_end(event_store, thread_id=thread_id, run_id=run_id, content=run_end_content, status=terminal_status)

    except asyncio.CancelledError:
        logger.info("Run %s was cancelled", run_id)
        await run_manager.set_status(
            run_id,
            RunStatus.interrupted,
            **terminal_status_kwargs,
        )

    except Exception as exc:
        error_msg = f"{exc}"
        # N14 §24.9 stable failure code for the node that was executing (the
        # compiler's per-node event already carries one; this is the fallback
        # when the exception bubbled out before that event was emitted).
        failure_class = classify_failure(exc)
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
                "error_class": failure_class,
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
                        metadata={"node_id": recent_node_id, "error_type": type(exc).__name__, "error_class": failure_class},
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
            {"message": error_msg, "name": type(exc).__name__, "class": failure_class},
        )

        if event_store is not None:
            try:
                await event_store.put(
                    thread_id=thread_id,
                    run_id=run_id,
                    event_type="run.error",
                    category="error",
                    content=error_msg,
                    metadata={"error_type": type(exc).__name__, "error_class": failure_class},
                )
            except Exception:
                logger.warning("Failed to persist run.error for run %s (non-fatal)", run_id, exc_info=True)

            # Every terminal path must expose one run.end.  Without this an
            # error run had no token/timing aggregate at all, while a cancelled
            # run wrote status=success because only ``has_pending`` was checked.
            run_end_content = _build_run_end_content(accumulated_output, status="error", error=error_msg)
            await _persist_run_end(event_store, thread_id=thread_id, run_id=run_id, content=run_end_content, status="error")

    finally:
        await bridge.publish_end(run_id)
        asyncio.create_task(bridge.cleanup(run_id, delay=60))


# ── Internal helpers ───────────────────────────────────────────────────────


#: A single state value larger than this is replaced by a typed marker in
#: ``run.end``.  The checkpoint remains the source of truth for the full value;
#: run events are an observability/reporting feed, not a second state store.
_RUN_END_VALUE_CHAR_LIMIT = 32_000


def _bounded_run_end_value(value: Any) -> Any:
    try:
        size = len(json.dumps(value, ensure_ascii=False, default=str))
    except Exception:
        size = len(str(value))
    if size <= _RUN_END_VALUE_CHAR_LIMIT:
        return value
    return {"__truncated": True, "type": type(value).__name__, "chars": size}


def _build_run_end_content(final_output: dict[str, Any], *, status: str, error: str | None = None) -> dict[str, Any]:
    """Build the terminal ``run.end`` payload with a bounded state snapshot."""
    content: dict[str, Any] = {}
    for key, value in final_output.items():
        if isinstance(key, str) and key.startswith("wf:"):
            content[key] = _bounded_run_end_value(value)

    token_usage = _aggregate_final_token_usage(final_output)
    if token_usage is not None:
        content["token_usage"] = token_usage
    node_timings = _aggregate_final_node_durations(final_output)
    if node_timings is not None:
        content["node_timings"] = node_timings
    content["status"] = status
    if error:
        content["error"] = error
    return content


async def _persist_run_end(
    event_store: Any,
    *,
    thread_id: str,
    run_id: str,
    content: dict[str, Any],
    status: str,
) -> None:
    try:
        await event_store.put(
            thread_id=thread_id,
            run_id=run_id,
            event_type="run.end",
            category="outputs",
            content=content,
            metadata={"status": status},
        )
    except Exception:
        logger.warning("Failed to persist run.end for run %s (non-fatal)", run_id, exc_info=True)


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


def _aggregate_final_token_usage(final_output: dict[str, Any]) -> dict[str, Any] | None:
    """Collapse per-node reserved ``wf:<node>:__token_usage`` state into one dict.

    Each AI node's executor writes its aggregated sub-agent token usage onto
    ``wf:<node_id>:__token_usage`` (see ``deerflow.workflow.compiler``); this
    sums them into a run-level aggregate::

        {"input_tokens": int, "output_tokens": int, "total_tokens": int,
         "cache_read_tokens": int, "nodes": {<node_id>: <per-node dict>}}

    Returns ``None`` when no token-usage channel is present so the caller can
    keep the additive ``token_usage`` key absent instead of emitting an empty
    structure.
    """
    per_node: dict[str, dict[str, int]] = {}
    for key, value in final_output.items():
        if not (isinstance(key, str) and key.startswith("wf:") and key.endswith(":__token_usage")):
            continue
        if not isinstance(value, dict):
            continue
        node_id = key[len("wf:") : -len(":__token_usage")]
        per_node[node_id] = value
    if not per_node:
        return None
    totals = {"input_tokens": 0, "output_tokens": 0, "total_tokens": 0, "cache_read_tokens": 0}
    for value in per_node.values():
        for field in totals:
            totals[field] += int(value.get(field) or 0)
    return {**totals, "nodes": per_node}


def _aggregate_final_node_durations(final_output: dict[str, Any]) -> dict[str, Any] | None:
    """Collapse per-node reserved ``wf:<node>:__duration_ms`` state into one dict.

    Every node's compiler wrapper records its work duration (N14x) onto
    ``wf:<node_id>:__duration_ms``; this folds them into::

        {"nodes": {<node_id>: float}, "total_ms": float, "slowest_node": str}

    ``slowest_node`` breaks ties on the node id so a report is stable.  Returns
    ``None`` when no duration channel is present, so the additive
    ``node_timings`` key stays absent instead of emitting an empty structure.
    """
    per_node: dict[str, float] = {}
    for key, value in final_output.items():
        if not (isinstance(key, str) and key.startswith("wf:") and key.endswith(":__duration_ms")):
            continue
        try:
            per_node[key[len("wf:") : -len(":__duration_ms")]] = float(value)
        except (TypeError, ValueError):
            continue
    if not per_node:
        return None
    slowest = min(per_node.items(), key=lambda item: (-item[1], item[0]))[0]
    return {"nodes": per_node, "total_ms": round(sum(per_node.values()), 3), "slowest_node": slowest}


__all__ = ["run_workflow"]
