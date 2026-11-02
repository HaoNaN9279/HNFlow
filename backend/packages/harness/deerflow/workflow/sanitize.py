"""Injection-defense helper for AI-node context blocks (N14 §24.12).

§24.12's local-scope threat model is mostly satisfied by existing mechanisms:
the sandbox isolates commands, dangerous nodes are review-marked, irreversible
operations go through the preview/review boundary, and request-scoped
secrets never enter the prompt.  The one genuinely new surface is *content an AI
node pulls into its own prompt* — retrieved knowledge chunks (N14 §24.2) and
stored memory (N14 §24.1).  A document or memory item containing a
``<system-reminder>`` (or ``<memory>`` / ``<context>`` / ``<available_skills>``)
tag could otherwise forge a framework-authority block the model would treat as
trusted.

The fix is to run that untrusted text through the **same neutralizer the input
sanitization middleware already uses** — one denylist, one behaviour — so the
framework blocks this module renders cannot be forged by their contents.
"""

from __future__ import annotations


def neutralize_untrusted(text: str) -> str:
    """Neutralize framework/injection control tokens in untrusted *text*.

    Reuses ``neutralize_untrusted_tags`` from the input-sanitization middleware
    (the single source of truth for the framework-authority tag denylist),
    imported lazily so the workflow package keeps a light, cycle-free import
    graph.  A failure degrades to the original text rather than breaking the
    node — this is defense in depth, not a hard boundary.
    """
    if not text:
        return text
    try:
        from deerflow.agents.middlewares.input_sanitization_middleware import neutralize_untrusted_tags
    except Exception:  # pragma: no cover — defensive: sanitizer unavailable
        return text
    return neutralize_untrusted_tags(text)
