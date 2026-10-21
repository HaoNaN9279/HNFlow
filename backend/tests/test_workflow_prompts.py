"""Tests for deerflow.workflow.prompts — three-layer AI-node prompt assembly."""

from types import SimpleNamespace

from deerflow.workflow.prompts import (
    append_template_prompt,
    assemble_ai_node_prompt,
    build_capability_layer,
    build_capability_rules_layer,
    build_capability_skills_layer,
    build_identity_layer,
    build_task_layer,
    build_template_prompt_layer,
)
from deerflow.workflow.schema import Node, NodeType


def _make_node(*, agent_name=None, capability_groups=None, params=None) -> Node:
    """Build a minimal ``ai:llm_agent`` node for prompt-assembly tests."""
    return Node(
        id="n1",
        type=NodeType.AI_LLM_AGENT,
        agent_name=agent_name,
        capability_groups=capability_groups or [],
        params=params or {},
    )


class TestBuildIdentityLayer:
    """Identity layer: default lead vs. bound custom agent."""

    def test_none_agent_name_returns_default_lead_declaration(self):
        result = build_identity_layer(None)
        assert "通用 AI 助手" in result
        assert "custom agent" not in result

    def test_custom_agent_with_soul_includes_declaration_and_body(self, monkeypatch):
        monkeypatch.setattr(
            "deerflow.workflow.prompts.load_agent_soul",
            lambda agent_name, user_id=None: "我是 publisher 的 SOUL。",
        )
        result = build_identity_layer("publisher", user_id="u1")
        assert "publisher" in result
        assert "我是 publisher 的 SOUL。" in result

    def test_custom_agent_without_soul_is_lenient(self, monkeypatch):
        monkeypatch.setattr(
            "deerflow.workflow.prompts.load_agent_soul",
            lambda agent_name, user_id=None: None,
        )
        result = build_identity_layer("ghost", user_id="u1")
        assert "ghost" in result
        assert "自定义 agent" in result


class TestBuildCapabilityLayer:
    """Capability layer: group listing + allowed-tools union description."""

    def test_empty_groups_returns_empty_string(self):
        assert build_capability_layer([]) == ""

    def test_lists_groups_and_describes_union(self):
        result = build_capability_layer(["web", "publish"], agent_skills=["web"])
        assert "已启用能力组" in result
        assert "web" in result
        assert "publish" in result
        assert "allowed-tools" in result

    def test_empty_groups_returns_empty_even_with_agent_skills(self):
        assert build_capability_layer([], agent_skills=["web"]) == ""


class TestBuildTaskLayer:
    """Task layer: ``{{port}}`` interpolation with lenient missing keys."""

    def test_interpolates_list_value(self):
        result = build_task_layer("处理 {{url_list}}", {"url_list": ["a", "b"]})
        assert result == "处理 ['a', 'b']"

    def test_missing_key_becomes_empty(self):
        assert build_task_layer("x{{missing}}y", {}) == "xy"

    def test_no_placeholder_returns_verbatim(self):
        assert build_task_layer("原样文本", {"a": 1}) == "原样文本"

    def test_empty_instruction_returns_empty(self):
        assert build_task_layer("", {"a": 1}) == ""
        assert build_task_layer(None, {"a": 1}) == ""

    def test_multiple_placeholders(self):
        result = build_task_layer("端口 {{a}} 和 {{b}}", {"a": "x", "b": 2})
        assert result == "端口 x 和 2"


