"""Tests for N14 §24.8 embedded definition eval suites.

``deerflow.workflow.definition_evals`` parses a declarative ``metadata.evals``
block into the replay + assertion machinery, and the CRUD routes optionally
gate a save on it (``require_pass``) and expose it on demand.
"""

from __future__ import annotations

from collections.abc import Callable
from types import SimpleNamespace

import pytest
from fastapi import FastAPI, Request, Response
from fastapi.testclient import TestClient
from starlette.middleware.base import BaseHTTPMiddleware
from starlette.types import ASGIApp

from app.gateway.routers import workflow_routes
from deerflow.config.database_config import DatabaseConfig
from deerflow.persistence.engine import get_session_factory, init_engine_from_config
from deerflow.persistence.workflow_definitions import WorkflowDefinitionRepository
from deerflow.workflow.compiler import clear_compile_cache, compile_definition
from deerflow.workflow.definition_evals import (
    DefinitionEvalError,
    definition_has_evals,
    eval_gate_errors,
    evaluate_definition_evals,
    parse_definition_evals,
)
from deerflow.workflow.executors import build_default_registry
from deerflow.workflow.replay import MODE_RECORD, REPLAY_CONTEXT_KEY, ReplayFixture, ReplaySession
from deerflow.workflow.schema import Edge, Node, NodeType, Port, PortType, WorkflowDefinition, WorkflowMetadata

# ── definition helpers ────────────────────────────────────────────────────────


def _definition(*, evals: dict | None = None) -> WorkflowDefinition:
    nodes = [
        Node(id="start", type=NodeType.FLOW_START, inputs=[], outputs=[Port(name="input", type=PortType.DATA)]),
        Node(
            id="work",
            type=NodeType.DATA_ASSIGN,
            inputs=[Port(name="in", type=PortType.DATA)],
            outputs=[Port(name="out", type=PortType.DATA)],
            params={"value": "expected-output"},
        ),
        Node(id="end", type=NodeType.FLOW_END, inputs=[Port(name="in", type=PortType.DATA)], outputs=[]),
    ]
    edges = [
        Edge(source="start", source_port="input", target="work", target_port="in"),
        Edge(source="work", source_port="out", target="end", target_port="in"),
    ]
    return WorkflowDefinition(
        id="wf-evals",
        name="Evals Workflow",
        nodes=nodes,
        edges=edges,
        metadata=WorkflowMetadata(evals=evals),
    )


async def _record_fixture(definition: WorkflowDefinition) -> dict:
    """Execute *definition* once in record mode and return the fixture document."""
    session = ReplaySession(mode=MODE_RECORD, fixture=ReplayFixture(run_id="r1"), redact=False)
    graph = compile_definition(definition, context=build_default_registry().build_context())
    await graph.ainvoke(
        dict(_INITIAL_STATE),
        {"configurable": {"thread_id": "t-eval"}, "context": {"run_id": "r1", REPLAY_CONTEXT_KEY: session}},
    )
    return session.fixture.to_dict()


def _case(port: str = "out", kind: str = "equals", expected=None, node_id: str = "work") -> dict:
    return {"name": "happy-path", "assertions": [{"node_id": node_id, "port": port, "kind": kind, "expected": expected}]}


#: The graph input the recording was taken with — replay must reproduce it
#: exactly, or every node's input digest (and so every lookup) misses.
_INITIAL_STATE = {"wf:start:input": "seed"}


@pytest.fixture(autouse=True)
def _isolate_compile_cache():
    clear_compile_cache()
    yield
    clear_compile_cache()


# ── parsing ───────────────────────────────────────────────────────────────────


