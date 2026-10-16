"""Flow-control workflow executors.

Each executor follows the ``Executor`` contract:
``(runtime: WorkflowRuntime, params: dict, inputs: dict) -> dict``.
"""

from __future__ import annotations

import asyncio
from typing import Any

from deerflow.workflow.compiler import WorkflowRuntime
from deerflow.workflow.handoff import DECISION_PORT, HANDOFF_COUNT_CHANNEL, TARGET_PORT, handoff_count_key, parse_handoff, resolve_handoff_target
from deerflow.workflow.registry import WorkflowExecutionError

# ── flow:wait ────────────────────────────────────────────────────────────────


async def exec_wait(runtime: WorkflowRuntime, params: dict[str, Any], inputs: dict[str, Any]) -> dict[str, Any]:
    """Sleep for ``params.duration`` seconds, then pass through inputs.

    Default duration is 0 (no-op pass-through).  The executor writes the
    input value on the ``out`` port unchanged.
    """
    duration: float = float(params.get("duration", 0))
    if duration > 0:
        await asyncio.sleep(duration)
    return {"out": inputs.get("in")}


# ── flow:switch ──────────────────────────────────────────────────────────────


def exec_switch(runtime: WorkflowRuntime, params: dict[str, Any], inputs: dict[str, Any]) -> dict[str, Any]:
    """Match ``inputs.in`` against ``params.cases`` and light the matching branch.

    ``params.cases`` is a list of ``{value: ..., port: ...}`` entries.
    The first case whose ``value`` equals ``inputs.in`` wins — its
    ``port`` is written ``True`` in the output dict.  If no case matches,
    an empty dict is returned and the default (unconditional) edge
    takes over.
    """
    cases: list[dict[str, Any]] = params.get("cases", [])
    target_value = inputs.get("in")

    for case in cases:
        if case.get("value") == target_value:
            return {case["port"]: True}

    # No match — return empty; the compiler's default edge handles routing.
    return {}


# ── flow:if ──────────────────────────────────────────────────────────────────


def exec_if(runtime: WorkflowRuntime, params: dict[str, Any], inputs: dict[str, Any]) -> dict[str, Any]:
    """Evaluate if-conditions and write the matching branch port.

    ``params.port`` (str, default ``"true"``): the output port to write
    when the condition is truthy.  The compiler's route function reads
    port values from state to select the active branch.

    For non-trivial condition logic, override this executor in
    ``CompileContext`` with a custom callable (the built-in
    ``exec_if`` is intentionally a minimal pass-through that writes
    the input value to the declared output ports — the route function
    handles truthy/falsy routing).
    """
    ports: list[str] = params.get("ports", ["true", "false"])
    input_val = inputs.get("in")

    result: dict[str, Any] = {}
    for port in ports:
        result[port] = input_val
    return result


# ── flow:handoff ─────────────────────────────────────────────────────────────


def exec_handoff(runtime: WorkflowRuntime, params: dict[str, Any], inputs: dict[str, Any]) -> dict[str, Any]:
    """Resolve a supervisor's selection onto a whitelisted expert node (§24.6a).

    Reads ``inputs.decision`` and maps it through ``params.candidates``
    (``[{value, node}, ...]``) onto the target node id — the compiler turns that
    into the routing edge.  An unknown or missing selection **fails** rather
    than falling through: a switch's default edge is exactly the silent
    wrong-branch behaviour a handoff must not have.

    ``params.max_handoffs`` bounds how often this node may route within a run;
    the count is carried on the reserved ``wf:<node_id>:__handoffs`` channel
    (the compiler injects ``node_id`` into the params).  Every declared input
    other than ``decision`` is forwarded to the same-named output port, which is
    how a handoff carries its structured message (task / constraints / context
    references) inline with the routing decision.
    """
    spec = parse_handoff(params)
    target = resolve_handoff_target(spec, inputs.get(DECISION_PORT))

    node_id = params.get("node_id")
    if not isinstance(node_id, str) or not node_id:
        # Should not happen — the compiler injects it.  Refuse rather than
        # pretend the budget is enforced when no counter can be read.
        raise WorkflowExecutionError("flow:handoff requires a 'node_id' (injected by the compiler) to enforce its budget")

    used = runtime.state.get(handoff_count_key(node_id), 0)
    used_count = used if isinstance(used, int) and not isinstance(used, bool) else 0
    if used_count >= spec.max_handoffs:
        raise WorkflowExecutionError(f"node '{node_id}': handoff budget exhausted ({used_count} >= {spec.max_handoffs}); raise 'params.max_handoffs' or restructure the routing")

    outputs: dict[str, Any] = {
        TARGET_PORT: target,
        HANDOFF_COUNT_CHANNEL: used_count + 1,
    }
    for name, value in inputs.items():
        if name != DECISION_PORT:
            outputs[name] = value
    return outputs
