"""Tests for the static AI-node prompt preview breakdown."""

from __future__ import annotations

from types import SimpleNamespace

from deerflow.workflow.context_policy import estimate_tokens
from deerflow.workflow.prompt_preview import build_prompt_preview
from deerflow.workflow.prompts import DEFAULT_LEAD_IDENTITY
from deerflow.workflow.schema import Edge, Node, NodeType, Port, PortType, WorkflowDefinition


def _node(
    id_: str,
    type_: NodeType,
    *,
    params: dict | None = None,
    inputs: list[Port] | None = None,
    outputs: list[Port] | None = None,
    capability_groups: list[str] | None = None,
) -> Node:
    return Node(
        id=id_,
        type=type_,
        params=params or {},
        inputs=inputs or [],
        outputs=outputs or [],
        capability_groups=capability_groups or [],
    )


def _definition(
    *,
    ai_params: dict | None = None,
    selector: bool = False,
    ai_inputs: list[Port] | None = None,
) -> WorkflowDefinition:
    nodes = [
        _node("start", NodeType.FLOW_START, outputs=[Port(name="out", type=PortType.DATA)]),
        _node(
            "ai",
            NodeType.AI_LLM_AGENT,
            params=ai_params or {"instruction": "Do {{in}}"},
            inputs=ai_inputs or [Port(name="in", type=PortType.DATA)],
            outputs=[Port(name="out", type=PortType.DATA)],
        ),
        _node("end", NodeType.FLOW_END, inputs=[Port(name="in", type=PortType.DATA)]),
    ]
    edges = [
        Edge(source="start", source_port="out", target="ai", target_port="in"),
        Edge(source="ai", source_port="out", target="end", target_port="in"),
    ]
    if selector:
        nodes.append(
            _node(
                "groups",
                NodeType.AI_CAPABILITY_GROUP,
                params={"groups": ["alpha", "beta"]},
                outputs=[Port(name="groups", type=PortType.ARRAY)],
            )
        )
        edges.append(Edge(source="groups", source_port="groups", target="ai", target_port="capability_groups"))
    return WorkflowDefinition(id="wf-preview", name="Preview", nodes=nodes, edges=edges)


def _by_key(preview, key: str):
    return next(component for component in preview.components if component.key == key)


def test_components_follow_prompt_order(monkeypatch) -> None:
    monkeypatch.setattr(
        "deerflow.workflow.prompts.load_agent_soul",
        lambda agent_name, user_id=None: None,
    )
    monkeypatch.setattr(
        "deerflow.workflow.prompt_preview.load_capability_rules",
        lambda groups, user_id=None: [],
    )
    monkeypatch.setattr(
        "deerflow.workflow.prompt_preview.load_capability_skills",
        lambda groups, user_id=None: [],
    )
    definition = _definition(
        ai_params={
            "instruction": "Do {{in}}",
            "context_policy": {
                "examples": ["Example A"],
                "include": ["in"],
            },
        },
        selector=True,
    )

    preview = build_prompt_preview(definition, "ai")

    assert [component.key for component in preview.components] == [
        "identity",
        "capability",
        "examples",
        "context",
        "task",
    ]
    assert preview.capability_groups == ["alpha", "beta"]

    context = _by_key(preview, "context")
    assert context.state == "runtime"
    assert context.summary == "Ports: in \u2190 start.out"

    task = _by_key(preview, "task")
    assert task.content == "Do {{in}}"
    assert task.source == "params.instruction"
    assert "placeholders: in \u2190 start.out" in task.summary
    assert preview.task_prompt == "Do {{in}}"
    assert preview.prompt.endswith("Do {{in}}")


def test_runtime_blocks_are_listed_but_have_no_static_content() -> None:
    definition = _definition(
        ai_params={
            "instruction": "Do it",
            "memory": {"scopes": ["session"]},
            "retrieval": {"collection": "docs", "top_k": 3},
        }
    )

    preview = build_prompt_preview(definition, "ai")

    assert [component.key for component in preview.components] == [
        "retrieval",
        "memory",
        "identity",
        "task",
    ]
    memory = _by_key(preview, "memory")
    retrieval = _by_key(preview, "retrieval")
    assert memory.state == "runtime"
    assert retrieval.state == "runtime"
    assert memory.content == ""
    assert retrieval.content == ""
    assert preview.omitted_runtime_blocks == ("memory", "retrieval")


def test_budget_dropped_source_is_marked() -> None:
    scaffold = estimate_tokens(DEFAULT_LEAD_IDENTITY) + estimate_tokens("Do it")
    definition = _definition(
        ai_params={
            "instruction": "Do it",
            "context_policy": {
                "examples": ["x" * 1000],
                "budget": {"total_tokens": scaffold + 1},
            },
        }
    )

    preview = build_prompt_preview(definition, "ai")

    examples = _by_key(preview, "examples")
    assert examples.state == "dropped"
    assert examples.content == ""


def test_template_prompt_port_is_a_runtime_source() -> None:
    definition = _definition(
        ai_params={"instruction": "Do it"},
        ai_inputs=[
            Port(name="in", type=PortType.DATA),
            Port(name="template_prompt", type=PortType.DATA),
        ],
    )

    preview = build_prompt_preview(definition, "ai")

    template = _by_key(preview, "template_prompt")
    assert template.state == "runtime"
    assert template.source == "inputs.template_prompt"
    assert template.content == ""
    assert "template_prompt" in preview.omitted_runtime_blocks


def test_rules_and_skill_descriptions_have_their_own_sources(monkeypatch) -> None:
    monkeypatch.setattr(
        "deerflow.workflow.prompts.load_agent_soul",
        lambda agent_name, user_id=None: None,
    )
    rule = SimpleNamespace(
        group_guid="a" * 32,
        group_name="alpha",
        group_version="0.1.0",
        path="rules/a.md",
        content="RULE BODY",
        source="capability_group:alpha@0.1.0/rules/a.md",
        label="Rule: alpha / rules/a.md",
    )
    skill = SimpleNamespace(
        group_guid="a" * 32,
        group_name="alpha",
        group_version="0.1.0",
        name="profile",
        description="PROFILE DESC",
        source="capability_group:alpha@0.1.0/skills/profile/SKILL.md",
        label="Skill: alpha / profile",
    )
    monkeypatch.setattr(
        "deerflow.workflow.prompt_preview.load_capability_rules",
        lambda groups, user_id=None: [rule],
    )
    monkeypatch.setattr(
        "deerflow.workflow.prompt_preview.load_capability_skills",
        lambda groups, user_id=None: [skill],
    )
    definition = _definition(
        ai_params={"instruction": "Do it"},
        selector=True,
    )

    preview = build_prompt_preview(definition, "ai")

    rule_component = _by_key(
        preview,
        f"capability_rule:{rule.group_guid}@{rule.group_version}:{rule.path}",
    )
    skill_component = _by_key(
        preview,
        f"capability_skill:{skill.group_guid}@{skill.group_version}:{skill.name}",
    )
    assert rule_component.content == "RULE BODY"
    assert rule_component.label == "Rule: alpha / rules/a.md"
    assert skill_component.content == "- profile: PROFILE DESC"
    assert skill_component.label == "Skill: alpha / profile"
    assert "RULE BODY" in preview.system_prompt
    assert "PROFILE DESC" in preview.system_prompt
    assert "SKILL BODY" not in preview.system_prompt
