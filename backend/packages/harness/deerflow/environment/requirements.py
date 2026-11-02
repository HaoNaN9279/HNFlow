"""Bind environment requirements to their declaring sources (N11).

§22 asks for probing to be *bound to capability groups and validated on load*.
Two kinds of source declare requirements, and both are collected here:

- **applications** (``config.yaml -> apps.definitions.<name>.requires``), plus the
  application's own ``version_command`` — the field N4 declared and nothing ever
  read, now the source of the app's detected version;
- **capability groups / skills** (``SKILL.md`` frontmatter ``requires:``), the
  binding §22 names explicitly.  Only *enabled* skills are collected: a package
  you have not enabled is not something your machine has to be ready for.

The collection is a pure structural walk; the probing is
:func:`deerflow.environment.probe.probe_all_cached`; the judgement is
:func:`deerflow.environment.evaluate.evaluate_probe`; the gate is
:func:`required_failures`.
"""

from __future__ import annotations

import logging
import os
from dataclasses import dataclass
from pathlib import Path
from typing import Any

from deerflow.environment.evaluate import required_failures
from deerflow.environment.probe import DEFAULT_PROBE_CACHE_SECONDS, DEFAULT_PROBE_TIMEOUT_SECONDS, probe_all_cached
from deerflow.environment.spec import (
    OVERALL_DEGRADED,
    OVERALL_MISSING,
    OVERALL_OK,
    OVERALL_STATES,
    PROBE_OK,
    ProbeKind,
    RequirementReport,
    RequirementSpec,
)

logger = logging.getLogger(__name__)


@dataclass(frozen=True)
class RequirementSource:
    """One thing that declares requirements, and where its probes should run.

    ``working_dir`` matters for two kinds: a ``plugin`` requirement resolves a
    relative name against the application's install directory, and a version
    command runs there so it sees the same installation the driver would.
    """

    source: str
    label: str
    specs: tuple[RequirementSpec, ...]
    working_dir: str | None = None

    @property
    def has_requirements(self) -> bool:
        return bool(self.specs)


@dataclass(frozen=True)
class EnvironmentStatus:
    """The whole environment answer: per-source reports plus the roll-up."""

    enabled: bool
    reports: tuple[RequirementReport, ...]
    require_on_load: bool = False

    @property
    def overall(self) -> str:
        """``ok`` / ``degraded`` / ``missing`` across every source."""
        if any(report.overall == OVERALL_MISSING for report in self.reports):
            return OVERALL_MISSING
        if any(report.overall != OVERALL_OK for report in self.reports):
            return OVERALL_DEGRADED
        return OVERALL_OK

    @property
    def failures(self) -> tuple[Any, ...]:
        """Required, definitively-failed results — what ``require_on_load`` gates on."""
        return required_failures(list(self.reports))

    def to_dict(self) -> dict[str, object]:
        return {
            "enabled": self.enabled,
            "overall": self.overall,
            "require_on_load": self.require_on_load,
            "sources": [report.to_dict() for report in self.reports],
        }


def _expanded_working_dir(definition: Any) -> str | None:
    """Resolve a definition's ``working_dir`` the way the ``cli`` driver does."""
    raw = getattr(definition, "working_dir", None)
    if not raw:
        return None
    return str(Path(os.path.expandvars(str(raw))).expanduser())


def app_version_spec(definition: Any) -> RequirementSpec | None:
    """Build the implicit version requirement for an application (N11).

    ``AppDefinition.version_command`` has existed since N4 without a reader.  It is
    a token appended in the same argv position as a script (and as
    ``presence_command``), so no quoting rules are invented, and the resulting
    spec is **optional**: an application that cannot answer a version query is not
    a broken environment, it is an application that cannot answer a version query.
    """
    version_command = getattr(definition, "version_command", None)
    command = getattr(definition, "command", None)
    if not version_command or not command:
        return None
    argv = [str(command), *[str(a) for a in getattr(definition, "args", []) or []], *[str(a) for a in getattr(definition, "script_args", []) or []], str(version_command)]
    return RequirementSpec(kind=ProbeKind.VERSION, name=str(command), command=argv, optional=True)


