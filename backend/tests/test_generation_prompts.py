"""Tests for workflow generation prompt builders — pure function layer.

Covers the four public functions in
``deerflow.workflow.generation_prompts``: generate prompt, edit prompt,
skill-context rendering, and lenient definition JSON parsing.
"""

from pathlib import Path

from deerflow.skills.types import Skill, SkillCategory
from deerflow.workflow.generation_prompts import (
    _MINIMAL_EXAMPLE_JSON,
    build_edit_prompt,
    build_generate_prompt,
    build_skill_context,
    parse_definition_json,
)
from deerflow.workflow.schema import NodeType


class TestBuildGeneratePrompt:
    def test_contains_all_node_type_values(self):
        prompt = build_generate_prompt("任意描述")
        for member in NodeType:
            assert member.value in prompt, f"missing node type {member.value}"

    def test_contains_port_rules(self):
        prompt = build_generate_prompt("任意描述")
        for port_type in ("data", "file", "bool", "enum"):
            assert port_type in prompt, f"missing port type {port_type}"
        assert "flow:start" in prompt
        assert "flow:end" in prompt
        assert "flow:if" in prompt
        assert "条件" in prompt

    def test_contains_naming_constraints(self):
        prompt = build_generate_prompt("任意描述")
        assert r"^[A-Za-z0-9_-]{1,64}$" in prompt
        assert r"^[A-Za-z0-9-]+$" in prompt

    def test_contains_danger_node_hints(self):
        prompt = build_generate_prompt("任意描述")
        assert "tool:bash" in prompt
        assert "tool:http" in prompt
        assert "crash_confirm" in prompt
        assert "待审核" in prompt

    def test_contains_output_contract(self):
        prompt = build_generate_prompt("任意描述")
        assert "WorkflowDefinition" in prompt
        for field in ("id", "name", "version", "nodes", "edges", "metadata"):
            assert field in prompt, f"missing output-contract field {field}"

    def test_example_toggle(self):
        with_example = build_generate_prompt("任意描述", include_example=True)
        without_example = build_generate_prompt("任意描述", include_example=False)
        assert '"nodes"' in with_example
        assert '"flow:start"' in with_example
        assert '"data:assign"' in with_example
        assert '"flow:end"' in with_example
        assert '"nodes"' not in without_example

    def test_example_is_valid_definition(self):
        prompt = build_generate_prompt("任意描述", include_example=True)
        assert _MINIMAL_EXAMPLE_JSON in prompt
        parsed = parse_definition_json(_MINIMAL_EXAMPLE_JSON)
        assert parsed is not None
        assert parsed.id == "demo"

    def test_includes_user_prompt(self):
        prompt = build_generate_prompt("生成一个数据转换工作流")
        assert "生成一个数据转换工作流" in prompt

    def test_includes_capability_boundary_hint(self):
        prompt = build_generate_prompt("任意描述")
        assert "能力边界" in prompt
        assert "无法生成" in prompt


class TestBuildEditPrompt:
    def test_includes_existing_json_and_instruction(self):
        existing = '{"id": "wf", "name": "wf", "nodes": []}'
        instruction = "把节点 A 的 value 改为 42"
        prompt = build_edit_prompt(existing, instruction)
        assert existing in prompt
        assert instruction in prompt

    def test_preserve_unrelated_nodes(self):
        prompt = build_edit_prompt("{}", "改一个节点")
        assert "保留" in prompt
        assert "无关" in prompt

    def test_requires_complete_output(self):
        prompt = build_edit_prompt("{}", "改")
        assert "完整" in prompt

    def test_skill_context_appended_when_given(self):
        skill_context = "可用技能：\n- 数据分析: 统计汇总"
        prompt = build_edit_prompt("{}", "改", skill_context=skill_context)
        assert "可用技能：" in prompt
        assert "- 数据分析: 统计汇总" in prompt

    def test_skill_context_omitted_when_none(self):
        without = build_edit_prompt("{}", "改")
        with_ctx = build_edit_prompt("{}", "改", skill_context="ctx")
        assert "ctx" not in without
        assert "ctx" in with_ctx


class TestBuildSkillContext:
    @staticmethod
    def _skill(name, description, version="1.2.3", skill_id=None):
        return Skill(
            name=name,
            description=description,
            license=None,
            skill_dir=Path("."),
            skill_file=Path("SKILL.md"),
            relative_path=Path("."),
            category=SkillCategory.PUBLIC,
            version=version,
            skill_id=skill_id,
        )

    def test_renders_matching_skills(self):
        skills = [
            self._skill("数据分析", "对 Excel/CSV 做统计汇总", skill_id="data-analysis"),
            self._skill("deep-research", "多角度网络调研", skill_id="deep-research", version="2.0.0"),
        ]
        out = build_skill_context(["data-analysis@v1.2.3", "deep-research@v2.0.0"], skills)
        assert "数据分析" in out
        assert "对 Excel/CSV 做统计汇总" in out
        assert "deep-research" in out
        assert "多角度网络调研" in out

    def test_no_match_returns_empty(self):
        skills = [self._skill("数据分析", "统计", skill_id="data-analysis")]
        assert build_skill_context(["other@v1.0.0"], skills) == ""
        assert build_skill_context(["data-analysis@v9.9.9"], skills) == ""

    def test_guid_format_mismatch_skipped(self):
        skills = [self._skill("数据分析", "统计", skill_id="data-analysis")]
        assert build_skill_context(["data-analysis@1.2.3"], skills) == ""
        assert build_skill_context(["data-analysis"], skills) == ""
        assert build_skill_context(["@v1.0.0"], skills) == ""

    def test_skill_without_skill_id_never_matches(self):
        skills = [self._skill("旧技能", "无 skill_id", version="1.2.3", skill_id=None)]
        assert build_skill_context(["旧技能@v1.2.3"], skills) == ""

    def test_empty_inputs(self):
        assert build_skill_context([], []) == ""

    def test_mixed_partial_match(self):
        skills = [
            self._skill("数据分析", "统计汇总", skill_id="data-analysis"),
            self._skill("图片生成", "生成图片", skill_id="image-gen"),
        ]
        out = build_skill_context(["data-analysis@v1.2.3", "unknown@v3.0.0", "bad-format"], skills)
        assert "统计汇总" in out
        assert "图片生成" not in out


class TestParseDefinitionJson:
    @staticmethod
    def _valid_json():
        return '{"id": "wf_demo", "name": "演示", "version": "0.1.0", "nodes": [], "edges": [], "metadata": {"resolved_groups": []}}'

    def test_pure_json(self):
        parsed = parse_definition_json(self._valid_json())
        assert parsed is not None
        assert parsed.id == "wf_demo"
        assert parsed.name == "演示"

    def test_fenced_json(self):
        text = "```json\n" + self._valid_json() + "\n```"
        parsed = parse_definition_json(text)
        assert parsed is not None
        assert parsed.id == "wf_demo"

    def test_surrounding_noise(self):
        text = "好的，生成结果如下：\n" + self._valid_json() + "\n（以上）"
        parsed = parse_definition_json(text)
        assert parsed is not None
        assert parsed.id == "wf_demo"

    def test_garbage_returns_none(self):
        assert parse_definition_json("这不是 JSON") is None
        assert parse_definition_json("") is None
        assert parse_definition_json("   ") is None
        assert parse_definition_json("```json\n```") is None
        assert parse_definition_json("[1, 2, 3]") is None
        assert parse_definition_json('{"id": 123, "name": "x"}') is None
