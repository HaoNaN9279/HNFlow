"""Tests for the static AI-node prompt preview breakdown."""

from __future__ import annotations

from types import SimpleNamespace

from deerflow.workflow.prompt_preview import build_prompt_preview
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
            params=ai_params or {},
            inputs=ai_inputs or [Port(name="in", type=PortType.DATA)],
            outputs=[Port(name="out", type=PortType.DATA)],
        ),
        _node("end", NodeType.FLOW_END, inputs=[Port(name="in", type=PortType.DATA)]),
    ]
    edges = [
        Edge(source="start", source_port="out", target="ai", target_port="in"),
        Edge(source="ai", source_port="out", target="end", target_port="in"),
    ]
    if any(port.name == "template_prompt" for port in (ai_inputs or [])):
        edges.append(Edge(source="start", source_port="out", target="ai", target_port="template_prompt"))
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
        lambda groups, user_id=None, project_roots=(): [],
    )
    monkeypatch.setattr(
        "deerflow.workflow.prompt_preview.load_capability_skills",
        lambda groups, user_id=None, project_roots=(): [],
    )
    definition = _definition(
        selector=True,
        ai_inputs=[
            Port(name="in", type=PortType.DATA),
            Port(name="template_prompt", type=PortType.DATA),
        ],
    )

    preview = build_prompt_preview(definition, "ai")

    assert [component.key for component in preview.components] == [
        "identity",
        "capability",
        "template_prompt",
    ]
    assert preview.capability_groups == ["alpha", "beta"]
    assert preview.task_prompt == ""
    assert "template_prompt" in preview.omitted_runtime_blocks


def test_schema_contract_and_both_schema_bindings_are_previewed(monkeypatch) -> None:
    monkeypatch.setattr(
        "deerflow.workflow.prompts.load_agent_soul",
        lambda agent_name, user_id=None: None,
    )
    nodes = [
        _node("start", NodeType.FLOW_START, outputs=[Port(name="out", type=PortType.DATA)]),
        _node(
            "schema",
            NodeType.DATA_SCHEMA,
            params={
                "schema": {
                    "version": 1,
                    "max_repairs": 1,
                    "custom_fields": [
                        {
                            "name": "decision",
                            "type": "enum",
                            "required": True,
                            "description": "Decision",
                            "enum_values": ["approve", "reject"],
                        }
                    ],
                }
            },
            outputs=[Port(name="schema", type=PortType.RECORD)],
        ),
        _node(
            "ai",
            NodeType.AI_LLM_AGENT,
            inputs=[
                Port(name="in", type=PortType.DATA),
                Port(name="template_prompt", type=PortType.DATA),
                Port(name="input_schema", type=PortType.RECORD),
                Port(name="output_schema", type=PortType.RECORD),
            ],
            outputs=[Port(name="out", type=PortType.DATA)],
        ),
        _node("end", NodeType.FLOW_END, inputs=[Port(name="in", type=PortType.DATA)]),
    ]
    edges = [
        Edge(source="start", source_port="out", target="ai", target_port="in"),
        Edge(source="start", source_port="out", target="ai", target_port="template_prompt"),
        Edge(source="schema", source_port="schema", target="ai", target_port="input_schema"),
        Edge(source="schema", source_port="schema", target="ai", target_port="output_schema"),
        Edge(source="ai", source_port="out", target="end", target_port="in"),
    ]
    definition = WorkflowDefinition(id="wf-schema", name="Schema", nodes=nodes, edges=edges)

    preview = build_prompt_preview(definition, "ai")

    keys = [component.key for component in preview.components]
    assert "schema_contract" in keys
    assert "input_schema" in keys
    assert "schema" in keys
    assert "Custom field semantics" in _by_key(preview, "schema_contract").content
    assert "Decision" in _by_key(preview, "input_schema").content


def test_runtime_task_has_no_static_content() -> None:
    definition = _definition(
        ai_inputs=[
            Port(name="in", type=PortType.DATA),
            Port(name="template_prompt", type=PortType.DATA),
        ]
    )

    preview = build_prompt_preview(definition, "ai")

    template = _by_key(preview, "template_prompt")
    assert template.state == "runtime"
    assert template.content == ""
    assert preview.omitted_runtime_blocks == ("template_prompt",)


def test_template_prompt_port_is_a_runtime_source() -> None:
    definition = _definition(
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
        lambda groups, user_id=None, project_roots=(): [rule],
    )
    monkeypatch.setattr(
        "deerflow.workflow.prompt_preview.load_capability_skills",
        lambda groups, user_id=None, project_roots=(): [skill],
    )
    definition = _definition(
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
