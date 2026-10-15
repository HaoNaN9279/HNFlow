"""Workflow evaluation / regression core (N14 §24.8).

A deterministic orchestration engine still cannot claim "behaviour unchanged
after a change" without *evaluating* it.  This module is the assertion core:

- a run's node outputs are extracted from its final state
  (:func:`extract_node_outputs`) — the same ``wf:<node>:<port>`` channel shape
  the compiler writes, so an N14 §24.11 replayed run feeds straight in;
- a case declares per-port assertions.  Deterministic ports use exact assertions
  (``equals`` / ``contains`` / ``matches`` / ``exists`` / ``truthy``); an AI
  port whose text is legitimately non-reproducible uses a **semantic** assertion
  delegated to an injectable judge (``LLM-as-judge`` / similarity) — the judge is
  a callable the caller supplies, so this module stays pure and offline-testable;
- results aggregate into a report (pass count / rate / failures).

The runner that executes a definition and the CI hook are thin callers; the
comparable logic lives here so it is testable without a model.
"""

from __future__ import annotations

import json
import re
from collections.abc import Callable
from dataclasses import dataclass, field
from typing import Any

#: Assertion kinds: exact ones are deterministic; ``semantic`` needs a judge.
ASSERTION_KINDS: frozenset[str] = frozenset({"equals", "contains", "matches", "exists", "truthy", "semantic"})

#: A semantic judge gets ``(expected, actual)`` (both strings) and returns pass.
SemanticJudge = Callable[[str, str], bool]


class EvalError(ValueError):
    """Raised for a malformed evaluation case / assertion."""


# ── Output extraction ────────────────────────────────────────────────────────


def extract_node_outputs(state: dict[str, Any]) -> dict[str, dict[str, Any]]:
    """Group a final workflow state's ``wf:<node>:<port>`` channels by node.

    Reserved channels are skipped: ``wf:shared:<name>`` (N14 shared workspace)
    and ``wf:<node>:__<reserved>`` (token usage, retry count, …) are engine
    bookkeeping, not node output ports.
    """
    outputs: dict[str, dict[str, Any]] = {}
    for key, value in state.items():
        if not isinstance(key, str) or not key.startswith("wf:"):
            continue
        remainder = key[3:]
        if remainder.startswith("shared:"):
            continue
        node_id, _, port = remainder.partition(":")
        if not node_id or not port or port.startswith("__"):
            continue
        outputs.setdefault(node_id, {})[port] = value
    return outputs


# ── Assertions ───────────────────────────────────────────────────────────────


@dataclass(frozen=True)
class NodeAssertion:
    """One assertion about a single ``(node, port)`` output value."""

    node_id: str
    port: str
    kind: str
    expected: Any = None
    case_sensitive: bool = True

    def __post_init__(self) -> None:
        if self.kind not in ASSERTION_KINDS:
            raise EvalError(f"unknown assertion kind {self.kind!r}; allowed: {sorted(ASSERTION_KINDS)}")
        if self.kind == "semantic" and not isinstance(self.expected, str):
            raise EvalError("a 'semantic' assertion requires a string expected value")
        if self.kind == "matches":
            if not isinstance(self.expected, str):
                raise EvalError("a 'matches' assertion requires a string regex")
            try:
                re.compile(self.expected)
            except re.error as exc:
                raise EvalError(f"invalid regex {self.expected!r}: {exc}") from exc


@dataclass
class AssertionResult:
    node_id: str
    port: str
    kind: str
    passed: bool
    detail: str = ""

    def to_dict(self) -> dict[str, Any]:
        return {"node_id": self.node_id, "port": self.port, "kind": self.kind, "passed": self.passed, "detail": self.detail}


