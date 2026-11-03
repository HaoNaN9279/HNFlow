"""In-process workflow runs for the headless engine.

One :class:`RunHost` owns every run started through ``run/start``.  Each run
compiles the frozen definition with the real executor registry and streams it
through LangGraph, translating node-level custom events into the run event log
the plugin mirrors into a DSH job.

Human nodes suspend the graph: the stream ends with pending tasks, the run
becomes ``waiting_human``, and ``run/resume`` submits a task and continues the
same checkpoint.

Deliberate limits (``docs/dsh-plugin-plan.md`` §14):

- a run owns a per-run ``MemorySaver`` checkpointer, so a process restart loses
  the run; durable checkpoints arrive with the engine store in M2;
- cancellation is cooperative: the stream stops at the next chunk boundary.
"""

from __future__ import annotations

import asyncio
import logging
import uuid
from collections.abc import Callable
from dataclasses import dataclass, field
from datetime import UTC, datetime
from types import SimpleNamespace
from typing import Any

from langgraph.checkpoint.memory import MemorySaver
from langgraph.types import Command

from deerflow.runtime.user_context import DEFAULT_USER_ID
from deerflow.workflow.compiler import WorkflowCompileError, compile_definition
from deerflow.workflow.executors import build_default_registry
from deerflow.workflow.rpc.protocol import EngineError
from deerflow.workflow.rpc.tasks import MemoryTaskStore, TaskError
from deerflow.workflow.runtime_context import build_workflow_compile_context, build_workflow_runtime_context
from deerflow.workflow.schema import NodeType, WorkflowDefinition
from deerflow.workflow.workflow_io import validate_definition

logger = logging.getLogger(__name__)

#: Events retained per run; older ones are dropped from the head.
MAX_EVENTS_PER_RUN = 2000
#: Finished runs retained for status/event lookups before the oldest are evicted.
MAX_RETAINED_RUNS = 50
#: Bound applied to any value copied into a status result or an event payload.
MAX_VALUE_BYTES = 8192

_TERMINAL_STATUSES = frozenset({"succeeded", "failed", "cancelled"})
_MAX_RUN_DEPTH = 64


def _now() -> str:
    """ISO-8601 UTC timestamp used in events and statuses."""
    return datetime.now(UTC).isoformat(timespec="milliseconds")


@dataclass
class RunEvent:
    """One entry of a run's ordered event log."""

    seq: int
    at: str
    type: str
    node_id: str | None
    data: dict[str, Any]

    def to_wire(self) -> dict[str, Any]:
        """Render the event for JSON-RPC."""
        return {"seq": self.seq, "at": self.at, "type": self.type, "nodeId": self.node_id, "data": self.data}


@dataclass
class RunState:
    """Everything the host remembers about one run."""

    run_id: str
    definition: WorkflowDefinition
    inputs: dict[str, Any]
    metadata: dict[str, Any]
    checkpointer: MemorySaver
    graph: Any = None
    config: dict[str, Any] = field(default_factory=dict)
    status: str = "queued"
    started_at: str = field(default_factory=_now)
    ended_at: str | None = None
    error: str | None = None
    result: Any = None
    nodes: dict[str, dict[str, Any]] = field(default_factory=dict)
    events: list[RunEvent] = field(default_factory=list)
    seq: int = 0
    cancel_requested: bool = False
    task: asyncio.Task[None] | None = None

    def summary(self) -> dict[str, Any]:
        """Render the compact run record returned by ``run/status``."""
        return {
            "runId": self.run_id,
            "status": self.status,
            "startedAt": self.started_at,
            "endedAt": self.ended_at,
            "error": self.error,
            "result": self.result,
            "nodes": [{"nodeId": node_id, **values} for node_id, values in self.nodes.items()],
        }


