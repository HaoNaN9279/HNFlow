"""Headless RPC surface of the workflow engine.

The DSH plugin is the only production client, so these tests pin the wire
contract it depends on: line framing, the version handshake, definition
validation, the run lifecycle, and cooperative cancellation.
"""

from __future__ import annotations

import asyncio
import json
import os
import subprocess
import sys
import tempfile
from pathlib import Path
from typing import Any

from deerflow.workflow.rpc.protocol import PROTOCOL_VERSION, RpcError, decode, encode
from deerflow.workflow.rpc.runner import RunHost
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


def _human_task_definition() -> dict[str, Any]:
    """start → human:task → end, with one required output port."""
    return {
        "id": "approve-workflow",
        "name": "Approve workflow",
        "version": "0.1.0",
        "nodes": [
            {"id": "start", "type": "flow:start", "outputs": [{"name": "out", "type": "data"}]},
            {
                "id": "approve",
                "type": "human:task",
                "inputs": [{"name": "in", "type": "data"}],
                "outputs": [{"name": "note", "type": "data", "required": True}],
                "params": {"description": "confirm the release"},
            },
            {"id": "end", "type": "flow:end", "inputs": [{"name": "in", "type": "data"}]},
        ],
        "edges": [
            {"source": "start", "source_port": "out", "target": "approve", "target_port": "in"},
            {"source": "approve", "source_port": "note", "target": "end", "target_port": "in"},
        ],
    }


def _ai_definition() -> dict[str, Any]:
    """start → ai:llm_agent → end."""
    return {
        "id": "ai-workflow",
        "name": "AI workflow",
        "version": "0.1.0",
        "nodes": [
            {"id": "start", "type": "flow:start", "outputs": [{"name": "out", "type": "data"}]},
            {
                "id": "write",
                "type": "ai:llm_agent",
                "inputs": [{"name": "task", "type": "data"}],
                "outputs": [{"name": "out", "type": "data"}],
                "params": {"template_prompt": "write a haiku"},
            },
            {"id": "end", "type": "flow:end", "inputs": [{"name": "in", "type": "data"}]},
        ],
        "edges": [
            {"source": "start", "source_port": "out", "target": "write", "target_port": "task"},
            {"source": "write", "source_port": "out", "target": "end", "target_port": "in"},
        ],
    }


async def _await_terminal(server: RpcServer, run_id: str, timeout: float = 10.0, wanted: set[str] | frozenset[str] = _TERMINAL) -> dict[str, Any]:
    """Poll ``run/status`` until the run reaches one of ``wanted``."""
    deadline = asyncio.get_running_loop().time() + timeout
    while True:
        response = await server.dispatch(_request("run/status", {"runId": run_id}))
        status = response["result"]
        if status["status"] in wanted:
            return status
        if asyncio.get_running_loop().time() > deadline:
            raise AssertionError(f"run {run_id} did not reach {sorted(wanted)}: {status}")
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
    assert result["capabilities"]["humanTasks"] is True
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


def test_human_task_suspends_the_run_with_a_pending_task() -> None:
    async def scenario() -> dict[str, Any]:
        server = RpcServer()
        started = (await server.dispatch(_request("run/start", {"definition": _human_task_definition()})))["result"]
        return await _await_terminal(server, started["runId"], wanted={"waiting_human", "failed", "succeeded"})

    status = asyncio.run(scenario())

    assert status["status"] == "waiting_human"
    assert len(status["pendingTasks"]) == 1
    task = status["pendingTasks"][0]
    assert task["nodeId"] == "approve"
    assert task["kind"] == "task"
    assert task["description"] == "confirm the release"
    assert [port["name"] for port in task["outputSpec"]["ports"]] == ["note"]


def test_task_list_returns_pending_tasks() -> None:
    async def scenario() -> dict[str, Any]:
        server = RpcServer()
        started = (await server.dispatch(_request("run/start", {"definition": _human_task_definition()})))["result"]
        await _await_terminal(server, started["runId"], wanted={"waiting_human"})
        return (await server.dispatch(_request("task/list", {"runId": started["runId"]})))["result"]

    result = asyncio.run(scenario())

    assert len(result["tasks"]) == 1
    assert result["tasks"][0]["runId"].startswith("run-")


