"""Tests for the host-side resource governor (N8, plan §19)."""

from __future__ import annotations

import threading
import time

import pytest

from deerflow.config.apps_config import AppResourceDemand, AppsConfig, LicenseGroup
from deerflow.resources.governor import (
    ResourceDemand,
    ResourceGovernor,
    ResourceLease,
    ResourceUnavailableError,
)

pytestmark = pytest.mark.no_auto_user


def _governor(**kwargs) -> ResourceGovernor:
    return ResourceGovernor(**kwargs)


# ── declaration / no-op paths ────────────────────────────────────────────────


def test_ungoverned_demand_is_a_no_op():
    governor = _governor()
    lease = governor.acquire(ResourceDemand(gpu=4, memory_mb=1024))
    assert lease.reserved is False
    assert lease.degraded is False
    assert governor.snapshot()["in_use"]["gpu"] == 0


def test_demand_inside_an_uncapped_dimension_is_a_no_op():
    governor = _governor(limits={"gpu": 1})
    lease = governor.acquire(ResourceDemand(cpu=99))
    assert lease.reserved is False


def test_from_apps_config_reads_limits_and_licenses():
    config = AppsConfig(
        resources={"gpu": 2, "memory_mb": 4096},
        licenses={"render": LicenseGroup(slots=2)},
        on_conflict="fail",
        acquire_timeout_seconds=5,
    )
    governor = ResourceGovernor.from_apps_config(config)
    assert governor.limits == {"gpu": 2, "cpu": None, "memory_mb": 4096, "disk_mb": None}
    assert governor.license_slots == {"render": 2}
    assert governor.on_conflict == "fail"
    assert governor.acquire_timeout_seconds == 5


def test_from_declaration_bridges_config_model():
    demand = ResourceDemand.from_declaration(AppResourceDemand(gpu=1, cpu=2, memory_mb=512, disk_mb=64, license="x"))
    assert demand.numeric() == {"gpu": 1, "cpu": 2, "memory_mb": 512, "disk_mb": 64}
    assert demand.license == "x"
    assert ResourceDemand.from_declaration(None) == ResourceDemand()


# ── reservation and release ──────────────────────────────────────────────────


def test_reserve_and_release_restore_capacity():
    governor = _governor(limits={"gpu": 1, "memory_mb": 2048})
    lease = governor.acquire(ResourceDemand(gpu=1, memory_mb=1024))
    assert lease.reserved is True
    assert governor.snapshot()["in_use"] == {"gpu": 1, "cpu": 0, "memory_mb": 1024, "disk_mb": 0}

    governor.release(lease)
    assert governor.snapshot()["in_use"] == {"gpu": 0, "cpu": 0, "memory_mb": 0, "disk_mb": 0}


def test_release_is_idempotent():
    governor = _governor(limits={"gpu": 1})
    lease = governor.acquire(ResourceDemand(gpu=1))
    governor.release(lease)
    governor.release(lease)
    assert governor.snapshot()["in_use"]["gpu"] == 0


def test_license_slots_are_held_and_released():
    governor = _governor(licenses={"render": 2})
    first = governor.acquire(ResourceDemand(license="render"))
    second = governor.acquire(ResourceDemand(license="render"))
    assert (first.reserved, second.reserved) == (True, True)
    assert governor.snapshot()["licenses"]["render"]["in_use"] == 2

    with pytest.raises(ResourceUnavailableError):
        governor.acquire(ResourceDemand(license="render"), on_conflict="fail")
    assert governor.snapshot()["licenses"]["render"]["in_use"] == 2

    governor.release(first)
    assert governor.snapshot()["licenses"]["render"]["in_use"] == 1
    governor.release(second)
    assert governor.snapshot()["licenses"]["render"]["in_use"] == 0


# ── conflict policies ────────────────────────────────────────────────────────


def test_fail_policy_raises_with_dimension():
    governor = _governor(limits={"gpu": 1}, on_conflict="fail")
    governor.acquire(ResourceDemand(gpu=1))
    with pytest.raises(ResourceUnavailableError) as exc:
        governor.acquire(ResourceDemand(gpu=1))
    assert exc.value.dimension == "gpu"
    assert "gpu" in str(exc.value)


def test_fail_policy_raises_with_license():
    governor = _governor(licenses={"render": 1}, on_conflict="fail")
    governor.acquire(ResourceDemand(license="render"))
    with pytest.raises(ResourceUnavailableError) as exc:
        governor.acquire(ResourceDemand(license="render"))
    assert exc.value.license == "render"
    assert "render" in str(exc.value)