class RunHost:
    """Start, observe, cancel, and resume workflow runs inside the engine process."""

    def __init__(self, emit: Callable[[dict[str, Any]], None] | None = None) -> None:
        self._runs: dict[str, RunState] = {}
        self._emit = emit or (lambda _message: None)
        self._registry: Any = None
        self._tasks = MemoryTaskStore()

    # ── registry ───────────────────────────────────────────────────────────

    def _executor_registry(self) -> Any:
        """Build the executor registry once per process."""
        if self._registry is None:
            self._registry = build_default_registry()
        return self._registry

    # ── public API ─────────────────────────────────────────────────────────

    async def start(self, *, definition: Any, inputs: dict[str, Any] | None = None, metadata: dict[str, Any] | None = None) -> dict[str, Any]:
        """Validate, compile, and start a run.

        Raises:
            EngineError: the definition is invalid or fails to compile.
        """
        def_ = _coerce_definition(definition)
        errors = validate_definition(def_)
        if errors:
            raise EngineError("invalid-definition", "workflow definition is invalid", {"errors": errors})

        checkpointer = MemorySaver()
        try:
            context = build_workflow_compile_context(self._executor_registry(), checkpointer=checkpointer)
            graph = compile_definition(def_, context=context)
        except WorkflowCompileError as exc:
            raise EngineError("compile-failed", str(exc)) from exc

        state = RunState(
            run_id=f"run-{uuid.uuid4().hex[:16]}",
            definition=def_,
            inputs=dict(inputs or {}),
            metadata=dict(metadata or {}),
            checkpointer=checkpointer,
            graph=graph,
        )
        state.config = {"configurable": {"thread_id": state.run_id}, "context": self._runtime_context(state)}
        self._runs[state.run_id] = state
        self._prune()
        self._record(state, "run/started", None, {"workflowId": def_.id, "workflowName": def_.name})
        state.task = asyncio.create_task(self._stream(state, _graph_input(def_, state.inputs)), name=f"hnflow:{state.run_id}")
        return {"runId": state.run_id, "status": state.status, "startedAt": state.started_at}

    def status(self, run_id: str) -> dict[str, Any]:
        """Return the current run record plus its pending human tasks."""
        state = self._get(run_id)
        return {**state.summary(), "pendingTasks": self._tasks.summaries(state.run_id)}

    def events(self, run_id: str, after_seq: int = 0) -> dict[str, Any]:
        """Return the event log slice after ``after_seq``."""
        state = self._get(run_id)
        return {"runId": state.run_id, "events": [event.to_wire() for event in state.events if event.seq > after_seq], "status": state.status}

    def tasks(self, run_id: str | None = None) -> dict[str, Any]:
        """Every pending human task, optionally for one run."""
        if run_id is not None:
            self._get(run_id)
        return {"tasks": self._tasks.summaries(run_id)}

    async def submit(self, *, task_id: str, payload: dict[str, Any], revision: int | None = None) -> dict[str, Any]:
        """Submit one task and continue its run.

        The store owns the CAS: a duplicate or stale submission raises
        ``task-not-pending`` / ``task-revision-conflict`` before any graph work.

        Raises:
            EngineError: the task is unknown or the run is not waiting.
        """
        row = self._tasks.get(task_id)
        if row is None:
            raise EngineError("unknown-task", f"no task named {task_id}", {"taskId": task_id})
        state = self._get(row["workflow_run_id"])
        if state.status != "waiting_human":
            raise EngineError("run-not-waiting", f"run {state.run_id} is {state.status}, not waiting for a task", {"runId": state.run_id, "status": state.status})
        if state.task is not None and not state.task.done():
            raise EngineError("run-busy", f"run {state.run_id} is still streaming", {"runId": state.run_id})
        try:
            submitted = self._tasks.submit(task_id, payload, revision=revision)
        except TaskError as exc:
            raise EngineError(exc.code, exc.message, exc.data) from exc
        state.task = asyncio.create_task(self._stream(state, Command(resume=submitted["payload"])), name=f"hnflow:{state.run_id}:resume")
        return {"taskId": task_id, "runId": state.run_id, "status": "running", "revision": submitted["revision"]}

    def cancel(self, run_id: str) -> dict[str, Any]:
        """Ask a run to stop at its next stream boundary."""
        state = self._get(run_id)
        if state.status in _TERMINAL_STATUSES:
            return {"runId": state.run_id, "status": state.status, "cancelled": False}
        if state.status == "waiting_human":
            self._tasks.discard_run(state.run_id)
            self._transition(state, "cancelled")
            return {"runId": state.run_id, "status": state.status, "cancelled": True}
        state.cancel_requested = True
        return {"runId": state.run_id, "status": state.status, "cancelled": True}

    def list_runs(self) -> dict[str, Any]:
        """Return every retained run, newest last."""
        return {"runs": [state.summary() for state in self._runs.values()]}

    async def close(self) -> None:
        """Cancel every in-flight run (engine shutdown)."""
        tasks = [state.task for state in self._runs.values() if state.task is not None and not state.task.done()]
        for task in tasks:
            task.cancel()
        if tasks:
            await asyncio.gather(*tasks, return_exceptions=True)

    # ── internals ──────────────────────────────────────────────────────────

    def _get(self, run_id: str) -> RunState:
        """Look up a run or raise ``unknown-run``."""
        state = self._runs.get(run_id)
        if state is None:
            raise EngineError("unknown-run", f"no run named {run_id!r}", {"runId": run_id})
        return state

    def _prune(self) -> None:
        """Drop the oldest finished runs once the retention bound is exceeded."""
        if len(self._runs) <= MAX_RETAINED_RUNS:
            return
        for run_id, state in list(self._runs.items()):
            if len(self._runs) <= MAX_RETAINED_RUNS:
                break
            if state.status in _TERMINAL_STATUSES:
                self._runs.pop(run_id, None)

    def _record(self, state: RunState, event_type: str, node_id: str | None, data: dict[str, Any]) -> None:
        """Append an event to the run log and notify the client."""
        state.seq += 1
        event = RunEvent(seq=state.seq, at=_now(), type=event_type, node_id=node_id, data=_bounded(data))
        state.events.append(event)
        if len(state.events) > MAX_EVENTS_PER_RUN:
            del state.events[: len(state.events) - MAX_EVENTS_PER_RUN]
        self._emit({"jsonrpc": "2.0", "method": "run/event", "params": {"runId": state.run_id, "event": event.to_wire()}})

    def _transition(self, state: RunState, status: str, *, error: str | None = None, result: Any = None) -> None:
        """Set the run status and publish a ``run/status`` notification."""
        state.status = status
        if status in _TERMINAL_STATUSES:
            state.ended_at = _now()
        if error is not None:
            state.error = error
        if result is not None:
            state.result = _bounded(result)
        payload: dict[str, Any] = {"status": status, "error": error}
        if status == "waiting_human":
            payload["tasks"] = self._tasks.summaries(state.run_id)
        self._record(state, f"run/{status}", None, payload)
        self._emit({"jsonrpc": "2.0", "method": "run/status", "params": {"runId": state.run_id, **payload}})

    def _runtime_context(self, state: RunState) -> dict[str, Any]:
        """Assemble ``config['context']`` for this run.

        The headless engine has no app configuration, tool gateway, or project
        metadata yet; both namespaces stay ``None`` so every optional capability
        reports its own explicit "not wired" error instead of a wrong default.
        Human nodes need the task store; it is the one capability this build wires.
        """
        record = SimpleNamespace(run_id=state.run_id, thread_id=state.run_id, user_id=DEFAULT_USER_ID, metadata=state.metadata)
        run_ctx = SimpleNamespace(app_config=None, checkpointer=state.checkpointer, spec_repo=None)
        return build_workflow_runtime_context(record=record, run_ctx=run_ctx, human_task_repo=self._tasks)

    def _note_node(self, state: RunState, node_id: str, status: str, data: dict[str, Any] | None = None, error: str | None = None) -> None:
        """Fold a node lifecycle event into the run's node table."""
        entry = state.nodes.setdefault(node_id, {"nodeId": node_id})
        entry["status"] = status
        entry[f"{status}At"] = _now()
        if data:
            entry.update(_bounded(data))
        if error is not None:
            entry["error"] = error

    async def _stream(self, state: RunState, graph_input: Any) -> None:
        """Stream the run's graph from ``graph_input`` and translate its events.

        ``graph_input`` is the initial state mapping for a fresh run, or a
        ``Command(resume=...)`` for a resumed one. The checkpoint is the run's own
        thread either way, so a resume continues where the graph suspended.
        """
        if state.status != "running":
            self._transition(state, "running")
        try:
            async for chunk in state.graph.astream(graph_input, state.config, stream_mode=["updates", "custom"]):
                if state.cancel_requested:
                    break
                if not (isinstance(chunk, tuple) and len(chunk) == 2):
                    continue
                mode, data = chunk
                if mode != "custom" or not isinstance(data, dict):
                    continue
                if data.get("depth", 0) != 0:
                    continue
                node_id = data.get("node_id")
                if not isinstance(node_id, str):
                    continue
                kind = data.get("type")
                if kind == "wf:node:started":
                    self._note_node(state, node_id, "running")
                    self._record(state, "node/started", node_id, {"nodeId": node_id})
                elif kind == "wf:node:completed":
                    output = data.get("output")
                    self._note_node(state, node_id, "succeeded", {"output": output} if output is not None else None)
                    self._record(state, "node/completed", node_id, {"nodeId": node_id, "output": output})
                elif kind == "wf:node:failed":
                    self._note_node(state, node_id, "failed", error=str(data.get("error", "")))
                    self._record(state, "node/failed", node_id, {"nodeId": node_id, "error": str(data.get("error", ""))})

            if state.cancel_requested:
                self._transition(state, "cancelled")
                return
            if await self._suspended(state):
                self._transition(state, "waiting_human")
                return
            result = await self._final_result(state, state.graph, state.config)
            self._transition(state, "succeeded", result=result)
        except asyncio.CancelledError:
            self._transition(state, "cancelled")
        except Exception as exc:  # noqa: BLE001 - any node failure ends this run, never the engine
            logger.warning("run %s failed: %s", state.run_id, exc, exc_info=True)
            self._transition(state, "failed", error=f"{type(exc).__name__}: {exc}")

    async def _suspended(self, state: RunState) -> bool:
        """Whether the graph stopped on an ``interrupt()`` instead of finishing."""
        try:
            snapshot = await state.graph.aget_state(state.config)
        except Exception:  # noqa: BLE001 - an unreadable checkpoint means "not suspended"
            logger.debug("run %s has no readable state after streaming", state.run_id, exc_info=True)
            return False
        return bool(getattr(snapshot, "next", None))

    async def _final_result(self, state: RunState, graph: Any, config: dict[str, Any]) -> Any:
        """Read the run result from the ports wired into ``flow:end``.

        The end node stores nothing of its own, so the result is the state
        values of the edges that feed it, keyed by the end node's port names.
        Falls back to the whole ``wf:*`` state slice when the definition has no
        inbound end edge (a shape the validator already rejects).
        """
        end_node = next((node for node in state.definition.nodes if node.type == NodeType.FLOW_END), None)
        if end_node is None:
            return None
        try:
            snapshot = await graph.aget_state(config)
        except Exception:  # noqa: BLE001 - a missing checkpoint must not fail a finished run
            logger.debug("run %s has no readable final state", state.run_id, exc_info=True)
            return None
        values = getattr(snapshot, "values", None)
        if not isinstance(values, dict):
            return None

        result: dict[str, Any] = {}
        for edge in state.definition.edges:
            if edge.target != end_node.id:
                continue
            source_key = f"wf:{edge.source}:{edge.source_port}"
            if source_key in values:
                result[edge.target_port] = values[source_key]
        if result:
            return result

        fallback = {key: value for key, value in values.items() if isinstance(key, str) and key.startswith("wf:") and "__duration_ms" not in key}
        return fallback or None


