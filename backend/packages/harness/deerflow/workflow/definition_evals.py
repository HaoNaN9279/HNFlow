"""Embedded eval suites carried by a workflow definition (N14 §24.8).

§24.8 asks for eval/regression suites to be *mountable* — a definition should
be able to carry its own golden fixture + assertions so a saved workflow is
regression-testable without an external harness.  This module is that carrier:
it parses a declarative ``metadata.evals`` block into the existing replay
(N14 §24.11) + assertion (N14 §24.8) machinery and runs it deterministically
and offline.

Shape (all keys optional except ``cases``)::

    metadata:
      evals:
        require_pass: true          # optional save gate
        on_miss: error              # error (default) | live
        initial_state: {...}        # optional graph input
        fixture:                    # the golden recording (ReplayFixture)
          schema_version: 1
          run_id: "..."
          entries: [...]
        cases:
          - name: happy-path
            assertions:
              - {node_id: n1, port: out, kind: equals, expected: "ok"}

**Why the gate is opt-in**: ``require_pass`` defaults to ``false``. An
existing definition without an ``evals`` block is untouched, and a definition
that carries a suite is only *gated* on save when it says so — otherwise every
save of a suite-carrying draft would need a passing fixture, which is exactly
the friction that makes teams stop writing evals.

Failures are loud on malformed specs (:class:`DefinitionEvalError`) — a
hand-written block that silently no-ops would be worse than a rejection.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any

from deerflow.workflow.evals import EvalCase, EvalReport, NodeAssertion, SemanticJudge
from deerflow.workflow.replay import ReplayFixture
from deerflow.workflow.schema import WorkflowDefinition

#: ``WorkflowMetadata`` / metadata-dict key holding the suite.
EVALS_METADATA_KEY = "evals"

#: Migration/carry key so a serialized definition round-trips the block.
ON_MISS_MODES = ("error", "live")


class DefinitionEvalError(ValueError):
    """A malformed embedded eval specification."""


@dataclass
class DefinitionEvals:
    """A parsed ``metadata.evals`` block."""

    fixture: ReplayFixture
    cases: list[EvalCase] = field(default_factory=list)
    require_pass: bool = False
    on_miss: str = "error"
    initial_state: dict[str, Any] | None = None


def _raw_evals(metadata: Any) -> Any:
    """Read the ``evals`` block from a ``WorkflowMetadata`` or a plain dict."""
    if metadata is None:
        return None
    if isinstance(metadata, dict):
        return metadata.get(EVALS_METADATA_KEY)
    return getattr(metadata, EVALS_METADATA_KEY, None)


def _parse_assertion(raw: Any, *, case_name: str) -> NodeAssertion:
    if not isinstance(raw, dict):
        raise DefinitionEvalError(f"case {case_name!r}: each assertion must be a mapping")
    missing = [key for key in ("node_id", "port", "kind") if not raw.get(key)]
    if missing:
        raise DefinitionEvalError(f"case {case_name!r}: assertion missing {', '.join(missing)}")
    try:
        return NodeAssertion(
            node_id=str(raw["node_id"]),
            port=str(raw["port"]),
            kind=str(raw["kind"]),
            expected=raw.get("expected"),
            case_sensitive=bool(raw.get("case_sensitive", True)),
        )
    except Exception as exc:
        raise DefinitionEvalError(f"case {case_name!r}: invalid assertion: {exc}") from exc


def _parse_case(raw: Any, *, index: int) -> EvalCase:
    if not isinstance(raw, dict):
        raise DefinitionEvalError(f"case #{index} must be a mapping")
    name = raw.get("name")
    if not name:
        raise DefinitionEvalError(f"case #{index} requires a non-empty 'name'")
    assertions = raw.get("assertions")
    if not isinstance(assertions, list) or not assertions:
        raise DefinitionEvalError(f"case {name!r} requires a non-empty 'assertions' list")
    inputs = raw.get("inputs")
    if inputs is not None and not isinstance(inputs, dict):
        raise DefinitionEvalError(f"case {name!r}: 'inputs' must be a mapping")
    return EvalCase(
        name=str(name),
        assertions=[_parse_assertion(entry, case_name=str(name)) for entry in assertions],
        definition_id=raw.get("definition_id"),
        inputs=inputs,
    )


def parse_definition_evals(metadata: Any) -> DefinitionEvals | None:
    """Parse the embedded suite, or ``None`` when none is declared.

    Raises :class:`DefinitionEvalError` for a malformed block: a spec the
    engine cannot honour must not silently disable the gate.
    """
    raw = _raw_evals(metadata)
    if raw is None:
        return None
    if not isinstance(raw, dict):
        raise DefinitionEvalError(f"'{EVALS_METADATA_KEY}' must be a mapping")

    require_pass = raw.get("require_pass", False)
    if not isinstance(require_pass, bool):
        raise DefinitionEvalError("'require_pass' must be a boolean")

    on_miss = raw.get("on_miss", "error")
    if on_miss not in ON_MISS_MODES:
        raise DefinitionEvalError(f"'on_miss' must be one of {sorted(ON_MISS_MODES)}")

    initial_state = raw.get("initial_state")
    if initial_state is not None and not isinstance(initial_state, dict):
        raise DefinitionEvalError("'initial_state' must be a mapping")

    fixture_raw = raw.get("fixture")
    if not isinstance(fixture_raw, dict):
        raise DefinitionEvalError("'fixture' must be a mapping (a ReplayFixture document)")
    try:
        fixture = ReplayFixture.from_dict(fixture_raw)
    except Exception as exc:
        raise DefinitionEvalError(f"invalid fixture: {exc}") from exc

    cases_raw = raw.get("cases")
    if not isinstance(cases_raw, list) or not cases_raw:
        raise DefinitionEvalError("'cases' must be a non-empty list")
    cases = [_parse_case(entry, index=index) for index, entry in enumerate(cases_raw)]

    return DefinitionEvals(
        fixture=fixture,
        cases=cases,
        require_pass=require_pass,
        on_miss=on_miss,
        initial_state=initial_state,
    )


def definition_has_evals(definition: WorkflowDefinition) -> bool:
    """Whether *definition* carries a parseable suite (raises when malformed)."""
    return parse_definition_evals(getattr(definition, "metadata", None)) is not None


async def evaluate_definition_evals(
    definition: WorkflowDefinition,
    *,
    judge: SemanticJudge | None = None,
    compile_context: Any = None,
    context: dict[str, Any] | None = None,
) -> EvalReport | None:
    """Replay the definition's embedded suite, or ``None`` when it has none.

    Deterministic and offline: execution is a replay against the definition's
    own fixture, so no model or tool is called (§24.8 "golden traces").
    """
    parsed = parse_definition_evals(getattr(definition, "metadata", None))
    if parsed is None:
        return None
    from deerflow.workflow.eval_runner import evaluate_replayed_run

    return await evaluate_replayed_run(
        definition,
        fixture=parsed.fixture,
        cases=parsed.cases,
        initial_state=parsed.initial_state,
        context=context,
        judge=judge,
        compile_context=compile_context,
        on_miss=parsed.on_miss,
    )


def eval_gate_errors(report: EvalReport) -> list[str]:
    """Human-readable gate failures for a 422 body.

    One line per failing assertion so the caller sees *what* regressed rather
    than just "evals failed".
    """
    errors: list[str] = []
    for case in report.failures:
        for failure in case.failures:
            detail = f" ({failure.detail})" if failure.detail else ""
            errors.append(f"评测未通过 [{case.case_name}] {failure.node_id}.{failure.port}: {failure.kind}{detail}")
    if not errors and report.failed:
        errors.append(f"评测未通过：{report.failed}/{report.total} 个用例失败")
    return errors


__all__ = [
    "EVALS_METADATA_KEY",
    "ON_MISS_MODES",
    "DefinitionEvalError",
    "DefinitionEvals",
    "definition_has_evals",
    "eval_gate_errors",
    "evaluate_definition_evals",
    "parse_definition_evals",
]
