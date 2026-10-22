"""Rewind & re-run for workflow runs (§25's third debugging capability).

Single-step mode (``debug_step.py``, N14ad) pauses a run; this
is the other half of debugging: after a run failed — or produced a wrong result —
re-execute it **from a chosen node** without re-running the nodes before it.

The mechanism is LangGraph's own checkpoint resumption, not a parallel replay
engine.  Every node visit writes a checkpoint whose scheduled tasks are exactly
the nodes about to run, so "the state before node X" is the checkpoint whose
``next`` contains X; resuming there re-executes X and everything downstream while
the already-produced upstream outputs stay in state (which is the point: a
side-effecting ``tool:bash`` / ``app:launch`` upstream must not run twice).

Judgement is a pure function over candidates (:func:`plan_rewind`) so the policy
is offline-testable; locating them needs the graph's checkpoint history, which is
the one impure step (:func:`locate_rewind_point`).
"""

from __future__ import annotations

import logging
from collections.abc import Sequence
from dataclasses import dataclass
from typing import Any

from deerflow.workflow.compiler import CompileContext, compile_definition
from deerflow.workflow.executors import build_default_registry
from deerflow.workflow.schema import NodeType, WorkflowDefinition

logger = logging.getLogger(__name__)


class RewindError(ValueError):
    """The requested node cannot be rewound to (unknown, never scheduled, sentinel)."""


@dataclass(frozen=True)
class RewindCandidate:
    """One checkpoint, reduced to what a rewind decision needs."""

    checkpoint_id: str
    next_node_ids: tuple[str, ...]
    step: int | None = None


@dataclass(frozen=True)
class RewindPoint:
    """The checkpoint a rewind should resume from, plus what it will re-run."""

    checkpoint_id: str
    node_id: str
    step: int | None = None


def parse_rewind_candidate(snapshot: Any) -> RewindCandidate | None:
    """Reduce a LangGraph ``StateSnapshot`` (or a stub) to a candidate.

    Defensive on purpose: a snapshot without an addressable checkpoint id is
    unusable for a rewrite, and reporting it as a candidate would make
    ``plan_rewind`` name a checkpoint nobody can resume from.
    """
    config = getattr(snapshot, "config", None)
    configurable = config.get("configurable") if isinstance(config, dict) else None
    checkpoint_id = configurable.get("checkpoint_id") if isinstance(configurable, dict) else None
    if not isinstance(checkpoint_id, str) or not checkpoint_id:
        return None
    raw_next = getattr(snapshot, "next", None)
    next_ids: tuple[str, ...] = ()
    if isinstance(raw_next, (list, tuple)):
        next_ids = tuple(item for item in raw_next if isinstance(item, str) and item)
    metadata = getattr(snapshot, "metadata", None)
    raw_step = metadata.get("step") if isinstance(metadata, dict) else None
    step = raw_step if isinstance(raw_step, int) and not isinstance(raw_step, bool) else None
    return RewindCandidate(checkpoint_id=checkpoint_id, next_node_ids=next_ids, step=step)


def plan_rewind(candidates: Sequence[RewindCandidate], node_id: str) -> RewindPoint:
    """Pick the checkpoint whose scheduled tasks include *node_id*.

    *candidates* must be **newest first** (LangGraph's ``aget_state_history``
    order): the newest match is the one on the run's current head lineage, which
    is what a caller means by "re-run that node".  An older match would resume a
    branch the last rewind abandoned.

    Raises :class:`RewindError` — never a silent "nothing to do" — naming the
    nodes the run *can* rewind to, because a rewind that quietly does nothing is
    indistinguishable from a successful one.
    """
    if node_id in (NodeType.FLOW_START.value, NodeType.FLOW_END.value):
        raise RewindError(f"cannot rewind to '{node_id}': it is a graph sentinel that never runs as a scheduled task")

    schedulable: list[str] = []
    for candidate in candidates:
        for scheduled in candidate.next_node_ids:
            if scheduled not in schedulable:
                schedulable.append(scheduled)
        if node_id in candidate.next_node_ids:
            return RewindPoint(checkpoint_id=candidate.checkpoint_id, node_id=node_id, step=candidate.step)

    available = ", ".join(schedulable) if schedulable else "<none>"
    raise RewindError(f"node '{node_id}' was never scheduled in this run's checkpoint history; rewindable nodes: {available}")


def _candidates_from_history(history: Sequence[Any]) -> list[RewindCandidate]:
    reduced: list[RewindCandidate] = []
    for snapshot in history:
        candidate = parse_rewind_candidate(snapshot)
        if candidate is not None:
            reduced.append(candidate)
    return reduced


async def locate_rewind_point(
    definition: WorkflowDefinition,
    checkpointer: Any,
    thread_id: str,
    node_id: str,
    *,
    definition_resolver: Any | None = None,
    max_delegation_depth: int = 3,
    history_limit: int | None = None,
    executors: dict[Any, Any] | None = None,
) -> RewindPoint:
    """Find the checkpoint to resume so that *node_id* (and its successors) re-run.

    The definition is compiled against the run's own checkpointer so the graph's
    channel table matches the one the run used — the same guarantee the worker
    relies on — and ``aget_state_history`` supplies each checkpoint's scheduled
    tasks.  Raises :class:`RewindError` when nothing matches.

    The graph is only used to *read* history, so the default registry is enough
    (and matches what the run itself compiled with); the executor bodies never
    run here.
    """
    registry_context = CompileContext(
        executors=dict(executors) if executors is not None else build_default_registry().build_context().executors,
        checkpointer=checkpointer,
        definition_resolver=definition_resolver,
        max_delegation_depth=max_delegation_depth,
    )
    graph = compile_definition(definition, context=registry_context)
    config = {"configurable": {"thread_id": thread_id}}
    history: list[Any] = []
    async for snapshot in graph.aget_state_history(config, limit=history_limit):
        history.append(snapshot)
    return plan_rewind(_candidates_from_history(history), node_id)


__all__ = [
    "RewindCandidate",
    "RewindError",
    "RewindPoint",
    "locate_rewind_point",
    "parse_rewind_candidate",
    "plan_rewind",
]
