"""Three-layer prompt assembly for AI workflow nodes — pure functions.

This module composes the system prompt of an ``ai:llm_agent`` node from three
independent layers, in order:

1. **Identity layer** (:func:`build_identity_layer`) — who executes the node:
   the default lead agent, or a bound custom agent (``node.agent_name``) whose
   ``SOUL.md`` is loaded leniently.
2. **Capability layer** (:func:`build_capability_layer`) — which capability
   groups (plus the custom agent's own skills configuration) contribute the
   node's allowed-tools union.
3. **Task layer** (:func:`build_task_layer`) — the node's instruction template
   with ``{{port}}`` placeholders interpolated from runtime inputs.

Every function is a pure transformation of its arguments. The only I/O — the
custom-agent SOUL read — is delegated to
:func:`deerflow.config.agents_config.load_agent_soul`, a thin loader with no
langgraph / langchain / app / subagents dependency, so this module stays free of
graph and executor imports and cannot introduce import cycles.
"""

from __future__ import annotations

import re
from typing import Any

from deerflow.config.agents_config import load_agent_soul
from deerflow.workflow.schema import Node

# 默认 lead 身份声明：agent_name 为 None（未绑定 custom agent）时使用。
DEFAULT_LEAD_IDENTITY = "你是一个通用 AI 助手，负责执行当前工作流节点任务。"

# 匹配 ``{{ name }}`` 形式的端口占位符（允许空白，键名不能包含大括号）。
_PLACEHOLDER_PATTERN = re.compile(r"\{\{\s*([^{}]+?)\s*\}\}")


def build_identity_layer(agent_name: str | None, *, user_id: str | None = None) -> str:
    """Build the identity-layer prompt section for a workflow node.

    Args:
        agent_name: Custom-agent name bound to the node, or ``None`` for the
            default lead agent.
        user_id: Owner scope for the custom agent's SOUL lookup.

    Returns:
        ``agent_name=None`` yields the neutral default lead declaration. A
        non-``None`` ``agent_name`` yields a declaration naming that agent,
        followed by its ``SOUL.md`` body when one exists; a missing SOUL is
        lenient — the declaration alone is returned, never an error.
    """
    if agent_name is None:
        return DEFAULT_LEAD_IDENTITY
    declaration = f"你正在以自定义 agent「{agent_name}」的身份执行当前工作流节点任务。"
    soul = load_agent_soul(agent_name, user_id=user_id)
    if not soul:
        return declaration
    return f"{declaration}\n\n{soul}"


def build_capability_layer(capability_groups: list[str], *, agent_skills: list[str] | None = None) -> str:
    """Build the capability-layer prompt section for a workflow node.

    Describes the enabled capability groups whose allowed-tools union supplies
    the node's tool set. ``agent_skills`` describes the custom agent's own
    skills configuration: ``None`` = all enabled, ``[]`` = disabled, a
    non-empty list = exactly those skills enabled.

    Args:
        capability_groups: Enabled capability-group names (skill names).
        agent_skills: Custom agent's own skills whitelist (see semantics above).

    Returns:
        The capability description paragraph, or an empty string when
        ``capability_groups`` is empty.
    """
    if not capability_groups:
        return ""
    lines = [
        f"已启用能力组：{'、'.join(capability_groups)}。",
        "这些能力组提供的 allowed-tools 工具集合并集构成当前节点的可用工具集。",
    ]
    if agent_skills is None:
        lines.append("自定义 agent 自身 skills：全部启用。")
    elif not agent_skills:
        lines.append("自定义 agent 自身 skills：禁用。")
    else:
        lines.append(f"自定义 agent 自身 skills：指定启用 {'、'.join(agent_skills)}。")
    return "\n".join(lines)


def build_task_layer(instruction: str | None, inputs: dict[str, Any]) -> str:
    """Build the task-layer prompt section by interpolating ``{{port}}``.

    Each ``{{name}}`` placeholder is replaced with ``str(inputs[name])``;
    missing keys (and ``None`` values) become empty strings without raising.
    An instruction with no placeholders is returned verbatim.

    Args:
        instruction: The node's instruction template, or ``None``/empty.
        inputs: Runtime input values keyed by port name.

    Returns:
        The interpolated instruction, or an empty string for a falsy
        ``instruction``.
    """
    if not instruction:
        return ""

    def render(match: re.Match[str]) -> str:
        value = inputs.get(match.group(1).strip())
        return "" if value is None else str(value)

    return _PLACEHOLDER_PATTERN.sub(render, instruction)


def assemble_ai_node_prompt(
    node: Node,
    inputs: dict[str, Any],
    *,
    user_id: str | None = None,
    agent_skills: list[str] | None = None,
) -> str:
    """Assemble the complete AI-node prompt from the three layers.

    Layers are assembled identity → capability → task, joined by blank lines;
    empty layers are omitted. The instruction template is read from
    ``node.params.get("instruction")``.

    Args:
        node: The AI node being executed.
        inputs: Runtime input values keyed by port name.
        user_id: Owner scope for the custom agent's SOUL lookup.
        agent_skills: Custom agent's own skills whitelist.

    Returns:
        The full assembled prompt string.
    """
    sections = [
        build_identity_layer(node.agent_name, user_id=user_id),
        build_capability_layer(node.capability_groups, agent_skills=agent_skills),
        build_task_layer(node.params.get("instruction"), inputs),
    ]
    return "\n\n".join(section for section in sections if section)
