"""Flow-control workflow executors.

Each executor follows the ``Executor`` contract:
``(runtime: WorkflowRuntime, params: dict, inputs: dict) -> dict``.
"""

from __future__ import annotations

import asyncio
from typing import Any

from deerflow.workflow.compiler import WorkflowRuntime

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
