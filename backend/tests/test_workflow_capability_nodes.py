"""Capability selector/merge wiring and prompt preview."""

from __future__ import annotations

import asyncio
from typing import Any

import pytest

from deerflow.workflow.capability_groups import (
    CapabilityWiringError,
    resolve_ai_capability_groups,
    validate_capability_wiring,
)
from deerflow.workflow.compiler import CompileContext, WorkflowCompileError, clear_compile_cache, compile_definition
from deerflow.workflow.executors import exec_prompt_preview
from deerflow.workflow.prompt_preview import PromptPreviewError, build_prompt_preview
from deerflow.workflow.schema import Edge, Node, NodeType, Port, PortType, WorkflowDefinition


def _selector(id_: str, group: str) -> Node:
    return Node(
        id=id_,
        type=NodeType.AI_CAPABILITY_GROUP,
        params={"group": group},
        outputs=[Port(name="groups", type=PortType.ARRAY)],
    )


def _merge(id_: str, count: int = 2) -> Node:
    return Node(
        id=id_,
        type=NodeType.AI_CAPABILITY_MERGE,
        inputs=[Port(name=f"group_{i}", type=PortType.ARRAY) for i in range(1, count + 1)],
        outputs=[Port(name="groups", type=PortType.ARRAY)],
    )


def _ai(id_: str = "ai") -> Node:
    return Node(
        id=id_,
        type=NodeType.AI_LLM_AGENT,
        params={"instruction": "Do {{in}}"},
        inputs=[Port(name="in", type=PortType.DATA), Port(name="capability_groups", type=PortType.ARRAY)],
        outputs=[Port(name="out", type=PortType.DATA)],
    )


def _start() -> Node:
    return Node(id="start", type=NodeType.FLOW_START, outputs=[Port(name="out", type=PortType.DATA)])


def _end() -> Node:
    return Node(id="end", type=NodeType.FLOW_END, inputs=[Port(name="in", type=PortType.DATA)])


def _definition(nodes: list[Node], edges: list[Edge]) -> WorkflowDefinition:
    return WorkflowDefinition(id="wf", name="capability test", nodes=nodes, edges=edges)


def _flow_edges() -> list[Edge]:
    return [
        Edge(source="start", source_port="out", target="ai", target_port="in"),
        Edge(source="ai", source_port="out", target="end", target_port="in"),
    ]


@pytest.fixture(autouse=True)
def _clear_cache() -> Any:
    clear_compile_cache()
    yield


def test_merge_resolution_preserves_slot_order_and_dedupes() -> None:
    nodes = [
        _start(),
        _selector("a", "alpha"),
        _selector("b", "beta"),
        _selector("a2", "alpha"),
        _merge("merge", 3),
        _ai(),
        _end(),
    ]
    edges = [
        *_flow_edges(),
        Edge(source="a", source_port="groups", target="merge", target_port="group_1"),
        Edge(source="b", source_port="groups", target="merge", target_port="group_2"),
        Edge(source="a2", source_port="groups", target="merge", target_port="group_3"),
        Edge(source="merge", source_port="groups", target="ai", target_port="capability_groups"),
    ]
    definition = _definition(nodes, edges)

    ai_node = next(node for node in nodes if node.id == "ai")
    assert resolve_ai_capability_groups(definition, ai_node) == ["alpha", "beta"]


def test_legacy_ai_capability_groups_still_resolve() -> None:
    ai = Node(
        id="ai",
        type=NodeType.AI_LLM_AGENT,
        capability_groups=["legacy"],
        inputs=[Port(name="in", type=PortType.DATA)],
        outputs=[Port(name="out", type=PortType.DATA)],
    )
    assert resolve_ai_capability_groups(_definition([ai], []), ai) == ["legacy"]