def test_task_submit_resumes_the_run_to_completion() -> None:
    async def scenario() -> tuple[dict[str, Any], dict[str, Any]]:
        server = RpcServer()
        started = (await server.dispatch(_request("run/start", {"definition": _human_task_definition()})))["result"]
        waiting = await _await_terminal(server, started["runId"], wanted={"waiting_human"})
        task_id = waiting["pendingTasks"][0]["taskId"]
        submitted = (await server.dispatch(_request("task/submit", {"taskId": task_id, "payload": {"note": "looks good"}})))["result"]
        assert submitted["taskId"] == task_id
        return submitted, await _await_terminal(server, started["runId"])

    submitted, final = asyncio.run(scenario())

    assert submitted["status"] == "running"
    assert final["status"] == "succeeded"
    assert final["result"] == {"in": "looks good"}
    assert final["pendingTasks"] == []


def test_task_submit_refuses_a_duplicate_submission() -> None:
    async def scenario() -> dict[str, Any]:
        server = RpcServer()
        started = (await server.dispatch(_request("run/start", {"definition": _human_task_definition()})))["result"]
        waiting = await _await_terminal(server, started["runId"], wanted={"waiting_human"})
        task_id = waiting["pendingTasks"][0]["taskId"]
        await server.dispatch(_request("task/submit", {"taskId": task_id, "payload": {"note": "first"}}))
        await _await_terminal(server, started["runId"])
        return await server.dispatch(_request("task/submit", {"taskId": task_id, "payload": {"note": "second"}}))

    response = asyncio.run(scenario())

    assert response["error"]["data"]["code"] == "run-not-waiting"


def test_task_submit_validates_the_declared_ports() -> None:
    async def scenario() -> dict[str, Any]:
        server = RpcServer()
        started = (await server.dispatch(_request("run/start", {"definition": _human_task_definition()})))["result"]
        waiting = await _await_terminal(server, started["runId"], wanted={"waiting_human"})
        task_id = waiting["pendingTasks"][0]["taskId"]
        return await server.dispatch(_request("task/submit", {"taskId": task_id, "payload": {"typo": "x"}}))

    response = asyncio.run(scenario())

    assert response["error"]["data"]["code"] == "task-invalid"


def test_cancelling_a_waiting_run_drops_its_tasks() -> None:
    async def scenario() -> tuple[dict[str, Any], dict[str, Any]]:
        server = RpcServer()
        started = (await server.dispatch(_request("run/start", {"definition": _human_task_definition()})))["result"]
        awaiting = await _await_terminal(server, started["runId"], wanted={"waiting_human"})
        cancelled = (await server.dispatch(_request("run/cancel", {"runId": started["runId"]})))["result"]
        tasks = (await server.dispatch(_request("task/list", {"runId": started["runId"]})))["result"]
        assert awaiting["status"] == "waiting_human"
        return cancelled, tasks

    cancelled, tasks = asyncio.run(scenario())

    assert cancelled["status"] == "cancelled"
    assert tasks["tasks"] == []


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


def _ai_definition_models() -> list[dict[str, Any]]:
    """A minimal model catalog entry the engine accepts."""
    return [
        {
            "name": "test-model",
            "use": "deerflow.models.patched_deepseek:PatchedChatDeepSeek",
            "model": "test-model",
            "api_base": "http://127.0.0.1:9/v1",
            "api_key": "test-key",
        }
    ]


def test_an_ai_workflow_without_models_fails_loud() -> None:
    async def scenario() -> dict[str, Any]:
        return await RpcServer().dispatch(_request("run/start", {"definition": _ai_definition()}))

    response = asyncio.run(scenario())

    assert response["error"]["data"]["code"] == "models-unavailable"
    assert response["error"]["data"]["nodes"] == ["write"]


def test_initialize_installs_the_supplied_model_catalog() -> None:
    async def scenario() -> tuple[dict[str, Any], int, int]:
        server = RpcServer()
        handshake = (await server.dispatch(_request("engine/initialize", {"protocolVersion": PROTOCOL_VERSION, "models": _ai_definition_models()})))["result"]
        bad = await server.dispatch(_request("engine/initialize", {"protocolVersion": PROTOCOL_VERSION, "models": [{"name": "x"}, "nope"]}))
        return handshake, handshake["capabilities"]["models"], bad["result"]["capabilities"]["models"]

    handshake, count, after_bad = asyncio.run(scenario())

    assert count == 1
    assert after_bad == 0


