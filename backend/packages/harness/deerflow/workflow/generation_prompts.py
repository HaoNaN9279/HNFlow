"""Workflow definition generation prompt builders — pure functions.

This module composes the LLM prompts used to generate and edit
:class:`~deerflow.workflow.schema.WorkflowDefinition` JSON documents, renders
resolved capability groups into a skill summary block, and leniently parses a
definition back out of raw model output.  It is a pure function layer: no
langgraph / langchain imports, no I/O.

- :func:`build_generate_prompt` — system (node-type enum, port rules, naming
  constraints, danger-node hints, output contract, optional minimal example) +
  user (the user prompt plus a capability-boundary hint).
- :func:`build_edit_prompt` — regenerate a complete definition from an existing
  JSON document plus an edit instruction, preserving unrelated nodes.
- :func:`build_skill_context` — resolve ``guid@v<version>`` capability groups to
  a human-readable ``<skill name>: <description>`` summary block; fail-open on
  any parse failure or mismatch.
- :func:`parse_definition_json` — leniently parse a ``WorkflowDefinition`` from
  raw model output (strips Markdown fences and surrounding noise).
"""

from __future__ import annotations

import json
from typing import TYPE_CHECKING

from pydantic import ValidationError

from deerflow.workflow.schema import (
    _ID_PATTERN,
    NodeType,
    PortType,
    WorkflowDefinition,
)

if TYPE_CHECKING:
    from collections.abc import Sequence

    from deerflow.skills.types import Skill

# Shared naming-contract pattern: id grammar mirrors ``schema._ID_PATTERN`` and
# agent_name mirrors ``deerflow.config.agents_config.AGENT_NAME_PATTERN``.  The
# pattern text is surfaced to the model so it never has to reverse-engineer the
# validator; keep it in lockstep with the schema.
_AGENT_NAME_PATTERN = r"^[A-Za-z0-9-]+$"

# A minimal legal definition: start -> data:assign -> end.  Kept valid against
# the Pydantic schema (extra="forbid" everywhere), so it doubles as a golden
# example for tests.
_MINIMAL_EXAMPLE_JSON = """{
  "id": "demo",
  "name": "demo workflow",
  "version": "0.1.0",
  "nodes": [
    {
      "id": "start",
      "type": "flow:start",
      "inputs": [],
      "outputs": [{"name": "out", "type": "data", "required": true}],
      "params": {}
    },
    {
      "id": "assign",
      "type": "data:assign",
      "inputs": [{"name": "in", "type": "data", "required": true}],
      "outputs": [{"name": "out", "type": "data", "required": true}],
      "params": {"value": "hello"}
    },
    {
      "id": "end",
      "type": "flow:end",
      "inputs": [{"name": "in", "type": "data", "required": true}],
      "outputs": [],
      "params": {}
    }
  ],
  "edges": [
    {"source": "start", "source_port": "out", "target": "assign", "target_port": "in"},
    {"source": "assign", "source_port": "out", "target": "end", "target_port": "in"}
  ],
  "metadata": {"resolved_groups": []}
}"""


def build_generate_prompt(
    user_prompt: str,
    *,
    include_example: bool = True,
) -> str:
    """Build the LLM prompt that generates a workflow definition.

    The system section enumerates every :class:`NodeType` member
    (``category:name``), the four :class:`PortType` values, the structural port
    rules (exactly one ``flow:start`` and one ``flow:end``; ``flow:if`` needs a
    bool condition port), the id / agent_name naming constraints, the danger-node
    hint (``tool:bash`` / ``tool:http`` are pending-review by default and can be
    exempted with an explicit ``crash_confirm: false`` in ``params``), and the
    output contract (exactly one WorkflowDefinition JSON object, no Markdown
    fence).  When ``include_example`` is true a minimal legal example
    (``start -> data:assign -> end``) is appended.

    The user section carries ``user_prompt`` plus a capability-boundary hint.
    Callers that resolved skill context (via :func:`build_skill_context`) should
    append it to ``user_prompt`` so the model stays inside the available
    capability surface.
    """
    port_type_list = ", ".join(port.value for port in PortType)
    system_body = "\n".join(
        [
            "你是一名工作流定义生成器。根据用户描述，生成一个 DeerFlow 工作流定义。",
            "",
            "## 可用节点类型（category:name）",
            *(f"- {member.value}" for member in NodeType),
            "",
            "## 端口规则",
            f"- 端口类型共四种：{port_type_list}。",
            "- 每个工作流必须且只能有一个 flow:start 节点和一个 flow:end 节点。",
            "- flow:if 节点必须提供一个 bool 类型输入端口作为分支条件。",
            "- 同一输入端口只允许一条入边（flow:end 与 flow:loop 例外）。",
            "- ai:llm_agent 的任务只来自 template_prompt 输入端口；输出 Schema 由 data:schema 节点接入 output_schema，不要写 instruction/output_schema 参数。",
            "",
            "## 命名约束",
            f"- 节点 id 必须匹配 {_ID_PATTERN.pattern!r}（1-64 个安全 ASCII 字符）。",
            f"- agent_name 必须匹配 {_AGENT_NAME_PATTERN!r}。",
            "",
            "## 危险节点",
            "- tool:bash 与 tool:http 节点默认携带待审核标记（pending review）。",
            "- 仅当用户已明确确认风险时，才可在该节点 params 中显式设置 crash_confirm: false 以豁免待审核标记。",
            "",
            "## 输出要求",
            "- 只输出一个 JSON 对象，其结构对应 WorkflowDefinition：id、name、version、nodes、edges、metadata。",
            "- 不要输出 Markdown 代码围栏（```），不要输出任何解释性文字。",
        ]
    )

    user_body = "\n".join(
        [
            user_prompt,
            "",
            "能力边界：只能使用上述节点类型与端口规则构建工作流。若请求超出可用能力范围或缺少关键信息，请说明无法生成的原因；不要编造不存在的节点类型。",
        ]
    )

    sections = [f"system：\n{system_body}"]
    if include_example:
        sections.append(f"## 合法示例（start → data:assign → end）\n{_MINIMAL_EXAMPLE_JSON}")
    sections.append(f"user：\n{user_body}")
    return "\n\n".join(sections)


