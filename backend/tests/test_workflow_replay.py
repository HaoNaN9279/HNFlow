"""Tests for N14 §24.11 deterministic record/replay (:mod:`deerflow.workflow.replay`)."""

from __future__ import annotations

from typing import Any

import pytest

from deerflow.workflow.compiler import clear_compile_cache, compile_definition
from deerflow.workflow.executors import build_default_registry
from deerflow.workflow.replay import (
    MISS_ERROR,
    MISS_LIVE,
    MODE_RECORD,
    MODE_REPLAY,
    REPLAY_CONTEXT_KEY,
    ReplayEntry,
    ReplayError,
    ReplayFixture,
    ReplayMissError,
    ReplaySession,
    input_digest,
    load_fixture,
    redact_secrets,
    save_fixture,
)
from deerflow.workflow.schema import Edge, Node, NodeType, Port, PortType, WorkflowDefinition

# ── pure ─────────────────────────────────────────────────────────────────────


class TestInputDigest:
    def test_deterministic(self) -> None:
        d1 = input_digest(node_id="n", node_type="data:assign", inputs={"a": 1, "b": [2, 3]})
        d2 = input_digest(node_id="n", node_type="data:assign", inputs={"b": [2, 3], "a": 1})
        assert d1 == d2  # key order does not matter

    def test_sensitive(self) -> None:
        base = input_digest(node_id="n", node_type="t", inputs={"a": 1})
        assert base != input_digest(node_id="n", node_type="t", inputs={"a": 2})
        assert base != input_digest(node_id="m", node_type="t", inputs={"a": 1})
        assert base != input_digest(node_id="n", node_type="u", inputs={"a": 1})

    def test_non_json_values(self) -> None:
        # default=str keeps a non-JSON value stable instead of raising.
        class _Thing:
            def __str__(self) -> str:
                return "thing"

        assert input_digest(node_id="n", node_type="t", inputs={"x": _Thing()}) == input_digest(node_id="n", node_type="t", inputs={"x": _Thing()})


class TestRedactSecrets:
    def test_masks_hinted_keys(self) -> None:
        out = redact_secrets({"api_key": "abc", "Authorization": "Bearer x", "normal": "ok", "nested": {"db_password": "p"}})
        assert out == {"api_key": "***", "Authorization": "***", "normal": "ok", "nested": {"db_password": "***"}}

    def test_extra_names(self) -> None:
        out = redact_secrets({"widget": "secret-ish", "keep": 1}, extra_names=frozenset({"widget"}))
        assert out == {"widget": "***", "keep": 1}

    def test_lists(self) -> None:
        out = redact_secrets([{"token": "t"}, {"ok": 1}])
        assert out == [{"token": "***"}, {"ok": 1}]


class TestFixturePersistence:
    def test_roundtrip_dict(self) -> None:
        fixture = ReplayFixture(run_id="r", entries=[ReplayEntry("n", "data:assign", "d", {"out": 1})])
        assert ReplayFixture.from_dict(fixture.to_dict()) == fixture

    def test_roundtrip_json(self) -> None:
        fixture = ReplayFixture(run_id="r", entries=[ReplayEntry("n", "data:assign", "d", {"out": 1})])
        assert ReplayFixture.from_json(fixture.to_json()) == fixture

    def test_bad_schema_version(self) -> None:
        with pytest.raises(ReplayError):
            ReplayFixture.from_dict({"schema_version": 999, "entries": []})

    def test_bad_json(self) -> None:
        with pytest.raises(ReplayError):
            ReplayFixture.from_json("{not json")

    def test_malformed_entry(self) -> None:
        with pytest.raises(ReplayError):
            ReplayFixture.from_dict({"entries": [{"node_id": "n"}]})

    def test_file_roundtrip(self, tmp_path: Any) -> None:
        fixture = ReplayFixture(run_id="r", entries=[ReplayEntry("n", "t", "d", {"out": "x"})])
        path = tmp_path / "sub" / "fixture.json"
        save_fixture(path, fixture)
        assert load_fixture(path) == fixture


class TestReplaySession:
    def test_bad_mode(self) -> None:
        with pytest.raises(ReplayError):
            ReplaySession(mode="off")

    def test_bad_on_miss(self) -> None:
        with pytest.raises(ReplayError):
            ReplaySession(mode=MODE_REPLAY, on_miss="whatever")

    def test_record_then_replay(self) -> None:
        session = ReplaySession(mode=MODE_RECORD, redact=False)
        session.record(node_id="n", node_type="t", inputs={"a": 1}, outputs={"out": 5})
        player = ReplaySession(mode=MODE_REPLAY, fixture=session.fixture)
        assert player.replay(node_id="n", node_type="t", inputs={"a": 1}) == {"out": 5}

    def test_record_redacts(self) -> None:
        session = ReplaySession(mode=MODE_RECORD, redact=True)
        entry = session.record(node_id="n", node_type="t", inputs={}, outputs={"api_key": "secret", "out": 1})
        assert entry.outputs == {"api_key": "***", "out": 1}

    def test_miss_error(self) -> None:
        session = ReplaySession(mode=MODE_REPLAY, on_miss=MISS_ERROR)
        with pytest.raises(ReplayMissError):
            session.replay(node_id="n", node_type="t", inputs={})

    def test_miss_live_returns_none(self) -> None:
        session = ReplaySession(mode=MODE_REPLAY, on_miss=MISS_LIVE)
        assert session.replay(node_id="n", node_type="t", inputs={}) is None


