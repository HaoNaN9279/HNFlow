"""Human review node: approve/reject routing and per-visit task identity."""

from __future__ import annotations

from typing import Any

import pytest
from langgraph.checkpoint.memory import InMemorySaver
from langgraph.types import Command

from deerflow.workflow.compiler import CompileContext, WorkflowRuntime, clear_compile_cache, compile_definition
from deerflow.workflow.executors import build_default_registry
from deerflow.workflow.review import (
    DEFAULT_REJECT_FEEDBACK,
    REVIEW_APPROVED_PORT,
    REVIEW_DECISION_CHANNEL,
    REVIEW_DECISION_REJECTED,
    REVIEW_REJECTED_PORT,
    REVIEW_TASK_KIND,
    REVIEW_VISIT_CHANNEL,
    ReviewDecision,
    ReviewDecisionError,
)
from deerflow.workflow.schema import Edge, Node, NodeType, Port, PortType, WorkflowDefinition
from deerflow.workflow.workflow_io import validate_definition


def _port(name: str, type_: PortType = PortType.DATA, required: bool = False) -> Port:
    return Port(name=name, type=type_, required=required)


def _review_definition() -> WorkflowDefinition:
    return WorkflowDefinition(
        id="review-wf",
        name="Review workflow",
        nodes=[
            Node(id="start", type=NodeType.FLOW_START, outputs=[_port("out")]),
            Node(
                id="ai",
                type=NodeType.AI_LLM_AGENT,
                inputs=[_port("in"), _port("continue_prompt")],
                outputs=[_port("out")],
                params={"instruction": "make {{in}}"},
            ),
            Node(
                id="review",
                type=NodeType.HUMAN_REVIEW,
                inputs=[_port("in", required=True)],
                outputs=[_port(REVIEW_APPROVED_PORT), _port(REVIEW_REJECTED_PORT)],
                params={"instructions": "Check the draft"},
            ),
            Node(id="end", type=NodeType.FLOW_END, inputs=[_port("in")]),
        ],
        edges=[
            Edge(source="start", source_port="out", target="ai", target_port="in"),
            Edge(source="ai", source_port="out", target="review", target_port="in"),
            Edge(source="review", source_port=REVIEW_APPROVED_PORT, target="end", target_port="in"),
            Edge(source="review", source_port=REVIEW_REJECTED_PORT, target="ai", target_port="continue_prompt"),
        ],
    )


class _ReviewRepo:
    def __init__(self) -> None:
        self.rows: list[dict[str, Any]] = []

    async def find_by_run_and_node(self, *, run_id: str, node_id: str) -> dict[str, Any] | None:
        matches = [row for row in self.rows if row["workflow_run_id"] == run_id and row["node_id"] == node_id]
        return matches[-1] if matches else None

    async def create(self, **kwargs: Any) -> dict[str, Any]:
        row = {"id": f"ht-{len(self.rows) + 1}", "status": "pending", **kwargs}
        self.rows.append(row)
        return row

    def submit_latest(self, values: dict[str, Any]) -> None:
        self.rows[-1]["status"] = "submitted"
        self.rows[-1]["submission"] = values


def _compile(repo: _ReviewRepo, seen: list[dict[str, Any]]) -> Any:
    async def fake_ai(runtime: WorkflowRuntime, params: dict[str, Any], inputs: dict[str, Any]) -> dict[str, Any]:
        seen.append({"params": params, "inputs": inputs})
        return {"out": inputs.get("continue_prompt") or inputs.get("in")}

    built = build_default_registry().build_context()
    executors = dict(built.executors)
    executors[NodeType.AI_LLM_AGENT] = fake_ai
    ctx = CompileContext(
        executors=executors,
        resource_accessors=dict(built.resource_accessors),
        checkpointer=InMemorySaver(),
    )
    return compile_definition(_review_definition(), context=ctx)


def _config(repo: _ReviewRepo) -> dict[str, Any]:
    return {
        "configurable": {"thread_id": "review-thread"},
        "context": {
            "human_task_repo": repo,
            "user_id": "user-1",
            "run_id": "run-1",
        },
    }


