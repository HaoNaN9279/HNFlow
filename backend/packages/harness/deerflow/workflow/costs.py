"""Workflow run cost report (N14 §24.10).

Prices a workflow run's AI-node token usage against the optional
``models[*].pricing`` metadata — the same convention the console cost
display uses (``currency`` / ``input_per_million`` / ``output_per_million``
/ ``input_cache_hit_per_million``), so a deployment annotates its models
once and both views agree.

**Pure logic**: callers hand in the model configs and the run's per-node
token usage; nothing here reads config, the filesystem, or the network.

**Honest attribution**: the reserved usage channel
``wf:<node>:__token_usage`` records tokens, not the model that spent them.
Pricing therefore falls back to a caller-supplied default model — the
console's documented legacy behaviour for rows without a per-model split —
and every node reports which model it was priced with. A node whose model
is unpriced (or when no pricing is configured at all) yields ``cost: None``
rather than a fabricated zero, and a mixed-currency config disables cost
reporting entirely (invalid aggregates are worse than no aggregate).
"""

from __future__ import annotations

from typing import Any, NamedTuple

#: Reserved state-channel suffix carrying one AI node's aggregated usage.
USAGE_CHANNEL_SUFFIX = ":__token_usage"

#: Reserved state-channel prefix for every workflow channel.
CHANNEL_PREFIX = "wf:"

#: The four per-node usage fields (``ai:llm_agent`` writes exactly these).
USAGE_FIELDS = ("input_tokens", "output_tokens", "total_tokens", "cache_read_tokens")


class ModelPricing(NamedTuple):
    """Per-million-token prices for one model, in one currency."""

    input_per_million: float
    output_per_million: float
    currency: str
    #: Cache-hit input price. ``None`` → hits are billed at the miss price
    #: (a conservative upper bound).
    input_cache_hit_per_million: float | None = None


class NodeCost(NamedTuple):
    """One node's priced usage."""

    node_id: str
    model: str | None
    input_tokens: int
    output_tokens: int
    total_tokens: int
    cache_read_tokens: int
    cost: float | None


def _coerce_float(value: Any) -> float | None:
    try:
        return float(value)
    except (TypeError, ValueError):
        return None


def build_pricing_map(models: Any) -> dict[str, ModelPricing]:
    """Collect per-model prices from config ``models[*].pricing``.

    ``ModelConfig`` is ``extra="allow"``, so a deployment annotates each
    model with ``pricing: {currency: USD, input_per_million: 3,
    output_per_million: 15, input_cache_hit_per_million: 0.3}`` without a
    schema change. Entries are keyed by the config ``name`` and the provider
    ``model`` id (plus lowercase variants), because usage buckets may carry
    either spelling.

    Returns ``{}`` when no model declares a usable price, and — deliberately
    — also ``{}`` when the declared prices **mix currencies**: a single
    deployment cannot display one total across two currencies, so reporting
    is disabled instead of summing incomparable numbers. This mirrors
    ``app/gateway/routers/console.py`` so the canvas and the console cannot
    disagree about whether costs are reportable.
    """
    pricing: dict[str, ModelPricing] = {}
    currency: str | None = None
    for model_cfg in models or []:
        raw = getattr(model_cfg, "pricing", None)
        if not isinstance(raw, dict):
            continue
        input_price = _coerce_float(raw.get("input_per_million")) or 0.0
        output_price = _coerce_float(raw.get("output_per_million")) or 0.0
        if input_price <= 0 and output_price <= 0:
            continue
        raw_hit = raw.get("input_cache_hit_per_million")
        hit_price = _coerce_float(raw_hit) if raw_hit is not None else None
        model_currency = str(raw.get("currency") or "USD").strip().upper() or "USD"
        name = getattr(model_cfg, "name", None)
        if currency is None:
            currency = model_currency
        elif model_currency != currency:
            # Mixed currencies: refuse to produce an invalid aggregate.
            return {}
        entry = ModelPricing(input_price, output_price, model_currency, hit_price)
        for key in (name, getattr(model_cfg, "model", None)):
            if key:
                pricing.setdefault(str(key), entry)
                pricing.setdefault(str(key).lower(), entry)
    return pricing


def pricing_currency(pricing: dict[str, ModelPricing]) -> str | None:
    """Display currency — one currency per deployment (``None`` when unpriced)."""
    return next(iter(pricing.values())).currency if pricing else None


def lookup_pricing(pricing: dict[str, ModelPricing], model: str | None) -> ModelPricing | None:
    """Price entry for *model*, tolerating case/spelling differences."""
    if not model:
        return None
    return pricing.get(model) or pricing.get(model.lower())


