"""Model-backed trigger judge for the skill eval gate (§24.8).

A *trigger* eval asks whether a skill would be selected for an utterance.  That
is a decision, so it needs a model to make it — the same shape as the security
scanner's moderation call: a standalone, non-thread-scoped model invocation that
owns its own trace root.

The judge is built **only** when a package's manifest declares ``require_pass``
(see :mod:`deerflow.skills.eval_gate`), so an ordinary install makes no model
call.  A judge that cannot decide raises: the gate turns that into a refusal
when a pass was required, because a declared gate that silently passes is worse
than one that refuses.
"""

from __future__ import annotations

import json
import logging
import os
import re
from typing import Any

from deerflow.config import get_app_config
from deerflow.models import create_chat_model
from deerflow.runtime.user_context import get_effective_user_id
from deerflow.skills.eval_gate import TriggerEvalCase
from deerflow.tracing import inject_langfuse_metadata

logger = logging.getLogger(__name__)

_RUBRIC = 'You decide whether an agent skill is selected for a user utterance. Answer with ONLY a single JSON object on one line, no code fences, no commentary:\n{"trigger":true|false,"reason":"..."}'


def _extract_json_object(raw: str) -> dict[str, Any] | None:
    """Parse a JSON object out of a model reply (fences and prose tolerated)."""
    text = raw.strip()
    fence = re.match(r"^```(?:json)?\s*\n?(.*?)\n?\s*```$", text, re.DOTALL)
    if fence:
        text = fence.group(1).strip()
    try:
        parsed = json.loads(text)
    except json.JSONDecodeError:
        start = text.find("{")
        if start == -1:
            return None
        depth = 0
        in_string = False
        escape = False
        for index in range(start, len(text)):
            char = text[index]
            if escape:
                escape = False
                continue
            if char == "\\":
                escape = True
                continue
            if char == '"':
                in_string = not in_string
                continue
            if in_string:
                continue
            if char == "{":
                depth += 1
            elif char == "}":
                depth -= 1
                if depth == 0:
                    try:
                        candidate = json.loads(text[start : index + 1])
                    except json.JSONDecodeError:
                        return None
                    return candidate if isinstance(candidate, dict) else None
        return None
    return parsed if isinstance(parsed, dict) else None


def build_trigger_judge(
    skill_name: str,
    *,
    description: str | None = None,
    app_config: Any | None = None,
) -> Any:
    """Build an async trigger decider for *skill_name*.

    The returned callable takes a :class:`TriggerEvalCase` and answers whether
    the skill triggers for its utterance.  An unparseable reply raises rather
    than defaulting to a verdict — a guess in either direction would corrupt the
    gate it feeds.
    """
    resolved_config = app_config or get_app_config()

    async def _judge(case: TriggerEvalCase) -> bool:
        model_kwargs: dict[str, Any] = {"thinking_enabled": False, "app_config": resolved_config, "attach_tracing": False}
        model = create_chat_model(**model_kwargs)
        prompt = f"Skill name: {skill_name}\nSkill description: {description or '<not provided>'}\n\nUtterance:\n{case.utterance}"
        invoke_config: dict[str, Any] = {"run_name": "skill_eval_judge"}
        # Standalone caller: no graph root to inherit from, so it owns its trace
        # attribution (the documented pattern for oneshot_llm / MemoryUpdater /
        # the goal evaluator — see the Tracing System in backend/AGENTS.md).
        inject_langfuse_metadata(
            invoke_config,
            thread_id=None,
            user_id=get_effective_user_id(),
            assistant_id="skill_eval_judge",
            model_name=None,
            environment=os.environ.get("DEER_FLOW_ENV") or os.environ.get("ENVIRONMENT"),
        )
        response = await model.ainvoke(
            [
                {"role": "system", "content": _RUBRIC},
                {"role": "user", "content": prompt},
            ],
            config=invoke_config,
        )
        raw = str(getattr(response, "content", "") or "")
        parsed = _extract_json_object(raw)
        if parsed is None or not isinstance(parsed.get("trigger"), bool):
            raise ValueError(f"trigger judge returned no usable verdict: {raw[:200]!r}")
        return bool(parsed["trigger"])

    return _judge


__all__ = ["build_trigger_judge"]