class TestParseDefinitionEvals:
    def test_no_block_returns_none(self) -> None:
        assert parse_definition_evals(WorkflowMetadata()) is None
        assert parse_definition_evals({}) is None
        assert parse_definition_evals(None) is None

    def test_valid_block_from_metadata_object_and_dict(self) -> None:
        raw = {"fixture": {"schema_version": 1, "run_id": "r1", "entries": []}, "cases": [_case()]}
        for source in (WorkflowMetadata(evals=raw), {"evals": raw}):
            parsed = parse_definition_evals(source)
            assert parsed is not None
            assert parsed.require_pass is False
            assert parsed.on_miss == "error"
            assert len(parsed.cases) == 1
            assert parsed.cases[0].assertions[0].node_id == "work"

    def test_require_pass_and_on_miss_parsed(self) -> None:
        raw = {"fixture": {"entries": []}, "cases": [_case()], "require_pass": True, "on_miss": "live", "initial_state": {"a": 1}}
        parsed = parse_definition_evals({"evals": raw})
        assert parsed is not None
        assert parsed.require_pass is True
        assert parsed.on_miss == "live"
        assert parsed.initial_state == {"a": 1}

    @pytest.mark.parametrize(
        "raw",
        [
            "not-a-mapping",
            {"cases": [_case()]},
            {"fixture": {"entries": []}},
            {"fixture": {"entries": []}, "cases": []},
            {"fixture": {"entries": []}, "cases": [_case()], "require_pass": "yes"},
            {"fixture": {"entries": []}, "cases": [_case()], "on_miss": "whatever"},
            {"fixture": {"entries": []}, "cases": [_case()], "initial_state": []},
            {"fixture": {"schema_version": 99, "entries": []}, "cases": [_case()]},
            {"fixture": {"entries": []}, "cases": [{"name": "c", "assertions": []}]},
            {"fixture": {"entries": []}, "cases": [{"assertions": [_case()["assertions"][0]]}]},
            {"fixture": {"entries": []}, "cases": [{"name": "c", "assertions": ["nope"]}]},
            {"fixture": {"entries": []}, "cases": [{"name": "c", "assertions": [{"node_id": "n", "port": "p"}]}]},
            {"fixture": {"entries": []}, "cases": [{"name": "c", "assertions": [{"node_id": "n", "port": "p", "kind": "bogus"}]}]},
            {"fixture": {"entries": []}, "cases": [{"name": "c", "assertions": [_case()["assertions"][0]], "inputs": 3}]},
        ],
    )
    def test_malformed_blocks_raise(self, raw) -> None:
        with pytest.raises(DefinitionEvalError):
            parse_definition_evals({"evals": raw})

    def test_definition_has_evals(self) -> None:
        assert definition_has_evals(_definition()) is False
        assert definition_has_evals(_definition(evals={"fixture": {"entries": []}, "cases": [_case()]})) is True

    def test_definition_has_evals_raises_on_malformed(self) -> None:
        with pytest.raises(DefinitionEvalError):
            definition_has_evals(_definition(evals={"cases": [_case()]}))


class _ReportStub:
    """Minimal report shape for the count-line fallback (no failing assertions)."""

    def __init__(self, *, failed: int) -> None:
        self.failed = failed
        self.failures: list = []
        self.total = 1


def test_eval_gate_errors_falls_back_to_a_count_line() -> None:
    assert eval_gate_errors(_ReportStub(failed=1)) == ["\u8bc4\u6d4b\u672a\u901a\u8fc7\uff1a1/1 \u4e2a\u7528\u4f8b\u5931\u8d25"]


# ── evaluation ────────────────────────────────────────────────────────────────


class TestEvaluateDefinitionEvals:
    @pytest.mark.asyncio
    async def test_no_block_returns_none(self) -> None:
        assert await evaluate_definition_evals(_definition()) is None

    @pytest.mark.asyncio
    async def test_passing_suite(self) -> None:
        fixture = await _record_fixture(_definition())
        definition = _definition(evals={"fixture": fixture, "initial_state": dict(_INITIAL_STATE), "cases": [_case(expected="expected-output")]})
        report = await evaluate_definition_evals(definition)
        assert report is not None
        assert report.passed == 1
        assert report.failed == 0
        assert report.pass_rate == 1.0

    @pytest.mark.asyncio
    async def test_failing_suite_reports_assertion_detail(self) -> None:
        fixture = await _record_fixture(_definition())
        definition = _definition(evals={"fixture": fixture, "initial_state": dict(_INITIAL_STATE), "cases": [_case(expected="wrong")]})
        report = await evaluate_definition_evals(definition)
        assert report is not None
        assert report.failed == 1
        errors = eval_gate_errors(report)
        assert len(errors) == 1
        assert "happy-path" in errors[0]
        assert "work.out" in errors[0]

    @pytest.mark.asyncio
    async def test_unrecorded_node_fails_loud_by_default(self) -> None:
        definition = _definition(evals={"fixture": {"schema_version": 1, "run_id": "r1", "entries": []}, "cases": [_case(expected="x")]})
        with pytest.raises(Exception):
            await evaluate_definition_evals(definition)

    @pytest.mark.asyncio
    async def test_on_miss_live_falls_back_to_real_execution(self) -> None:
        definition = _definition(
            evals={
                "fixture": {"schema_version": 1, "run_id": "r1", "entries": []},
                "cases": [_case(expected="expected-output")],
                "on_miss": "live",
            }
        )
        report = await evaluate_definition_evals(definition)
        assert report is not None
        assert report.passed == 1


# ── save gate ─────────────────────────────────────────────────────────────────