def _coerce_definition(raw: Any) -> WorkflowDefinition:
    """Accept a definition object (the asset's ``definition`` member)."""
    if isinstance(raw, WorkflowDefinition):
        return raw
    if not isinstance(raw, dict):
        raise EngineError("invalid-definition", "definition must be a JSON object")
    try:
        return WorkflowDefinition.model_validate(raw)
    except Exception as exc:  # noqa: BLE001 - pydantic errors are caller input errors
        raise EngineError("invalid-definition", f"definition does not match the schema: {exc}") from exc


def _graph_input(definition: WorkflowDefinition, params: dict[str, Any]) -> dict[str, Any]:
    """Seed the start node's ports from caller-supplied run inputs.

    Mirrors ``worker._build_graph_input``; kept local so this module does not
    depend on a private helper of the gateway path.
    """
    if not params:
        return {}
    start_node = next((node for node in definition.nodes if node.type == NodeType.FLOW_START), None)
    if start_node is None:
        return {}
    return {f"wf:{start_node.id}:{port_name}": value for port_name, value in params.items()}


def _bounded(value: Any, depth: int = 0) -> Any:
    """Copy ``value`` into JSON-safe data, truncating oversized strings/containers."""
    if depth > 6:
        return "..."
    if value is None or isinstance(value, (bool, int, float)):
        return value
    if isinstance(value, str):
        return value if len(value) <= MAX_VALUE_BYTES else value[:MAX_VALUE_BYTES] + "…"
    if isinstance(value, dict):
        return {str(key): _bounded(item, depth + 1) for key, item in list(value.items())[:_MAX_RUN_DEPTH]}
    if isinstance(value, (list, tuple)):
        return [_bounded(item, depth + 1) for item in list(value)[:_MAX_RUN_DEPTH]]
    return _bounded(str(value), depth + 1)


__all__ = ["MAX_EVENTS_PER_RUN", "MAX_RETAINED_RUNS", "RunHost", "RunState"]
