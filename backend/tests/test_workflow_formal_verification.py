"""Formal-verification extension: specs, three-valued gates and run summary."""

from __future__ import annotations

import asyncio
from typing import Any

import pytest
from langgraph.checkpoint.memory import InMemorySaver
from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine

from deerflow.persistence.base import Base
from deerflow.persistence.specifications import (
    SpecificationConflictError,
    SpecificationRepository,
)
from deerflow.workflow.compiler import CompileContext, WorkflowRuntime, clear_compile_cache, compile_definition
from deerflow.workflow.executors import build_default_registry
from deerflow.workflow.executors.spec import exec_spec
from deerflow.workflow.executors.verify import exec_verify_gate
from deerflow.workflow.registry import WorkflowExecutionError
from deerflow.workflow.schema import Edge, Node, NodeType, Port, PortType, WorkflowDefinition
from deerflow.workflow.spec import SpecLanguage, SpecRef, SpecStatus, collect_spec_refs, content_hash, parse_spec_ref
from deerflow.workflow.tool_gateway import StaticToolProvider, ToolGateway
from deerflow.workflow.verification import (
    VERIFICATION_RESULT_KEY,
    VERIFY_INCONCLUSIVE_PORT,
    VERIFY_STATUS_PORT,
    VerificationStatus,
    normalize_verifier_result,
)
from deerflow.workflow.verifiers.tools import mock_verifier_tool, spec_lint_tool
from deerflow.workflow.workflow_io import validate_definition

SPEC_CONTENT = "method Abs(x: int) returns (y: int) ensures y >= 0 { y := if x < 0 then -x else x; }"
SPEC_HASH = content_hash(SPEC_CONTENT)
SPEC_REF = {"spec_id": "spec-1", "revision": 1, "content_hash": SPEC_HASH, "language": "dafny", "title": "Abs"}


def _runtime(context: dict[str, Any] | None = None, *, state: dict[str, Any] | None = None) -> WorkflowRuntime:
    return WorkflowRuntime(state=state or {}, context=context or {})


def _run(coro: Any) -> Any:
    return asyncio.run(coro)


class _SpecRepo:
    def __init__(self, *, status: str = "frozen") -> None:
        self.status = status
        self.calls: list[tuple[str, Any]] = []

    async def resolve_ref(self, ref: SpecRef | dict[str, Any], *, user_id: str) -> dict[str, Any]:
        parsed = parse_spec_ref(ref)
        self.calls.append(("resolve", parsed))
        if parsed.content_hash != SPEC_HASH:
            raise SpecificationConflictError("hash mismatch")
        if self.status != "frozen":
            raise SpecificationConflictError("not frozen")
        return {
            "spec_id": parsed.spec_id,
            "revision": parsed.revision,
            "user_id": user_id,
            "language": "dafny",
            "content": SPEC_CONTENT,
            "content_hash": SPEC_HASH,
            "status": self.status,
            "title": "Abs",
            "metadata": {},
        }


def _gateway() -> ToolGateway:
    return ToolGateway([StaticToolProvider("builtin", {"mock_verifier": mock_verifier_tool(), "spec_lint": spec_lint_tool()})])


def _port(name: str, type_: PortType, required: bool = False) -> Port:
    return Port(name=name, type=type_, required=required)


def _verify_definition() -> WorkflowDefinition:
    return WorkflowDefinition(
        id="verify-wf",
        name="Verify workflow",
        nodes=[
            Node(id="start", type=NodeType.FLOW_START, outputs=[_port("out", PortType.DATA)]),
            Node(
                id="gate",
                type=NodeType.VERIFY_GATE,
                inputs=[_port("implementation", PortType.DATA, True)],
                outputs=[
                    _port("status", PortType.ENUM),
                    _port("verified", PortType.DATA),
                    _port("failed", PortType.DATA),
                    _port("inconclusive", PortType.DATA),
                    _port("evidence", PortType.RECORD),
                ],
                params={"spec_ref": SPEC_REF, "verifier": "mock_verifier"},
            ),
            Node(id="ok", type=NodeType.DATA_ASSIGN, inputs=[_port("in", PortType.DATA)], outputs=[_port("out", PortType.DATA)], params={"value": "ok"}),
            Node(id="bad", type=NodeType.DATA_ASSIGN, inputs=[_port("in", PortType.DATA)], outputs=[_port("out", PortType.DATA)], params={"value": "bad"}),
            Node(id="unknown", type=NodeType.DATA_ASSIGN, inputs=[_port("in", PortType.DATA)], outputs=[_port("out", PortType.DATA)], params={"value": "unknown"}),
            Node(id="end", type=NodeType.FLOW_END, inputs=[_port("in", PortType.DATA)]),
        ],
        edges=[
            Edge(source="start", source_port="out", target="gate", target_port="implementation"),
            Edge(source="gate", source_port="verified", target="ok", target_port="in"),
            Edge(source="gate", source_port="failed", target="bad", target_port="in"),
            Edge(source="gate", source_port="inconclusive", target="unknown", target_port="in"),
            Edge(source="ok", source_port="out", target="end", target_port="in"),
            Edge(source="bad", source_port="out", target="end", target_port="in"),
            Edge(source="unknown", source_port="out", target="end", target_port="in"),
        ],
    )


