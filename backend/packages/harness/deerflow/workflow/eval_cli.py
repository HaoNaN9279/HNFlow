"""``python -m deerflow.workflow.eval_cli`` — run a workflow eval suite in CI (N14 §24.8).

Loads a saved definition, a golden replay fixture, and a case file, replays the
run (no real model/tool call) and reports pass/fail.  Exit codes:

- ``0`` — every case passed;
- ``1`` — at least one case failed;
- ``2`` — the inputs could not be loaded or the run itself could not execute.

The case file is a JSON list::

    [
      {"name": "smoke", "assertions": [
        {"node_id": "work", "port": "out", "kind": "equals", "expected": "ok"},
        {"node_id": "ai", "port": "out", "kind": "semantic", "expected": "a friendly greeting"}
      ]}
    ]
"""

from __future__ import annotations

import argparse
import asyncio
import json
import sys
from pathlib import Path
from typing import Any

from deerflow.workflow.evals import EvalCase, NodeAssertion
from deerflow.workflow.replay import load_fixture


def _parse_cases(raw: Any) -> list[EvalCase]:
    if not isinstance(raw, list):
        raise ValueError("cases file must be a JSON list")
    cases: list[EvalCase] = []
    for entry in raw:
        if not isinstance(entry, dict):
            raise ValueError("each case must be a JSON object")
        assertions = [
            NodeAssertion(
                node_id=str(a["node_id"]),
                port=str(a["port"]),
                kind=str(a["kind"]),
                expected=a.get("expected"),
                case_sensitive=a.get("case_sensitive", True),
            )
            for a in entry.get("assertions", [])
        ]
        cases.append(EvalCase(name=str(entry.get("name", "")), assertions=assertions))
    return cases


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(prog="python -m deerflow.workflow.eval_cli", description="Replay a workflow against a golden fixture and evaluate cases.")
    parser.add_argument("--definition", required=True, help="Path to a serialized WorkflowDefinition JSON")
    parser.add_argument("--fixture", required=True, help="Path to a replay fixture JSON")
    parser.add_argument("--cases", required=True, help="Path to a JSON list of eval cases")
    parser.add_argument("--on-miss", choices=["error", "live"], default="error", help="Replay miss policy (default: error)")
    parser.add_argument("--json", action="store_true", help="Emit the full report as JSON")
    args = parser.parse_args(argv)

    try:
        from deerflow.workflow.workflow_io import deserialize

        definition = deserialize(Path(args.definition).read_text(encoding="utf-8"))
        fixture = load_fixture(args.fixture)
        cases = _parse_cases(json.loads(Path(args.cases).read_text(encoding="utf-8")))
    except Exception as exc:  # noqa: BLE001 — a load failure is exit code 2
        print(f"eval: cannot load inputs: {exc}", file=sys.stderr)
        return 2

    from deerflow.workflow.eval_runner import evaluate_replayed_run

    try:
        report = asyncio.run(evaluate_replayed_run(definition, fixture=fixture, cases=cases, on_miss=args.on_miss))
    except Exception as exc:  # noqa: BLE001 — a run failure is exit code 2
        print(f"eval: run failed: {exc}", file=sys.stderr)
        return 2

    if args.json:
        print(report.to_json())
    else:
        print(f"{report.passed}/{report.total} eval case(s) passed")
        for case in report.failures:
            for assertion in case.failures:
                print(f"  FAIL {case.case_name}: {assertion.node_id}.{assertion.port} [{assertion.kind}] {assertion.detail}")
    return 0 if report.failed == 0 else 1


if __name__ == "__main__":
    raise SystemExit(main())
