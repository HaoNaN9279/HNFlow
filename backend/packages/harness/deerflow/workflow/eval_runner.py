"""Run-and-evaluate glue for workflow eval suites (N14 §24.8).

``evals.py`` is the pure assertion core and ``replay.py`` can replay a recorded
run with no model/tool call; this module is the thin runner that joins them: it
compiles a definition, executes it **in replay mode** against a golden fixture,
extracts the node outputs, and evaluates a list of cases against them.

Running in replay mode is deliberate — an eval suite must be deterministic and
offline (§24.8 "golden traces"), so a missing recording fails loudly rather than
silently calling a real model.  Compilation is the caller's concern only if it
wants a custom registry; otherwise the default one is used.
"""

from __future__ import annotations

from typing import Any

from deerflow.workflow.evals import EvalCase, EvalReport, SemanticJudge, evaluate_case, extract_node_outputs
from deerflow.workflow.replay import MODE_REPLAY, REPLAY_CONTEXT_KEY, ReplayFixture, ReplaySession
from deerflow.workflow.schema import WorkflowDefinition

#: Thread id used for the throwaway eval run (replay needs a thread for config).
_EVAL_THREAD_ID = "wf-eval"


async def evaluate_replayed_run(
    definition: WorkflowDefinition,
    *,
    fixture: ReplayFixture,
    cases: list[EvalCase],
    initial_state: dict[str, Any] | None = None,
    context: dict[str, Any] | None = None,
    judge: SemanticJudge | None = None,
    compile_context: Any = None,
    on_miss: str = "error",
) -> EvalReport:
    """Replay *definition* against *fixture* and evaluate every case.

    *on_miss* mirrors :class:`~deerflow.workflow.replay.ReplaySession`: ``error``
    (default) fails loudly on an un-recorded node; ``live`` falls back to real
    execution (only use when an eval genuinely wants a live path).
    """
    from deerflow.workflow.compiler import compile_definition
    from deerflow.workflow.executors import build_default_registry

    session = ReplaySession(mode=MODE_REPLAY, fixture=fixture, on_miss=on_miss)
    ctx = compile_context if compile_context is not None else build_default_registry().build_context()
    graph = compile_definition(definition, context=ctx)

    run_context = dict(context or {})
    run_context[REPLAY_CONTEXT_KEY] = session
    state = await graph.ainvoke(initial_state or {}, {"configurable": {"thread_id": _EVAL_THREAD_ID}, "context": run_context})

    outputs = extract_node_outputs(state)
    report = EvalReport()
    for case in cases:
        report.add(evaluate_case(case, outputs, judge=judge))
    return report
