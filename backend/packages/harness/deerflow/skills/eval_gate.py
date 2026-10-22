"""Install-time eval gate for skill packages (§24.8, capability-package side).

N14u gates a *workflow definition* on the eval suite embedded in its metadata.
This is the capability-package half of the same idea: a package that ships
``evals/*.json`` can ask to be verified when it is installed or upgraded, and a
gate that was declared but cannot be run never silently passes.

Two deliberate bounds:

* **Only *trigger* cases are decided.**  ``should_trigger`` is a predicate an
  injected decider can answer ("would this skill be selected for this
  utterance?"), which keeps the policy offline-testable.  A behavioural case
  (an ``assertions`` list, an expected readiness) needs its own runner and is
  counted, never judged here — reporting a number the gate cannot verify as
  "passed" would be a lie.
* **Opt-in is the package author's, exactly like N14u.**  A dict manifest
  carrying ``require_pass: true`` gates its cases.  A manifest that cannot
  express it (a bare ``[{...}]`` trigger list) stays report-only: there is no
  place to declare intent, and gating every package that merely *ships* a
  trigger set would make installs depend on a model call nobody asked for.

The default install path therefore stays model-free — a judge is only built
when a manifest actually requires a pass.
"""

from __future__ import annotations

import asyncio
import inspect
import json
import logging
from collections.abc import Awaitable, Callable
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

from deerflow.skills.review.eval_schema import iter_manifest_cases

logger = logging.getLogger(__name__)

#: Directory (relative to the package root) the manifests live in.
EVALS_DIRNAME = "evals"
#: Manifest keys that carry the utterance a trigger case is about, in priority order.
_UTTERANCE_KEYS = ("query", "prompt", "input", "utterance", "task", "message")
#: A decider answers "would this skill trigger for this utterance?".
Decider = Callable[["TriggerEvalCase"], bool | Awaitable[bool]]


class EvalGateError(ValueError):
    """Raised when a package's declared eval gate did not pass."""

    def __init__(self, message: str, *, failures: list[TriggerEvalFailure] | None = None, skill_name: str | None = None) -> None:
        super().__init__(message)
        self.failures = list(failures or [])
        self.skill_name = skill_name


@dataclass(frozen=True)
class TriggerEvalCase:
    """One decidable trigger expectation."""

    path: str
    index: int
    utterance: str
    should_trigger: bool


@dataclass(frozen=True)
class SkippedEvalCase:
    """A case this gate deliberately does not decide."""

    path: str
    index: int
    reason: str


@dataclass(frozen=True)
class EvalManifest:
    path: str
    schema: str
    require_pass: bool
    cases: tuple[TriggerEvalCase, ...]
    skipped: tuple[SkippedEvalCase, ...]


@dataclass(frozen=True)
class EvalSuite:
    """Everything the gate read out of a package's ``evals/`` directory."""

    manifests: tuple[EvalManifest, ...] = ()
    problems: tuple[str, ...] = field(default=())

    @property
    def cases(self) -> tuple[TriggerEvalCase, ...]:
        return tuple(case for manifest in self.manifests for case in manifest.cases)

    @property
    def skipped(self) -> tuple[SkippedEvalCase, ...]:
        return tuple(case for manifest in self.manifests for case in manifest.skipped)

    @property
    def requires_pass(self) -> bool:
        """True when any manifest that has decidable cases opted into gating."""
        return any(manifest.require_pass and manifest.cases for manifest in self.manifests)

    def gated_manifests(self) -> tuple[EvalManifest, ...]:
        return tuple(manifest for manifest in self.manifests if manifest.require_pass and manifest.cases)


@dataclass(frozen=True)
class TriggerEvalFailure:
    case: TriggerEvalCase
    expected: bool
    actual: bool


@dataclass(frozen=True)
class TriggerEvalReport:
    skill_name: str
    total: int
    passed: int
    failed: int
    skipped: int
    #: Cases a judge was asked about but could not answer.
    undecided: int
    requires_pass: bool
    decided: bool
    failures: tuple[TriggerEvalFailure, ...] = ()
    problems: tuple[str, ...] = ()
    #: Manifest paths that opted into gating (only their failures block).
    gated_paths: tuple[str, ...] = ()

    @property
    def pass_rate(self) -> float:
        return 1.0 if self.total == 0 else self.passed / self.total

    def to_dict(self) -> dict[str, Any]:
        return {
            "skill_name": self.skill_name,
            "total": self.total,
            "passed": self.passed,
            "failed": self.failed,
            "skipped": self.skipped,
            "undecided": self.undecided,
            "requires_pass": self.requires_pass,
            "decided": self.decided,
            "pass_rate": self.pass_rate,
            "failures": [{"path": failure.case.path, "index": failure.case.index, "utterance": failure.case.utterance, "expected": failure.expected, "actual": failure.actual} for failure in self.failures],
            "problems": list(self.problems),
        }


