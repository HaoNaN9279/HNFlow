"""Environment probing and data-directory conventions (N11, dev plan §22).

The package mirrors the split the engine already uses elsewhere:

- :mod:`deerflow.environment.spec` — declared requirements + result vocabulary (pure data).
- :mod:`deerflow.environment.version` — version parsing/comparison (pure).
- :mod:`deerflow.environment.evaluate` — the probe decision table (pure).
- :mod:`deerflow.environment.probe` — the I/O that feeds it (never raises; unknown on doubt).

Probing is **read-only**: it answers "is this here, and which version" and never
installs, downloads, edits the environment, or writes to the host.
"""

from __future__ import annotations

from deerflow.environment.evaluate import (
    Observation,
    build_report,
    evaluate_probe,
    required_failures,
    summarize,
)
from deerflow.environment.probe import (
    DEFAULT_PROBE_CACHE_SECONDS,
    DEFAULT_PROBE_TIMEOUT_SECONDS,
    clear_probe_cache,
    probe_all,
    probe_all_cached,
    resolve_executable,
    run_probe,
)
from deerflow.environment.requirements import (
    EnvironmentStatus,
    RequirementSource,
    app_requirement_specs,
    app_version_spec,
    collect_sources,
    detect_app_version,
    skill_requirement_specs,
    validate_environment,
)
from deerflow.environment.spec import (
    FAILED_OUTCOMES,
    OVERALL_DEGRADED,
    OVERALL_MISSING,
    OVERALL_OK,
    OVERALL_STATES,
    PROBE_MISMATCH,
    PROBE_MISSING,
    PROBE_OK,
    PROBE_OUTCOMES,
    PROBE_UNKNOWN,
    ProbeKind,
    ProbeResult,
    RequirementReport,
    RequirementSpec,
)
from deerflow.environment.version import compare_versions, extract_version, parse_version, version_satisfies

__all__ = [
    "DEFAULT_PROBE_CACHE_SECONDS",
    "DEFAULT_PROBE_TIMEOUT_SECONDS",
    "FAILED_OUTCOMES",
    "OVERALL_DEGRADED",
    "OVERALL_MISSING",
    "OVERALL_OK",
    "OVERALL_STATES",
    "PROBE_MISMATCH",
    "PROBE_MISSING",
    "PROBE_OK",
    "PROBE_OUTCOMES",
    "PROBE_UNKNOWN",
    "EnvironmentStatus",
    "Observation",
    "ProbeKind",
    "ProbeResult",
    "RequirementReport",
    "RequirementSource",
    "RequirementSpec",
    "app_requirement_specs",
    "app_version_spec",
    "build_report",
    "clear_probe_cache",
    "collect_sources",
    "compare_versions",
    "detect_app_version",
    "evaluate_probe",
    "extract_version",
    "parse_version",
    "probe_all",
    "probe_all_cached",
    "required_failures",
    "resolve_executable",
    "run_probe",
    "skill_requirement_specs",
    "summarize",
    "validate_environment",
    "version_satisfies",
]