def _compile_graph(gateway: ToolGateway) -> Any:
    built = build_default_registry().build_context()
    ctx = CompileContext(executors=dict(built.executors), resource_accessors=dict(built.resource_accessors), checkpointer=InMemorySaver())
    return compile_definition(_verify_definition(), context=ctx)


@pytest.fixture(autouse=True)
def _clear_cache() -> Any:
    clear_compile_cache()
    yield
    clear_compile_cache()


# ── pure contracts ────────────────────────────────────────────────────────────


def test_spec_ref_roundtrip_and_collection() -> None:
    ref = parse_spec_ref(SPEC_REF)
    assert ref.key() == "spec-1@1"
    assert collect_spec_refs(_verify_definition())[0].content_hash == SPEC_HASH


def test_normalize_verifier_result_three_values() -> None:
    verified = normalize_verifier_result({"status": "verified", "verifier": "mock"})
    assert verified.status is VerificationStatus.VERIFIED
    failed = normalize_verifier_result({"status": "failed", "errors": [{"category": "invariant", "message": "x"}]})
    assert failed.status is VerificationStatus.FAILED
    assert failed.errors[0].category == "invariant"
    inconclusive = normalize_verifier_result({"status": "unknown"})
    assert inconclusive.status is VerificationStatus.INCONCLUSIVE
    malformed = normalize_verifier_result("not json")
    assert malformed.status is VerificationStatus.INCONCLUSIVE


def test_definition_requires_all_three_gate_branches() -> None:
    definition = _verify_definition()
    definition.edges = [edge for edge in definition.edges if not (edge.source == "gate" and edge.source_port == "inconclusive")]
    errors = validate_definition(definition)
    assert any("inconclusive" in error for error in errors)


def test_spec_port_is_strict() -> None:
    definition = _verify_definition()
    definition.nodes[1].inputs.append(_port("spec", PortType.DATA))
    definition.edges.append(Edge(source="start", source_port="out", target="gate", target_port="spec"))
    errors = validate_definition(definition)
    assert any("must be type spec" in error for error in errors)


# ── execution ─────────────────────────────────────────────────────────────────


@pytest.mark.parametrize(
    ("mode", "expected_branch", "expected_status"),
    [
        ("verified", "wf:ok:out", "verified"),
        ("failed", "wf:bad:out", "failed"),
        ("inconclusive", "wf:unknown:out", "inconclusive"),
    ],
)
def test_compiled_gate_routes_each_branch(mode: str, expected_branch: str, expected_status: str) -> None:
    repo = _SpecRepo()
    graph = _compile_graph(_gateway())
    config = {"configurable": {"thread_id": f"verify-{mode}"}, "context": {"spec_repo": repo, "tool_gateway": _gateway(), "user_id": "u1", "run_id": "r1"}}
    definition = _verify_definition()
    definition.nodes[1].params = {**definition.nodes[1].params, "mock_mode": mode}
    # Recompile with the mode-specific params; the cache key includes params.
    built = build_default_registry().build_context()
    compile_ctx = CompileContext(executors=dict(built.executors), resource_accessors=dict(built.resource_accessors), checkpointer=InMemorySaver())
    graph = compile_definition(definition, context=compile_ctx)
    state = _run(graph.ainvoke({"wf:start:out": "source"}, config=config))
    assert state[expected_branch] is not None
    assert state[f"wf:gate:{VERIFY_STATUS_PORT}"] == expected_status
    assert state[f"wf:gate:{VERIFICATION_RESULT_KEY}"]["status"] == expected_status
    if expected_status == "failed":
        assert state[f"wf:gate:{VERIFY_INCONCLUSIVE_PORT}"] is None


