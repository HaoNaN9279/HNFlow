"""Static prompt preview for ``ai:llm_agent`` nodes.

The canvas can ask for the prompt an AI node *would* assemble without running
the model.  Runtime-only blocks (node memory and knowledge retrieval) have no
values before execution, so the response reports them as omitted instead of
inventing content.  Everything else uses the same assemblers as the real
executor, including capability groups resolved from selector/merge wiring.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any

from deerflow.config.agents_config import load_agent_config
from deerflow.workflow.capability_groups import (
    CapabilityWiringError,
    resolve_ai_capability_groups,
    validate_capability_wiring,
)
from deerflow.workflow.context_policy import BUCKET_ORDER, ContextPolicyError, apply_context_budget, parse_context_policy
from deerflow.workflow.prompts import build_ai_node_buckets
from deerflow.workflow.schema import NodeType, WorkflowDefinition
from deerflow.workflow.structured_output import StructuredOutputError, parse_output_schema, schema_instruction


class PromptPreviewError(ValueError):
    """A prompt preview request that cannot be answered for this definition."""


@dataclass(frozen=True)
class PromptPreview:
    node_id: str
    prompt: str
    system_prompt: str
    task_prompt: str
    capability_groups: list[str]
    omitted_runtime_blocks: tuple[str, ...]

    def to_dict(self) -> dict[str, Any]:
        return {
            "node_id": self.node_id,
            "prompt": self.prompt,
            "system_prompt": self.system_prompt,
            "task_prompt": self.task_prompt,
            "capability_groups": list(self.capability_groups),
            "omitted_runtime_blocks": list(self.omitted_runtime_blocks),
        }


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
        validate_capability_wiring(definition)
        capability_groups = resolve_ai_capability_groups(definition, node)
    except CapabilityWiringError as exc:
        raise PromptPreviewError(str(exc)) from exc

    try:
        policy = parse_context_policy(node.params)
    except ContextPolicyError as exc:
        raise PromptPreviewError(f"invalid context_policy: {exc}") from exc
    try:
        output_schema = parse_output_schema(node.params)
    except StructuredOutputError as exc:
        raise PromptPreviewError(f"invalid output_schema: {exc}") from exc

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
    )
    if output_schema is not None:
        buckets["schema"] = schema_instruction(output_schema)
    budget_result = apply_context_budget(buckets, policy.budget if policy else None)
    task_prompt = budget_result.buckets.get("task", "")
    system_prompt = "\n\n".join(budget_result.buckets[name] for name in BUCKET_ORDER if name != "task" and budget_result.buckets.get(name))
    prompt = "\n\n".join(part for part in (system_prompt, task_prompt) if part)

    omitted: list[str] = []
    if node.params.get("memory") is not None:
        omitted.append("memory")
    if node.params.get("retrieval") is not None:
        omitted.append("retrieval")

    return PromptPreview(
        node_id=node.id,
        prompt=prompt,
        system_prompt=system_prompt,
        task_prompt=task_prompt,
        capability_groups=capability_groups,
        omitted_runtime_blocks=tuple(omitted),
    )


__all__ = ["PromptPreview", "PromptPreviewError", "build_prompt_preview"]