def test_the_model_catalog_reaches_the_run_context() -> None:
    host = RunHost()
    assert host.configure_models(_ai_definition_models()) == 1
    assert host.model_count == 1
    config = host._resolve_app_config()
    assert config is not None
    assert [model.name for model in config.models] == ["test-model"]


# ── durability ────────────────────────────────────────────────────────────────


def _temp_state_dir() -> Path:
    """A throwaway state directory.

    ``tempfile.mkdtemp`` and pytest's ``tmp_path`` both create directories whose
    Windows ACL the sandbox cannot write SQLite files into, so the directory is
    created with a plain mkdir under a writable temp root instead.
    """
    base = Path(tempfile.gettempdir()) / "hnflow-rpc"
    base.mkdir(exist_ok=True)
    directory = base / os.urandom(4).hex()
    directory.mkdir()
    return directory


def test_waiting_run_and_pending_task_survive_a_restart() -> None:
    state = _temp_state_dir()

    async def first_session() -> tuple[str, str]:
        host = RunHost(state_dir=str(state))
        await host.boot()
        try:
            started = await host.start(definition=_human_task_definition())
            run_id = started["runId"]
            for _ in range(300):
                status = host.status(run_id)
                if status["status"] == "waiting_human":
                    return run_id, status["pendingTasks"][0]["taskId"]
                await asyncio.sleep(0.02)
            raise AssertionError(f"run never waited: {status}")
        finally:
            await host.close()

    async def second_session(run_id: str, task_id: str) -> tuple[dict[str, Any], dict[str, Any]]:
        host = RunHost(state_dir=str(state))
        await host.boot()
        try:
            restored = host.status(run_id)
            await host.submit(task_id=task_id, payload={"note": "after restart"})
            for _ in range(300):
                final = host.status(run_id)
                if final["status"] in _TERMINAL:
                    return restored, final
                await asyncio.sleep(0.02)
            raise AssertionError(f"resumed run never settled: {final}")
        finally:
            await host.close()

    run_id, task_id = asyncio.run(first_session())
    restored, final = asyncio.run(second_session(run_id, task_id))

    assert restored["status"] == "waiting_human"
    assert restored["pendingTasks"][0]["taskId"] == task_id
    assert final["status"] == "succeeded"
    assert final["result"] == {"in": "after restart"}


def test_a_run_that_was_streaming_becomes_interrupted_and_resumes() -> None:
    state = _temp_state_dir()

    async def run_once() -> str:
        host = RunHost(state_dir=str(state))
        await host.boot()
        try:
            started = await host.start(definition=_wait_definition(0.01))
            for _ in range(300):
                status = host.status(started["runId"])
                if status["status"] in _TERMINAL:
                    return started["runId"]
                await asyncio.sleep(0.02)
            raise AssertionError(f"run never settled: {status}")
        finally:
            await host.close()

    run_id = asyncio.run(run_once())

    # Simulate a process that died mid-run: the record still says "running".
    records = json.loads((state / "runs.json").read_text(encoding="utf-8"))
    records["runs"][0]["status"] = "running"
    (state / "runs.json").write_text(json.dumps(records), encoding="utf-8")

    async def reopen() -> tuple[dict[str, Any], dict[str, Any]]:
        host = RunHost(state_dir=str(state))
        await host.boot()
        try:
            restored = host.status(run_id)
            await host.resume(run_id)
            for _ in range(300):
                final = host.status(run_id)
                if final["status"] in _TERMINAL:
                    return restored, final
                await asyncio.sleep(0.02)
            raise AssertionError(f"resumed run never settled: {final}")
        finally:
            await host.close()

    restored, final = asyncio.run(reopen())

    assert restored["status"] == "interrupted"
    assert final["status"] == "succeeded"
    assert final["result"] == {"in": None}


def test_a_memory_host_reports_no_durability() -> None:
    async def scenario() -> bool:
        host = RunHost()
        await host.boot()
        try:
            return host.durable
        finally:
            await host.close()

    assert asyncio.run(scenario()) is False


