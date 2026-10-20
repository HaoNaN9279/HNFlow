"""Static prompt preview for ``ai:llm_agent`` nodes.

The canvas can ask for the prompt an AI node *would* assemble without running
the model.  Runtime-only blocks (node memory, knowledge retrieval and the
``template_prompt`` input port) have no values before execution, so the
response reports them as omitted instead of inventing content.  Everything else
uses the same assemblers as the real executor, including the node's capability
groups, rules and skill descriptions.
"""

from __future__ import annotations

import re
from dataclasses import dataclass
from typing import Any

from deerflow.capability_groups.discovery import CapabilityGroupError
from deerflow.capability_groups.runtime import CapabilityContentError, load_capability_rules, load_capability_skills
from deerflow.config.agents_config import load_agent_config
from deerflow.workflow.capability_group_nodes import CapabilityGroupWiringError, resolve_ai_capability_groups, validate_capability_group_wiring
from deerflow.workflow.context_policy import BUCKET_ORDER, ContextPolicyError, apply_context_budget, estimate_tokens, parse_context_policy
from deerflow.workflow.knowledge import KnowledgeError, parse_retrieval_params
from deerflow.workflow.memory import MemoryPolicyError, parse_memory_policy
from deerflow.workflow.prompts import TEMPLATE_PROMPT_PORT, build_ai_node_buckets
from deerflow.workflow.schema import NodeType, WorkflowDefinition
from deerflow.workflow.structured_output import StructuredOutputError, parse_output_schema, schema_instruction

_PLACEHOLDER_PATTERN = re.compile(r"\{\{\s*([^{}]+?)\s*\}\}")


class PromptPreviewError(ValueError):
    """A prompt preview request that cannot be answered for this definition."""


@dataclass(frozen=True)
class PromptComponent:
    """One source section in the assembled prompt."""

    key: str
    section: str
    source: str
    summary: str
    content: str
    estimated_tokens: int
    state: str = "active"
    editable: bool = False
    label: str = ""

    def to_dict(self) -> dict[str, Any]:
        return {
            "key": self.key,
            "section": self.section,
            "source": self.source,
            "summary": self.summary,
            "content": self.content,
            "estimated_tokens": self.estimated_tokens,
            "state": self.state,
            "editable": self.editable,
            "label": self.label,
        }


@dataclass(frozen=True)
class PromptPreview:
    node_id: str
    prompt: str
    system_prompt: str
    task_prompt: str
    capability_groups: list[str]
    omitted_runtime_blocks: tuple[str, ...]
    components: tuple[PromptComponent, ...] = ()

    def to_dict(self) -> dict[str, Any]:
        return {
            "node_id": self.node_id,
            "prompt": self.prompt,
            "system_prompt": self.system_prompt,
            "task_prompt": self.task_prompt,
            "capability_groups": list(self.capability_groups),
            "omitted_runtime_blocks": list(self.omitted_runtime_blocks),
            "components": [component.to_dict() for component in self.components],
        }


def _first_line(text: str, *, limit: int = 160) -> str:
    line = next((line.strip() for line in text.splitlines() if line.strip()), "")
    return line if len(line) <= limit else f"{line[: limit - 1]}…"


def _placeholder_names(text: str) -> list[str]:
    return list(dict.fromkeys(match.strip() for match in _PLACEHOLDER_PATTERN.findall(text)))


def _port_connections(definition: WorkflowDefinition, node_id: str) -> dict[str, list[str]]:
    connections: dict[str, list[str]] = {}
    for edge in definition.edges:
        if edge.target != node_id:
            continue
        connections.setdefault(edge.target_port, []).append(f"{edge.source}.{edge.source_port}")
    return connections


def _describe_ports(definition: WorkflowDefinition, node_id: str, ports: list[str]) -> str:
    connections = _port_connections(definition, node_id)
    parts = []
    for port in ports:
        sources = connections.get(port)
        parts.append(f"{port} ← {', '.join(sources)}" if sources else f"{port} (unconnected)")
    return "; ".join(parts)


def _bucket_state(name: str, *, runtime: bool, dropped: set[str], truncated: set[str]) -> str:
    if name in dropped:
        return "dropped"
    if name in truncated:
        return "truncated"
    return "runtime" if runtime else "active"


def _summarize(text: str, fallback: str) -> str:
    return _first_line(text) if text.strip() else fallback