def _utterance_of(case: dict[str, Any]) -> str | None:
    for key in _UTTERANCE_KEYS:
        value = case.get(key)
        if isinstance(value, str) and value.strip():
            return value
    return None


def _manifest_from_payload(rel_path: str, payload: Any) -> EvalManifest | None:
    recognized = iter_manifest_cases(payload)
    if recognized is None:
        return None
    schema, raw_cases = recognized
    # Only a mapping can declare the gate (a bare list has nowhere to put it).
    require_pass = bool(payload.get("require_pass")) if isinstance(payload, dict) else False

    cases: list[TriggerEvalCase] = []
    skipped: list[SkippedEvalCase] = []
    for index, raw_case in enumerate(raw_cases):
        if not isinstance(raw_case, dict):
            skipped.append(SkippedEvalCase(rel_path, index, "case is not a mapping"))
            continue
        should_trigger = raw_case.get("should_trigger")
        if not isinstance(should_trigger, bool):
            skipped.append(SkippedEvalCase(rel_path, index, "no boolean 'should_trigger'"))
            continue
        utterance = _utterance_of(raw_case)
        if utterance is None:
            skipped.append(SkippedEvalCase(rel_path, index, f"no utterance ({'/'.join(_UTTERANCE_KEYS)})"))
            continue
        cases.append(TriggerEvalCase(path=rel_path, index=index, utterance=utterance, should_trigger=should_trigger))
    return EvalManifest(
        path=rel_path,
        schema=schema,
        require_pass=require_pass,
        cases=tuple(cases),
        skipped=tuple(skipped),
    )


def collect_trigger_cases(root: str | Path) -> EvalSuite:
    """Read a package's ``evals/*.json`` manifests.

    A manifest that cannot be read or parsed becomes a *problem* string rather
    than an exception: the review package already classifies an unparseable
    manifest as a warning (``eval.invalid-json``), so a packaging defect must
    not be escalated into a blocked install here.  An unrecognized manifest
    shape is ignored (`iter_manifest_cases` returning ``None``).
    """
    root_path = Path(root)
    evals_dir = root_path / EVALS_DIRNAME
    if not evals_dir.is_dir():
        return EvalSuite()

    manifests: list[EvalManifest] = []
    problems: list[str] = []
    for path in sorted(candidate for candidate in evals_dir.rglob("*.json") if candidate.is_file()):
        rel_path = path.relative_to(root_path).as_posix()
        try:
            payload = json.loads(path.read_text(encoding="utf-8"))
        except (OSError, UnicodeDecodeError, json.JSONDecodeError) as exc:
            problems.append(f"{rel_path}: {exc}")
            continue
        manifest = _manifest_from_payload(rel_path, payload)
        if manifest is not None:
            manifests.append(manifest)
    return EvalSuite(manifests=tuple(manifests), problems=tuple(problems))


async def aevaluate_trigger_cases(suite: EvalSuite, decider: Decider) -> TriggerEvalReport:
    """Decide every trigger case with *decider* (sync or async).

    A loader failure is recorded as a *problem* instead of aborting the report,
    so one flaky judge call cannot hide the cases that already decided.
    """
    case_total = 0
    passed = 0
    undecided = 0
    failures: list[TriggerEvalFailure] = []
    problems = list(suite.problems)
    for manifest in suite.manifests:
        for case in manifest.cases:
            try:
                actual = decider(case)
                if inspect.isawaitable(actual):
                    actual = await actual
            except Exception as exc:  # noqa: BLE001 — a judge failure is data, not a crash
                undecided += 1
                problems.append(f"{case.path}#{case.index}: judge failed: {exc}")
                continue
            case_total += 1
            if bool(actual) == case.should_trigger:
                passed += 1
            else:
                failures.append(TriggerEvalFailure(case=case, expected=case.should_trigger, actual=bool(actual)))
    return TriggerEvalReport(
        skill_name="",
        total=case_total,
        passed=passed,
        failed=len(failures),
        skipped=len(suite.skipped),
        undecided=undecided,
        requires_pass=suite.requires_pass,
        decided=True,
        failures=tuple(failures),
        problems=tuple(problems),
    )