def test_verify_gate_fails_loud_for_missing_spec_or_tool() -> None:
    definition = _verify_definition()
    graph = _compile_graph(_gateway())
    config = {"configurable": {"thread_id": "missing-spec"}, "context": {"tool_gateway": _gateway(), "user_id": "u1", "run_id": "r1"}}
    with pytest.raises(WorkflowExecutionError, match="spec_repo"):
        _run(graph.ainvoke({"wf:start:out": "source"}, config=config))

    params = dict(definition.nodes[1].params)
    params["verifier"] = "no_such_verifier"
    with pytest.raises(WorkflowExecutionError, match="could not be resolved"):
        _run(exec_verify_gate(_runtime({"spec_repo": _SpecRepo(), "tool_gateway": _gateway(), "user_id": "u1"}), {**params, "node_id": "gate"}, {"implementation": "source"}))


def test_exec_spec_lifecycle_operations() -> None:
    class Repo(_SpecRepo):
        async def create(self, **kwargs: Any) -> dict[str, Any]:
            return {"spec_id": "spec-1", "revision": 1, "language": "dafny", "content": SPEC_CONTENT, "content_hash": SPEC_HASH, "status": "draft", "title": None}

        async def add_revision(self, spec_id: str, **kwargs: Any) -> dict[str, Any]:
            return {"spec_id": spec_id, "revision": 2, "language": "dafny", "content": kwargs["content"], "content_hash": content_hash(kwargs["content"]), "status": "draft", "title": None}

        async def freeze(self, spec_id: str, revision: int, **kwargs: Any) -> dict[str, Any]:
            return {"spec_id": spec_id, "revision": revision, "language": "dafny", "content": SPEC_CONTENT, "content_hash": SPEC_HASH, "status": "frozen", "title": None}

        async def resolve_ref(self, ref: Any, *, user_id: str) -> dict[str, Any]:
            return await super().resolve_ref(ref, user_id=user_id)

    runtime = _runtime({"spec_repo": Repo(), "user_id": "u1"})
    created = _run(exec_spec(runtime, {"operation": "create", "language": "dafny", "name": "Abs"}, {"content": SPEC_CONTENT}))
    assert created["spec"]["revision"] == 1
    revised = _run(exec_spec(runtime, {"operation": "revise", "spec_ref": SPEC_REF}, {"content": SPEC_CONTENT + "\n"}))
    assert revised["spec"]["revision"] == 2
    frozen = _run(exec_spec(runtime, {"operation": "freeze", "spec_ref": SPEC_REF, "approved_by": "reviewer"}, {}))
    assert frozen["spec"]["revision"] == 1
    linted = _run(exec_spec(runtime, {"operation": "lint", "spec_ref": SPEC_REF}, {}))
    assert isinstance(linted["issues"], list)


def test_specification_repository_revision_freeze_and_resolve() -> None:
    async def scenario() -> None:
        engine = create_async_engine("sqlite+aiosqlite:///:memory:")
        async with engine.begin() as conn:
            await conn.run_sync(Base.metadata.create_all)
        repo = SpecificationRepository(async_sessionmaker(engine, expire_on_commit=False))
        created = await repo.create(user_id="u1", name="Abs", language=SpecLanguage.DAFNY, content=SPEC_CONTENT, title="Abs")
        assert created["status"] == SpecStatus.DRAFT.value
        revised = await repo.add_revision(created["spec_id"], user_id="u1", content=SPEC_CONTENT + "\n")
        frozen = await repo.freeze(created["spec_id"], 1, user_id="u1", approved_by="human")
        assert frozen["status"] == SpecStatus.FROZEN.value
        ref = SpecRef(spec_id=created["spec_id"], revision=1, content_hash=SPEC_HASH, language=SpecLanguage.DAFNY)
        resolved = await repo.resolve_ref(ref, user_id="u1")
        assert resolved["content"] == SPEC_CONTENT
        with pytest.raises(SpecificationConflictError):
            await repo.resolve_ref(SpecRef(spec_id=created["spec_id"], revision=2, content_hash=content_hash("x"), language=SpecLanguage.DAFNY), user_id="u1")
        assert revised["revision"] == 2
        await engine.dispose()

    _run(scenario())


def test_run_end_verification_summary_aggregation() -> None:
    from deerflow.workflow.worker import _build_run_end_content

    content = _build_run_end_content(
        {
            "wf:gate:__verification": {
                "node_id": "gate",
                "status": "inconclusive",
                "verifier": "mock_verifier",
                "verifier_version": "1",
                "spec": SPEC_REF,
                "duration_ms": 12,
            }
        },
        status="success",
    )
    summary = content["verification_summary"]
    assert summary["gates_total"] == 1
    assert summary["gates_inconclusive"] == 1
    assert summary["verifier_versions"] == {"mock_verifier": "1"}
    assert summary["specs_used"][0]["spec_id"] == "spec-1"
