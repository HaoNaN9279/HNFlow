"""Environment probe execution (N11) — the I/O half of §22's environment probing.

Everything here is **read-only and total**: it resolves an executable, checks a
path, or runs a version command, and it never raises.  On doubt it returns
:data:`~deerflow.environment.spec.PROBE_UNKNOWN` rather than a guess, which is the
same failure direction the rest of the engine uses (a broken presence probe must
not report "nobody is using it"; a broken version probe must not report "not
installed" *or* "satisfied").

It is also deliberately side-effect free beyond running the declared command:
probing never installs, downloads, edits the environment, or writes to the host.
The single directory-creating action in N11 lives in the data-directory half
(``Paths.ensure_data_dirs``), not here.

The judgement itself is pure and lives in
:mod:`deerflow.environment.evaluate`; this module only produces
:class:`~deerflow.environment.evaluate.Observation` values.
"""

from __future__ import annotations

import logging
import os
import shutil
import subprocess
import threading
import time
from pathlib import Path

from deerflow.environment.evaluate import Observation, evaluate_probe
from deerflow.environment.spec import (
    COMMAND_KINDS,
    SOURCE_CACHE,
    ProbeKind,
    ProbeResult,
    RequirementSpec,
)
from deerflow.environment.version import extract_version

logger = logging.getLogger(__name__)

#: Default wall-clock cap for one version command.  Version queries are cheap;
#: a command that needs longer than this is hanging, not working.
DEFAULT_PROBE_TIMEOUT_SECONDS = 5.0

#: Default lifetime of the in-process probe cache.  Probing costs a process
#: spawn, and an operator refreshing a report should not pay for that every
#: click — but the answer is a *fact about this moment*, so the cache is short
#: and ``force=True`` always bypasses it.
DEFAULT_PROBE_CACHE_SECONDS = 5.0

_CACHE_LOCK = threading.Lock()
_CACHE: dict[tuple[object, ...], tuple[float, tuple[ProbeResult, ...]]] = {}


def resolve_executable(name: str) -> str | None:
    """Resolve *name* to an executable path, or ``None``.

    Mirrors the ``cli`` application driver's availability rule (N4) so an
    application's own check and an environment requirement about the same binary
    cannot disagree: a name containing a path separator is an explicit path and
    must exist; a bare name is looked up on ``PATH``.
    """
    expanded = os.path.expandvars(os.path.expanduser(name))
    if not expanded.strip():
        return None
    if any(sep in expanded for sep in ("/", "\\")):
        candidate = Path(expanded)
        return str(candidate) if candidate.exists() else None
    return shutil.which(expanded)


def _resolve_filesystem_path(name: str, *, base: Path) -> Path:
    """Expand ``$VAR``/``~`` and resolve a relative path against *base*."""
    expanded = os.path.expandvars(os.path.expanduser(name))
    path = Path(expanded)
    return path if path.is_absolute() else base / path


def _observe_existence(spec: RequirementSpec, *, working_dir: Path | None) -> Observation:
    """Observe an ``executable`` / ``path`` / ``plugin`` spec.

    ``path`` resolves a relative name against the process working directory
    (it is an environment fact), while ``plugin`` resolves it against the
    application's ``working_dir`` (it is a fact about that application's
    install) — the declared semantic difference between the two kinds.
    """
    if spec.kind == ProbeKind.EXECUTABLE:
        try:
            resolved = resolve_executable(spec.name)
        except OSError as exc:  # pragma: no cover - defensive; which() rarely raises
            return Observation.unknown(f"{type(exc).__name__}: {exc}")
        if resolved is None:
            return Observation(found=False, detail="not found on PATH or at the given path")
        return Observation(found=True, path=resolved)

    base = Path.cwd() if working_dir is None else Path(working_dir)
    target = _resolve_filesystem_path(spec.name, base=base)
    try:
        if target.exists():
            return Observation(found=True, path=str(target))
        return Observation(found=False, path=str(target), detail="path does not exist")
    except OSError as exc:
        # exists() can raise on a malformed path (an embedded NUL on some
        # platforms) — that is "could not look", not "absent".
        return Observation.unknown(f"{type(exc).__name__}: {exc}")


