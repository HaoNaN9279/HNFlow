"""Three-layer prompt assembly for AI workflow nodes — pure functions.

This module composes the system prompt of an ``ai:llm_agent`` node from three
independent layers, in order:

1. **Identity layer** (:func:`build_identity_layer`) — who executes the node:
   the default lead agent, or a bound custom agent (``node.agent_name``) whose
   ``SOUL.md`` is loaded leniently.
2. **Capability layer** — which capability groups contribute the node's
   allowed-tools union, their ``rules/**/*.md`` bodies, and the names +
   descriptions of their skills.  Full skill bodies load on demand through the
   scoped reader tool, not here.
3. **Task layer** (:func:`build_task_layer`) — the node's template prompt
   with ``{{port}}`` placeholders interpolated from runtime inputs.

Every function is a pure transformation of its arguments. The only I/O — the
custom-agent SOUL read — is delegated to
:func:`deerflow.config.agents_config.load_agent_soul`, a thin loader with no
langgraph / langchain / app / subagents dependency, so this module stays free of
graph and executor imports and cannot introduce import cycles.
"""

from __future__ import annotations

import html
import re
from collections.abc import Sequence
from typing import Any

from deerflow.config.agents_config import load_agent_soul
from deerflow.workflow.schema import Node

# 默认 lead 身份声明：agent_name 为 None（未绑定 custom agent）时使用。
DEFAULT_LEAD_IDENTITY = "你是一个通用 AI 助手，负责执行当前工作流节点任务。"

#: Input port carrying the template/reset mode's runtime user turn.
TEMPLATE_PROMPT_PORT = "template_prompt"

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


def build_task_layer(task_text: str | None, inputs: dict[str, Any], *, preserve_placeholders: bool = False) -> str:
    """Build the task-layer prompt section by interpolating ``{{port}}``.

    Each ``{{name}}`` placeholder is replaced with ``str(inputs[name])``;
    missing keys (and ``None`` values) become empty strings without raising.
    A task text with no placeholders is returned verbatim.

    Args:
        task_text: The prompt text to interpolate, or ``None``/empty.
        inputs: Runtime input values keyed by port name.
        preserve_placeholders: Keep an unresolved ``{{name}}`` verbatim instead
            of replacing it with an empty string.  Used by the static prompt
            preview, where no runtime inputs exist yet.

    Returns:
        The interpolated prompt, or an empty string for a falsy ``task_text``.
    """
    if not task_text:
        return ""

    def render(match: re.Match[str]) -> str:
        key = match.group(1).strip()
        if key not in inputs or inputs.get(key) is None:
            return match.group(0) if preserve_placeholders else ""
        return str(inputs[key])

    return _PLACEHOLDER_PATTERN.sub(render, task_text)


def build_template_prompt_layer(
    template_prompt: str | None,
    inputs: dict[str, Any],
    *,
    preserve_placeholders: bool = False,
) -> str:
    """Render the template-mode runtime user turn.

    It shares the task layer's ``{{port}}`` interpolation semantics, including
    preserving unresolved placeholders for the static preview.
    """
    return build_task_layer(template_prompt, inputs, preserve_placeholders=preserve_placeholders)


def append_template_prompt(task_prompt: str, template_prompt: str) -> str:
    """Join the runtime turn after *task_prompt* without blank separators."""
    return "\n\n".join(part for part in (task_prompt, template_prompt) if part)


def build_capability_rules_layer(rules: Sequence[Any]) -> str:
    """Render every active capability-group rule as a source-labelled block."""
    if not rules:
        return ""
    parts: list[str] = ["<capability_rules>"]
    for rule in rules:
        parts.append(f"--- {rule.group_name}@{rule.group_version} / {rule.path} ---\n{rule.content.rstrip()}")
    parts.append("</capability_rules>")
    return "\n\n".join(parts)


def build_capability_skills_layer(skills: Sequence[Any]) -> str:
    """Render skill names and descriptions only; bodies load on demand."""
    if not skills:
        return ""
    lines = [
        "<capability_skills>",
        "Call read_capability_skill(name) to load a skill's full instructions.",
    ]
    for skill in skills:
        name = html.escape(skill.name, quote=False)
        description = html.escape(skill.description, quote=False)
        lines.append(f"- {name}: {description}")
    lines.append("</capability_skills>")
    return "\n".join(lines)


#: Prompt bucket order.  The task bucket is the user turn; everything else is
#: system context.  The schema bucket is appended by the executor.
BUCKET_ORDER: tuple[str, ...] = (
    "identity",
    "capability",
    "capability_rules",
    "capability_skills",
    "task",
    "schema",
)


def build_ai_node_buckets(
    *,
    agent_name: str | None,
    capability_groups: Sequence[str],
    template_prompt: str | None,
    inputs: dict[str, Any],
    user_id: str | None = None,
    agent_skills: list[str] | None = None,
    preserve_placeholders: bool = False,
    capability_rules: Sequence[Any] = (),
    capability_skills: Sequence[Any] = (),
) -> dict[str, str]:
    """Build the named prompt buckets for an AI node.

    ``template_prompt`` is the only task source.  It is interpolated with the
    same ``{{port}}`` semantics as every other dynamic prompt input.
    """
    buckets = {
        "identity": build_identity_layer(agent_name, user_id=user_id),
        "capability": build_capability_layer(list(capability_groups), agent_skills=agent_skills),
        "capability_rules": build_capability_rules_layer(capability_rules),
        "capability_skills": build_capability_skills_layer(capability_skills),
        "task": build_task_layer(template_prompt, inputs, preserve_placeholders=preserve_placeholders),
    }
    return {name: buckets[name] for name in BUCKET_ORDER if name in buckets}


def assemble_ai_node_prompt(
    node: Node,
    inputs: dict[str, Any],
    *,
    user_id: str | None = None,
    agent_skills: list[str] | None = None,
    capability_rules: Sequence[Any] = (),
    capability_skills: Sequence[Any] = (),
) -> str:
    """Assemble the complete AI-node prompt (unbudgeted reference path)."""
    buckets = build_ai_node_buckets(
        agent_name=node.agent_name,
        capability_groups=node.capability_groups,
        template_prompt=inputs.get(TEMPLATE_PROMPT_PORT),
        inputs=inputs,
        user_id=user_id,
        agent_skills=agent_skills,
        capability_rules=capability_rules,
        capability_skills=capability_skills,
    )
    return "\n\n".join(text for text in buckets.values() if text)
