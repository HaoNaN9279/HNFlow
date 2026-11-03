"""Headless RPC surface of the workflow engine.

The DSH plugin is the only production client, so these tests pin the wire
contract it depends on: line framing, the version handshake, definition
validation, the run lifecycle, and cooperative cancellation.
"""

from __future__ import annotations

import asyncio
import json
import subprocess
import sys
from typing import Any

from deerflow.workflow.rpc.protocol import PROTOCOL_VERSION, RpcError, decode, encode
from deerflow.workflow.rpc.server import RpcServer

_TERMINAL = {"succeeded", "failed", "cancelled"}


def _hello_definition(value: str = "hello from HNFlow") -> dict[str, Any]:
    """The minimal start → assign → end graph."""
    return {
        "id": "hello-workflow",
        "name": "Hello workflow",
        "version": "0.1.0",
        "nodes": [
            {"id": "start", "type": "flow:start", "outputs": [{"name": "out", "type": "data"}]},
            {"id": "greet", "type": "data:assign", "inputs": [{"name": "in", "type": "data"}], "outputs": [{"name": "out", "type": "data"}], "params": {"value": value}},
            {"id": "end", "type": "flow:end", "inputs": [{"name": "in", "type": "data"}]},
        ],
        "edges": [
            {"source": "start", "source_port": "out", "target": "greet", "target_port": "in"},
            {"source": "greet", "source_port": "out", "target": "end", "target_port": "in"},
        ],
    }


def _wait_definition(duration: float) -> dict[str, Any]:
    """start → wait → end, used to observe cancellation."""
    return {
        "id": "wait-workflow",
        "name": "Wait workflow",
        "version": "0.1.0",
        "nodes": [
            {"id": "start", "type": "flow:start", "outputs": [{"name": "out", "type": "data"}]},
            {"id": "pause", "type": "flow:wait", "inputs": [{"name": "in", "type": "data"}], "outputs": [{"name": "out", "type": "data"}], "params": {"duration": duration}},
            {"id": "end", "type": "flow:end", "inputs": [{"name": "in", "type": "data"}]},
        ],
        "edges": [
            {"source": "start", "source_port": "out", "target": "pause", "target_port": "in"},
            {"source": "pause", "source_port": "out", "target": "end", "target_port": "in"},
        ],
    }


def _request(method: str, params: dict[str, Any] | None = None, request_id: int = 1) -> dict[str, Any]:
    """Build a JSON-RPC request envelope."""
    return {"jsonrpc": "2.0", "id": request_id, "method": method, "params": params or {}}


async def _await_terminal(server: RpcServer, run_id: str, timeout: float = 10.0) -> dict[str, Any]:
    """Poll ``run/status`` until the run settles."""
    deadline = asyncio.get_running_loop().time() + timeout
    while True:
        response = await server.dispatch(_request("run/status", {"runId": run_id}))
        status = response["result"]
        if status["status"] in _TERMINAL:
            return status
        if asyncio.get_running_loop().time() > deadline:
            raise AssertionError(f"run {run_id} did not settle: {status}")
        await asyncio.sleep(0.02)


def _as(text: str) -> Any:
    """Shorthand for parsing a worker line in tests."""
    return json.loads(text)


# ── framing ───────────────────────────────────────────────────────────────────


def test_encode_emits_one_line_of_json() -> None:
    line = encode({"jsonrpc": "2.0", "id": 7, "result": {"ok": True}})

    assert line.endswith("\n")
    assert line.count("\n") == 1
    assert json.loads(line)["id"] == 7


def test_decode_rejects_malformed_json() -> None:
    try:
        decode("{not json")
    except RpcError as exc:
        assert exc.code == -32700
    else:
        raise AssertionError("malformed JSON must raise RpcError")


def test_decode_rejects_non_object_payload() -> None:
    try:
        decode("[1, 2, 3]")
    except RpcError as exc:
        assert exc.code == -32600
    else:
        raise AssertionError("a non-object request must raise RpcError")


# ── handshake and dispatch ────────────────────────────────────────────────────


def test_initialize_returns_the_catalog() -> None:
    async def scenario() -> dict[str, Any]:
        server = RpcServer()
        response = await server.dispatch(_request("engine/initialize", {"protocolVersion": PROTOCOL_VERSION}))
        return response["result"]

    result = asyncio.run(scenario())

    assert result["protocolVersion"] == PROTOCOL_VERSION
    assert result["engine"]["name"] == "hnflow-engine"
    assert result["capabilities"]["humanTasks"] is False
    assert result["workflow"]["schemaVersion"] == 1
    assert any(node["type"] == "ai:llm_agent" for node in result["workflow"]["nodeTypes"])


def test_initialize_rejects_a_protocol_mismatch() -> None:
    async def scenario() -> dict[str, Any]:
        server = RpcServer()
        return await server.dispatch(_request("engine/initialize", {"protocolVersion": 99}))

    response = asyncio.run(scenario())

    assert response["error"]["code"] == -32000
    assert response["error"]["data"]["code"] == "protocol-mismatch"
    assert response["error"]["data"]["engineProtocolVersion"] == PROTOCOL_VERSION


def test_unknown_method_is_a_jsonrpc_error() -> None:
    async def scenario() -> dict[str, Any]:
        return await RpcServer().dispatch(_request("workflow/nope"))

    response = asyncio.run(scenario())

    assert response["error"]["code"] == -32601