class TestEmbeddedEvalGate:
    @pytest.mark.asyncio
    async def test_no_evals_is_a_noop(self) -> None:
        await workflow_routes._run_embedded_eval_gate(_definition())

    @pytest.mark.asyncio
    async def test_reports_only_suite_is_a_noop(self) -> None:
        fixture = await _record_fixture(_definition())
        definition = _definition(evals={"fixture": fixture, "cases": [_case(expected="wrong")]})
        await workflow_routes._run_embedded_eval_gate(definition)

    @pytest.mark.asyncio
    async def test_failing_required_suite_raises_422(self) -> None:
        from fastapi import HTTPException

        fixture = await _record_fixture(_definition())
        definition = _definition(evals={"fixture": fixture, "cases": [_case(expected="wrong")], "require_pass": True})
        with pytest.raises(HTTPException) as excinfo:
            await workflow_routes._run_embedded_eval_gate(definition)
        assert excinfo.value.status_code == 422

    @pytest.mark.asyncio
    async def test_passing_required_suite_passes(self) -> None:
        fixture = await _record_fixture(_definition())
        definition = _definition(evals={"fixture": fixture, "initial_state": dict(_INITIAL_STATE), "cases": [_case(expected="expected-output")], "require_pass": True})
        await workflow_routes._run_embedded_eval_gate(definition)

    @pytest.mark.asyncio
    async def test_malformed_spec_raises_422(self) -> None:
        from fastapi import HTTPException

        with pytest.raises(HTTPException) as excinfo:
            await workflow_routes._run_embedded_eval_gate(_definition(evals={"cases": [_case()]}))
        assert excinfo.value.status_code == 422


# ── routes ────────────────────────────────────────────────────────────────────


class _StubAuthMiddleware(BaseHTTPMiddleware):
    def __init__(self, app: ASGIApp, factory: Callable[[], SimpleNamespace]) -> None:
        super().__init__(app)
        self._factory = factory

    async def dispatch(self, request: Request, call_next: Callable) -> Response:
        request.state.user = self._factory()
        return await call_next(request)


def _stub_user() -> SimpleNamespace:
    return SimpleNamespace(id="11111111-1111-1111-1111-111111111111", system_role="user")


def _make_app(repo) -> FastAPI:
    from unittest.mock import AsyncMock, MagicMock

    app = FastAPI()
    app.add_middleware(_StubAuthMiddleware, factory=_stub_user)
    app.state.workflow_definition_repo = repo
    thread_store = MagicMock()
    thread_store.check_access = AsyncMock(return_value=True)
    app.state.thread_store = thread_store
    app.include_router(workflow_routes.router)
    return app


async def _make_repo(tmp_path) -> WorkflowDefinitionRepository:
    await init_engine_from_config(DatabaseConfig(backend="sqlite", sqlite_dir=str(tmp_path)))
    sf = get_session_factory()
    assert sf is not None
    return WorkflowDefinitionRepository(sf)


def _create(client: TestClient, *, evals=None) -> str:
    payload = {"name": "Evals", "definition": _definition(evals=evals).model_dump(mode="json")}
    resp = client.post("/api/workflows", json=payload)
    assert resp.status_code in (200, 201), f"Got {resp.status_code}: {resp.text}"
    body = resp.json()
    return body.get("id") or body.get("definition_id")


class TestEvaluateRoute:
    @pytest.mark.asyncio
    async def test_definition_without_evals_reports_ran_false(self, tmp_path) -> None:
        repo = await _make_repo(tmp_path)
        client = TestClient(_make_app(repo))
        definition_id = _create(client)
        resp = client.post(f"/api/workflows/{definition_id}/evaluate")
        assert resp.status_code == 200, resp.text
        body = resp.json()
        assert body["ran"] is False
        assert body["report"] is None
        assert body["passed"] is None

    @pytest.mark.asyncio
    async def test_definition_with_passing_evals_reports_report(self, tmp_path) -> None:
        fixture = await _record_fixture(_definition())
        repo = await _make_repo(tmp_path)
        client = TestClient(_make_app(repo))
        definition_id = _create(client, evals={"fixture": fixture, "initial_state": dict(_INITIAL_STATE), "cases": [_case(expected="expected-output")], "require_pass": True})
        resp = client.post(f"/api/workflows/{definition_id}/evaluate")
        assert resp.status_code == 200, resp.text
        body = resp.json()
        assert body["ran"] is True
        assert body["require_pass"] is True
        assert body["passed"] is True
        assert body["report"]["total"] == 1
        assert body["errors"] == []

    @pytest.mark.asyncio
    async def test_unknown_definition_returns_404(self, tmp_path) -> None:
        repo = await _make_repo(tmp_path)
        client = TestClient(_make_app(repo))
        resp = client.post("/api/workflows/does-not-exist/evaluate")
        assert resp.status_code == 404, resp.text

    @pytest.mark.asyncio
    async def test_failing_required_suite_blocks_the_save(self, tmp_path) -> None:
        fixture = await _record_fixture(_definition())
        repo = await _make_repo(tmp_path)
        client = TestClient(_make_app(repo))
        payload = {
            "name": "Evals",
            "definition": _definition(evals={"fixture": fixture, "cases": [_case(expected="wrong")], "require_pass": True}).model_dump(mode="json"),
        }
        resp = client.post("/api/workflows", json=payload)
        assert resp.status_code == 422, f"Got {resp.status_code}: {resp.text}"

    @pytest.mark.asyncio
    async def test_failing_non_required_suite_saves(self, tmp_path) -> None:
        fixture = await _record_fixture(_definition())
        repo = await _make_repo(tmp_path)
        client = TestClient(_make_app(repo))
        definition_id = _create(client, evals={"fixture": fixture, "cases": [_case(expected="wrong")]})
        assert definition_id
