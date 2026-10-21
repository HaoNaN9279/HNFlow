"""Static prompt preview for ``ai:llm_agent`` nodes.

The canvas asks for the prompt an AI node *would* assemble without running the
model.  The only runtime-only block is ``template_prompt`` itself; the preview
reports it as omitted instead of inventing a task.  Everything else uses the
same assemblers as the real executor, including capability rules/skill
descriptions and a schema supplied by a ``data:schema`` node.
"""

from __future__ import annotations

import re
from dataclasses import dataclass
from typing import Any

from deerflow.capability_groups.discovery import CapabilityGroupError
from deerflow.capability_groups.runtime import CapabilityContentError, load_capability_rules, load_capability_skills
from deerflow.config.agents_config import load_agent_config
from deerflow.workflow.capability_group_nodes import CapabilityGroupWiringError, resolve_ai_capability_groups, validate_capability_group_wiring
from deerflow.workflow.context_compression import estimate_tokens
from deerflow.workflow.prompts import BUCKET_ORDER, TEMPLATE_PROMPT_PORT, build_ai_node_buckets
from deerflow.workflow.schema import NodeType, WorkflowDefinition
from deerflow.workflow.structured_output import OUTPUT_SCHEMA_PORT, StructuredOutputError, parse_output_schema, schema_instruction

_PLACEHOLDER_PATTERN = re.compile(r"\{\{\s*([^{}]+?)\s*\}\}")


class PromptPreviewError(ValueError):
    """A prompt preview request that cannot be answered for this definition."""


@dataclass(frozen=True)
class PromptComponent:
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


def _summarize(text: str, fallback: str) -> str:
    return _first_line(text) if text.strip() else fallback


def _schema_for_node(definition: WorkflowDefinition, node_id: str) -> dict[str, Any] | None:
    node_map = {node.id: node for node in definition.nodes}
    for edge in definition.edges:
        if edge.target != node_id or edge.target_port != OUTPUT_SCHEMA_PORT:
            continue
        source = node_map.get(edge.source)
        if source is None or source.type != NodeType.DATA_SCHEMA:
            raise PromptPreviewError(f"'{OUTPUT_SCHEMA_PORT}' must come from a data:schema node")
        try:
            return parse_output_schema((source.params or {}).get("schema"))
        except StructuredOutputError as exc:
            raise PromptPreviewError(f"invalid schema: {exc}") from exc
    return None


def build_prompt_preview(
    definition: WorkflowDefinition,
    node_id: str,
    *,
    user_id: str | None = None,
) -> PromptPreview:
    """Assemble the static text prompt for one AI node."""
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

    output_schema = _schema_for_node(definition, node.id)
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
        template_prompt="",
        inputs={},
        user_id=user_id,
        agent_skills=agent_skills,
        preserve_placeholders=True,
        capability_rules=capability_rules,
        capability_skills=capability_skills,
    )
    if output_schema is not None:
        buckets["schema"] = schema_instruction(output_schema)
    system_prompt = "\n\n".join(buckets[name] for name in BUCKET_ORDER if name != "task" and buckets.get(name))
    task_prompt = ""
    prompt = system_prompt

    components: list[PromptComponent] = []

    def add(key: str, section: str, source: str, summary: str, content: str, *, state: str = "active", label: str = "") -> None:
        components.append(
            PromptComponent(
                key=key,
                section=section,
                source=source,
                summary=summary,
                content=content,
                estimated_tokens=estimate_tokens(content),
                state=state,
                label=label,
            )
        )

    identity = buckets.get("identity", "")
    if identity:
        add(
            "identity",
            "system",
            f"agent:{node.agent_name}" if node.agent_name else "agent:lead (default)",
            f"Custom agent: {node.agent_name}" if node.agent_name else "Default lead agent",
            identity,
        )

    capability = buckets.get("capability", "")
    if capability:
        skill_hint = "all enabled" if agent_skills is None else ("disabled" if not agent_skills else ", ".join(agent_skills))
        add(
            "capability",
            "system",
            f"capability_groups:{','.join(capability_groups)}",
            f"Groups: {', '.join(capability_groups)} · agent skills: {skill_hint}",
            capability,
        )

    for rule in capability_rules:
        add(
            f"capability_rule:{rule.group_guid}@{rule.group_version}:{rule.path}",
            "system",
            rule.source,
            f"{rule.group_name}@{rule.group_version} · {rule.path} · {_summarize(rule.content, 'Empty rule')}",
            rule.content,
            label=rule.label,
        )

    for skill in capability_skills:
        add(
            f"capability_skill:{skill.group_guid}@{skill.group_version}:{skill.name}",
            "system",
            skill.source,
            f"{skill.name}: {skill.description}",
            f"- {skill.name}: {skill.description}",
            label=skill.label,
        )

    if output_schema is not None:
        required = ", ".join(output_schema["required"]) or "none"
        add(
            "schema",
            "system",
            f"data:schema → {OUTPUT_SCHEMA_PORT}",
            f"Fields: {', '.join(output_schema['fields'])} · required: {required}",
            buckets.get("schema", ""),
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
    placeholders = _placeholder_names(str(node.params.get("template_prompt") or ""))
    if placeholders:
        add(
            "template_prompt_placeholders",
            "task",
            "inputs.template_prompt.placeholders",
            _describe_ports(definition, node.id, placeholders),
            "",
            state="runtime",
        )

    omitted: list[str] = ["template_prompt"] if has_template_prompt else []
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
