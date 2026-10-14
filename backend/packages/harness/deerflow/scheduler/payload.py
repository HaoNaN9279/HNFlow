"""Trigger-payload → target-input rendering (N7).

A condition-driven trigger produces a payload (the file that changed, the app
instance that finished, the idle window that elapsed). ``payload_template`` on
the task turns that payload into the target's inputs: a prompt for an ``agent``
target, or ``flow:start`` params for a ``workflow`` target.

Supported placeholders (deliberately minimal — no expressions, no conditionals):

- ``{{payload}}`` — the whole payload mapping
- ``{{payload.<key>}}`` / ``{{payload.<key>.<sub>}}`` — a (nested) payload value
- ``{{now}}`` — the dispatch time as an ISO-8601 UTC string

A value that is exactly one placeholder keeps the payload value's own type
(numbers, lists, dicts stay typed); a placeholder embedded in a larger string
is substituted textually. A missing payload key raises ``ValueError`` rather
than rendering an empty string: a silently-empty param would produce a run with
wrong inputs instead of a visible dispatch failure.
"""

from __future__ import annotations

import re
from collections.abc import Mapping, Sequence
from datetime import UTC, datetime
from typing import Any

_PLACEHOLDER = re.compile(r"\{\{\s*(payload(?:\.[A-Za-z0-9_][A-Za-z0-9_.\-]*)?|now)\s*\}\}")
_EXACT_PLACEHOLDER = re.compile(r"^\{\{\s*(payload(?:\.[A-Za-z0-9_][A-Za-z0-9_.\-]*)?|now)\s*\}\}$")


def _resolve(path: str, payload: Mapping[str, Any], now: datetime) -> Any:
    if path == "now":
        return now.astimezone(UTC).isoformat()
    target: Any = payload
    for segment in path.split(".")[1:]:
        if isinstance(target, Mapping) and segment in target:
            target = target[segment]
            continue
        raise ValueError(f"payload has no key {segment!r} (placeholder {{{{ {path} }}}})")
    return target


def _render_string(value: str, payload: Mapping[str, Any], now: datetime) -> Any:
    exact = _EXACT_PLACEHOLDER.match(value)
    if exact is not None:
        return _resolve(exact.group(1), payload, now)

    def _substitute(match: re.Match[str]) -> str:
        resolved = _resolve(match.group(1), payload, now)
        return resolved if isinstance(resolved, str) else str(resolved)

    return _PLACEHOLDER.sub(_substitute, value)


def render_value(value: Any, payload: Mapping[str, Any], *, now: datetime) -> Any:
    """Render one template value, recursing through mappings and sequences."""
    if isinstance(value, str):
        return _render_string(value, payload, now)
    if isinstance(value, Mapping):
        return {key: render_value(item, payload, now=now) for key, item in value.items()}
    if isinstance(value, Sequence) and not isinstance(value, (bytes, bytearray)):
        return [render_value(item, payload, now=now) for item in value]
    return value


def render_template(
    template: Mapping[str, Any] | None,
    payload: Mapping[str, Any] | None,
    *,
    now: datetime,
) -> dict[str, Any]:
    """Render ``payload_template`` against the trigger payload."""
    if not template:
        return {}
    data = payload or {}
    return {key: render_value(value, data, now=now) for key, value in template.items()}