def test_run_events_survive_a_restart() -> None:
    state = _temp_state_dir()

    async def first_session() -> str:
        host = RunHost(state_dir=str(state))
        await host.boot()
        try:
            started = await host.start(definition=_hello_definition())
            for _ in range(300):
                if host.status(started["runId"])["status"] in _TERMINAL:
                    return started["runId"]
                await asyncio.sleep(0.02)
            raise AssertionError("run never settled")
        finally:
            await host.close()

    run_id = asyncio.run(first_session())
    before = json.loads((state / "events" / f"{run_id}.jsonl").read_text(encoding="utf-8").splitlines()[0])
    assert before["type"] == "run/started"

    async def second_session() -> dict[str, Any]:
        host = RunHost(state_dir=str(state))
        await host.boot()
        try:
            return host.events(run_id, 0)
        finally:
            await host.close()

    events = asyncio.run(second_session())
    kinds = [event["type"] for event in events["events"]]
    assert kinds[0] == "run/started"
    assert "node/completed" in kinds
    assert kinds[-1] == "run/succeeded"
    seqs = [event["seq"] for event in events["events"]]
    assert seqs == sorted(seqs)


# ── model bridge ───────────────────────────────────────────────────────────────


def test_the_bridge_model_forwards_to_the_harness() -> None:
    from langchain_core.messages import HumanMessage, SystemMessage

    from deerflow.workflow.rpc import llm_bridge

    seen: list[dict[str, Any]] = []

    async def transport(payload: dict[str, Any]) -> dict[str, Any]:
        seen.append(payload)
        return {"text": "hello from the harness"}

    async def scenario() -> Any:
        llm_bridge.set_transport(transport)
        try:
            model = llm_bridge.BridgeChatModel(provider="deepseek", model="deepseek-flash")
            return await model.ainvoke([SystemMessage(content="be brief"), HumanMessage(content="hi")])
        finally:
            llm_bridge.set_transport(None)

    message = asyncio.run(scenario())

    assert message.content == "hello from the harness"
    assert seen[0]["provider"] == "deepseek"
    assert seen[0]["model"] == "deepseek-flash"
    assert seen[0]["messages"] == [{"role": "system", "text": "be brief"}, {"role": "user", "text": "hi"}]


def test_the_bridge_model_fails_loud_without_a_transport() -> None:
    from langchain_core.messages import HumanMessage

    from deerflow.workflow.rpc import llm_bridge

    async def scenario() -> None:
        llm_bridge.set_transport(None)
        model = llm_bridge.BridgeChatModel(provider="deepseek", model="m")
        await model.ainvoke([HumanMessage(content="hi")])

    try:
        asyncio.run(scenario())
    except RuntimeError as exc:
        assert "no harness LLM transport" in str(exc)
    else:
        raise AssertionError("the bridge must fail without a transport")


def test_outbound_requests_resolve_and_time_out() -> None:
    async def scenario() -> tuple[dict[str, Any], Any]:
        server = RpcServer()
        sent: list[dict[str, Any]] = []
        server.set_emit(sent.append)

        task = asyncio.create_task(server.call_client("llm/complete", {"model": "m"}, 500))
        await asyncio.sleep(0.01)
        request = sent[-1]
        assert request["method"] == "llm/complete"
        assert server.resolve({"jsonrpc": "2.0", "id": request["id"], "result": {"text": "ok"}})
        resolved = await task

        try:
            await server.call_client("llm/complete", {}, 10)
        except Exception as exc:  # noqa: BLE001 - asserted below
            return resolved, exc
        raise AssertionError("a client that never answers must time out")

    resolved, error = asyncio.run(scenario())

    assert resolved == {"text": "ok"}
    assert getattr(error, "engine_code", "") == "client-timeout"


# ── stdio transport ───────────────────────────────────────────────────────────


def test_stdio_transport_serves_a_session() -> None:
    environment = {**os.environ, "HNFLOW_ENGINE_STATE": str(_temp_state_dir())}
    process = subprocess.Popen(
        [sys.executable, "-m", "deerflow.workflow.rpc"],
        stdin=subprocess.PIPE,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        text=True,
        encoding="utf-8",
        env=environment,
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