def token_cost(input_tokens: int, output_tokens: int, price: ModelPricing, cache_read_tokens: int = 0) -> float:
    """Cache-aware spend for one usage bucket.

    ``cache_read_tokens`` is clamped into ``[0, input_tokens]``; the
    remainder is billed at the full (cache-miss) input price. Without a
    configured hit price all input is billed at the miss price.
    """
    cache_read = min(max(int(cache_read_tokens or 0), 0), max(int(input_tokens or 0), 0))
    uncached = max(int(input_tokens or 0), 0) - cache_read
    hit_price = price.input_cache_hit_per_million if price.input_cache_hit_per_million is not None else price.input_per_million
    return (uncached / 1_000_000) * price.input_per_million + (cache_read / 1_000_000) * hit_price + (output_tokens / 1_000_000) * price.output_per_million


def node_usage_from_state(state: Any) -> dict[str, dict[str, int]]:
    """Extract ``{node_id: {usage fields}}`` from workflow channel values.

    Reads only the reserved ``wf:<node>:__token_usage`` channels and skips
    anything that is not a mapping, so a hand-written or legacy value can
    never break the report.
    """
    usage: dict[str, dict[str, int]] = {}
    if not isinstance(state, dict):
        return usage
    for key, value in state.items():
        if not (isinstance(key, str) and key.startswith(CHANNEL_PREFIX) and key.endswith(USAGE_CHANNEL_SUFFIX)):
            continue
        if not isinstance(value, dict):
            continue
        node_id = key[len(CHANNEL_PREFIX) : -len(USAGE_CHANNEL_SUFFIX)]
        if not node_id:
            continue
        bucket: dict[str, int] = {}
        for field in USAGE_FIELDS:
            raw = value.get(field)
            try:
                bucket[field] = int(raw or 0)
            except (TypeError, ValueError):
                bucket[field] = 0
        usage[node_id] = bucket
    return usage


def build_run_cost_report(
    state: Any,
    models: Any,
    *,
    default_model: str | None = None,
    model_by_node: dict[str, str] | None = None,
) -> dict[str, Any]:
    """Price every AI node's usage in *state* and report the run total.

    ``model_by_node`` overrides the model used to price a given node; the
    default model is the fallback, because the usage channel does not record
    which model spent the tokens (documented limitation, same as the
    console's legacy per-run fallback).

    Returned mapping (always JSON-serialisable)::

        {"currency": str | None,
         "total_cost": float | None,
         "priced_nodes": int,
         "unpriced_nodes": [node_id, ...],
         "nodes": [{node_id, model, <usage fields>, cost}],
         "token_usage": {<summed usage fields>}}

    ``total_cost`` is ``None`` when **no** node could be priced (mirrors the
    console's ``cost: null``); when only some nodes are priced the total sums
    the priced ones and the rest are listed in ``unpriced_nodes``.
    """
    usage_by_node = node_usage_from_state(state)
    pricing = build_pricing_map(models)
    overrides = model_by_node or {}

    nodes: list[NodeCost] = []
    priced_total = 0.0
    priced = 0
    unpriced: list[str] = []
    totals = dict.fromkeys(USAGE_FIELDS, 0)

    for node_id in sorted(usage_by_node):
        bucket = usage_by_node[node_id]
        for field in USAGE_FIELDS:
            totals[field] += bucket.get(field, 0)
        model = overrides.get(node_id) or default_model
        price = lookup_pricing(pricing, model)
        cost = token_cost(bucket.get("input_tokens", 0), bucket.get("output_tokens", 0), price, bucket.get("cache_read_tokens", 0)) if price is not None else None
        if cost is None:
            unpriced.append(node_id)
        else:
            priced += 1
            priced_total += cost
        nodes.append(
            NodeCost(
                node_id=node_id,
                model=model,
                input_tokens=bucket.get("input_tokens", 0),
                output_tokens=bucket.get("output_tokens", 0),
                total_tokens=bucket.get("total_tokens", 0),
                cache_read_tokens=bucket.get("cache_read_tokens", 0),
                cost=cost,
            )
        )

    return {
        "currency": pricing_currency(pricing),
        "total_cost": round(priced_total, 6) if priced else None,
        "priced_nodes": priced,
        "unpriced_nodes": unpriced,
        "nodes": [
            {
                "node_id": item.node_id,
                "model": item.model,
                "input_tokens": item.input_tokens,
                "output_tokens": item.output_tokens,
                "total_tokens": item.total_tokens,
                "cache_read_tokens": item.cache_read_tokens,
                "cost": round(item.cost, 6) if item.cost is not None else None,
            }
            for item in nodes
        ],
        "token_usage": dict(totals),
    }


__all__ = [
    "CHANNEL_PREFIX",
    "ModelPricing",
    "NodeCost",
    "USAGE_CHANNEL_SUFFIX",
    "USAGE_FIELDS",
    "build_pricing_map",
    "build_run_cost_report",
    "lookup_pricing",
    "node_usage_from_state",
    "pricing_currency",
    "token_cost",
]
