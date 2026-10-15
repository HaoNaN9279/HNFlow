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
from collections.abc import Sequence
from typing import TYPE_CHECKING, Any

from deerflow.config.agents_config import load_agent_soul
from deerflow.workflow.schema import Node

if TYPE_CHECKING:
    from deerflow.workflow.context_policy import ContextPolicy

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


def build_examples_layer(examples: Sequence[str]) -> str:
    """Build the declarative few-shot section (N14 §24.3).

    Renders the node's declared ``context_policy.examples`` as a deterministic
    ``<examples>`` block.  Empty input yields an empty string, so a node with no
    examples assembles exactly as before.  The entries are already normalized to
    strings by ``context_policy.parse_context_policy``.
    """
    items = [example for example in examples if example]
    if not items:
        return ""
    return "<examples>\n" + "\n\n".join(items) + "\n</examples>"


def build_context_layer(include: Sequence[str], inputs: dict[str, Any]) -> str:
    """Build the declarative context-mounting section (N14 §24.3).

    Mounts the values of the named input ports in the declared order, each under
    a ``--- <port> ---`` header, into a deterministic ``<context>`` block.  This
    is how a retrieval or upstream node's output reaches the AI node's window:
    the node declares which ports to load instead of the assembler guessing.
    Missing or ``None`` ports are skipped (no placeholder), so an unpopulated
    input never injects an empty section.
    """
    parts = [f"--- {name} ---\n{inputs[name]}" for name in include if inputs.get(name) is not None]
    if not parts:
        return ""
    return "<context>\n" + "\n\n".join(parts) + "\n</context>"


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


def build_ai_node_buckets(
    *,
    agent_name: str | None,
    capability_groups: Sequence[str],
    instruction: str | None,
    inputs: dict[str, Any],
    user_id: str | None = None,
    agent_skills: list[str] | None = None,
    policy: ContextPolicy | None = None,
) -> dict[str, str]:
    """Build the named prompt buckets for an AI node, in the fixed N14 §24.3 order.

    The single source of truth for the bucket set and order, shared by the
    executor (``executors/ai.py``) and :func:`assemble_ai_node_prompt`.  Returns
    a mapping keyed by :data:`deerflow.workflow.context_policy.BUCKET_ORDER` names
    (``identity`` / ``capability`` / ``task`` / ``examples`` / ``context``).
    The ``schema`` bucket is added by the executor (it needs the parsed
    structured-output schema), and the budget is applied separately via
    ``apply_context_budget`` — this function only *builds*.
    """
    from deerflow.workflow.context_policy import BUCKET_ORDER

    buckets = {
        "identity": build_identity_layer(agent_name, user_id=user_id),
        "capability": build_capability_layer(list(capability_groups), agent_skills=agent_skills),
        "task": build_task_layer(instruction, inputs),
        "examples": build_examples_layer(policy.examples if policy else ()),
        "context": build_context_layer(policy.include if policy else (), inputs),
    }
    return {name: buckets[name] for name in BUCKET_ORDER if name in buckets}


def assemble_ai_node_prompt(
    node: Node,
    inputs: dict[str, Any],
    *,
    user_id: str | None = None,
    agent_skills: list[str] | None = None,
    policy: ContextPolicy | None = None,
) -> str:
    """Assemble the complete AI-node prompt (unbudgeted reference path).

    Buckets are assembled in the fixed order identity → capability → task →
    examples → context, joined by blank lines; empty buckets are omitted. The
    instruction template is read from ``node.params.get("instruction")``. The
    executor applies the budget over these buckets plus the structured-output
    schema; this helper is the pure, budget-free assembler.

    Args:
        node: The AI node being executed.
        inputs: Runtime input values keyed by port name.
        user_id: Owner scope for the custom agent's SOUL lookup.
        agent_skills: Custom agent's own skills whitelist.
        policy: Normalized context policy, or ``None`` for a node without one.

    Returns:
        The full assembled prompt string.
    """
    buckets = build_ai_node_buckets(
        agent_name=node.agent_name,
        capability_groups=node.capability_groups,
        instruction=node.params.get("instruction"),
        inputs=inputs,
        user_id=user_id,
        agent_skills=agent_skills,
        policy=policy,
    )
    return "\n\n".join(text for text in buckets.values() if text)