def app_requirement_specs(name: str, definition: Any) -> tuple[RequirementSpec, ...]:
    """Declared requirements for one application, plus its own version probe."""
    declared = tuple(getattr(definition, "requires", ()) or ())
    version_spec = app_version_spec(definition)
    return (*declared, version_spec) if version_spec is not None else declared


def skill_requirement_specs(skill: Any) -> tuple[RequirementSpec, ...]:
    """Declared requirements for one capability group (empty when it declares none)."""
    return tuple(getattr(skill, "requirements", ()) or ())


def collect_sources(*, registry: Any = None, skills: Any = None) -> list[RequirementSource]:
    """Collect every requirement source that actually declares something.

    Sources with no requirements are skipped so a report never lists empty
    noise, and so an untouched configuration produces no output at all.
    """
    sources: list[RequirementSource] = []

    if registry is not None:
        for name, definition in registry.entries():
            specs = app_requirement_specs(name, definition)
            if not specs:
                continue
            sources.append(
                RequirementSource(
                    source=f"app:{name}",
                    label=str(getattr(definition, "description", "") or name),
                    specs=specs,
                    working_dir=_expanded_working_dir(definition),
                )
            )

    for skill in skills or ():
        specs = skill_requirement_specs(skill)
        if not specs:
            continue
        if not getattr(skill, "enabled", False):
            # An unenabled capability group is not a requirement on this machine.
            continue
        sources.append(RequirementSource(source=f"skill:{skill.name}", label=str(getattr(skill, "description", "") or skill.name), specs=specs))

    return sources


def validate_environment(
    *,
    registry: Any = None,
    skills: Any = None,
    enabled: bool = True,
    timeout: float = DEFAULT_PROBE_TIMEOUT_SECONDS,
    cache_seconds: float = DEFAULT_PROBE_CACHE_SECONDS,
    force: bool = False,
    require_on_load: bool = False,
) -> EnvironmentStatus:
    """Probe every declared requirement and roll the answers up.

    Never raises: a probe that cannot answer contributes ``unknown``, which is
    reported but never treated as a failure.
    """
    if not enabled:
        return EnvironmentStatus(enabled=False, reports=(), require_on_load=require_on_load)

    reports: list[RequirementReport] = []
    for source in collect_sources(registry=registry, skills=skills):
        results = probe_all_cached(
            list(source.specs),
            namespace=source.source,
            working_dir=source.working_dir,
            timeout=timeout,
            ttl=cache_seconds,
            force=force,
        )
        reports.append(RequirementReport(source=source.source, label=source.label, results=results))

    status = EnvironmentStatus(enabled=True, reports=tuple(reports), require_on_load=require_on_load)
    if status.overall not in OVERALL_STATES:  # pragma: no cover - defensive
        logger.warning("unexpected environment overall state %r", status.overall)
    return status


def detect_app_version(definition: Any, *, timeout: float = DEFAULT_PROBE_TIMEOUT_SECONDS) -> str | None:
    """Return the application's detected version, or ``None``.

    Used by the apps API to answer "which version is installed?" without making
    the caller reconstruct the argv position rules.
    """
    spec = app_version_spec(definition)
    if spec is None:
        return None
    result = probe_all_cached([spec], namespace=f"app-version:{spec.name}", working_dir=_expanded_working_dir(definition), timeout=timeout)[0]
    return result.observed if result.outcome == PROBE_OK else None


__all__ = [
    "EnvironmentStatus",
    "RequirementSource",
    "app_requirement_specs",
    "app_version_spec",
    "collect_sources",
    "detect_app_version",
    "skill_requirement_specs",
    "validate_environment",
]