@pytest.fixture(autouse=True)
def _clear_cache() -> Any:
    clear_compile_cache()
    yield
    clear_compile_cache()


def test_review_decision_parses_approve_and_reject() -> None:
    assert ReviewDecision.from_resume({"decision": True}).approved is True
    rejected = ReviewDecision.from_resume({"decision": False, "feedback": "  add citations  "})
    assert rejected.approved is False
    assert rejected.feedback == "add citations"
    fallback = ReviewDecision.from_resume({"decision": False, "feedback": "   "})
    assert fallback.feedback == DEFAULT_REJECT_FEEDBACK


def test_review_decision_rejects_skip_and_malformed_payloads() -> None:
    with pytest.raises(ReviewDecisionError, match="cannot be skipped"):
        ReviewDecision.from_resume({"__skip": True})
    with pytest.raises(ReviewDecisionError, match="boolean 'decision'"):
        ReviewDecision.from_resume({"decision": "yes"})


def test_definition_requires_approved_and_rejected_edges() -> None:
    definition = _review_definition()
    definition.edges = [edge for edge in definition.edges if edge.source_port != REVIEW_REJECTED_PORT]
    errors = validate_definition(definition)
    assert any("exactly one 'rejected' out-edge" in error for error in errors)


def test_definition_rejects_non_ai_retry_target() -> None:
    definition = _review_definition()
    definition.edges = [edge if edge.source_port != REVIEW_REJECTED_PORT else Edge(source="review", source_port=REVIEW_REJECTED_PORT, target="start", target_port="in") for edge in definition.edges]
    errors = validate_definition(definition)
    assert any("rejected target 'start'" in error for error in errors)


@pytest.mark.asyncio
async def test_approve_routes_to_approved_branch() -> None:
    repo = _ReviewRepo()
    seen: list[dict[str, Any]] = []
    graph = _compile(repo, seen)
    config = _config(repo)

    await graph.ainvoke({"wf:start:out": "draft"}, config)
    assert repo.rows[0]["kind"] == REVIEW_TASK_KIND
    assert repo.rows[0]["inputs_snapshot"]["visit"] == 1

    repo.submit_latest({"decision": True})
    await graph.ainvoke(Command(resume={"decision": True}), config)
    state = await graph.aget_state(config)

    assert state.next == ()
    assert state.values["wf:review:approved"] == "draft"
    assert state.values[f"wf:review:{REVIEW_DECISION_CHANNEL}"] == "approved"
    assert len(seen) == 1


@pytest.mark.asyncio
async def test_reject_routes_back_to_ai_and_creates_next_visit() -> None:
    repo = _ReviewRepo()
    seen: list[dict[str, Any]] = []
    graph = _compile(repo, seen)
    config = _config(repo)

    await graph.ainvoke({"wf:start:out": "draft"}, config)
    repo.submit_latest({"decision": False, "feedback": "add citations"})
    await graph.ainvoke(Command(resume={"decision": False, "feedback": "add citations"}), config)
    state = await graph.aget_state(config)

    assert state.next == ("review",)
    assert len(seen) == 2
    assert seen[1]["inputs"]["continue_prompt"] == "add citations"
    assert len(repo.rows) == 2
    assert repo.rows[1]["inputs_snapshot"]["visit"] == 2
    assert repo.rows[1]["inputs_snapshot"]["previous_rejections"] == 1
    assert state.values[f"wf:review:{REVIEW_DECISION_CHANNEL}"] == REVIEW_DECISION_REJECTED
    assert state.values[f"wf:review:{REVIEW_VISIT_CHANNEL}"] == 1

    repo.submit_latest({"decision": True})
    await graph.ainvoke(Command(resume={"decision": True}), config)
    state = await graph.aget_state(config)

    assert state.next == ()
    assert len(repo.rows) == 2  # the second-visit resume did not mint a third task
    assert state.values[f"wf:review:{REVIEW_VISIT_CHANNEL}"] == 2