def _observe_command(spec: RequirementSpec, *, working_dir: Path | None, timeout: float) -> Observation:
    """Run a version command and observe what it printed.

    A non-zero exit is **not** trusted even when stdout looks like a version: a
    command that failed did not answer the question.  Stdout is preferred, with
    stderr as a fallback, because a few tools print their version there.
    """
    argv = spec.resolved_command()
    if not argv:
        return Observation.unknown("no command to run")

    executable = resolve_executable(argv[0])
    if executable is None:
        return Observation(found=False, detail="command not found")

    try:
        completed = subprocess.run(  # noqa: S603 - operator-declared argv, never a shell string
            argv,
            cwd=str(working_dir) if working_dir is not None else None,
            capture_output=True,
            text=True,
            timeout=timeout,
            check=False,
        )
    except subprocess.TimeoutExpired:
        return Observation(found=True, path=executable, detail=f"timed out after {timeout:g}s")
    except OSError as exc:
        return Observation(found=None, path=executable, detail=f"could not run: {exc}")

    if completed.returncode != 0:
        stderr = (completed.stderr or "").strip().splitlines()
        reason = stderr[0].strip() if stderr else ""
        detail = f"exit code {completed.returncode}" + (f": {reason}" if reason else "")
        return Observation(found=True, path=executable, detail=detail)

    version = extract_version(completed.stdout or "") or extract_version(completed.stderr or "")
    if version is None:
        return Observation(found=True, path=executable, detail="no version-like text in the command output")
    return Observation(found=True, version=version, path=executable)


def run_probe(spec: RequirementSpec, *, working_dir: str | Path | None = None, timeout: float = DEFAULT_PROBE_TIMEOUT_SECONDS) -> ProbeResult:
    """Probe one requirement.  Never raises — doubt becomes ``unknown``."""
    base = Path(working_dir) if working_dir is not None else None
    try:
        if spec.kind in COMMAND_KINDS:
            observation = _observe_command(spec, working_dir=base, timeout=float(timeout))
        else:
            observation = _observe_existence(spec, working_dir=base)
    except Exception as exc:  # noqa: BLE001 - a probe boundary; a broken probe must not fail a run
        logger.debug("probe for %s raised; reporting unknown", spec.describe(), exc_info=True)
        observation = Observation.unknown(f"{type(exc).__name__}: {exc}")
    return evaluate_probe(spec, observation)


def probe_all(
    specs: list[RequirementSpec] | tuple[RequirementSpec, ...],
    *,
    working_dir: str | Path | None = None,
    timeout: float = DEFAULT_PROBE_TIMEOUT_SECONDS,
) -> tuple[ProbeResult, ...]:
    """Probe every spec, preserving order."""
    return tuple(run_probe(spec, working_dir=working_dir, timeout=timeout) for spec in specs)


def _cache_key(
    specs: list[RequirementSpec] | tuple[RequirementSpec, ...],
    *,
    working_dir: str | Path | None,
    timeout: float,
    namespace: str,
) -> tuple[object, ...]:
    return (
        namespace,
        str(working_dir) if working_dir is not None else "",
        float(timeout),
        tuple(spec.model_dump_json() for spec in specs),
    )


def probe_all_cached(
    specs: list[RequirementSpec] | tuple[RequirementSpec, ...],
    *,
    namespace: str = "default",
    working_dir: str | Path | None = None,
    timeout: float = DEFAULT_PROBE_TIMEOUT_SECONDS,
    ttl: float = DEFAULT_PROBE_CACHE_SECONDS,
    force: bool = False,
) -> tuple[ProbeResult, ...]:
    """Probe every spec, reusing a recent answer within *ttl* seconds.

    The cache is process-local on purpose: a probe result is a fact about *this*
    machine *right now*, so persisting it would only create a stale truth (an
    application installed tomorrow would still read as missing).  Cached results
    are re-stamped with ``source=cache`` so a reader can tell them apart.
    """
    if not specs:
        return ()

    key = _cache_key(specs, working_dir=working_dir, timeout=timeout, namespace=namespace)
    if not force and ttl > 0:
        with _CACHE_LOCK:
            entry = _CACHE.get(key)
        if entry is not None:
            stored_at, results = entry
            if time.monotonic() - stored_at <= ttl:
                return tuple(_restamped(result) for result in results)

    results = probe_all(specs, working_dir=working_dir, timeout=timeout)
    if ttl > 0:
        with _CACHE_LOCK:
            _CACHE[key] = (time.monotonic(), results)
    return results


def _restamped(result: ProbeResult) -> ProbeResult:
    """Mark a cached result so it is never mistaken for a live probe."""
    return ProbeResult(spec=result.spec, outcome=result.outcome, observed=result.observed, detail=result.detail, source=SOURCE_CACHE)


def clear_probe_cache() -> None:
    """Drop every cached probe result (tests, config reload, explicit refresh)."""
    with _CACHE_LOCK:
        _CACHE.clear()


__all__ = [
    "DEFAULT_PROBE_CACHE_SECONDS",
    "DEFAULT_PROBE_TIMEOUT_SECONDS",
    "clear_probe_cache",
    "probe_all",
    "probe_all_cached",
    "resolve_executable",
    "run_probe",
]
