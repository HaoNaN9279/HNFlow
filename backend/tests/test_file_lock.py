"""Tests for the cross-process reentrant file lock (N8, plan §19)."""

from __future__ import annotations

import subprocess
import sys
import threading
import time
from pathlib import Path

import pytest

from deerflow.locks.file_lock import (
    LockNameError,
    LockTimeoutError,
    acquire_many,
    resource_lock,
)

pytestmark = pytest.mark.no_auto_user


def _lock_file(base_dir: Path, name: str) -> Path:
    return base_dir / "locks" / f"{name}.lock"


def test_lock_file_created_under_base_dir(tmp_path):
    with resource_lock("demo-lock", base_dir=tmp_path):
        assert _lock_file(tmp_path, "demo-lock").exists()
    assert _lock_file(tmp_path, "demo-lock").exists()


def test_lock_is_reentrant_for_same_thread(tmp_path):
    with resource_lock("reentrant", base_dir=tmp_path):
        with resource_lock("reentrant", base_dir=tmp_path):
            with resource_lock("reentrant", base_dir=tmp_path):
                pass


def test_concurrent_threads_serialize(tmp_path):
    order: list[str] = []
    barrier = threading.Barrier(2)

    def worker(tag: str) -> None:
        barrier.wait(timeout=10)
        for _ in range(5):
            with resource_lock("threads", base_dir=tmp_path):
                order.append(f"{tag}-in")
                time.sleep(0.01)
                order.append(f"{tag}-out")

    threads = [threading.Thread(target=worker, args=(tag,)) for tag in ("a", "b")]
    for thread in threads:
        thread.start()
    for thread in threads:
        thread.join(timeout=30)

    assert len(order) == 20
    # No interleaving: every in/out pair is adjacent and from one tag.
    for index in range(0, len(order), 2):
        assert order[index].split("-")[0] == order[index + 1].split("-")[0]
        assert order[index].endswith("-in")
        assert order[index + 1].endswith("-out")


def test_timeout_when_held_by_another_thread(tmp_path):
    holding = threading.Event()
    release = threading.Event()

    def holder() -> None:
        with resource_lock("held", base_dir=tmp_path):
            holding.set()
            release.wait(timeout=30)

    thread = threading.Thread(target=holder)
    thread.start()
    try:
        assert holding.wait(timeout=10)
        started = time.monotonic()
        with pytest.raises(LockTimeoutError):
            with resource_lock("held", base_dir=tmp_path, timeout=0.2):
                pass
        assert time.monotonic() - started >= 0.15
    finally:
        release.set()
        thread.join(timeout=30)


def test_acquire_many_is_order_independent(tmp_path):
    results: list[str] = []

    def worker(names: list[str], tag: str) -> None:
        with acquire_many(names, base_dir=tmp_path, timeout=10):
            results.append(tag)
            time.sleep(0.05)

    first = threading.Thread(target=worker, args=(["a", "b"], "ab"))
    second = threading.Thread(target=worker, args=(["b", "a"], "ba"))
    first.start()
    second.start()
    first.join(timeout=30)
    second.join(timeout=30)

    assert sorted(results) == ["ab", "ba"]


def test_acquire_many_times_out_without_partial_hold(tmp_path):
    """A blocked set must not leave earlier names held after the timeout."""
    holding = threading.Event()
    release = threading.Event()

    def holder() -> None:
        with resource_lock("b", base_dir=tmp_path):
            holding.set()
            release.wait(timeout=30)

    thread = threading.Thread(target=holder)
    thread.start()
    try:
        assert holding.wait(timeout=10)
        with pytest.raises(LockTimeoutError):
            with acquire_many(["a", "b"], base_dir=tmp_path, timeout=0.2):
                pass
        # "a" must be free again: a plain acquire succeeds immediately.
        with resource_lock("a", base_dir=tmp_path, timeout=1):
            pass
    finally:
        release.set()
        thread.join(timeout=30)


@pytest.mark.parametrize("name", ["", "a/b", "../escape", "a b", ".", "-leading", "a" * 65])
def test_invalid_lock_names_rejected(tmp_path, name):
    with pytest.raises(LockNameError):
        with resource_lock(name, base_dir=tmp_path):
            pass


def test_cross_process_exclusion(tmp_path):
    """A second *process* holding the lock must block this one."""
    script = (
        "import sys, time\n"
        "from pathlib import Path\n"
        "from deerflow.locks.file_lock import resource_lock\n"
        "base = Path(sys.argv[1])\n"
        "with resource_lock('cross', base_dir=base):\n"
        "    sys.stdout.write('locked\\n')\n"
        "    sys.stdout.flush()\n"
        "    time.sleep(1.2)\n"
    )
    process = subprocess.Popen(
        [sys.executable, "-c", script, str(tmp_path)],
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        text=True,
    )
    try:
        assert process.stdout is not None
        assert process.stdout.readline().strip() == "locked"
        with pytest.raises(LockTimeoutError):
            with resource_lock("cross", base_dir=tmp_path, timeout=0.3):
                pass
        process.wait(timeout=30)
        # Released by the child: this process can now take it.
        with resource_lock("cross", base_dir=tmp_path, timeout=5):
            pass
    finally:
        if process.poll() is None:
            process.kill()
            process.wait(timeout=30)