def build_prompt_preview(
    definition: WorkflowDefinition,
    node_id: str,
    *,
    user_id: str | None = None,
) -> PromptPreview:
    """Assemble the static text prompt for one AI node.

    Unresolved ``{{port}}`` placeholders are preserved verbatim (there is no
    runtime input to interpolate), so the preview shows the template the author
    wrote rather than silently blanking it.  Memory/retrieval blocks are
    reported in ``omitted_runtime_blocks``.
    """
    node = next((candidate for candidate in definition.nodes if candidate.id == node_id), None)
    if node is None:
        raise PromptPreviewError(f"node '{node_id}' not found")
    if node.type != NodeType.AI_LLM_AGENT:
        raise PromptPreviewError(f"node '{node_id}' is not an ai:llm_agent node")

    try:
        validate_capability_group_wiring(definition)
        capability_groups = resolve_ai_capability_groups(definition, node)
    except CapabilityGroupWiringError as exc:
        raise PromptPreviewError(str(exc)) from exc

    try:
        policy = parse_context_policy(node.params)
    except ContextPolicyError as exc:
        raise PromptPreviewError(f"invalid context_policy: {exc}") from exc
    try:
        output_schema = parse_output_schema(node.params)
    except StructuredOutputError as exc:
        raise PromptPreviewError(f"invalid output_schema: {exc}") from exc
    try:
        memory_policy = parse_memory_policy(node.params)
    except MemoryPolicyError as exc:
        raise PromptPreviewError(f"invalid memory: {exc}") from exc
    try:
        retrieval_policy = parse_retrieval_params(node.params)
    except KnowledgeError as exc:
        raise PromptPreviewError(f"invalid retrieval: {exc}") from exc

    try:
        capability_rules = load_capability_rules(capability_groups, user_id=user_id)
        capability_skills = load_capability_skills(capability_groups, user_id=user_id)
    except (CapabilityContentError, CapabilityGroupError) as exc:
        raise PromptPreviewError(str(exc)) from exc

    agent_config = load_agent_config(node.agent_name, user_id=user_id) if node.agent_name else None
    agent_skills = agent_config.skills if agent_config is not None else None

    buckets = build_ai_node_buckets(
        agent_name=node.agent_name,
        capability_groups=capability_groups,
        instruction=node.params.get("instruction"),
        inputs={},
        user_id=user_id,
        agent_skills=agent_skills,
        policy=policy,
        preserve_placeholders=True,
        capability_rules=capability_rules,
        capability_skills=capability_skills,
    )
    if output_schema is not None:
        buckets["schema"] = schema_instruction(output_schema)
    budget_result = apply_context_budget(buckets, policy.budget if policy else None)
    base_task_prompt = budget_result.buckets.get("task", "")
    task_prompt = base_task_prompt
    system_prompt = "\n\n".join(budget_result.buckets[name] for name in BUCKET_ORDER if name != "task" and budget_result.buckets.get(name))
    prompt = "\n\n".join(part for part in (system_prompt, task_prompt) if part)

    dropped = set(budget_result.dropped)
    truncated = set(budget_result.truncated)
    components: list[PromptComponent] = []

    def add(
        key: str,
        section: str,
        source: str,
        summary: str,
        content: str,
        *,
        state: str = "active",
        editable: bool = False,
        label: str = "",
    ) -> None:
        components.append(
            PromptComponent(
                key=key,
                section=section,
                source=source,
                summary=summary,
                content=content,
                estimated_tokens=estimate_tokens(content),
                state=state,
                editable=editable,
                label=label,
            )
        )

    # Match the executor's actual prepend order: memory is prepended first, then
    # retrieval, so retrieval ends up at the very top of the system prompt.
    if retrieval_policy is not None:
        query_hint = f" · query: {_first_line(retrieval_policy.query or '', limit=60)}" if retrieval_policy.query else ""
        add(
            "retrieval",
            "system",
            "params.retrieval",
            f"Collection: {retrieval_policy.collection} · top_k: {retrieval_policy.top_k}{query_hint}",
            "",
            state="runtime",
        )

    if memory_policy is not None:
        write_hint = f" · write: {memory_policy.write_scope}" if memory_policy.write else ""
        query_hint = f" · query: {_first_line(memory_policy.query or '', limit=60)}" if memory_policy.query else ""
        add(
            "memory",
            "system",
            "params.memory",
            f"Runtime memory · scopes: {', '.join(memory_policy.scopes)}{query_hint}{write_hint}",
            "",
            state="runtime",
        )

    identity = budget_result.buckets.get("identity", "")
    if identity:
        add(
            "identity",
            "system",
            f"agent:{node.agent_name}" if node.agent_name else "agent:lead (default)",
            f"Custom agent: {node.agent_name}" if node.agent_name else "Default lead agent",
            identity,
            state=_bucket_state("identity", runtime=False, dropped=dropped, truncated=truncated),
        )

    capability = budget_result.buckets.get("capability", "")
    if capability:
        skill_hint = "all enabled" if agent_skills is None else ("disabled" if not agent_skills else ", ".join(agent_skills))
        add(
            "capability",
            "system",
            f"capability_groups:{','.join(capability_groups)}",
            f"Groups: {', '.join(capability_groups)} · agent skills: {skill_hint}",
            capability,
            state=_bucket_state("capability", runtime=False, dropped=dropped, truncated=truncated),
        )

    for rule in capability_rules:
        add(
            f"capability_rule:{rule.group_guid}@{rule.group_version}:{rule.path}",
            "system",
            rule.source,
            f"{rule.group_name}@{rule.group_version} · {rule.path} · {_summarize(rule.content, 'Empty rule')}",
            rule.content,
            state=_bucket_state("capability_rules", runtime=False, dropped=dropped, truncated=truncated),
            label=rule.label,
        )

    for skill in capability_skills:
        description = f"- {skill.name}: {skill.description}"
        add(
            f"capability_skill:{skill.group_guid}@{skill.group_version}:{skill.name}",
            "system",
            skill.source,
            f"{skill.name}: {skill.description}",
            description,
            state=_bucket_state("capability_skills", runtime=False, dropped=dropped, truncated=truncated),
            label=skill.label,
        )

    examples = budget_result.buckets.get("examples", "")
    if policy is not None and policy.examples:
        add(
            "examples",
            "system",
            "params.context_policy.examples",
            f"{len(policy.examples)} example(s) · {_summarize(examples, 'No rendered examples')}",
            examples,
            state=_bucket_state("examples", runtime=False, dropped=dropped, truncated=truncated),
        )

    if policy is not None and policy.include:
        context = budget_result.buckets.get("context", "")
        add(
            "context",
            "system",
            f"params.context_policy.include:{','.join(policy.include)}",
            f"Ports: {_describe_ports(definition, node.id, list(policy.include))}",
            context,
            state=_bucket_state("context", runtime=True, dropped=dropped, truncated=truncated),
        )

    if output_schema is not None:
        schema = budget_result.buckets.get("schema", "")
        required = ", ".join(output_schema["required"]) or "none"
        add(
            "schema",
            "system",
            "params.output_schema",
            f"Fields: {', '.join(output_schema['fields'])} · required: {required}",
            schema,
            state=_bucket_state("schema", runtime=False, dropped=dropped, truncated=truncated),
        )

    instruction = node.params.get("instruction") or ""
    placeholders = _placeholder_names(instruction)
    placeholder_hint = f" · placeholders: {_describe_ports(definition, node.id, placeholders)}" if placeholders else ""
    add(
        "task",
        "task",
        "params.instruction",
        f"Instruction: {_summarize(base_task_prompt, 'Empty instruction')}{placeholder_hint}",
        base_task_prompt,
        state=_bucket_state("task", runtime=False, dropped=dropped, truncated=truncated),
    )

    has_template_prompt = any(port.name == TEMPLATE_PROMPT_PORT for port in node.inputs)
    if has_template_prompt:
        add(
            "template_prompt",
            "task",
            "inputs.template_prompt",
            f"Port: {_describe_ports(definition, node.id, [TEMPLATE_PROMPT_PORT])}",
            "",
            state="runtime",
            label="Template prompt",
        )

    omitted: list[str] = []
    if memory_policy is not None:
        omitted.append("memory")
    if retrieval_policy is not None:
        omitted.append("retrieval")
    if has_template_prompt:
        omitted.append("template_prompt")

    return PromptPreview(
        node_id=node.id,
        prompt=prompt,
        system_prompt=system_prompt,
        task_prompt=task_prompt,
        capability_groups=capability_groups,
        omitted_runtime_blocks=tuple(omitted),
        components=tuple(components),
    )


__all__ = ["PromptComponent", "PromptPreview", "PromptPreviewError", "build_prompt_preview"]