# ── compiler integration ─────────────────────────────────────────────────────


def _start_node() -> Node:
    return Node(id="start", type=NodeType.FLOW_START, inputs=[], outputs=[Port(name="input", type=PortType.DATA)])


def _end_node() -> Node:
    return Node(id="end", type=NodeType.FLOW_END, inputs=[Port(name="in", type=PortType.DATA)], outputs=[])


def _work_node() -> Node:
    return Node(id="work", type=NodeType.DATA_ASSIGN, inputs=[Port(name="in", type=PortType.DATA)], outputs=[Port(name="out", type=PortType.DATA)])


def _def() -> WorkflowDefinition:
    return WorkflowDefinition(
        id="test-wf",
        name="Test Workflow",
        nodes=[_start_node(), _work_node(), _end_node()],
        edges=[
            Edge(source="start", source_port="input", target="work", target_port="in"),
            Edge(source="work", source_port="out", target="end", target_port="in"),
        ],
    )


@pytest.fixture(autouse=True)
def _isolate_cache() -> Any:
    clear_compile_cache()
    yield
    clear_compile_cache()


async def _invoke(*, exec_fn: Any, session: ReplaySession | None) -> dict[str, Any]:
    ctx = build_default_registry().build_context()
    ctx.executors[NodeType.DATA_ASSIGN] = exec_fn
    graph = compile_definition(_def(), context=ctx)
    context: dict[str, Any] = {"run_id": "r1"}
    if session is not None:
        context[REPLAY_CONTEXT_KEY] = session
    return await graph.ainvoke({"wf:start:input": "seed"}, {"configurable": {"thread_id": "t"}, "context": context})


class TestCompilerRecordReplay:
    @pytest.mark.asyncio
    async def test_record_captures_node_output(self) -> None:
        calls: list[int] = []

        def _exec(rt: Any, _p: dict, _i: dict) -> dict[str, Any]:
            calls.append(1)
            return {"out": "live-value"}

        session = ReplaySession(mode=MODE_RECORD, fixture=ReplayFixture(run_id="r1"), redact=False)
        state = await _invoke(exec_fn=_exec, session=session)

        assert state.get("wf:work:out") == "live-value"
        assert len(calls) == 1
        assert len(session.fixture.entries) == 1
        assert session.fixture.entries[0].node_id == "work"
        assert session.fixture.entries[0].outputs == {"out": "live-value"}

    @pytest.mark.asyncio
    async def test_replay_skips_executor(self) -> None:
        session = ReplaySession(mode=MODE_RECORD, fixture=ReplayFixture(run_id="r1"), redact=False)
        session.record(node_id="work", node_type=NodeType.DATA_ASSIGN.value, inputs={"in": "seed"}, outputs={"out": "recorded"})

        calls: list[int] = []

        def _boom(rt: Any, _p: dict, _i: dict) -> dict[str, Any]:
            calls.append(1)
            raise AssertionError("executor must not be called in replay mode")

        player = ReplaySession(mode=MODE_REPLAY, fixture=session.fixture)
        state = await _invoke(exec_fn=_boom, session=player)

        assert calls == []
        assert state.get("wf:work:out") == "recorded"

    @pytest.mark.asyncio
    async def test_replay_miss_errors(self) -> None:
        def _exec(rt: Any, _p: dict, _i: dict) -> dict[str, Any]:
            return {"out": "live"}

        player = ReplaySession(mode=MODE_REPLAY, on_miss=MISS_ERROR, fixture=ReplayFixture(run_id="r1"))
        with pytest.raises(ReplayMissError):
            await _invoke(exec_fn=_exec, session=player)

    @pytest.mark.asyncio
    async def test_replay_miss_live_falls_back(self) -> None:
        calls: list[int] = []

        def _exec(rt: Any, _p: dict, _i: dict) -> dict[str, Any]:
            calls.append(1)
            return {"out": "live"}

        player = ReplaySession(mode=MODE_REPLAY, on_miss=MISS_LIVE, fixture=ReplayFixture(run_id="r1"))
        state = await _invoke(exec_fn=_exec, session=player)

        assert len(calls) == 1
        assert state.get("wf:work:out") == "live"

    @pytest.mark.asyncio
    async def test_no_session_is_unchanged(self) -> None:
        calls: list[int] = []

        def _exec(rt: Any, _p: dict, _i: dict) -> dict[str, Any]:
            calls.append(1)
            return {"out": "live"}

        state = await _invoke(exec_fn=_exec, session=None)
        assert state.get("wf:work:out") == "live"
        assert len(calls) == 1

    @pytest.mark.asyncio
    async def test_full_record_replay_cycle(self) -> None:
        """A run recorded once replays identically with a poisoned executor."""
        session = ReplaySession(mode=MODE_RECORD, fixture=ReplayFixture(run_id="r1"), redact=False)

        def _v1(rt: Any, _p: dict, _i: dict) -> dict[str, Any]:
            return {"out": "v1"}

        await _invoke(exec_fn=_v1, session=session)

        def _v2(rt: Any, _p: dict, _i: dict) -> dict[str, Any]:
            return {"out": "v2-should-not-appear"}

        player = ReplaySession(mode=MODE_REPLAY, fixture=ReplayFixture.from_json(session.fixture.to_json()))
        state = await _invoke(exec_fn=_v2, session=player)
        assert state.get("wf:work:out") == "v1"
