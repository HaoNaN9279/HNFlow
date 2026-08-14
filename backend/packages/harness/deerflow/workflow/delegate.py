"""Sub-workflow delegation tool factory (T10-3).

Builds the ``invoke_workflow`` LangChain tool that a T10-5 delegation node
binds into a sub-agent's toolset.  The tool closes over an already-compiled
child :class:`~langgraph.graph.state.CompiledStateGraph` (produced by
:func:`deerflow.workflow.compiler._expand_subworkflow`) and lets the sub-agent
execute that sub-workflow with explicit inputs, then read its structured
outputs back.

Input/output keys follow the compiler's subgraph-boundary convention
(see :func:`deerflow.workflow.compiler._make_subworkflow_node_fn`):

- child inputs are injected as ``wf:<child_start_id>:<port>``;
- child outputs are read from ``wf:<child_end_id>:<port>`` and stripped to a
  plain ``{port: value}`` dict before being returned.
"""

from __future__ import annotations

from typing import Any

from langchain_core.tools import BaseTool, tool
from langgraph.config import get_config  # type: ignore[import-untyped]
from langgraph.graph.state import CompiledStateGraph
from pydantic import BaseModel, Field

from deerflow.workflow.compiler import _copy_on_write
from deerflow.workflow.schema import WorkflowDefinition


class InvokeWorkflowArgs(BaseModel):
    """Arguments for the ``invoke_workflow`` tool."""

    template_id: str = Field(description="The sub-workflow template id being invoked (informational only — does not affect execution).")
    inputs: dict[str, Any] = Field(description="Sub-workflow inputs: child start output-port name → value.")


def build_invoke_workflow_tool(
    child_graph: CompiledStateGraph,
    child_def: WorkflowDefinition,
    child_start_id: str,
    child_end_id: str,
) -> BaseTool:
    """Build the ``invoke_workflow`` tool bound to a compiled sub-workflow.

    The tool captures the compiled child graph in a closure (T10-5's
    delegation node uses it) and executes it with the caller-supplied inputs,
    returning the child's end-node outputs as a plain ``{port: value}`` dict.
    Sub-workflow failures are returned as an error string rather than raised,
    so the sub-agent's turn is not aborted (mirrors the ``task_tool`` style).

    Args:
        child_graph: The compiled child ``CompiledStateGraph`` (checkpointer=None).
        child_def: The child :class:`WorkflowDefinition` (used for error attribution).
        child_start_id: The child ``flow:start`` node id.
        child_end_id: The child ``flow:end`` node id.

    Returns:
        A LangChain ``BaseTool`` named ``invoke_workflow``.
    """

    async def _invoke(template_id: str, inputs: dict[str, Any]) -> dict[str, Any] | str:
        # Build the child initial state from the caller-supplied inputs using
        # the compiler's ``wf:<child_start_id>:<port>`` key convention.  Every
        # value crosses the boundary through the compiler's ``_copy_on_write``
        # (COW), matching the compile-time subgraph adapter: mutable top-level
        # containers are shallow-copied so an in-place mutation by a child node
        # cannot pollute the parent's input values, while nested objects stay
        # shared (no deepcopy).
        sub_input: dict[str, Any] = {f"wf:{child_start_id}:{port}": _copy_on_write(value) for port, value in inputs.items()}

        # Forward the parent config (context, thread id, ...) when available;
        # fall back to {} when invoked outside a LangGraph context.
        try:
            config = get_config()
        except Exception:
            config = {}

        try:
            result = await child_graph.ainvoke(sub_input, config)
        except Exception as exc:
            # The exception may already carry the failing node path
            # (``WorkflowExecutionError(f"{node.id} > {exc}")``) — preserve it.
            return f"Error executing sub-workflow '{child_def.id}': {exc}"

        # Extract the child end-node outputs: strip the ``wf:<child_end_id>:`` prefix.
        prefix = f"wf:{child_end_id}:"
        return {key[len(prefix) :]: value for key, value in result.items() if key.startswith(prefix)}

    return tool(
        "invoke_workflow",
        description="Execute the bound sub-workflow with the given inputs and return its outputs.",
        args_schema=InvokeWorkflowArgs,
    )(_invoke)
