"""Host-side resource admission control for local applications (N8, plan §19).

Local professional software contends for GPU/CPU/memory/disk and for a license.
The layer is deliberately **declared**, not measured: an application declares
what it occupies (``config.yaml -> apps.definitions.<name>.resources``) and the
operator declares the host capacity (``apps.resources``) plus license pools
(``apps.licenses``).  Nothing here samples real hardware — a cross-platform
truthful GPU/VRAM reading does not exist, and a wrong number is worse than an
explicit declaration the operator can tune.

What the governor actually provides:

- **Admission**: an operation that cannot fit waits, fails, or degrades
  (``apps.on_conflict``).
- **Two occupancy levels**: an instance holds a *license slot* for its whole
  life, and an individual operation holds its *numeric demand* for its duration
  (see ``AppSessionManager``).
- **Atomic multi-dimension admission**: all dimensions are checked and taken
  under one lock, so nothing is ever partially held and no lock-order deadlock
  can exist.
- **FIFO fairness**: a ticket queue, so a steady trickle of small demands
  cannot starve an earlier larger one.

It is process-local by design (matching the scheduler's and the in-memory
sandbox's single-process contract): the cross-process dimension is covered by
:mod:`deerflow.locks.file_lock` where mutual exclusion actually matters.
"""

from __future__ import annotations

import logging
import threading
import time
from collections import deque
from collections.abc import Mapping
from dataclasses import dataclass, field
from typing import Any

from deerflow.config.apps_config import RESOURCE_DIMENSIONS, LicenseGroup, ResourceLimits

logger = logging.getLogger(__name__)


class ResourceUnavailableError(RuntimeError):
    """Raised when a declared demand cannot be admitted.

    Carries the blocking dimension (or license group) and how long the caller
    waited, so the failing workflow node reports something actionable instead
    of a bare timeout.
    """

    def __init__(self, message: str, *, dimension: str | None = None, license: str | None = None, waited_seconds: float = 0.0) -> None:
        super().__init__(message)
        self.dimension = dimension
        self.license = license
        self.waited_seconds = waited_seconds


@dataclass(frozen=True)
class ResourceDemand:
    """What one instance or operation occupies."""

    gpu: int = 0
    cpu: int = 0
    memory_mb: int = 0
    disk_mb: int = 0
    license: str | None = None

    @classmethod
    def from_declaration(cls, declaration: Any | None) -> ResourceDemand:
        """Build from an ``AppResourceDemand`` (or any object exposing the same fields)."""
        if declaration is None:
            return cls()
        return cls(
            gpu=int(getattr(declaration, "gpu", 0) or 0),
            cpu=int(getattr(declaration, "cpu", 0) or 0),
            memory_mb=int(getattr(declaration, "memory_mb", 0) or 0),
            disk_mb=int(getattr(declaration, "disk_mb", 0) or 0),
            license=getattr(declaration, "license", None),
        )

    def numeric(self) -> dict[str, int]:
        return {dimension: getattr(self, dimension) for dimension in RESOURCE_DIMENSIONS}

    def total(self) -> int:
        return sum(self.numeric().values())


@dataclass
class ResourceLease:
    """The right to run. ``degraded`` means the quota was oversubscribed."""

    demand: ResourceDemand
    reserved: bool = False
    degraded: bool = False
    license: str | None = None
    acquired_at: float = field(default_factory=time.monotonic)

    def released(self) -> bool:
        return not self.reserved