def test_degrade_policy_proceeds_and_marks():
    governor = _governor(limits={"gpu": 1}, on_conflict="degrade")
    governor.acquire(ResourceDemand(gpu=1))
    lease = governor.acquire(ResourceDemand(gpu=1))
    assert lease.degraded is True
    assert lease.reserved is False  # oversubscription is not accounted for
    assert governor.snapshot()["in_use"]["gpu"] == 1


def test_degrade_policy_reserves_when_it_still_fits():
    governor = _governor(limits={"gpu": 2}, on_conflict="degrade")
    lease = governor.acquire(ResourceDemand(gpu=1))
    assert lease.degraded is False
    assert lease.reserved is True


def test_wait_policy_times_out():
    governor = _governor(limits={"gpu": 1}, on_conflict="wait")
    governor.acquire(ResourceDemand(gpu=1))
    started = time.monotonic()
    with pytest.raises(ResourceUnavailableError) as exc:
        governor.acquire(ResourceDemand(gpu=1), timeout=0.2)
    assert time.monotonic() - started >= 0.15
    assert exc.value.waited_seconds >= 0.15
    # The timed-out waiter left the queue cleanly.
    assert governor.snapshot()["waiting"]["gpu"] == 0


def test_wait_policy_proceeds_after_release():
    governor = _governor(limits={"gpu": 1}, on_conflict="wait")
    holder = governor.acquire(ResourceDemand(gpu=1))
    results: list[ResourceLease] = []
    started = threading.Event()

    def waiter() -> None:
        started.set()
        results.append(governor.acquire(ResourceDemand(gpu=1), timeout=10))

    thread = threading.Thread(target=waiter)
    started.clear()
    thread.start()
    started.wait(timeout=5)
    # Give the waiter a moment to enqueue, then free the slot.
    _wait_for(lambda: governor.snapshot()["waiting"]["gpu"] == 1)
    governor.release(holder)
    thread.join(timeout=10)

    assert len(results) == 1
    assert results[0].reserved is True
    governor.release(results[0])


def test_wait_queue_is_fifo():
    governor = _governor(limits={"gpu": 1}, on_conflict="wait")
    holder = governor.acquire(ResourceDemand(gpu=1))
    order: list[str] = []

    def waiter(tag: str) -> None:
        lease = governor.acquire(ResourceDemand(gpu=1), timeout=15)
        order.append(tag)
        governor.release(lease)

    threads = [threading.Thread(target=waiter, args=(tag,)) for tag in ("first", "second")]
    threads[0].start()
    _wait_for(lambda: governor.snapshot()["waiting"]["gpu"] == 1)
    threads[1].start()
    _wait_for(lambda: governor.snapshot()["waiting"]["gpu"] == 2)
    governor.release(holder)
    for thread in threads:
        thread.join(timeout=15)

    assert order == ["first", "second"]


# ── atomic multi-dimension admission ─────────────────────────────────────────


def test_multi_dimension_admission_is_all_or_nothing():
    governor = _governor(limits={"gpu": 1, "memory_mb": 1024}, on_conflict="fail")
    governor.acquire(ResourceDemand(memory_mb=1024))
    with pytest.raises(ResourceUnavailableError):
        governor.acquire(ResourceDemand(gpu=1, memory_mb=1024))
    # Neither dimension was partially consumed.
    assert governor.snapshot()["in_use"] == {"gpu": 0, "cpu": 0, "memory_mb": 1024, "disk_mb": 0}


def test_concurrent_acquires_never_oversubscribe():
    governor = _governor(limits={"gpu": 2}, on_conflict="wait")
    peak: list[int] = []
    lock = threading.Lock()

    def worker() -> None:
        lease = governor.acquire(ResourceDemand(gpu=1), timeout=15)
        with lock:
            peak.append(governor.snapshot()["in_use"]["gpu"])
        time.sleep(0.02)
        governor.release(lease)

    threads = [threading.Thread(target=worker) for _ in range(6)]
    for thread in threads:
        thread.start()
    for thread in threads:
        thread.join(timeout=30)

    assert len(peak) == 6
    assert max(peak) <= 2
    assert governor.snapshot()["in_use"]["gpu"] == 0


def test_snapshot_reports_limits_use_and_waiting():
    governor = _governor(limits={"gpu": 1}, licenses={"render": 1}, on_conflict="fail")
    governor.acquire(ResourceDemand(gpu=1, license="render"))
    snapshot = governor.snapshot()
    assert snapshot["limits"]["gpu"] == 1
    assert snapshot["in_use"]["gpu"] == 1
    assert snapshot["waiting"]["gpu"] == 0
    assert snapshot["licenses"]["render"] == {"slots": 1, "in_use": 1, "waiting": 0}
    assert snapshot["on_conflict"] == "fail"


def _wait_for(predicate, *, timeout: float = 5.0, interval: float = 0.01) -> None:
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        if predicate():
            return
        time.sleep(interval)
    raise AssertionError("condition not met in time")