class TestTemplatePromptLayer:
    """Template prompt = runtime user turn appended after the task layer."""

    def test_interpolates_like_instruction(self):
        assert build_template_prompt_layer("Answer {{in}}", {"in": "x"}) == "Answer x"

    def test_empty_template_prompt(self):
        assert build_template_prompt_layer("", {"in": "x"}) == ""
        assert build_template_prompt_layer(None, {"in": "x"}) == ""

    def test_append_keeps_template_prompt_at_end(self):
        assert append_template_prompt("Task", "User") == "Task\n\nUser"
        assert append_template_prompt("", "User") == "User"
        assert append_template_prompt("Task", "") == "Task"

    def test_assemble_includes_capability_content(self, monkeypatch):
        monkeypatch.setattr(
            "deerflow.workflow.prompts.load_agent_soul",
            lambda agent_name, user_id=None: None,
        )
        node = _make_node(
            capability_groups=["alpha"],
            params={"instruction": "do {{x}}"},
        )
        rule = SimpleNamespace(
            group_name="alpha",
            group_version="0.1.0",
            path="rules/a.md",
            content="RULE BODY",
        )
        skill = SimpleNamespace(name="s1", description="SKILL DESC")
        prompt = assemble_ai_node_prompt(
            node,
            {"x": 1},
            capability_rules=[rule],
            capability_skills=[skill],
        )
        assert "RULE BODY" in prompt
        assert "s1: SKILL DESC" in prompt
        assert "full SKILL.md" not in prompt


class TestCapabilityContentLayers:
    def test_rules_are_source_labelled(self):
        rule = SimpleNamespace(
            group_name="alpha",
            group_version="0.1.0",
            path="rules/a.md",
            content="RULE",
        )
        result = build_capability_rules_layer([rule])
        assert "<capability_rules>" in result
        assert "alpha@0.1.0 / rules/a.md" in result
        assert "RULE" in result

    def test_skills_render_descriptions_not_bodies(self):
        skill = SimpleNamespace(name="s1", description="DESC")
        result = build_capability_skills_layer([skill])
        assert "<capability_skills>" in result
        assert "s1: DESC" in result
        assert "read_capability_skill" in result
        assert "BODY" not in result


class TestAssembleAiNodePrompt:
    """Full three-layer assembly."""

    def test_three_layer_assembly(self, monkeypatch):
        monkeypatch.setattr(
            "deerflow.workflow.prompts.load_agent_soul",
            lambda agent_name, user_id=None: "SOUL正文",
        )
        node = _make_node(
            agent_name="publisher",
            capability_groups=["web", "publish"],
            params={},
        )
        prompt = assemble_ai_node_prompt(node, {"template_prompt": "抓取 {{url_list}}", "url_list": ["a", "b"]}, user_id="u1")
        assert "publisher" in prompt  # identity layer
        assert "SOUL正文" in prompt
        assert "已启用能力组" in prompt  # capability layer
        assert "web" in prompt
        assert "抓取 ['a', 'b']" in prompt  # task layer

    def test_empty_capability_layer_omitted(self, monkeypatch):
        monkeypatch.setattr(
            "deerflow.workflow.prompts.load_agent_soul",
            lambda agent_name, user_id=None: None,
        )
        node = _make_node(agent_name="publisher")
        prompt = assemble_ai_node_prompt(node, {"template_prompt": "do {{x}}", "x": 1})
        assert "已启用能力组" not in prompt
        assert "do 1" in prompt

    def test_empty_instruction_omits_task_layer(self, monkeypatch):
        monkeypatch.setattr(
            "deerflow.workflow.prompts.load_agent_soul",
            lambda agent_name, user_id=None: None,
        )
        node = _make_node(capability_groups=["web"])
        prompt = assemble_ai_node_prompt(node, {})
        expected = build_identity_layer(None) + "\n\n" + build_capability_layer(["web"])
        assert prompt == expected

    def test_pure_function_same_input_same_output(self, monkeypatch):
        monkeypatch.setattr(
            "deerflow.workflow.prompts.load_agent_soul",
            lambda agent_name, user_id=None: "SOUL",
        )
        node = _make_node(
            agent_name="publisher",
            capability_groups=["web"],
            params={},
        )
        inputs = {"url_list": ["a", "b"]}
        first = assemble_ai_node_prompt(node, inputs, user_id="u1")
        second = assemble_ai_node_prompt(node, inputs, user_id="u1")
        assert first == second
