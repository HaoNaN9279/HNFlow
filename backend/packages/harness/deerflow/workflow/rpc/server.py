"""JSON-RPC dispatch and the stdio serve loop.

Transport specifics stay in :func:`serve`; :class:`RpcServer` is a plain
request/response dispatcher so tests can drive it without pipes.
"""

from __future__ import annotations

import asyncio
import json
import logging
import sys
import threading
from collections.abc import Awaitable, Callable
from typing import Any

from deerflow.workflow.rpc.describe import describe
from deerflow.workflow.rpc.protocol import (
    INTERNAL_ERROR,
    INVALID_REQUEST,
    METHOD_NOT_FOUND,
    PROTOCOL_VERSION,
    EngineError,
    InvalidParams,
    RpcError,
    decode,
    encode,
)
from deerflow.workflow.rpc.runner import RunHost
from deerflow.workflow.workflow_io import SCHEMA_VERSION, deserialize, validate_definition

logger = logging.getLogger(__name__)

ENGINE_NAME = "hnflow-engine"
ENGINE_VERSION = "0.1.0"

Params = dict[str, Any]
Handler = Callable[[Params], Awaitable[dict[str, Any]]]


class RpcServer:
    """Dispatch JSON-RPC requests onto a :class:`RunHost`."""

    def __init__(self) -> None:
        self._emit: Callable[[dict[str, Any]], None] = lambda _message: None
        self._host = RunHost(emit=self._notify)
        self._shutdown_requested = False
        self._initialized = False

    # ── wiring ─────────────────────────────────────────────────────────────

    def set_emit(self, emit: Callable[[dict[str, Any]], None]) -> None:
        """Install the notification sink (the stdio writer in production)."""
        self._emit = emit

    def _notify(self, message: dict[str, Any]) -> None:
        """Forward a host notification, never letting a broken pipe escape."""
        try:
            self._emit(message)
        except Exception:  # noqa: BLE001 - a dead client must not kill a run
            logger.debug("notification dropped", exc_info=True)

    @property
    def host(self) -> RunHost:
        """The run host this server dispatches to."""
        return self._host

    @property
    def shutdown_requested(self) -> bool:
        """Whether ``engine/shutdown`` has been dispatched."""
        return self._shutdown_requested

    # ── methods ────────────────────────────────────────────────────────────

    def methods(self) -> dict[str, Handler]:
        """The method table; unknown names are ``-32601``."""
        return {
            "engine/initialize": self._initialize,
            "engine/ping": self._ping,
            "engine/shutdown": self._shutdown,
            "workflow/validate": self._validate,
            "workflow/describe": self._describe,
            "run/start": self._run_start,
            "run/status": self._run_status,
            "run/cancel": self._run_cancel,
            "run/events": self._run_events,
            "run/list": self._run_list,
            "task/list": self._task_list,
            "task/submit": self._task_submit,
        }

    async def dispatch(self, message: dict[str, Any]) -> dict[str, Any] | None:
        """Handle one decoded request; returns ``None`` for notifications."""
        request_id = message.get("id")
        is_notification = "id" not in message
        try:
            method = message.get("method")
            if not isinstance(method, str) or not method:
                raise RpcError(INVALID_REQUEST, "request.method must be a non-empty string")
            handler = self.methods().get(method)
            if handler is None:
                raise RpcError(METHOD_NOT_FOUND, f"unknown method {method!r}")
            raw_params = message.get("params")
            if raw_params is None:
                params: Params = {}
            elif isinstance(raw_params, dict):
                params = raw_params
            else:
                raise InvalidParams("request.params must be an object")
            result = await handler(params)
            if is_notification:
                return None
            return {"jsonrpc": "2.0", "id": request_id, "result": result}
        except RpcError as exc:
            if is_notification:
                return None
            return {"jsonrpc": "2.0", "id": request_id, "error": exc.to_error()}
        except Exception as exc:  # noqa: BLE001 - an engine bug is reported, not fatal
            logger.exception("unhandled engine failure in %s", message.get("method"))
            if is_notification:
                return None
            return {"jsonrpc": "2.0", "id": request_id, "error": {"code": INTERNAL_ERROR, "message": f"{type(exc).__name__}: {exc}"}}

    # ── handlers ───────────────────────────────────────────────────────────

    async def _initialize(self, params: Params) -> dict[str, Any]:
        """Version handshake; the plugin fails loud on a mismatch."""
        client_protocol = params.get("protocolVersion")
        if client_protocol != PROTOCOL_VERSION:
            raise EngineError(
                "protocol-mismatch",
                f"plugin speaks protocol {client_protocol!r}, engine speaks {PROTOCOL_VERSION}",
                {"engineProtocolVersion": PROTOCOL_VERSION},
            )
        self._initialized = True
        return {
            "protocolVersion": PROTOCOL_VERSION,
            "engine": {"name": ENGINE_NAME, "version": ENGINE_VERSION},
            "capabilities": {"humanTasks": True, "durableRuns": False, "jobMirror": True},
            "workflow": {"schemaVersion": SCHEMA_VERSION, **describe()},
        }

    async def _ping(self, _params: Params) -> dict[str, Any]:
        """Liveness probe used by the plugin before it reports "engine down"."""
        return {"engine": {"name": ENGINE_NAME, "version": ENGINE_VERSION}, "protocolVersion": PROTOCOL_VERSION}

    async def _shutdown(self, _params: Params) -> dict[str, Any]:
        """Ask the serve loop to exit after this response is written."""
        self._shutdown_requested = True
        return {"ok": True}

    async def _validate(self, params: Params) -> dict[str, Any]:
        """Validate a definition without compiling or running it."""
        definition = params.get("definition")
        if not isinstance(definition, dict):
            raise InvalidParams("definition must be a JSON object")
        def_ = _definition_from_wire(definition)
        errors = validate_definition(def_)
        return {"valid": not errors, "errors": errors}

    async def _describe(self, _params: Params) -> dict[str, Any]:
        """Return the node/port catalog."""
        return describe()

    async def _run_start(self, params: Params) -> dict[str, Any]:
        """Compile and start a run; the returned id addresses it afterwards."""
        return await self._host.start(
            definition=params.get("definition"),
            inputs=_optional_object(params, "inputs"),
            metadata=_optional_object(params, "metadata"),
        )

    async def _run_status(self, params: Params) -> dict[str, Any]:
        """Return one run record."""
        return self._host.status(_required_id(params, "runId"))

    async def _run_cancel(self, params: Params) -> dict[str, Any]:
        """Request cooperative cancellation."""
        return self._host.cancel(_required_id(params, "runId"))

    async def _run_events(self, params: Params) -> dict[str, Any]:
        """Return the event slice after ``afterSeq``."""
        after_seq = params.get("afterSeq", 0)
        if not isinstance(after_seq, int) or after_seq < 0:
            raise InvalidParams("afterSeq must be a non-negative integer")
        return self._host.events(_required_id(params, "runId"), after_seq)

    async def _run_list(self, _params: Params) -> dict[str, Any]:
        """Return every retained run."""
        return self._host.list_runs()

    async def _task_list(self, params: Params) -> dict[str, Any]:
        """Return pending human tasks, for one run or for the whole engine."""
        run_id = params.get("runId")
        if run_id is not None and (not isinstance(run_id, str) or not run_id):
            raise InvalidParams("runId must be a non-empty string when present")
        return self._host.tasks(run_id)

    async def _task_submit(self, params: Params) -> dict[str, Any]:
        """Submit a task and continue its run from the suspended checkpoint."""
        payload = params.get("payload")
        if not isinstance(payload, dict):
            raise InvalidParams("payload must be a JSON object")
        revision = params.get("revision")
        if revision is not None and (not isinstance(revision, int) or revision < 1):
            raise InvalidParams("revision must be a positive integer when present")
        return await self._host.submit(task_id=_required_id(params, "taskId"), payload=payload, revision=revision)