def test_notification_gets_no_response() -> None:
    async def scenario() -> dict[str, Any] | None:
        return await RpcServer().dispatch({"jsonrpc": "2.0", "method": "engine/ping", "params": {}})

    assert asyncio.run(scenario()) is None


# ── validation ────────────────────────────────────────────────────────────────


def test_validate_accepts_the_hello_definition() -> None:
    async def scenario() -> dict[str, Any]:
        return (await RpcServer().dispatch(_request("workflow/validate", {"definition": _hello_definition()})))["result"]

    result = asyncio.run(scenario())

    assert result["valid"] is True
    assert result["errors"] == []


def test_validate_reports_a_dangling_edge() -> None:
    definition = _hello_definition()
    definition["edges"][1]["target"] = "missing"

    async def scenario() -> dict[str, Any]:
        return (await RpcServer().dispatch(_request("workflow/validate", {"definition": definition})))["result"]

    result = asyncio.run(scenario())

    assert result["valid"] is False
    assert any("missing" in error for error in result["errors"])


def test_describe_lists_every_node_type() -> None:
    async def scenario() -> dict[str, Any]:
        return (await RpcServer().dispatch(_request("workflow/describe")))["result"]

    result = asyncio.run(scenario())

    types = {node["type"] for node in result["nodeTypes"]}
    assert {"flow:start", "human:task", "verify:gate"} <= types
    assert "data" in result["portTypes"]


# ── runs ──────────────────────────────────────────────────────────────────────


def test_run_start_completes_and_records_node_events() -> None:
    async def scenario() -> tuple[dict[str, Any], dict[str, Any]]:
        server = RpcServer()
        started = (await server.dispatch(_request("run/start", {"definition": _hello_definition()})))["result"]
        status = await _await_terminal(server, started["runId"])
        events = (await server.dispatch(_request("run/events", {"runId": started["runId"]})))["result"]
        return status, events

    status, events = asyncio.run(scenario())

    assert status["status"] == "succeeded"
    assert status["result"] == {"in": "hello from HNFlow"}
    assert status["error"] is None
    kinds = [event["type"] for event in events["events"]]
    assert kinds[0] == "run/started"
    assert "node/started" in kinds
    assert "node/completed" in kinds
    assert kinds[-1] == "run/succeeded"
    seqs = [event["seq"] for event in events["events"]]
    assert seqs == sorted(seqs)


def test_run_events_honour_after_seq() -> None:
    async def scenario() -> dict[str, Any]:
        server = RpcServer()
        started = (await server.dispatch(_request("run/start", {"definition": _hello_definition()})))["result"]
        await _await_terminal(server, started["runId"])
        return (await server.dispatch(_request("run/events", {"runId": started["runId"], "afterSeq": 2})))["result"]

    events = asyncio.run(scenario())

    assert events["events"]
    assert all(event["seq"] > 2 for event in events["events"])


def test_run_start_rejects_human_nodes_with_a_stable_code() -> None:
    definition = _hello_definition()
    definition["nodes"][1] = {
        "id": "approve",
        "type": "human:task",
        "inputs": [{"name": "in", "type": "data"}],
        "outputs": [{"name": "out", "type": "data"}],
        "params": {"fields": [{"name": "note", "type": "data"}]},
    }
    definition["edges"] = [
        {"source": "start", "source_port": "out", "target": "approve", "target_port": "in"},
        {"source": "approve", "source_port": "out", "target": "end", "target_port": "in"},
    ]

    async def scenario() -> dict[str, Any]:
        return await RpcServer().dispatch(_request("run/start", {"definition": definition}))

    response = asyncio.run(scenario())

    assert response["error"]["data"]["code"] == "human-tasks-unavailable"
    assert response["error"]["data"]["nodes"] == ["approve"]


def test_run_cancel_stops_the_stream() -> None:
    async def scenario() -> dict[str, Any]:
        server = RpcServer()
        started = (await server.dispatch(_request("run/start", {"definition": _wait_definition(0.3)})))["result"]
        await asyncio.sleep(0.05)
        cancelled = (await server.dispatch(_request("run/cancel", {"runId": started["runId"]})))["result"]
        assert cancelled["cancelled"] is True
        return await _await_terminal(server, started["runId"])

    status = asyncio.run(scenario())

    assert status["status"] == "cancelled"
    assert status["result"] is None


def test_unknown_run_is_a_stable_error() -> None:
    async def scenario() -> dict[str, Any]:
        return await RpcServer().dispatch(_request("run/status", {"runId": "run-nope"}))

    response = asyncio.run(scenario())

    assert response["error"]["data"]["code"] == "unknown-run"


# ── stdio transport ───────────────────────────────────────────────────────────


def test_stdio_transport_serves_a_session() -> None:
    process = subprocess.Popen(
        [sys.executable, "-m", "deerflow.workflow.rpc"],
        stdin=subprocess.PIPE,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        text=True,
        encoding="utf-8",
    )
    assert process.stdin is not None
    assert process.stdout is not None
    try:
        process.stdin.write(encode(_request("engine/initialize", {"protocolVersion": PROTOCOL_VERSION})))
        process.stdin.write(encode(_request("engine/shutdown", {}, request_id=2)))
        process.stdin.flush()
        first = _as(process.stdout.readline())
        second = _as(process.stdout.readline())
    finally:
        process.stdin.close()
        process.wait(timeout=30)

    assert first["result"]["protocolVersion"] == PROTOCOL_VERSION
    assert second["result"] == {"ok": True}
    assert process.returncode == 0