def test_non_capability_source_for_ai_groups_is_rejected() -> None:
    nodes = [_start(), Node(id="other", type=NodeType.DATA_ASSIGN, outputs=[Port(name="out", type=PortType.ARRAY)]), _ai(), _end()]
    edges = [
        *_flow_edges(),
        Edge(source="other", source_port="out", target="ai", target_port="capability_groups"),
    ]
    with pytest.raises(CapabilityWiringError, match="selector or merge"):
        validate_capability_wiring(_definition(nodes, edges))


def test_compile_injects_groups_and_runs_ai_once() -> None:
    seen: list[list[str]] = []

    def ai_exec(_rt: Any, params: dict[str, Any], _inputs: dict[str, Any]) -> dict[str, Any]:
        seen.append(list(params.get("capability_groups") or []))
        return {"out": "ok"}

    nodes = [_start(), _selector("a", "alpha"), _selector("b", "beta"), _merge("merge"), _ai(), _end()]
    edges = [
        *_flow_edges(),
        Edge(source="a", source_port="groups", target="merge", target_port="group_1"),
        Edge(source="b", source_port="groups", target="merge", target_port="group_2"),
        Edge(source="merge", source_port="groups", target="ai", target_port="capability_groups"),
    ]
    graph = compile_definition(_definition(nodes, edges), context=CompileContext(executors={NodeType.AI_LLM_AGENT: ai_exec}))
    state = asyncio.run(graph.ainvoke({}))

    assert state["wf:ai:out"] == "ok"
    assert seen == [["alpha", "beta"]]


def test_static_prompt_preview_preserves_placeholders_and_groups() -> None:
    nodes = [_start(), _selector("a", "alpha"), _ai(), _end()]
    edges = [
        *_flow_edges(),
        Edge(source="a", source_port="groups", target="ai", target_port="capability_groups"),
    ]

    preview = build_prompt_preview(_definition(nodes, edges), "ai")

    assert "alpha" in preview.prompt
    assert "Do {{in}}" in preview.prompt
    assert preview.capability_groups == ["alpha"]


def test_prompt_preview_rejects_non_ai_node() -> None:
    with pytest.raises(PromptPreviewError, match="not an ai:llm_agent"):
        build_prompt_preview(_definition([_start(), _selector("a", "alpha"), _ai(), _end()], _flow_edges()), "a")


def test_prompt_preview_executor_reads_reserved_channel() -> None:
    runtime = type("Runtime", (), {"state": {"wf:ai:__prompt": "full prompt"}})()
    assert exec_prompt_preview(runtime, {"agent_node": "ai"}, {"in": "ignored"}) == {
        "prompt": "full prompt",
        "out": "full prompt",
    }


def test_compile_rejects_preview_without_target() -> None:
    preview = Node(
        id="preview",
        type=NodeType.AI_PROMPT_PREVIEW,
        inputs=[Port(name="in", type=PortType.DATA)],
        outputs=[Port(name="prompt", type=PortType.DATA)],
    )
    nodes = [_start(), _ai(), preview, _end()]
    edges = [
        *_flow_edges(),
        Edge(source="ai", source_port="out", target="preview", target_port="in"),
    ]
    # The AI edge is present, so inference succeeds; a bare preview with no AI
    # incoming edge is the failing shape.
    graph = compile_definition(_definition(nodes, edges), context=CompileContext(executors={NodeType.AI_LLM_AGENT: lambda *_a: {"out": "x"}, NodeType.AI_PROMPT_PREVIEW: exec_prompt_preview}))
    assert graph is not None

    with pytest.raises(WorkflowCompileError, match="prompt preview needs"):
        compile_definition(
            _definition(
                [_start(), _ai(), Node(id="preview", type=NodeType.AI_PROMPT_PREVIEW, inputs=[Port(name="in", type=PortType.DATA)], outputs=[Port(name="prompt", type=PortType.DATA)]), _end()],
                _flow_edges() + [Edge(source="start", source_port="out", target="preview", target_port="in")],
            ),
            context=CompileContext(executors={NodeType.AI_LLM_AGENT: lambda *_a: {"out": "x"}, NodeType.AI_PROMPT_PREVIEW: exec_prompt_preview}),
        )