def _required_id(params: Params, key: str) -> str:
    """Read a required non-empty string parameter."""
    value = params.get(key)
    if not isinstance(value, str) or not value:
        raise InvalidParams(f"{key} must be a non-empty string")
    return value


def _optional_object(params: Params, key: str) -> dict[str, Any]:
    """Read an optional object parameter."""
    value = params.get(key)
    if value is None:
        return {}
    if not isinstance(value, dict):
        raise InvalidParams(f"{key} must be a JSON object")
    return value


def _definition_from_wire(raw: dict[str, Any]) -> Any:
    """Accept a bare workflow object or a ``serialize()`` envelope."""
    if "workflow" in raw and "schema_version" in raw:
        return deserialize(json.dumps(raw))
    return deserialize(json.dumps({"schema_version": SCHEMA_VERSION, "workflow": raw}))


async def serve() -> int:
    """Run the engine on stdin/stdout until EOF or ``engine/shutdown``."""
    server = RpcServer()
    loop = asyncio.get_running_loop()
    incoming: asyncio.Queue[bytes | None] = asyncio.Queue()
    outgoing: asyncio.Queue[str | None] = asyncio.Queue()

    def read_stdin() -> None:
        """Feed decoded lines onto the event loop from a reader thread."""
        try:
            for line in sys.stdin.buffer:
                loop.call_soon_threadsafe(incoming.put_nowait, line)
        except Exception:  # noqa: BLE001 - EOF and pipe errors both end the session
            logger.debug("stdin reader stopped", exc_info=True)
        finally:
            loop.call_soon_threadsafe(incoming.put_nowait, None)

    async def write_stdout() -> None:
        """Write every queued frame in order."""
        while True:
            frame = await outgoing.get()
            if frame is None:
                return
            sys.stdout.write(frame)
            sys.stdout.flush()

    def enqueue(message: dict[str, Any]) -> None:
        """Serialize a notification into the writer queue."""
        outgoing.put_nowait(encode(message))

    server.set_emit(enqueue)
    writer = asyncio.create_task(write_stdout(), name="hnflow-rpc-writer")
    threading.Thread(target=read_stdin, name="hnflow-rpc-reader", daemon=True).start()

    async def handle(line: bytes) -> None:
        """Decode, dispatch, and answer one line."""
        try:
            message = decode(line.decode("utf-8", errors="replace"))
        except RpcError as exc:
            enqueue({"jsonrpc": "2.0", "id": None, "error": exc.to_error()})
            return
        response = await server.dispatch(message)
        if response is not None:
            enqueue(response)
        if server.shutdown_requested:
            incoming.put_nowait(None)

    pending: set[asyncio.Task[None]] = set()
    try:
        while True:
            line = await incoming.get()
            if line is None:
                break
            if not line.strip():
                continue
            task = asyncio.create_task(handle(line))
            pending.add(task)
            task.add_done_callback(pending.discard)
        if pending:
            await asyncio.gather(*pending, return_exceptions=True)
    finally:
        await server.host.close()
        outgoing.put_nowait(None)
        await writer
    return 0


__all__ = ["ENGINE_NAME", "ENGINE_VERSION", "RpcServer", "serve"]
