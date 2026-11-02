"""The probe decision table (N11) — pure, total, testable without I/O.

Given a declared :class:`~deerflow.environment.spec.RequirementSpec` and a raw
:class:`Observation` of what the machine showed, :func:`evaluate_probe` returns
the outcome.  This is the same split the engine uses for scheduled triggers
(``is_trigger_due``), human presence (``decide_access``) and irreversible-action
previews (``make_preview``): **the judgement is a pure function; the I/O that
feeds it lives elsewhere.**

The rules in one place:

=================================  =========================================
observation                        outcome
=================================  =========================================
existence kind, ``found is None``   ``unknown`` (we could not tell)
existence kind, not found           ``missing``
existence kind, found               ``ok``
command kind, executable not found  ``missing``
command kind, no version readable   ``unknown``
command kind, version satisfies     ``ok``
command kind, version violates      ``mismatch``
command kind, comparison impossible ``unknown``
=================================  =========================================

Two asymmetries are intentional.  A *missing executable* is ``missing`` rather
than ``unknown`` because "the command is not on PATH" is a complete answer.  An
*unparsable constraint or version* is ``unknown`` rather than ``mismatch``
because a typo in a config file must not be reported as a broken machine — and
because a probe that cannot compare has, in fact, learned nothing.
"""

from __future__ import annotations

from dataclasses import dataclass

from deerflow.environment.spec import (
    COMMAND_KINDS,
    OVERALL_DEGRADED,
    OVERALL_MISSING,
    OVERALL_OK,
    PROBE_MISMATCH,
    PROBE_MISSING,
    PROBE_OK,
    PROBE_UNKNOWN,
    ProbeResult,
    RequirementReport,
    RequirementSpec,
)
from deerflow.environment.version import version_satisfies


@dataclass(frozen=True)
class Observation:
    """What a probe actually saw, before any judgement.

    ``found`` is three-valued on purpose: ``True`` / ``False`` are answers,
    ``None`` is "the check itself failed" (a timeout, a permission error, an
    unreadable directory).  A probe must be able to say "I could not look"
    without pretending it looked and saw nothing.
    """

    found: bool | None = None
    #: Detected version text for command kinds (already extracted from output).
    version: str | None = None
    #: Resolved path/executable when the probe learned one (evidence for the report).
    path: str = ""
    detail: str = ""

    @classmethod
    def unknown(cls, detail: str = "") -> Observation:
        """The honest "could not look" observation."""
        return cls(found=None, detail=detail)


def evaluate_probe(spec: RequirementSpec, observation: Observation) -> ProbeResult:
    """Turn an observation into a :class:`ProbeResult` (pure, total)."""
    if spec.kind in COMMAND_KINDS:
        return _evaluate_command_spec(spec, observation)
    return _evaluate_existence_spec(spec, observation)


def _evaluate_existence_spec(spec: RequirementSpec, observation: Observation) -> ProbeResult:
    if observation.found is None:
        return ProbeResult(spec=spec, outcome=PROBE_UNKNOWN, observed=observation.path, detail=observation.detail or "existence could not be checked")
    if not observation.found:
        return ProbeResult(spec=spec, outcome=PROBE_MISSING, observed=observation.path, detail=observation.detail or "not found")
    return ProbeResult(spec=spec, outcome=PROBE_OK, observed=observation.path or spec.name, detail=observation.detail)


def _evaluate_command_spec(spec: RequirementSpec, observation: Observation) -> ProbeResult:
    if observation.found is False:
        return ProbeResult(spec=spec, outcome=PROBE_MISSING, observed=observation.path, detail=observation.detail or "command not found")

    if not observation.version:
        # Either the executable's presence is unknown, or it ran but printed
        # nothing version-like.  Both are "we learned nothing", not a failure:
        # a missing version command is not a missing application.
        return ProbeResult(spec=spec, outcome=PROBE_UNKNOWN, observed=observation.path, detail=observation.detail or "no version could be read")

    satisfies = version_satisfies(observation.version, spec.expect)
    if satisfies is True:
        return ProbeResult(spec=spec, outcome=PROBE_OK, observed=observation.version, detail=observation.detail)
    if satisfies is False:
        return ProbeResult(
            spec=spec,
            outcome=PROBE_MISMATCH,
            observed=observation.version,
            detail=observation.detail or f"detected {observation.version} does not satisfy {spec.expect!r}",
        )
    return ProbeResult(
        spec=spec,
        outcome=PROBE_UNKNOWN,
        observed=observation.version,
        detail=observation.detail or f"could not compare detected version {observation.version!r} against {spec.expect!r}",
    )


def build_report(source: str, label: str, pairs: list[tuple[RequirementSpec, Observation]]) -> RequirementReport:
    """Evaluate every ``(spec, observation)`` pair into one grouped report."""
    return RequirementReport(
        source=source,
        label=label,
        results=tuple(evaluate_probe(spec, observation) for spec, observation in pairs),
    )


def summarize(reports: list[RequirementReport]) -> str:
    """Roll several reports up into one overall state.

    ``missing`` (a required spec is broken) is the loudest signal; ``degraded``
    covers optional failures and unknowns; ``ok`` means every declared
    requirement was answered and satisfied.
    """
    if not reports:
        return OVERALL_OK
    if any(report.overall == OVERALL_MISSING for report in reports):
        return OVERALL_MISSING
    if any(report.overall != OVERALL_OK for report in reports):
        return OVERALL_DEGRADED
    return OVERALL_OK


def required_failures(reports: list[RequirementReport]) -> tuple[ProbeResult, ...]:
    """Every required spec that definitively failed, across all reports.

    This is what a ``require_on_load`` gate keys on: an ``unknown`` never appears
    here, because refusing to start over an unanswerable probe would punish
    applications that simply cannot report a version.
    """
    return tuple(result for report in reports for result in report.failures)


__all__ = [
    "Observation",
    "build_report",
    "evaluate_probe",
    "required_failures",
    "summarize",
]