def build_edit_prompt(
    existing_json: str,
    instruction: str,
    *,
    skill_context: str | None = None,
) -> str:
    """Build the LLM prompt that edits an existing workflow definition.

    Presents ``existing_json`` plus ``instruction`` and demands a complete
    replacement WorkflowDefinition JSON — unchanged nodes and edges must be
    preserved verbatim and only the targeted parts modified.  ``skill_context``
    (e.g. the output of :func:`build_skill_context`) is appended when provided.
    """
    sections = [
        "你是一名工作流定义编辑器。你手里有一份现有工作流定义 JSON 和一条修改指令。",
        "",
        "规则：",
        "- 只修改指令要求的目标节点或边；其余与指令无关的节点、边和 metadata 必须原样保留。",
        "- 输出必须是一个完整的 WorkflowDefinition JSON 对象（id/name/version/nodes/edges/metadata），不要省略任何未修改的部分。",
        "- 不要输出 Markdown 代码围栏，不要输出解释性文字。",
        "",
        "现有工作流定义：",
        existing_json,
        "",
        "修改指令：",
        instruction,
    ]
    if skill_context:
        sections.extend(["", "可用技能上下文：", skill_context])
    return "\n".join(sections)


def build_skill_context(
    resolved_groups: list[str],
    skills: Sequence[Skill],
) -> str:
    """Render resolved capability groups into a skill summary block.

    Each entry of ``resolved_groups`` has the form ``<guid>@v<version>`` (as
    produced by ``schema.collect_resolved_groups``).  A skill matches when its
    ``skill_id`` equals the guid and its ``version`` equals the version.  The
    result is a block of ``<skill name>: <description>`` lines.  Fail-open:
    entries that cannot be parsed (missing ``@``, version not prefixed with
    ``v``, empty guid) and entries without a matching skill are skipped, and an
    empty result returns ``""``.
    """
    seen: set[tuple[str | None, str]] = set()
    matches: list[Skill] = []
    for group in resolved_groups:
        guid, version = _split_resolved_group(group)
        if guid is None or version is None:
            continue
        for skill in skills:
            if skill.skill_id == guid and skill.version == version and (skill.skill_id, skill.version) not in seen:
                seen.add((skill.skill_id, skill.version))
                matches.append(skill)
    if not matches:
        return ""
    lines = ["可用技能："]
    lines.extend(f"- {skill.name}: {skill.description}" for skill in matches)
    return "\n".join(lines)


def parse_definition_json(text: str) -> WorkflowDefinition | None:
    """Leniently parse a ``WorkflowDefinition`` from raw model output.

    Strips a Markdown fence and any leading/trailing non-JSON noise by slicing
    from the first ``{`` to the last ``}``, then validates the JSON against
    :class:`WorkflowDefinition`.  Returns ``None`` when the text holds no JSON
    object or when parsing/validation fails.
    """
    if not isinstance(text, str):
        return None
    start = text.find("{")
    end = text.rfind("}")
    if start == -1 or end < start:
        return None
    try:
        data = json.loads(text[start : end + 1])
    except (json.JSONDecodeError, ValueError):
        return None
    if not isinstance(data, dict):
        return None
    try:
        return WorkflowDefinition.model_validate(data)
    except (ValidationError, ValueError):
        return None


def _split_resolved_group(group: str) -> tuple[str | None, str | None]:
    """Split ``<guid>@v<version>`` into ``(guid, version)``.

    Returns ``(None, None)`` for any malformed entry (non-string, missing
    ``@``, empty guid, or a version part not starting with ``v``).
    """
    if not isinstance(group, str) or "@" not in group:
        return None, None
    guid, _, version_part = group.rpartition("@")
    if not guid or not version_part.startswith("v") or len(version_part) == 1:
        return None, None
    return guid, version_part[1:]