class ResourceGovernor:
    """Process-local admission control over declared quotas and license slots."""

    def __init__(
        self,
        limits: ResourceLimits | Mapping[str, int | None] | None = None,
        licenses: Mapping[str, LicenseGroup | int] | None = None,
        *,
        on_conflict: str = "wait",
        acquire_timeout_seconds: float = 60.0,
    ) -> None:
        caps: dict[str, int | None] = {}
        for dimension in RESOURCE_DIMENSIONS:
            value = limits.get(dimension) if isinstance(limits, Mapping) else getattr(limits, dimension, None) if limits is not None else None
            caps[dimension] = None if value is None else int(value)
        self._limits = caps

        pools: dict[str, int] = {}
        for name, group in (licenses or {}).items():
            slots = group if isinstance(group, int) else int(getattr(group, "slots", 1))
            pools[str(name)] = max(1, slots)
        self._license_slots = pools

        self._on_conflict = on_conflict
        self._acquire_timeout_seconds = float(acquire_timeout_seconds)

        self._condition = threading.Condition()
        self._in_use: dict[str, int] = dict.fromkeys(RESOURCE_DIMENSIONS, 0)
        self._license_in_use: dict[str, int] = dict.fromkeys(pools, 0)
        self._waiting: dict[str, int] = dict.fromkeys(RESOURCE_DIMENSIONS, 0)
        self._license_waiting: dict[str, int] = dict.fromkeys(pools, 0)
        self._tickets: deque[int] = deque()
        self._waiting_demands: dict[int, ResourceDemand] = {}
        self._next_ticket = 0

    # ── construction ────────────────────────────────────────────────────────

    @classmethod
    def from_apps_config(cls, config: Any) -> ResourceGovernor:
        """Build from an ``AppsConfig`` (or any object with the same fields)."""
        return cls(
            getattr(config, "resources", None),
            getattr(config, "licenses", None),
            on_conflict=getattr(config, "on_conflict", "wait"),
            acquire_timeout_seconds=getattr(config, "acquire_timeout_seconds", 60.0),
        )

    # ── introspection ───────────────────────────────────────────────────────

    @property
    def limits(self) -> dict[str, int | None]:
        return dict(self._limits)

    @property
    def license_slots(self) -> dict[str, int]:
        return dict(self._license_slots)

    @property
    def on_conflict(self) -> str:
        return self._on_conflict

    @property
    def acquire_timeout_seconds(self) -> float:
        return self._acquire_timeout_seconds

    @property
    def is_configured(self) -> bool:
        """Whether any cap or license pool is actually declared.

        ``False`` means every demand is a no-op admission (an untouched
        configuration), which is what the ops surface reports as "not governed".
        """
        return bool(self._license_slots) or any(cap is not None for cap in self._limits.values())

    def governs(self, demand: ResourceDemand) -> bool:
        """Whether this demand falls under any configured cap or license pool.

        A demand with nothing declared, or a demand whose dimensions are all
        uncapped and which names no license, is a no-op — an existing config
        therefore behaves exactly as it did before N8.
        """
        if demand.license is not None and demand.license in self._license_slots:
            return True
        return any(need and self._limits[dimension] is not None for dimension, need in demand.numeric().items())

    def snapshot(self) -> dict[str, Any]:
        """Current capacity, occupancy, and queue depth (for the API/ops)."""
        with self._condition:
            licenses = {
                name: {
                    "slots": slots,
                    "in_use": self._license_in_use.get(name, 0),
                    "waiting": self._license_waiting.get(name, 0),
                }
                for name, slots in self._license_slots.items()
            }
            return {
                "limits": dict(self._limits),
                "in_use": {dimension: self._in_use[dimension] for dimension in RESOURCE_DIMENSIONS},
                "waiting": {dimension: self._waiting[dimension] for dimension in RESOURCE_DIMENSIONS},
                "licenses": licenses,
                "on_conflict": self._on_conflict,
                "acquire_timeout_seconds": self._acquire_timeout_seconds,
            }

    # ── admission ───────────────────────────────────────────────────────────

    def acquire(self, demand: ResourceDemand, *, on_conflict: str | None = None, timeout: float | None = None) -> ResourceLease:
        """Admit *demand* now, after a wait, or explicitly degrade it.

        ``timeout=None`` uses the governor's configured
        ``acquire_timeout_seconds``; pass a number to bound this call only.
        """
        if not self.governs(demand):
            return ResourceLease(demand=demand, reserved=False, license=demand.license)

        policy = on_conflict or self._on_conflict
        effective_timeout = self._acquire_timeout_seconds if timeout is None else float(timeout)

        with self._condition:
            if self._fits(demand):
                self._reserve(demand)
                return ResourceLease(demand=demand, reserved=True, license=demand.license)

            if policy == "fail":
                raise self._unavailable(demand, waited=0.0)

            if policy == "degrade":
                logger.warning(
                    "resource governor: degrading %s (license=%s); declared demand exceeds available capacity",
                    demand.numeric(),
                    demand.license,
                )
                return ResourceLease(demand=demand, reserved=False, degraded=True, license=demand.license)

            # policy == "wait": FIFO queue behind earlier waiters.
            started = time.monotonic()
            deadline = started + max(0.0, effective_timeout)
            ticket = self._enqueue(demand)
            try:
                while not (self._tickets[0] == ticket and self._fits(demand)):
                    remaining = deadline - time.monotonic()
                    if remaining <= 0:
                        raise self._unavailable(demand, waited=time.monotonic() - started)
                    self._condition.wait(timeout=remaining)
                self._reserve(demand)
                return ResourceLease(demand=demand, reserved=True, license=demand.license)
            finally:
                self._dequeue(ticket)

    def release(self, lease: ResourceLease | None) -> None:
        """Return a reserved lease's capacity to the pool (idempotent)."""
        if lease is None or not lease.reserved:
            return
        with self._condition:
            for dimension, need in lease.demand.numeric().items():
                if need:
                    self._in_use[dimension] = max(0, self._in_use[dimension] - need)
            name = lease.license
            if name and name in self._license_in_use:
                self._license_in_use[name] = max(0, self._license_in_use[name] - 1)
            lease.reserved = False
            self._condition.notify_all()

    # ── internals (call with the condition held) ─────────────────────────────

    def _fits(self, demand: ResourceDemand) -> bool:
        for dimension, need in demand.numeric().items():
            if not need:
                continue
            cap = self._limits[dimension]
            if cap is not None and self._in_use[dimension] + need > cap:
                return False
        name = demand.license
        if name is not None and name in self._license_slots and self._license_in_use.get(name, 0) + 1 > self._license_slots[name]:
            return False
        return True

    def _reserve(self, demand: ResourceDemand) -> None:
        for dimension, need in demand.numeric().items():
            if need:
                self._in_use[dimension] += need
        name = demand.license
        if name is not None and name in self._license_slots:
            self._license_in_use[name] = self._license_in_use.get(name, 0) + 1

    def _enqueue(self, demand: ResourceDemand) -> int:
        ticket = self._next_ticket
        self._next_ticket += 1
        self._tickets.append(ticket)
        self._waiting_demands[ticket] = demand
        for dimension, need in demand.numeric().items():
            if need:
                self._waiting[dimension] += 1
        name = demand.license
        if name is not None and name in self._license_slots:
            self._license_waiting[name] = self._license_waiting.get(name, 0) + 1
        return ticket

    def _dequeue(self, ticket: int) -> None:
        if ticket in self._tickets:
            self._tickets.remove(ticket)
        self._decrement_waiting(ticket)

    def _decrement_waiting(self, ticket: int) -> None:
        demand = self._waiting_demands.pop(ticket, None)
        if demand is None:
            return
        for dimension, need in demand.numeric().items():
            if need:
                self._waiting[dimension] = max(0, self._waiting[dimension] - 1)
        name = demand.license
        if name is not None and name in self._license_waiting:
            self._license_waiting[name] = max(0, self._license_waiting[name] - 1)

    def _unavailable(self, demand: ResourceDemand, *, waited: float) -> ResourceUnavailableError:
        dimension, license_name = self._first_blocker(demand)
        if license_name is not None:
            slots = self._license_slots[license_name]
            detail = f"license {license_name!r}: {self._license_in_use.get(license_name, 0)} of {slots} slot(s) in use"
            return ResourceUnavailableError(f"{detail} after waiting {waited:.1f}s", license=license_name, waited_seconds=waited)
        cap = self._limits[dimension] if dimension else None
        detail = f"resource {dimension!r}: {self._in_use.get(dimension, 0)} of {cap} in use" if dimension else "declared resource demand exceeds available capacity"
        return ResourceUnavailableError(f"{detail} after waiting {waited:.1f}s", dimension=dimension, waited_seconds=waited)

    def _first_blocker(self, demand: ResourceDemand) -> tuple[str | None, str | None]:
        for dimension, need in demand.numeric().items():
            cap = self._limits[dimension]
            if need and cap is not None and self._in_use[dimension] + need > cap:
                return dimension, None
        name = demand.license
        if name is not None and name in self._license_slots and self._license_in_use.get(name, 0) + 1 > self._license_slots[name]:
            return None, name
        return None, None


__all__ = [
    "ResourceDemand",
    "ResourceGovernor",
    "ResourceLease",
    "ResourceUnavailableError",
]
