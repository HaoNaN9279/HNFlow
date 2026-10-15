"""Node-level model routing (N14 §24.10).

§24.10 asks for cost / budget governance and a **local-first, privacy-first**
model routing: a trivial or sensitive step should be able to insist on a local
model (nothing leaves the machine) or prefer a cheaper one, instead of always
taking the deployment default.

This module is the pure decision core.  Model metadata rides on
``config.yaml -> models[*]`` as optional, extra-allowed fields (``local`` bool,
``cost_tier`` int where higher = more expensive/powerful); a node declares
``params.model_policy`` and the decision picks a concrete model name the AI
executor hands to the sub-agent.  Selection is deterministic (stable tie-break
by name) so two runs with the same config route identically — the cache-discipline
half of §24.10.
"""

from __future__ import annotations

from collections.abc import Iterable
from dataclasses import dataclass
from typing import Any

PREFER_DEFAULT = "default"
PREFER_LOCAL = "local"
PREFER_CHEAP = "cheap"
PREFER_QUALITY = "quality"

_PREFER_VALUES = frozenset({PREFER_DEFAULT, PREFER_LOCAL, PREFER_CHEAP, PREFER_QUALITY})
_ALLOWED_POLICY_KEYS = frozenset({"prefer", "require_local"})


class RoutingError(ValueError):
    """Raised for a malformed ``params.model_policy`` or an unsatisfiable policy."""


@dataclass(frozen=True)
class ModelInfo:
    """One candidate model's routing-relevant metadata."""

    name: str
    local: bool = False
    cost_tier: int = 0


@dataclass(frozen=True)
class RoutingPolicy:
    prefer: str = PREFER_DEFAULT
    require_local: bool = False


def parse_routing_policy(params: dict | None) -> RoutingPolicy | None:
    """Parse ``params.model_policy`` (``{prefer?, require_local?}``) or ``None``."""
    raw = (params or {}).get("model_policy")
    if raw is None:
        return None
    if not isinstance(raw, dict):
        raise RoutingError("params.model_policy must be an object")
    unknown = set(raw) - _ALLOWED_POLICY_KEYS
    if unknown:
        raise RoutingError(f"params.model_policy has unknown keys {sorted(unknown)}; allowed: {sorted(_ALLOWED_POLICY_KEYS)}")
    prefer = raw.get("prefer", PREFER_DEFAULT)
    if prefer not in _PREFER_VALUES:
        raise RoutingError(f"params.model_policy.prefer must be one of {sorted(_PREFER_VALUES)}, got {prefer!r}")
    require_local = raw.get("require_local", False)
    if not isinstance(require_local, bool):
        raise RoutingError("params.model_policy.require_local must be a boolean")
    return RoutingPolicy(prefer=prefer, require_local=require_local)


def model_infos(models: Iterable[Any] | None) -> list[ModelInfo]:
    """Normalize ``config.models`` entries into :class:`ModelInfo`.

    Unknown/extra fields are tolerated (``ModelConfig`` is extra-allowed); a
    missing name is skipped rather than fabricating one.
    """
    infos: list[ModelInfo] = []
    for model in models or ():
        name = getattr(model, "name", None)
        if not name:
            continue
        raw_tier = getattr(model, "cost_tier", 0)
        try:
            tier = int(raw_tier) if raw_tier is not None else 0
        except (TypeError, ValueError):
            tier = 0
        infos.append(ModelInfo(name=str(name), local=bool(getattr(model, "local", False)), cost_tier=tier))
    return infos


def select_model(candidates: Iterable[ModelInfo], policy: RoutingPolicy) -> ModelInfo | None:
    """Pick a model from *candidates* per *policy*; ``None`` when there are none.

    ``require_local`` restricts the pool to local models and raises
    :class:`RoutingError` when none qualify — a privacy constraint must fail
    loud rather than silently send data to a remote model.  Preference ordering
    is deterministic, with a stable name tie-break.
    """
    pool = list(candidates)
    if not pool:
        return None
    if policy.require_local:
        pool = [m for m in pool if m.local]
        if not pool:
            raise RoutingError("model_policy require_local=True but no local model is configured")

    if policy.prefer == PREFER_LOCAL:
        pool.sort(key=lambda m: (not m.local, m.cost_tier, m.name))
    elif policy.prefer == PREFER_CHEAP:
        pool.sort(key=lambda m: (m.cost_tier, not m.local, m.name))
    elif policy.prefer == PREFER_QUALITY:
        pool.sort(key=lambda m: (-m.cost_tier, not m.local, m.name))
    else:  # default: deployment order, first wins
        return pool[0]
    return pool[0]
