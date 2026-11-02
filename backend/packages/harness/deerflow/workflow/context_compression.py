"""Automatic context compression for workflow AI nodes.

The workflow author configures nothing here.  The effective model selected by
the node's model profile supplies the context window; the executor derives a
prompt budget from it and installs the existing summarization middleware with a
built-in compression skill prompt.  Compression is therefore invisible to the
node contract and applies to every ``ai:llm_agent`` node.
"""

from __future__ import annotations

import logging
from dataclasses import dataclass
from typing import Any

logger = logging.getLogger(__name__)

#: Built-in compression skill.  ``{messages}`` is filled by the shared
#: summarization middleware.
CONTEXT_COMPRESSION_SKILL = """You are the workflow context compressor.

Compress the conversation below into a compact working summary that lets the
next model turn continue without re-reading the full history.

Preserve, in this order:
1. The user's objective and explicit constraints.
2. Decisions already made and rejected alternatives.
3. Concrete facts returned by tools: paths, identifiers, values, errors.
4. Files read or written, commands run, and their important results.
5. Pending work, open questions, and the next concrete step.

Remove greetings, repetition, superseded drafts, and redundant tool output.
Do not invent facts.  Do not omit an unresolved error or pending task.
Write terse plain text, not JSON, and no more than a few short paragraphs.

Conversation:
{messages}
"""

#: Internal budget constants.  They are deliberately not exposed as node params.
_OUTPUT_RESERVE_FALLBACK = 4096
_TRIGGER_FRACTION = 0.90
_KEEP_FRACTION = 0.30
_MIN_TRIGGER_TOKENS = 1024
_MIN_KEEP_TOKENS = 512
_SUMMARY_INPUT_TOKENS = 4000


class ContextCompressionError(ValueError):
    """The selected model cannot supply a usable context budget."""


def _is_cjk(ch: str) -> bool:
    code = ord(ch)
    return 0x3000 <= code <= 0x303F or 0x3040 <= code <= 0x30FF or 0x3400 <= code <= 0x4DBF or 0x4E00 <= code <= 0x9FFF or 0xAC00 <= code <= 0xD7AF or 0xF900 <= code <= 0xFAFF or 0xFF00 <= code <= 0xFFEF


def estimate_tokens(text: str) -> int:
    """Deterministic CJK-aware token estimate (not an exact tokenizer)."""
    if not text:
        return 0
    cjk = sum(1 for ch in text if _is_cjk(ch))
    ascii_like = len(text) - cjk
    return (ascii_like + 3) // 4 + (cjk + 1) // 2


@dataclass(frozen=True)
class ContextCompression:
    """Model-derived compression budget for one AI node execution."""

    model_name: str
    context_window: int
    input_budget: int
    trigger_tokens: int
    keep_tokens: int
    summary_model_name: str | None = None
    summary_prompt: str = CONTEXT_COMPRESSION_SKILL

    def build_middleware(self, *, app_config: Any) -> Any | None:
        """Build the middleware; a broken summary model degrades to no-op."""
        try:
            from deerflow.agents.middlewares.summarization_middleware import DeerFlowSummarizationMiddleware
            from deerflow.models import create_chat_model

            summary_model_name = self.summary_model_name or self.model_name
            model = create_chat_model(
                name=summary_model_name,
                thinking_enabled=False,
                app_config=app_config,
                attach_tracing=False,
            )
            return DeerFlowSummarizationMiddleware(
                model=model,
                trigger=("tokens", self.trigger_tokens),
                keep=("tokens", self.keep_tokens),
                trim_tokens_to_summarize=_SUMMARY_INPUT_TOKENS,
                summary_prompt=self.summary_prompt,
                app_config=app_config,
                configured_model_name=self.summary_model_name,
                run_model_name=summary_model_name,
                anchor_model_name=summary_model_name,
            )
        except Exception:  # noqa: BLE001 - compression must not break the node
            logger.warning(
                "Could not build context-compression middleware for model %r; continuing without compression",
                self.model_name,
                exc_info=True,
            )
            return None


def resolve_context_compression(
    model_name: str,
    models: Any,
    *,
    summary_model_name: str | None = None,
) -> ContextCompression:
    """Derive a compression budget from the effective model's context window."""
    model_config = None
    for candidate in models or ():
        if getattr(candidate, "name", None) == model_name:
            model_config = candidate
            break
    if model_config is None:
        raise ContextCompressionError(f"model {model_name!r} is not configured")
    context_window = getattr(model_config, "context_window", None)
    if not isinstance(context_window, int) or isinstance(context_window, bool) or context_window <= 0:
        raise ContextCompressionError(f"model {model_name!r} has no context_window; set it in config.yaml models[]")

    raw_output_reserve = getattr(model_config, "max_tokens", None)
    output_reserve = int(raw_output_reserve) if isinstance(raw_output_reserve, int) and not isinstance(raw_output_reserve, bool) and raw_output_reserve > 0 else min(_OUTPUT_RESERVE_FALLBACK, max(_MIN_TRIGGER_TOKENS, context_window // 5))
    input_budget = context_window - output_reserve
    if input_budget <= _MIN_TRIGGER_TOKENS:
        raise ContextCompressionError(f"model {model_name!r} context_window={context_window} leaves no usable input budget after reserving {output_reserve} output tokens")
    trigger = max(_MIN_TRIGGER_TOKENS, int(input_budget * _TRIGGER_FRACTION))
    keep = max(_MIN_KEEP_TOKENS, int(input_budget * _KEEP_FRACTION))
    return ContextCompression(
        model_name=model_name,
        context_window=context_window,
        input_budget=input_budget,
        trigger_tokens=trigger,
        keep_tokens=min(keep, trigger),
        summary_model_name=summary_model_name,
    )


__all__ = [
    "CONTEXT_COMPRESSION_SKILL",
    "ContextCompression",
    "ContextCompressionError",
    "estimate_tokens",
    "resolve_context_compression",
]
