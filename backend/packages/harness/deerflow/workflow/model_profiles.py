"""Model-profile reference resolution for workflow AI nodes.

An AI node stores a stable profile id in ``params.model_profile``.  The profile
is the middle layer: it names one actual model from ``config.yaml -> models[]``.
This module is the pure decision core shared by compile-time validation and the
runtime executor, so both paths agree on missing/disabled/invalid targets.
"""

from __future__ import annotations

from collections.abc import Iterable, Mapping
from typing import Any

MODEL_PROFILE_PARAM = "model_profile"
MODEL_PROFILES_CONTEXT_KEY = "model_profiles"


class ModelProfileError(ValueError):
    """A model-profile reference is malformed, missing, disabled, or unavailable."""


def parse_model_profile_id(params: Mapping[str, Any] | None) -> str | None:
    """Return the trimmed profile id, or ``None`` when the node does not use one."""
    raw = (params or {}).get(MODEL_PROFILE_PARAM)
    if raw is None:
        return None
    if not isinstance(raw, str) or not raw.strip():
        raise ModelProfileError(f"params.{MODEL_PROFILE_PARAM} must be a non-empty string")
    return raw.strip()


def model_names(models: Iterable[Any] | None) -> frozenset[str]:
    """Normalize configured model objects (or names) into a name set."""
    names: set[str] = set()
    for model in models or ():
        name = model if isinstance(model, str) else getattr(model, "name", None)
        if isinstance(name, str) and name:
            names.add(name)
    return frozenset(names)


def resolve_model_profile(
    profile_id: str,
    profiles: Mapping[str, Mapping[str, Any]] | None,
    available_models: Iterable[Any] | None,
) -> str:
    """Resolve a profile id to the actual configured model name.

    Fails loud: an unknown/disabled profile or a removed target model must never
    silently fall back to another model.
    """
    profile = (profiles or {}).get(profile_id)
    if profile is None:
        raise ModelProfileError(f"model profile '{profile_id}' does not exist")
    if not bool(profile.get("enabled", True)):
        raise ModelProfileError(f"model profile '{profile_id}' is disabled")
    target = profile.get("target_model")
    if not isinstance(target, str) or not target:
        raise ModelProfileError(f"model profile '{profile_id}' has no target model")
    names = model_names(available_models)
    if target not in names:
        raise ModelProfileError(f"model profile '{profile_id}' targets unconfigured model '{target}'")
    return target


def collect_model_profile_ids(value: Any) -> set[str]:
    """Collect every ``model_profile`` id in a definition payload recursively."""
    found: set[str] = set()
    stack: list[Any] = [value]
    while stack:
        item = stack.pop()
        if isinstance(item, Mapping):
            raw = item.get(MODEL_PROFILE_PARAM)
            if isinstance(raw, str) and raw:
                found.add(raw)
            stack.extend(item.values())
        elif isinstance(item, list):
            stack.extend(item)
    return found