def evaluate_assertion(assertion: NodeAssertion, outputs: dict[str, dict[str, Any]], *, judge: SemanticJudge | None = None) -> AssertionResult:
    """Evaluate one assertion against extracted node *outputs*."""
    node_outputs = outputs.get(assertion.node_id)
    present = node_outputs is not None and assertion.port in node_outputs
    actual = node_outputs.get(assertion.port) if node_outputs is not None else None

    if assertion.kind == "exists":
        return AssertionResult(assertion.node_id, assertion.port, assertion.kind, present, "" if present else "port was not produced")
    if not present:
        return AssertionResult(assertion.node_id, assertion.port, assertion.kind, False, "port was not produced")

    if assertion.kind == "equals":
        ok = actual == assertion.expected
        return AssertionResult(assertion.node_id, assertion.port, assertion.kind, ok, "" if ok else f"expected {assertion.expected!r}, got {actual!r}")
    if assertion.kind == "truthy":
        ok = bool(actual)
        return AssertionResult(assertion.node_id, assertion.port, assertion.kind, ok, "" if ok else f"expected a truthy value, got {actual!r}")
    if assertion.kind == "contains":
        needle = assertion.expected
        if isinstance(actual, (list, tuple, set)):
            ok = needle in actual  # membership for a collection
        else:
            haystack = actual if isinstance(actual, str) else json.dumps(actual, default=str, ensure_ascii=False)
            if assertion.case_sensitive:
                ok = str(needle) in haystack
            else:
                ok = str(needle).lower() in haystack.lower()
        return AssertionResult(assertion.node_id, assertion.port, assertion.kind, ok, "" if ok else f"{needle!r} not found in {actual!r}")
    if assertion.kind == "matches":
        text = actual if isinstance(actual, str) else json.dumps(actual, default=str, ensure_ascii=False)
        flags = 0 if assertion.case_sensitive else re.IGNORECASE
        ok = re.search(assertion.expected, text, flags) is not None
        return AssertionResult(assertion.node_id, assertion.port, assertion.kind, ok, "" if ok else f"pattern {assertion.expected!r} did not match {text!r}")
    # semantic
    if judge is None:
        return AssertionResult(assertion.node_id, assertion.port, assertion.kind, False, "no semantic judge was provided")
    text = actual if isinstance(actual, str) else json.dumps(actual, default=str, ensure_ascii=False)
    try:
        ok = bool(judge(assertion.expected, text))
    except Exception as exc:  # noqa: BLE001 — a judge failure is a failed assertion, not a crash
        return AssertionResult(assertion.node_id, assertion.port, assertion.kind, False, f"judge raised {type(exc).__name__}: {exc}")
    return AssertionResult(assertion.node_id, assertion.port, assertion.kind, ok, "" if ok else f"judge rejected {text!r} against {assertion.expected!r}")


# ── Cases / report ───────────────────────────────────────────────────────────


@dataclass
class EvalCase:
    """A named set of assertions over one run's outputs."""

    name: str
    assertions: list[NodeAssertion] = field(default_factory=list)
    definition_id: str | None = None
    inputs: dict[str, Any] | None = None

    def __post_init__(self) -> None:
        if not self.name:
            raise EvalError("an eval case requires a non-empty name")


@dataclass
class CaseResult:
    case_name: str
    results: list[AssertionResult]

    @property
    def passed(self) -> bool:
        return all(r.passed for r in self.results)

    @property
    def failures(self) -> list[AssertionResult]:
        return [r for r in self.results if not r.passed]

    def to_dict(self) -> dict[str, Any]:
        return {"case": self.case_name, "passed": self.passed, "assertions": [r.to_dict() for r in self.results]}


def evaluate_case(case: EvalCase, outputs: dict[str, dict[str, Any]], *, judge: SemanticJudge | None = None) -> CaseResult:
    """Evaluate every assertion of *case* against extracted node *outputs*."""
    return CaseResult(case.name, [evaluate_assertion(a, outputs, judge=judge) for a in case.assertions])


@dataclass
class EvalReport:
    """Aggregate of one suite run (pass rate + failures)."""

    results: list[CaseResult] = field(default_factory=list)

    @property
    def total(self) -> int:
        return len(self.results)

    @property
    def passed(self) -> int:
        return sum(1 for r in self.results if r.passed)

    @property
    def failed(self) -> int:
        return self.total - self.passed

    @property
    def pass_rate(self) -> float:
        return (self.passed / self.total) if self.total else 1.0

    @property
    def failures(self) -> list[CaseResult]:
        return [r for r in self.results if not r.passed]

    def add(self, result: CaseResult) -> None:
        self.results.append(result)

    def to_dict(self) -> dict[str, Any]:
        return {"total": self.total, "passed": self.passed, "failed": self.failed, "pass_rate": self.pass_rate, "cases": [r.to_dict() for r in self.results]}

    def to_json(self) -> str:
        return json.dumps(self.to_dict(), ensure_ascii=False, indent=2)


def run_eval_suite(cases: list[EvalCase], outputs_by_case: dict[str, dict[str, dict[str, Any]]], *, judge: SemanticJudge | None = None) -> EvalReport:
    """Evaluate a list of cases against a mapping ``case_name → extracted outputs``."""
    report = EvalReport()
    for case in cases:
        report.add(evaluate_case(case, outputs_by_case.get(case.name, {}), judge=judge))
    return report