def gate_failures(report: TriggerEvalReport) -> list[TriggerEvalFailure]:
    """The failures that must block an install.

    Only cases from a manifest that opted in (`require_pass`) block; a
    report-only manifest contributes numbers, never a refusal.
    """
    gated = set(report.gated_paths)
    return [failure for failure in report.failures if failure.case.path in gated]


def _format_failures(failures: list[TriggerEvalFailure]) -> str:
    parts = []
    for failure in failures:
        expected = "trigger" if failure.expected else "not trigger"
        actual = "triggered" if failure.actual else "did not trigger"
        parts.append(f"{failure.case.path}#{failure.case.index} expected {expected} but {actual}: {failure.case.utterance[:120]}")
    return "; ".join(parts)


async def enforce_skill_eval_gate(
    root: str | Path,
    *,
    skill_name: str,
    description: str | None = None,
    decider: Decider | None = None,
    app_config: Any | None = None,
) -> TriggerEvalReport:
    """Verify a package's trigger evals at install time (§24.8).

    Returns a report for the caller to log; raises :class:`EvalGateError` when a
    manifest that declared ``require_pass`` did not pass — or when such a gate
    could not be run at all, because a declared gate that silently passes is
    worse than one that refuses.
    """
    # Manifest discovery reads/rglobs the extracted package. Keep that
    # synchronous filesystem work off the event loop, matching the rest of the
    # install pipeline; the strict Blockbuster gate anchors this path.
    suite = await asyncio.to_thread(collect_trigger_cases, root)
    for problem in suite.problems:
        logger.warning("Skill '%s' eval manifest problem (%s); not gating on it", skill_name, problem)

    if not suite.manifests:
        return TriggerEvalReport(skill_name=skill_name, total=0, passed=0, failed=0, skipped=len(suite.skipped), undecided=0, requires_pass=False, decided=False, problems=suite.problems)

    if decider is None and suite.requires_pass:
        from deerflow.skills.eval_judge import build_trigger_judge  # deferred: keeps the gate import-light

        try:
            decider = build_trigger_judge(skill_name, description=description, app_config=app_config)
        except Exception as exc:
            raise EvalGateError(f"Skill '{skill_name}' declares a required trigger eval suite but no judge could be built: {exc}", skill_name=skill_name) from exc

    if decider is None:
        # Nothing declared a gate and no caller supplied a judge: count, do not
        # judge — the default install path makes no model call.
        report = TriggerEvalReport(
            skill_name=skill_name,
            total=len(suite.cases),
            passed=0,
            failed=0,
            skipped=len(suite.skipped),
            undecided=0,
            requires_pass=False,
            decided=False,
            problems=suite.problems,
        )
        logger.info("Skill '%s' ships %d trigger eval case(s) (report-only; add \"require_pass\": true to gate the install)", skill_name, report.total)
        return report

    report = await aevaluate_trigger_cases(suite, decider)
    report = TriggerEvalReport(
        skill_name=skill_name,
        total=report.total,
        passed=report.passed,
        failed=report.failed,
        skipped=report.skipped,
        undecided=report.undecided,
        requires_pass=report.requires_pass,
        decided=report.decided,
        failures=report.failures,
        problems=report.problems,
        gated_paths=tuple(manifest.path for manifest in suite.gated_manifests()),
    )

    for problem in report.problems:
        logger.warning("Skill '%s' eval problem: %s", skill_name, problem)

    if not suite.requires_pass:
        logger.info("Skill '%s' trigger evals: %d/%d passed (report-only)", skill_name, report.passed, report.total)
        return report

    blocking = gate_failures(report)
    if blocking:
        raise EvalGateError(
            f"Skill '{skill_name}' failed its required trigger eval suite: {_format_failures(blocking)}",
            failures=blocking,
            skill_name=skill_name,
        )
    if report.undecided:
        # A declared gate we could not actually run must not pass: a judge that
        # answered nothing would otherwise turn "required" into "advisory".
        raise EvalGateError(
            f"Skill '{skill_name}' declares a required trigger eval suite but {report.undecided} case(s) could not be decided: {'; '.join(report.problems)}",
            skill_name=skill_name,
        )
    logger.info("Skill '%s' required trigger evals passed (%d/%d)", skill_name, report.passed, report.total)
    return report


__all__ = [
    "EVALS_DIRNAME",
    "Decider",
    "EvalGateError",
    "EvalManifest",
    "EvalSuite",
    "SkippedEvalCase",
    "TriggerEvalCase",
    "TriggerEvalFailure",
    "TriggerEvalReport",
    "aevaluate_trigger_cases",
    "collect_trigger_cases",
    "enforce_skill_eval_gate",
    "gate_failures",
]
