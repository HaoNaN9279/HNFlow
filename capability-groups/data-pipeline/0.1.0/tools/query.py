"""Run a tiny deterministic aggregate for data-pipeline tests."""

from __future__ import annotations

from collections.abc import Iterable


def total(values: Iterable[float]) -> float:
    return float(sum(values))
